#!/usr/bin/env node
// test-topaz-mpl2.mjs — 验证 Topaz 专属建模理解、真实包络、扩展骨骼与解析 IK (reach/aim/plant)
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones, serializePmxBones, deserializePmxBones } from "../src/lib/pmx-bones.ts"
import { measureModelGeometry } from "../src/lib/model-geometry.ts"
import { buildModelConditioning } from "../src/lib/model-conditioning.ts"
import { compileMPL2, expandHandPresets, ensureMain } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld } from "../src/lib/fk.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"
import { critiquePoseVmd } from "../src/lib/pose-critic.ts"
import { POSE_EXEMPLARS, retrievePoseExemplars } from "../src/lib/pose-exemplars.ts"
import { pickPeakPoseFrame, pickStoryboardSamples, renderPoseMultiViewPng, renderStoryboardPng } from "../src/lib/pose-renderer.ts"
import { parseVisualCriticJson, runVisualCritic, summarizeActiveMorphsAtFrame } from "../src/lib/visual-critic.ts"
import { encodeSseEvent, parseSseBuffer, stitchSegments, summarizeFragmentExit } from "../src/lib/long-motion.ts"
import { applyIkScheduleAtTime, computeIkSchedule, enhanceVmdDetailed } from "../src/lib/vmd-enhancer.ts"
import { expandLexiconSegment, LEXICON } from "../src/lib/motion-lexicon.ts"
import { parseMorphFrames } from "../src/lib/vmd-morph.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()
const topaz = parsePmxBones(new Uint8Array(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url))))

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}

function framePose(vmd, targetFrame) {
  const keys = readVmdBoneKeys(vmd)
  assert.ok(keys && keys.length > 0, "VMD has no bone keys")
  const byJp = new Map()
  for (const k of [...keys].sort((a, b) => a.frame - b.frame)) {
    if (k.frame <= targetFrame) byJp.set(k.jp, k)
  }
  const world = solveFrameWorld(topaz, byJp, "absolute")
  assert.ok(world, "solveFrameWorld failed")
  const at = (jp) => world[topaz.indexByJp.get(jp)]
  return { keys, byJp, world, at }
}

console.log("[1] Topaz 真实物理几何与包络提取")
test("rigids 含真实 shape/size/pos/mode", () => {
  const chestRigid = topaz.rigids.find((r) => r.jp === "上半身2")
  assert.ok(chestRigid && chestRigid.shape === 2 && chestRigid.size && chestRigid.size[0] > 0.5)
})
test("envelopes 含关键部位且往返序列化保留", () => {
  assert.ok(topaz.envelopes && topaz.envelopes["上半身2"] && topaz.envelopes["下半身"])
  assert.ok(topaz.envelopes["上半身2"].min[2] < -1.5, "chest front Z should reach < -1.5")
  const rt = deserializePmxBones(JSON.parse(JSON.stringify(serializePmxBones(topaz))))
  assert.ok(rt && rt.envelopes && rt.envelopes["上半身2"].count === topaz.envelopes["上半身2"].count)
})
test("measureModelGeometry & conditioning 暴露全部 66 个表情与轮廓指标", () => {
  const m = measureModelGeometry(topaz)
  assert.ok(m.chestFrontZ != null && m.chestFrontZ <= -1.8)
  assert.ok(m.hipHalfWidth != null && m.hipHalfWidth > 1.7)
  assert.ok(m.armRestAngleDeg != null && m.armRestAngleDeg >= 30 && m.armRestAngleDeg <= 45)
  const cond = buildModelConditioning(topaz)
  assert.ok(cond.extendedAvailable.includes("upper_body2"))
  assert.ok(cond.extendedAvailable.includes("wrist_twist_r"))
  assert.ok(cond.text.includes("照れ") && cond.text.includes("にやり２") && cond.text.includes("ワ"))
})

console.log("[2] MPL2 解析 IK (reach / aim / plant) + 扩展骨骼精确性")
test("akimbo: 双手精确到达左右髋侧且无自穿模误报", () => {
  const seg = expandLexiconSegment("akimbo", { hold: 1 })
  const { vmd, ikOps } = compileMPL2(compiler, seg.fragment, topaz)
  assert.ok(ikOps >= 3)
  const { at } = framePose(vmd, 15)
  const lWrist = at("左手首")
  const rWrist = at("右手首")
  const hip = at("下半身")
  assert.ok(lWrist.x > hip.x + 1.4 && lWrist.x < hip.x + 2.3, `left wrist x=${lWrist.x} should sit on left hip`)
  assert.ok(rWrist.x < hip.x - 1.4 && rWrist.x > hip.x - 2.3, `right wrist x=${rWrist.x} should sit on right hip`)
  assert.ok(Math.abs(lWrist.y - (hip.y + 0.15)) < 0.35, `left wrist y=${lWrist.y} near waistband/hip`)
  const audit = auditVmd(vmd, topaz)
  assert.equal(audit.violations.length, 0, `unexpected audit violations on akimbo: ${JSON.stringify(audit.violations)}`)
})

test("giggle_mouth_akimbo: 右手捂嘴右肘不翻转上方且手腕在嘴下缘、左手叉腰", () => {
  const mpl = `@pose pose_giggle {
    waist bend forward 10, turn right 8;
    upper_body2 bend forward 15, sway left 5;
    knee_l bend backward 10;
    knee_r bend backward 10;
    plant feet;
    reach hand_r to mouth;
    arm_twist_r turn right 20;
    reach hand_l to hip_l;
    aim head at camera;
    face 笑い 0.7;
    face 照れ 0.5;
}
@animation a {
    0.8: pose_giggle;
}
main {
    a;
}`
  const res = compileMPL2(compiler, mpl, topaz)
  assert.equal(res.legsKeyed, true)
  const { at } = framePose(res.vmd, 24)
  const rShoulder = at("右腕")
  const rElbow = at("右ひじ")
  const rWrist = at("右手首")
  const head = at("頭")
  assert.ok(rElbow.y < rShoulder.y, `right elbow y=${rElbow.y} must stay below shoulder y=${rShoulder.y}`)
  assert.ok(rWrist.y < head.y && rWrist.y > head.y - 0.95, `right wrist y=${rWrist.y} should sit just below mouth/head y=${head.y}`)
})

test("shy_cheek: 躯干前倾+歪头下，双手精确贴到旋转后的左右脸颊", () => {
  const seg = expandLexiconSegment("shy_cheek", { hold: 1 })
  const { vmd, morphCount } = compileMPL2(compiler, seg.fragment, topaz)
  assert.equal(morphCount, 4) // shy_pose ×2 frames × 2 morphs (照れ + なごみ)
  const morphs = parseMorphFrames(vmd)
  assert.ok(morphs.some((m) => m.name === "照れ"))
  const { at } = framePose(vmd, 18)
  const head = at("頭")
  const lWrist = at("左手首")
  const rWrist = at("右手首")
  const distL = Math.hypot(lWrist.x - head.x, lWrist.y - head.y, lWrist.z - head.z)
  const distR = Math.hypot(rWrist.x - head.x, rWrist.y - head.y, rWrist.z - head.z)
  assert.ok(distL > 1.0 && distL < 2.1, `left wrist dist to head=${distL}`)
  assert.ok(distR > 1.0 && distR < 2.1, `right wrist dist to head=${distR}`)
})

test("salute: 敬礼位置准确 + wrist_twist_r 注入 + aim head at camera 生效", () => {
  const mpl = `@pose start {
    waist reset;
    upper_body2 reset;
}
@pose sal {
    waist turn right 30;
    upper_body2 turn right 15;
    reach hand_r to salute_r;
    wrist_twist_r turn left 35;
    aim head at camera;
    face ウィンク 0.8;
}
@animation a {
    0: start;
    0.5: sal;
}
main {
    a;
}`
  const { vmd, ikOps } = compileMPL2(compiler, mpl, topaz)
  assert.ok(ikOps >= 3)
  const { keys, at } = framePose(vmd, 15)
  assert.ok(keys.some((k) => k.jp === "右手捩" && k.frame === 15), "wrist_twist_r key missing")
  assert.ok(keys.some((k) => k.jp === "上半身2" && k.frame === 15), "upper_body2 key missing")
  const rWrist = at("右手首")
  const head = at("頭")
  assert.ok(rWrist.y > head.y + 0.8, `salute wrist y=${rWrist.y} should be near forehead above head=${head.y}`)
  // Even with waist+upper_body2 turned 45° right, head aim at camera keeps 両目 centered in X
  const eyes = at("両目")
  assert.ok(Math.abs(eyes.x - head.x) < 0.35, `eyes should face forward (-Z), eyes.x=${eyes.x}, head.x=${head.x}`)
})

test("heart_chest: 单手抚胸停在胸前包络外侧（z < chestFrontZ）", () => {
  const seg = expandLexiconSegment("heart_chest", { hold: 1 })
  const { vmd } = compileMPL2(compiler, seg.fragment, topaz)
  const { at } = framePose(vmd, 18)
  const rWrist = at("右手首")
  assert.ok(rWrist.z < -1.5, `wrist z=${rWrist.z} should stay cleanly in front of chest`)
})

test("plant feet: 屈膝下蹲后自动将最低足保持在地面基准高度", () => {
  const mpl = `@pose crouch {
    leg_l bend forward 75;
    leg_r bend forward 75;
    knee_l bend backward 115;
    knee_r bend backward 115;
    ankle_l bend forward 40;
    ankle_r bend forward 40;
    plant feet;
}
@animation a {
    0: crouch;
}
main {
    a;
}`
  const { vmd } = compileMPL2(compiler, mpl, topaz)
  const { at } = framePose(vmd, 0)
  const toeY = Math.min(at("左足先EX").y, at("右足先EX").y)
  const ankleY = Math.min(at("左足首D").y, at("右足首D").y)
  const lowestFoot = Math.min(toeY, ankleY)
  assert.ok(lowestFoot >= -0.05 && lowestFoot <= 0.35, `planted foot should touch ground plane, got lowestFoot=${lowestFoot}`)
})

test("plant feet (非对称单膝跪): 选最大补偿保证最低足不穿地", () => {
  const mpl = `@pose half_kneel {
    leg_l bend backward 40;
    knee_l bend backward 125;
    leg_r bend forward 55;
    knee_r bend backward 60;
    plant feet;
}
@animation a {
    0: half_kneel;
}
main {
    a;
}`
  const { vmd } = compileMPL2(compiler, mpl, topaz)
  const { at } = framePose(vmd, 0)
  const lowestFoot = Math.min(at("左足先EX").y, at("右足先EX").y, at("左足首D").y, at("右足首D").y)
  assert.ok(lowestFoot >= 0.15 && lowestFoot <= 0.35, `asymmetric half-kneel lowest foot=${lowestFoot} should sit on ground`)
})

test("新扩充词库全部 19 条均可编译并执行镜像", () => {
  for (const prim of LEXICON) {
    const seg = expandLexiconSegment(prim.name, {}, true)
    assert.ok(seg)
    const { vmd } = compileMPL2(compiler, seg.fragment, topaz)
    assert.ok(vmd.length > 0, `${prim.name} mirrored failed`)
  }
})

test("pose-audit: 新增胸部包络能检出明显胸前穿模", () => {
  const clipMpl = `@pose clip {
    arm_l bend forward 45, sway right 70, turn left 80;
    elbow_l bend forward 125;
}
@animation a {
    0.5: clip;
}
main {
    a;
}`
  const { vmd } = compileMPL2(compiler, clipMpl, topaz)
  const audit = auditVmd(vmd, topaz)
  assert.ok(audit.violations.some((v) => v.target === "chest"), "expected chest clipping violation to be caught")
})

console.log("[3] Phase 1 Harness: 手型预设宏 + 指令校验 + 运动学 Critic")
test("hand_<l|r> 全部 7 种预设宏均可展开并编译", () => {
  for (const preset of ["relax", "cup", "akimbo", "fist", "open", "peace", "point"]) {
    const mpl = `@pose p {\n    hand_r ${preset};\n    hand_l ${preset};\n}\n@animation a {\n    0.5: p;\n}\nmain {\n    a;\n}\n`
    const res = compileMPL2(compiler, mpl, topaz)
    assert.equal(res.handPresets, 2)
    assert.equal(res.directiveErrors.length, 0)
    const keys = readVmdBoneKeys(res.vmd)
    assert.ok(keys.some((k) => k.jp === "右人指１") && keys.some((k) => k.jp === "左小指１"))
  }
})

test("reach 未显式指定手型时自动按锚点推导手指姿态", () => {
  const mpl = `@pose p {\n    reach hand_r to mouth;\n    reach hand_l to hip_l;\n}\n@animation a {\n    0.5: p;\n}\nmain {\n    a;\n}\n`
  const ex = expandHandPresets(mpl)
  assert.equal(ex.expandedHands, 2)
  assert.match(ex.output, /index_r bend forward 20;/) // cup
  assert.match(ex.output, /index_l bend forward 45;/) // akimbo
})

test("非法 reach 锚点 / aim 目标 / hand 预设被 directiveErrors 检出", () => {
  const bad = `@pose p {\n    reach hand_r to pocket;\n    aim head at moon;\n    hand_l claw;\n}\n@animation a {\n    0.5: p;\n}\nmain {\n    a;\n}\n`
  const res = compileMPL2(compiler, bad, topaz)
  assert.equal(res.directiveErrors.length, 3)
})

test("pose-critic: 优质姿态通过，肘部上翻与遮眼错误精准拦截", () => {
  const good = `@pose p {\n    waist bend forward 10;\n    upper_body2 bend forward 15;\n    reach hand_r to mouth;\n    reach hand_l to hip_l;\n    aim head at camera;\n}\n@animation a {\n    0.8: p;\n}\nmain {\n    a;\n}\n`
  const goodVmd = compileMPL2(compiler, good, topaz).vmd
  const goodRep = critiquePoseVmd(topaz, goodVmd, good)
  assert.ok(goodRep && goodRep.passed, `expected pass, got ${goodRep?.summary}`)

  const badBlockingEyes = `@pose p {\n    reach hand_r to mouth + [0, 1.2, 0];\n}\n@animation a {\n    0.8: p;\n}\nmain {\n    a;\n}\n`
  const eyeVmd = compileMPL2(compiler, badBlockingEyes, topaz).vmd
  const eyeRep = critiquePoseVmd(topaz, eyeVmd, badBlockingEyes)
  assert.ok(eyeRep && !eyeRep.passed && eyeRep.issues.some((i) => i.code === "hand_blocking_eyes"))

  const badElbowFlip = `@pose p {\n    arm_r bend backward 85, sway left 20;\n    elbow_r bend forward 110;\n}\n@animation a {\n    0.8: p;\n}\nmain {\n    a;\n}\n`
  const elbowVmd = compileMPL2(compiler, badElbowFlip, topaz).vmd
  const elbowRep = critiquePoseVmd(topaz, elbowVmd, badElbowFlip)
  assert.ok(elbowRep && !elbowRep.passed && elbowRep.issues.some((i) => i.code === "elbow_above_shoulder"))
})

console.log("[4] Phase 2 Harness: 双语 RAG 示例检索 + 停留呼吸 + 安全眨眼")
test("全部 POSE_EXEMPLARS 均零错误编译并通过运动学 Critic", () => {
  assert.ok(POSE_EXEMPLARS.length >= 13)
  for (const ex of POSE_EXEMPLARS) {
    const wrapped = ensureMain(ex.mpl)
    const res = compileMPL2(compiler, wrapped, topaz)
    assert.ok(res.vmd.length > 0, `${ex.id} empty VMD`)
    assert.equal(res.directiveErrors.length, 0, `${ex.id} directiveErrors: ${res.directiveErrors.join(", ")}`)
    const rep = critiquePoseVmd(topaz, res.vmd, wrapped)
    assert.ok(rep && rep.passed, `${ex.id} critic failed: ${rep?.summary}`)
  }
})

test("双语 RAG 检索准确命中对应 Top-1 示例", () => {
  const cases = [
    ["往前倾身子，右手捂嘴偷笑，左手叉腰", "giggle_mouth_akimbo"],
    ["比着剪刀手歪头wink微笑", "peace_wink_lean"],
    ["单膝蹲下并伸手扶住膝盖", "half_kneel_touch"],
    ["look back over shoulder smiling", "look_back_shoulder"],
    ["lying down relaxing on the floor", "lie_back_relaxed"],
  ]
  for (const [q, expectedId] of cases) {
    const hits = retrievePoseExemplars(q, 3)
    assert.equal(hits.length, 3)
    assert.equal(hits[0].id, expectedId, `query="${q}" expected ${expectedId}, got ${hits.map((h) => h.id)}`)
  }
})

test("vmd-enhancer 停留呼吸插值（不破坏 Critic 且默认不改动 morph）", () => {
  const ex = POSE_EXEMPLARS.find((e) => e.id === "akimbo_confident")
  const wrapped = ensureMain(ex.mpl)
  const compiled = compileMPL2(compiler, wrapped, topaz)
  const def = enhanceVmdDetailed(compiled.vmd)
  assert.ok(def.stats.insertedBreathKeys > 0, `expected breath keys > 0, got ${def.stats.insertedBreathKeys}`)
  assert.equal(def.stats.insertedBlinks, 0, "default autoBlink must stay false")
  assert.deepEqual(parseMorphFrames(def.vmd), parseMorphFrames(compiled.vmd))
  const rep = critiquePoseVmd(topaz, def.vmd, wrapped)
  assert.ok(rep && rep.passed, `enhanced breath VMD failed critic: ${rep?.summary}`)
})

test("vmd-enhancer 安全自然眨眼（睁眼微笑插眨眼，笑い/ウィンク闭眼不重复插）", () => {
  const openSmile = ensureMain(POSE_EXEMPLARS.find((e) => e.id === "akimbo_confident").mpl)
  const openVmd = compileMPL2(compiler, openSmile, topaz).vmd
  const openEnh = enhanceVmdDetailed(openVmd, { autoBlink: true })
  assert.ok(openEnh.stats.insertedBlinks >= 1, "open-eye pose should receive natural blink(s)")
  assert.ok(parseMorphFrames(openEnh.vmd)?.some((m) => m.name === "まばたき"))

  const closedSmile = ensureMain(POSE_EXEMPLARS.find((e) => e.id === "giggle_mouth_akimbo").mpl)
  const closedVmd = compileMPL2(compiler, closedSmile, topaz).vmd
  const closedEnh = enhanceVmdDetailed(closedVmd, { autoBlink: true })
  assert.equal(closedEnh.stats.insertedBlinks, 0, "笑い eye-shut pose must not double-blink")
})

const testAsync = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}

console.log("[5] Phase 3 Harness: 多视角包络渲染 + VLM 视觉 Critic 解析与回退")
test("pose-renderer: 峰值帧选取与三视图带包络 PNG 编码有效", () => {
  const ex = POSE_EXEMPLARS.find((e) => e.id === "giggle_mouth_akimbo")
  const vmd = compileMPL2(compiler, ensureMain(ex.mpl), topaz).vmd
  const peak = pickPeakPoseFrame(vmd, topaz)
  assert.ok(peak > 0, `expected peak frame > 0, got ${peak}`)
  const rendered = renderPoseMultiViewPng(topaz, vmd, peak)
  assert.ok(rendered && rendered.width === 840 && rendered.height === 360)
  // Valid PNG signature 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual([...rendered.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(rendered.dataUrl.startsWith("data:image/png;base64,"))
  const morphSummary = summarizeActiveMorphsAtFrame(vmd, peak)
  assert.match(morphSummary, /笑い=0\.80/)
})

test("visual-critic JSON 解析器（标准 JSON / 代码块包裹 / 阈值判定 / 异常输入）", () => {
  const ok = parseVisualCriticJson('```json\n{"pass":true,"score":8,"issues":[],"fixInstructions":""}\n```')
  assert.ok(ok && ok.pass === true && ok.score === 8)
  const low = parseVisualCriticJson('{"pass":true,"score":5,"issues":["hand too low"],"fixInstructions":"raise hand_r"}')
  assert.ok(low && low.pass === false && low.score === 5)
  assert.equal(parseVisualCriticJson("not json at all"), null)
})

await testAsync("visual-critic 端到端 mock: passed / needs_fix / 不支持图像时优雅降级 skipped", async () => {
  const ex = POSE_EXEMPLARS.find((e) => e.id === "giggle_mouth_akimbo")
  const wrapped = ensureMain(ex.mpl)
  const vmd = compileMPL2(compiler, wrapped, topaz).vmd
  const rendered = renderPoseMultiViewPng(topaz, vmd)

  const makeMockClient = (replyOrErr) => ({
    chat: {
      completions: {
        create: async (req) => {
          const userMsg = req.messages.find((m) => m.role === "user")
          assert.ok(Array.isArray(userMsg.content) && userMsg.content.some((p) => p.type === "image_url"))
          if (replyOrErr instanceof Error) throw replyOrErr
          return { choices: [{ message: { content: replyOrErr } }] }
        },
      },
    },
  })

  const vPass = await runVisualCritic({
    client: makeMockClient('{"pass":true,"score":9,"issues":[],"fixInstructions":""}'),
    model: "mock-vlm",
    userDescription: "右手捂嘴偷笑",
    mplScript: wrapped,
    vmd,
    rendered,
  })
  assert.equal(vPass.status, "passed")
  assert.equal(vPass.score, 9)

  const vFix = await runVisualCritic({
    client: makeMockClient('{"pass":false,"score":5,"issues":["right hand covers eyes"],"fixInstructions":"lower hand_r"}'),
    model: "mock-vlm",
    userDescription: "右手捂嘴偷笑",
    mplScript: wrapped,
    vmd,
    rendered,
  })
  assert.equal(vFix.status, "needs_fix")
  assert.equal(vFix.pass, false)
  assert.match(vFix.fixInstructions, /lower hand_r/)

  const vSkip = await runVisualCritic({
    client: makeMockClient(new Error("400 image_url is not supported by this model")),
    model: "text-only-llm",
    userDescription: "右手捂嘴偷笑",
    mplScript: wrapped,
    vmd,
    rendered,
  })
  assert.equal(vSkip.status, "skipped")
  assert.equal(vSkip.pass, true)
})

test("peace_r 无穿模 + aim head at camera 保留歪头侧倾 + body_clipping 精准拦截", () => {
  const cleanPeace = `@pose ready {
    waist reset;
    head reset;
}
@pose peace_tilt {
    waist sway left 5, turn right 8;
    upper_body2 bend backward 4, turn right 6;
    head sway right 12, bend forward 3;
    reach hand_r to peace_r;
    reach hand_l to hip_l;
    aim head at camera;
    face ウィンク 1.0;
}
@animation a {
    0: ready;
    0.6: peace_tilt;
}
main {
    a;
}`
  const res = compileMPL2(compiler, cleanPeace, topaz)
  assert.equal(res.directiveErrors.length, 0)
  const audit = auditVmd(res.vmd, topaz)
  assert.equal(audit.violations.length, 0, `expected 0 audit violations on peace_r, got ${audit.violations.length}`)
  const critic = critiquePoseVmd(topaz, res.vmd, cleanPeace)
  assert.ok(critic && critic.passed, `expected pass, got ${critic?.summary}`)
  // Head must preserve roll from `head sway right 12` (left-eye Y differs from right-eye Y / head quat Z != 0)
  const headKey = readVmdBoneKeys(res.vmd).filter((k) => k.jp === "頭").pop()
  assert.ok(headKey && Math.abs(headKey.quat[2]) > 0.05, `expected preserved head roll, got quat=${headKey?.quat}`)

  const badClip = `@pose ready {
    head reset;
}
@pose bad_peace {
    reach hand_r to cheek_r + [0.85, 0.05, 0.85];
    hand_r peace;
    wrist_twist_r turn left 25;
}
@animation a {
    0: ready;
    0.6: bad_peace;
}
main {
    a;
}`
  const badVmd = compileMPL2(compiler, badClip, topaz).vmd
  const badRep = critiquePoseVmd(topaz, badVmd, badClip)
  assert.ok(badRep && !badRep.passed && badRep.issues.some((i) => i.code === "body_clipping"))
})

test("peace / open 手型张开方向正确（食指与中指呈 V 字展开，不交叉）", () => {
  const mpl = `@pose p {\n    hand_r peace;\n    hand_l peace;\n}\n@animation a {\n    0: p;\n    0.5: p;\n}\nmain {\n    a;\n}`
  const { vmd } = compileMPL2(compiler, mpl, topaz)
  const { at } = framePose(vmd, 15)
  for (const side of ["左", "右"]) {
    const i1 = at(`${side}人指１`), i3 = at(`${side}人指３`)
    const m1 = at(`${side}中指１`), m3 = at(`${side}中指３`)
    const baseDist = Math.hypot(i1.x - m1.x, i1.y - m1.y, i1.z - m1.z)
    const tipDist = Math.hypot(i3.x - m3.x, i3.y - m3.y, i3.z - m3.z)
    assert.ok(i3.z < m3.z, `${side} peace index z=${i3.z} should stay on thumb side (< middle z=${m3.z})`)
    assert.ok(tipDist > baseDist, `${side} peace tips (${tipDist.toFixed(3)}) must spread wider than base (${baseDist.toFixed(3)})`)
  }
})

console.log("[6] Phase L1: 30s 剧情无缝拼装 + 表情自动退场 + 新增剧情原语")
test("新增 4 条剧情原语 (talk_explain/step_closer/weight_shift/goodbye_wave) 通过 Critic", () => {
  for (const name of ["talk_explain", "step_closer", "weight_shift", "goodbye_wave"]) {
    const seg = expandLexiconSegment(name, {})
    assert.ok(seg, `${name} missing`)
    const wrapped = ensureMain(seg.fragment)
    const res = compileMPL2(compiler, wrapped, topaz)
    assert.ok(res.vmd.length > 0 && res.directiveErrors.length === 0)
    const rep = critiquePoseVmd(topaz, res.vmd, wrapped)
    assert.ok(rep && rep.passed, `${name} critic failed: ${rep?.summary}`)
  }
})

test("seamless 缝合：剥除后续段 reset 立正帧、自适应过渡窗、下肢归零防残影、表情淡出归 0", () => {
  const segSit = expandLexiconSegment("sit", { deep: 0 })
  const segShy = expandLexiconSegment("shy_cheek", { hold: 1 })
  const segTalk = expandLexiconSegment("talk_explain", { cycles: 1 })
  const stitched = stitchSegments(
    [
      { fragment: segSit.fragment, duration: segSit.duration },
      { fragment: segTalk.fragment, duration: 5.0 },
      { fragment: segShy.fragment, duration: segShy.duration },
    ],
    { seamless: true }
  )
  // 后续段纯 reset 占位帧 s1_talk_ready / s2_shy_ready 不应再出现
  assert.ok(!stitched.script.includes("s1_talk_ready"), "pure-reset entry pose s1_talk_ready should be skipped")
  assert.ok(!stitched.script.includes("s2_shy_ready"), "pure-reset entry pose s2_shy_ready should be skipped")
  // sit -> talk 含下肢变化，自适应 gap = 0.75s
  assert.equal(Number((stitched.timeline[1].start - stitched.timeline[0].end).toFixed(2)), 0.75)
  // s1_entry_sync 应把上一段 sit 留下的 leg_l/knee_l 自动复位，s2_entry_sync 应把 talk 的 arm/morph 淡出
  assert.match(stitched.script, /s1_entry_sync[\s\S]*knee_l reset;[\s\S]*leg_l reset;/)
  assert.match(stitched.script, /s2_entry_sync[\s\S]*face にこり 0;/)
  const compiled = compileMPL2(compiler, stitched.script, topaz)
  assert.equal(compiled.collisions.length, 0, `unexpected collisions: ${JSON.stringify(compiled.collisions)}`)
  assert.ok(compiled.vmd.length > 0 && compiled.directiveErrors.length === 0)
  // talk_explain 切入帧处，双腿应回到站立膝直状态，不残余 sit 弯曲
  const { at } = framePose(compiled.vmd, Math.round(stitched.timeline[1].start * 30))
  const pelvis = at("下半身"), ankleL = at("左足首D")
  assert.ok(pelvis.y - ankleL.y > 7.5, `character should stand back up on talk_explain, pelvis-ankle=${pelvis.y - ankleL.y}`)
})

test("端到端 ~30s 剧情连招（含走近、对话、害羞、换重心、叉腰、鞠躬、告别）0 碰撞且通过增强前后 Critic", () => {
  const story = [
    { name: "wave_hand", duration: 2.8 },
    { name: "step_closer", params: { steps: 2 }, duration: 2.6 },
    { name: "talk_explain", duration: 6.8 },
    { name: "shy_cheek", duration: 2.6 },
    { name: "weight_shift", duration: 4.5 },
    { name: "akimbo", duration: 2.8 },
    { name: "heart_chest", duration: 2.4 },
    { name: "bow", params: { depth: 40 }, duration: 2.0 },
    { name: "goodbye_wave", duration: 3.5 },
  ]
  const stitched = stitchSegments(
    story.map((s) => {
      const seg = expandLexiconSegment(s.name, s.params, false, s.duration)
      return { fragment: seg.fragment, duration: s.duration }
    }),
    { seamless: true }
  )
  assert.ok(stitched.totalDuration >= 28 && stitched.totalDuration <= 36, `expected ~30s, got ${stitched.totalDuration}s`)
  const compiled = compileMPL2(compiler, stitched.script, topaz)
  assert.equal(compiled.collisions.length, 0, `collisions=${JSON.stringify(compiled.collisions)}`)
  assert.equal(compiled.directiveErrors.length, 0)
  const crit1 = critiquePoseVmd(topaz, compiled.vmd, stitched.script, stitched.timeline)
  assert.ok(crit1 && crit1.passed, `pre-enhance 30s story failed: ${crit1?.summary}`)
  const enh = enhanceVmdDetailed(compiled.vmd, { autoBlink: true })
  assert.ok(enh.stats.insertedBreathKeys > 0 && enh.stats.insertedBlinks >= 3)
  const crit2 = critiquePoseVmd(topaz, enh.vmd, stitched.script, stitched.timeline)
  assert.ok(crit2 && crit2.passed, `post-enhance 30s story failed: ${crit2?.summary}`)
  console.log(`    → 30s 剧情联编: ${stitched.totalDuration}s, VMD=${enh.vmd.length}B, 呼吸帧+${enh.stats.insertedBreathKeys}, 眨眼+${enh.stats.insertedBlinks}`)
})

console.log("[7] Phase L2: 分时段动态 Leg IK + 段落末尾状态摘要")
test("computeIkSchedule 在混合动作 (站姿→走近→站姿对话) 按时段动态开关足 IK", () => {
  const segs = [
    expandLexiconSegment("wave_hand", { cycles: 1 }),
    expandLexiconSegment("step_closer", { steps: 2 }),
    expandLexiconSegment("talk_explain", { cycles: 1 }),
  ]
  const stitched = stitchSegments(
    segs.map((s) => ({ fragment: s.fragment, duration: s.duration })),
    { seamless: true }
  )
  const vmd = compileMPL2(compiler, stitched.script, topaz).vmd
  const enh = enhanceVmdDetailed(vmd, { autoBlink: true })
  assert.equal(enh.stats.legIkReenabled, true)
  const sched = computeIkSchedule(enh.vmd)
  // 至少包含: 站姿(disableIK=false) -> 走步(disableIK=true) -> 恢复站姿(disableIK=false)
  assert.ok(sched.length >= 3, `expected >=3 IK schedule windows, got ${JSON.stringify(sched)}`)
  assert.equal(sched[0].disableIK, false)
  assert.ok(sched.some((w) => w.disableIK === true))
  assert.equal(sched[sched.length - 1].disableIK, false)

  const fakeEngine = { disableIK: true, disablePhysics: true }
  applyIkScheduleAtTime(fakeEngine, sched, 0.2)
  assert.equal(fakeEngine.disableIK, false)
  const walkWin = sched.find((w) => w.disableIK)
  applyIkScheduleAtTime(fakeEngine, sched, (walkWin.startSec + walkWin.endSec) * 0.5)
  assert.equal(fakeEngine.disableIK, true)
  applyIkScheduleAtTime(fakeEngine, sched, stitched.totalDuration - 0.2)
  assert.equal(fakeEngine.disableIK, false)
})

test("summarizeFragmentExit 正确提取末帧姿态/手位/表情摘要", () => {
  const step = expandLexiconSegment("step_closer", { steps: 2 })
  const talk = expandLexiconSegment("talk_explain", { cycles: 1 })
  const sStep = summarizeFragmentExit(step.fragment)
  const sTalk = summarizeFragmentExit(talk.fragment)
  assert.match(sStep, /stance=standing/)
  assert.match(sTalk, /hands=\[hand_r->front_r.*hand_l->hip_l\]/)
  assert.match(sTalk, /にこり/)
})

console.log("[8] Phase L3: 多帧分镜 Storyboard + 分镜 VLM 段落归因 + SSE 增量解析")
await testAsync("renderStoryboardPng 覆盖起承转合并优先纳入 custom 段，runVisualCritic 解析 targetSegmentIndex", async () => {
  const story = [
    { name: "wave_hand", params: { cycles: 2 }, duration: 2.5, source: "lexicon" },
    { name: "step_closer", params: { steps: 2 }, duration: 2.0, source: "lexicon" },
    { name: "talk_explain", params: { cycles: 2 }, duration: 4.5, source: "llm" },
    { name: "shy_cheek", params: { hold: 1.5 }, duration: 2.5, source: "lexicon" },
    { name: "weight_shift", params: { cycles: 2 }, duration: 4.0, source: "lexicon" },
    { name: "akimbo", params: { hold: 1.5 }, duration: 2.5, source: "llm" },
    { name: "bow", params: { depth: 35 }, duration: 2.0, source: "lexicon" },
    { name: "goodbye_wave", params: { cycles: 2 }, duration: 3.0, source: "lexicon" },
  ]
  const stitched = stitchSegments(
    story.map((s) => {
      const seg = expandLexiconSegment(s.name, s.params)
      return { fragment: seg.fragment, duration: s.duration }
    }),
    { seamless: true }
  )
  const vmd = compileMPL2(compiler, stitched.script, topaz).vmd
  const timelineMeta = stitched.timeline.map((t, i) => ({
    index: t.index,
    start: t.start,
    end: t.end,
    action: story[i].name,
    source: story[i].source,
  }))
  const samples = pickStoryboardSamples(vmd, topaz, timelineMeta, 6)
  assert.equal(samples.length, 6)
  assert.equal(samples[0].segmentIndex, 0)
  assert.equal(samples[samples.length - 1].segmentIndex, 7)
  assert.ok(samples.some((s) => s.segmentIndex === 2), "custom segment #2 must be included in storyboard")
  assert.ok(samples.some((s) => s.segmentIndex === 5), "custom segment #5 must be included in storyboard")

  const sb = renderStoryboardPng(topaz, vmd, timelineMeta, { maxTiles: 6 })
  assert.ok(sb, "storyboard PNG should render")
  assert.deepEqual([...sb.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(sb.width, 880)
  assert.equal(sb.tiles.length, 6)

  const parsedTarget = parseVisualCriticJson(
    '{"pass":false,"score":5,"targetSegmentIndex":2,"issues":["hand clips torso"],"fixInstructions":"reach hand_r to front_r;"}'
  )
  assert.ok(parsedTarget && parsedTarget.targetSegmentIndex === 2 && parsedTarget.pass === false)

  let capturedPrompt = ""
  const mockVlm = {
    chat: {
      completions: {
        create: async (req) => {
          const userMsg = req.messages.find((m) => m.role === "user")
          capturedPrompt = userMsg.content.find((c) => c.type === "text")?.text ?? ""
          return {
            choices: [
              {
                message: {
                  content: '{"pass":false,"score":6,"targetSegmentIndex":5,"issues":["pose stiff"],"fixInstructions":"waist turn right 12;"}',
                },
              },
            ],
          }
        },
      },
    },
  }
  const verdict = await runVisualCritic({
    client: mockVlm,
    model: "mock-vlm",
    userDescription: "30s greeting story",
    mplScript: stitched.script,
    vmd,
    storyboard: sb,
  })
  assert.equal(verdict.mode, "storyboard")
  assert.equal(verdict.tileCount, 6)
  assert.equal(verdict.status, "needs_fix")
  assert.equal(verdict.targetSegmentIndex, 5)
  assert.match(capturedPrompt, /Storyboard tiles \(6 sampled/)
  assert.match(capturedPrompt, /segment=#2/)
})

test("SSE encodeSseEvent / parseSseBuffer 支持跨分片拆包解析", () => {
  const ev1 = { type: "stage", stage: "planning", message: "正在编排" }
  const ev2 = { type: "segment_done", index: 1, total: 3, customCompleted: 1, customTotal: 2, action: "curtsy", source: "llm", duration: 3 }
  const ev3 = { type: "complete", payload: { mpl: "main { a; }", totalDuration: 3 } }
  const wire = encodeSseEvent(ev1) + encodeSseEvent(ev2) + encodeSseEvent(ev3)
  const splitAt = Math.floor(wire.length * 0.45)
  const p1 = parseSseBuffer(wire.slice(0, splitAt))
  const p2 = parseSseBuffer(p1.rest + wire.slice(splitAt))
  assert.equal(p2.rest, "")
  const all = [...p1.events, ...p2.events]
  assert.equal(all.length, 3)
  assert.deepEqual(all, [ev1, ev2, ev3])
})

console.log("[9] 长动作稳定性回归: 帧对齐 + 段内表情互斥 + shoe_l/r 锚点 + 词库节奏/防僵直")
test("WASM 与 MPL2 在 .x5s 时间戳帧号精确对齐，深蹲 plant feet 不再误报 ground_penetration", () => {
  const squatMpl = `@pose ready {
    waist reset;
}
@pose tie_shoe {
    plant feet;
    center move down 4;
    leg_l bend forward 55;
    leg_r bend forward 55;
    knee_l bend backward 120;
    knee_r bend backward 120;
    waist bend forward 15;
    upper_body bend forward 25;
    reach hand_l to shoe_l;
    reach hand_r to shoe_l;
    face 真面目 0.5;
}
@animation a {
    0: ready;
    12.15: tie_shoe;
    13.55: tie_shoe;
}
main {
    a;
}`
  const compiled = compileMPL2(compiler, squatMpl, topaz)
  assert.equal(compiled.directiveErrors.length, 0)
  const keys = readVmdBoneKeys(compiled.vmd)
  const frames = [...new Set(keys.map((k) => k.frame))].sort((a, b) => a - b)
  // 12.15*30=364.5 -> 364, 13.55*30=406.5 -> 406；不再出现 365 / 407 错位分裂帧
  assert.deepEqual(frames, [0, 364, 406], `expected aligned frames [0, 364, 406], got ${JSON.stringify(frames)}`)
  const crit = critiquePoseVmd(topaz, compiled.vmd, squatMpl)
  assert.ok(crit && crit.passed, `expected aligned squat to pass critic, got: ${crit?.summary}`)
})

test("seamless 缝合自动对段内多拍表情做互斥归零，且尾帧僵直保持有上限", () => {
  const multiBeat = `@pose b0 {
    head reset;
    face にこり 0.6;
}
@pose b1 {
    head bend forward 15;
    face 真面目 0.5;
}
@pose b2 {
    head reset;
    face ｷﾘｯ 0.7;
}
@animation seg {
    0: b0;
    1.5: b1;
    3.0: b2;
}`
  const stitched = stitchSegments([{ fragment: multiBeat, duration: 9.0 }], { seamless: true })
  // 段内切换自动生成 morph_sync 归零旧表情
  assert.match(stitched.script, /s0_f1_morph_sync/)
  assert.match(stitched.script, /s0_f2_morph_sync/)
  // 尾帧保持受 1.5s 上限约束，不会从 3.0s 僵直到 9.0s
  assert.ok(stitched.totalDuration <= 4.6, `expected capped hold <=4.6s, got ${stitched.totalDuration}s`)

  const { vmd } = compileMPL2(compiler, stitched.script, topaz)
  const morphs = parseMorphFrames(vmd)
  const activeAt = (f) => {
    const m = new Map()
    for (const k of morphs.filter((x) => x.frame <= f).sort((a, b) => a.frame - b.frame)) m.set(k.name, k.weight)
    return [...m.entries()].filter(([, w]) => w > 0.01).map(([k]) => k)
  }
  assert.deepEqual(activeAt(0), ["にこり"])
  assert.deepEqual(activeAt(45), ["真面目"])
  assert.deepEqual(activeAt(90), ["ｷﾘｯ"])
})

test("crouch_tie_shoes 双手到达 shoe_l 零 audit 误报破坏，pose-critic 精准拦截悬空脚 (floating_foot)", () => {
  const tieEx = POSE_EXEMPLARS.find((e) => e.id === "crouch_tie_shoes")
  assert.ok(tieEx, "missing crouch_tie_shoes exemplar")
  const compiled = compileMPL2(compiler, ensureMain(tieEx.mpl), topaz)
  assert.equal(compiled.directiveErrors.length, 0)
  const audit = auditVmd(compiled.vmd, topaz)
  assert.equal(audit.violations.length, 0, `expected 0 audit violations on crouch_tie_shoes, got ${JSON.stringify(audit.violations)}`)

  const badFloating = `@pose ready {
    center reset;
}
@pose bad_squat {
    center move down 4;
    leg_r bend forward 55;
    knee_r bend backward 140;
    leg_l bend forward 35;
    knee_l bend backward 80;
    plant feet;
}
@animation a {
    0: ready;
    1.0: bad_squat;
}
main {
    a;
}`
  const badVmd = compileMPL2(compiler, badFloating, topaz).vmd
  const badCrit = critiquePoseVmd(topaz, badVmd, badFloating)
  assert.ok(badCrit && !badCrit.passed && badCrit.issues.some((i) => i.code === "floating_foot"), `expected floating_foot error, got ${badCrit?.summary}`)
})

test("bow 站起复位颈头 + wave_hand/akimbo 按目标时长自适应防定格", () => {
  const bowSeg = expandLexiconSegment("bow", { depth: 50 })
  assert.match(bowSeg.fragment, /@pose upright[\s\S]*neck reset;[\s\S]*head reset;/)
  const longWave = expandLexiconSegment("wave_hand", undefined, false, 4.0)
  assert.ok(longWave.duration >= 3.2, `expected wave_hand to scale cycles for 4s target, got ${longWave.duration}s`)
  const longAkimbo = expandLexiconSegment("akimbo", undefined, false, 4.5)
  assert.match(longAkimbo.fragment, /akimbo_shift/, "long akimbo should include subtle weight shift beat")
})

console.log(`\n${passed} tests passed${process.exitCode ? " (WITH FAILURES)" : ""}`)
