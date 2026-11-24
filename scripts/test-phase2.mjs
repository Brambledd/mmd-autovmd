#!/usr/bin/env node
// test-phase2.mjs — Phase 2 语言层验证：main 组合偏移 / face 表情通道 / 碰撞检测 / 全链路
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { compileMPL2, composeMain, extractFace, findBoneCollisions, collectMorphKeys } from "../src/lib/mpl2.ts"
import { injectMorphFrames, parseMorphFrames, secondsToFrame } from "../src/lib/vmd-morph.ts"
import { enhanceVmd } from "../src/lib/vmd-enhancer.ts"
import { expandLexiconSegment } from "../src/lib/motion-lexicon.ts"
import { stitchSegments } from "../src/lib/long-motion.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}

// VMD 骨骼帧号读取（最小解析：header 50B + boneCount + entries）
function readBoneFrames(vmd) {
  const dv = new DataView(vmd.buffer, vmd.byteOffset, vmd.byteLength)
  const boneCount = dv.getUint32(50, true)
  let o = 54
  const frames = []
  for (let i = 0; i < boneCount; i++) {
    const nameBytes = vmd.subarray(o, o + 15)
    let end = 15
    for (let k = 0; k < 15; k++) if (nameBytes[k] === 0) { end = k; break }
    const jp = new TextDecoder("shift_jis").decode(nameBytes.subarray(0, end))
    frames.push({ jp, frame: dv.getUint32(o + 15, true) })
    o += 111
  }
  return frames
}

// ---------------------------------------------------------------- 1. main 组合
console.log("[1] main 组合语义（Phase 1 实测碰撞缺陷的修复验证）")
const collisionScript = `@pose arm_up {
    arm_l bend backward 90;
}

@pose arm_down {
    arm_l reset;
}

@animation seg_a {
    0: arm_up;
    1: arm_up;
}

@animation seg_b {
    0: arm_down;
    1: arm_down;
}

main {
    seg_a;
    seg_b offset 2;
}
`
test("offset 组合：seg_b 帧号 ≥ 60（2s×30fps）", () => {
  const { vmd, composed } = compileMPL2(compiler, collisionScript)
  assert.ok(composed, "should trigger composition")
  const frames = readBoneFrames(vmd)
  const segB = frames.filter((f) => f.frame >= 60)
  assert.ok(segB.some((f) => f.jp === "左腕"), "seg_b arm_l frames should exist at ≥2s")
  assert.ok(segB.length >= 2)
})
test("offset 组合：无同刻矛盾姿势合并（反编译不再出现 90, reset）", () => {
  const { vmd } = compileMPL2(compiler, collisionScript)
  const reversed = compiler.reverse_compile("vmd", vmd)
  assert.ok(!reversed.includes("90, reset"), "contradictory merged statement still present")
})
test("无偏移单引用 main 走 passthrough", () => {
  const r = composeMain(`@pose a {\n    head reset;\n}\n@animation x {\n    0: a;\n}\nmain {\n    x;\n}\n`)
  assert.equal(r.composed, false)
  assert.equal(r.output.includes("@animation x"), true)
})
test("姿势引用 @ 时刻 → 对应帧号单帧", () => {
  const script = `@pose sit_p {
    knee_l bend backward 90;
}

main {
    sit_p @ 1.0;
}
`
  const { vmd, composed } = compileMPL2(compiler, script)
  assert.ok(composed)
  const frames = readBoneFrames(vmd)
  assert.ok(frames.every((f) => f.frame === 30), `all frames at 1.0s (frame 30), got ${JSON.stringify(frames)}`)
})
test("旧碰撞脚本（无 offset）仍被静态检出", () => {
  const noOffset = collisionScript.replace("seg_b offset 2;", "seg_b;")
  const { collisions } = compileMPL2(compiler, noOffset)
  assert.ok(collisions.some((c) => c.bone === "arm_l" && c.time === 0), JSON.stringify(collisions))
})
test("offset 后碰撞清空", () => {
  const { collisions } = compileMPL2(compiler, collisionScript)
  assert.deepEqual(collisions, [])
})

// ---------------------------------------------------------------- 2. face 通道
console.log("[2] face 表情通道")
const faceScript = `@pose smile_big {
    face にこり 0.8;
    head bend backward 10;
}

@pose serious {
    face 真面目 0.6;
    waist bend forward 45;
}

@animation anim {
    0: smile_big;
    1.5: serious;
    3: smile_big;
}

main {
    anim;
}
`
test("wasm 直接编译 face 语句必须失败（证明 strip 必要）", () => {
  assert.throws(() => compiler.compile(faceScript))
})
test("compileMPL2 剥离 face 后编译成功且注入 morph", () => {
  const { vmd, morphCount } = compileMPL2(compiler, faceScript)
  // smile_big@0s + serious@1.5s + smile_big@3s = 3 条
  assert.equal(morphCount, 3)
  const morphs = parseMorphFrames(vmd)
  assert.ok(morphs && morphs.length === 3)
  assert.deepEqual(morphs.map((m) => m.frame), [0, 45, 90])
  assert.deepEqual(morphs.map((m) => m.name), ["にこり", "真面目", "にこり"])
  assert.ok(Math.abs(morphs[0].weight - 0.8) < 1e-6)
})
test("injectMorphFrames 语义：整体替换 morph chunk（幂等，compileMPL2 传完整键集）", () => {
  const { vmd } = compileMPL2(compiler, faceScript)
  const again = parseMorphFrames(injectMorphFrames(vmd, [{ name: "あ", frame: 10, weight: 0.5 }]))
  // 旧 3 条被替换为新的 1 条 —— 替换语义防止二次注入导致的重复关键帧
  assert.equal(again.length, 1)
  assert.deepEqual(again[0], { name: "あ", frame: 10, weight: 0.5 })
})
test("同名同帧后者覆盖 + 帧号排序", () => {
  const vmd = injectMorphFrames(new Uint8Array(0), [])
  assert.equal(vmd.length, 0) // 空 keys 原样返回
  const fake = injectMorphFrames(readOnlyHeader(), [
    { name: "にこり", frame: 5, weight: 0.2 },
    { name: "にこり", frame: 5, weight: 0.9 },
    { name: "あ", frame: 3, weight: 1 },
  ])
  const morphs = parseMorphFrames(fake)
  assert.deepEqual(morphs.map((m) => m.frame), [3, 5])
  // f32 存储精度
  assert.ok(Math.abs(morphs.find((m) => m.frame === 5).weight - 0.9) < 1e-6)
})
function readOnlyHeader() {
  // 构造最小合法 VMD：header+name+0 bones+morph chunk 0+空尾块
  const buf = new Uint8Array(50 + 4 + 4 + 4 + 4)
  const dv = new DataView(buf.buffer)
  const magic = new TextEncoder().encode("Vocaloid Motion Data 0002")
  buf.set(magic, 0)
  dv.setUint32(50, 0, true)   // boneCount=0
  dv.setUint32(54, 0, true)   // morphCount=0
  dv.setUint32(58, 0, true)   // cameraCount=0
  dv.setUint32(62, 0, true)   // lightCount=0
  return buf
}

// ---------------------------------------------------------------- 3. 全链路
console.log("[3] Phase 1 + Phase 2 全链路（词库 face → 缝合 → mpl2 → enhancer 保留 morph）")
test("词库 wave_hand 模板含 face 行且编译后注入 morph", () => {
  const seg = expandLexiconSegment("wave_hand", { cycles: 2, face: 0.7 })
  assert.match(seg.fragment, /face にこり 0.7;/)
  // 无 main 的片段 wasm 产出 0 字节（Phase 1 已知行为），补 main 走完整管道
  const animName = seg.fragment.match(/@animation\s+(\w+)/)[1]
  const { vmd, morphCount } = compileMPL2(compiler, `${seg.fragment}\nmain {\n    ${animName};\n}\n`)
  // wave_ready×2 + wave_l×2 + wave_r×2 = 6 次姿势引用，每次 1 条 にこり
  assert.equal(morphCount, 6)
  assert.ok(vmd.length > 0)
  const morphs = parseMorphFrames(vmd)
  assert.ok(morphs && morphs.every((m) => m.name === "にこり"))
  assert.equal(morphs.length, 6)
})
test("镜像不动 face 行", () => {
  const seg = expandLexiconSegment("wave_hand", { cycles: 1 }, true)
  assert.match(seg.fragment, /face にこり 0.8;/)
})
test("缝合 + mpl2 + enhanceVmd：morph chunk 端到端保留", () => {
  const segs = [
    expandLexiconSegment("wave_hand", { cycles: 1, face: 1 }),
    expandLexiconSegment("bow", { depth: 45 }),
    expandLexiconSegment("sit"),
    expandLexiconSegment("stand_up"),
  ]
  const stitched = stitchSegments(segs.map((s) => ({ fragment: s.fragment, duration: s.duration })))
  const { vmd, morphCount, collisions } = compileMPL2(compiler, stitched.script)
  assert.equal(collisions.length, 0)
  // wave_hand(1cycle): ready@0,l@0.3,r@0.6,ready@0.8 → 4 keys; bow_deep@0.8(+GAP 起点) → 1 key
  assert.equal(morphCount, 5)
  const enhanced = enhanceVmd(vmd)
  const before = parseMorphFrames(vmd)
  const after = parseMorphFrames(enhanced)
  assert.deepEqual(after, before, "enhanceVmd must preserve injected morph chunk verbatim")
  console.log(`    → 总时长 ${stitched.totalDuration}s, morph ${morphCount} 帧, VMD ${enhanced.length} bytes`)
})
test("无新语法的标准 MPL 输出与 wasm 直编字节一致", () => {
  const std = `@pose a {\n    head reset;\n}\n@animation x {\n    0: a;\n    1: a;\n}\nmain {\n    x;\n}\n`
  const { vmd } = compileMPL2(compiler, std)
  const direct = compiler.compile(std)
  assert.equal(Buffer.from(vmd).compare(Buffer.from(direct)), 0)
})
test("baseRotated 标志：base 旋转=true，普通手势/reset=false", () => {
  const crab = `@pose c {\n    base bend backward 90;\n    head bend forward 10;\n}\n@animation x {\n    0: c;\n}\nmain {\n    x;\n}\n`
  assert.equal(compileMPL2(compiler, crab).baseRotated, true)
  const wave = `@pose w {\n    shoulder_r bend backward 30;\n    head reset;\n}\n@animation x {\n    0: w;\n}\nmain {\n    x;\n}\n`
  assert.equal(compileMPL2(compiler, wave).baseRotated, false)
  const resetOnly = `@pose r {\n    base reset;\n}\n@animation x {\n    0: r;\n}\nmain {\n    x;\n}\n`
  assert.equal(compileMPL2(compiler, resetOnly).baseRotated, false)
})

// ---------------------------------------------------------------- 4. 单元
console.log("[4] 单元")
test("secondsToFrame", () => {
  assert.equal(secondsToFrame(0), 0)
  assert.equal(secondsToFrame(1.5), 45)
  assert.equal(secondsToFrame(12.15), 364)
})
test("collectMorphKeys 复合引用 a & b 取并集", () => {
  const src = `@animation composed {\n    1: p1 & p2;\n}`
  const faces = new Map([
    ["p1", [{ name: "にこり", weight: 0.8 }]],
    ["p2", [{ name: "あ", weight: 0.5 }]],
  ])
  const keys = collectMorphKeys(src, faces)
  assert.deepEqual(keys.map((k) => k.frame), [30, 30])
  assert.deepEqual(keys.map((k) => k.name), ["にこり", "あ"])
})
test("畸形 face 行被剥离且计数", () => {
  const r = extractFace(`@pose a {\n    face nodata;\n    head reset;\n}`)
  assert.equal(r.malformed, 1)
  assert.ok(!r.output.includes("face"))
})

console.log(`\n${passed} tests passed${process.exitCode ? " (WITH FAILURES)" : ""}`)
