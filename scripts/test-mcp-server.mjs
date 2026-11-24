import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readVmdBoneKeys } from "../src/lib/fk.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

// 统计通过的检查数（每条 "  ok  ..." 输出算一项），结尾的汇总以实际计数为准
let okCount = 0
const rawLog = console.log
console.log = (...a) => {
  if (String(a[0]).trimStart().startsWith("ok ")) okCount++
  rawLog(...a)
}

const child = spawn(process.execPath, [path.join(root, "src/mcp/popo-mcp-server.ts")], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
})

let stdoutBuf = ""
const pending = new Map()
let nextId = 1

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8")
  let idx
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim()
    stdoutBuf = stdoutBuf.slice(idx + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const resolver = pending.get(msg.id)
    if (resolver) {
      pending.delete(msg.id)
      resolver(msg)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC timeout for ${method}`))
    }, 15000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

try {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} })
  assert.equal(init.serverInfo.name, "popo-mmd")
  console.log("  ok  initialize")

  const listed = await rpc("tools/list", {})
  const names = listed.tools.map((t) => t.name)
  assert.deepEqual(names, [
    "make_motion",
    "list_models",
    "inspect_pmx",
    "compile_and_inspect_mpl2",
    "render_pose_views",
    "export_motion",
    "inspect_vmd_file",
    "push_vmd_to_stage",
    "inspect_duo",
    "get_blender_scene_info",
    "execute_blender_code",
    "get_blender_viewport",
  ])
  for (const t of listed.tools) {
    assert(t.description && t.description.length > 20, `${t.name} needs a description`)
    assert.equal(t.inputSchema.type, "object", `${t.name} schema must be an object`)
  }
  console.log("  ok  tools/list (12 tools, make_motion first)")

  const modelsRes = await rpc("tools/call", { name: "list_models", arguments: {} })
  const models = JSON.parse(modelsRes.content[0].text)
  assert.deepEqual(
    models.map((m) => m.id),
    ["topaz", "caelus"]
  )
  assert(models.every((m) => m.exists))
  console.log("  ok  list_models (topaz + caelus)")

  const caelusInspect = JSON.parse(
    (await rpc("tools/call", { name: "inspect_pmx", arguments: { modelId: "caelus" } })).content[0].text
  )
  assert.equal(caelusInspect.model.id, "caelus")
  assert(caelusInspect.measurements.heightCm > 170)
  const caelusCompile = JSON.parse(
    (await rpc("tools/call", { name: "compile_and_inspect_mpl2", arguments: { mpl: `@pose p {\n  reach hand_r to wave_r;\n  hand_r open;\n  face にこり 0.7;\n}\n@animation a {\n  0: p;\n  1: p;\n}`, modelId: "caelus" } })).content[0].text
  )
  assert.equal(caelusCompile.ok, true)
  console.log(`  ok  caelus (男主1.0) inspect & compile (${caelusInspect.measurements.heightCm}cm, vmd=${caelusCompile.vmdBytes}B)`)

  const inspectRes = await rpc("tools/call", { name: "inspect_pmx", arguments: { modelId: "topaz" } })
  const inspected = JSON.parse(inspectRes.content[0].text)
  assert(inspected.validReachAnchors.includes("back_of_head"))
  assert(inspected.validReachAnchors.includes("nape"))
  console.log("  ok  inspect_pmx (includes back_of_head & nape)")

  const scratchMpl = `@pose ready {
    waist reset;
    upper_body2 reset;
    head reset;
}
@pose scratch_back {
    waist turn right 6;
    upper_body2 bend backward 3, sway left 4;
    head sway left 15;
    aim head at camera;
    knee_l bend backward 8;
    knee_r bend backward 12;
    plant feet;
    reach hand_r to back_of_head;
    hand_r cup;
    reach hand_l to hip_l;
    hand_l akimbo;
    face 困る 0.7;
    face 照れ 0.4;
}
@animation seg {
    0: ready;
    0.8: scratch_back;
    2.2: scratch_back;
}`

  const compileRes = await rpc("tools/call", {
    name: "compile_and_inspect_mpl2",
    arguments: { mpl: scratchMpl, modelId: "topaz", sampleTimes: [0.8] },
  })
  const compiled = JSON.parse(compileRes.content[0].text)
  assert.equal(compiled.ok, true, `Expected ok=true, got: ${JSON.stringify(compiled)}`)
  assert.equal(compiled.directiveErrors.length, 0)
  const sample = compiled.keyframeCoords[0]
  assert(sample.armExtensionRatioR != null && sample.armExtensionRatioR < 0.78, `Expected bent elbow, got ext=${sample.armExtensionRatioR}`)
  console.log(`  ok  compile_and_inspect_mpl2 (back_of_head extR=${sample.armExtensionRatioR}, wristR=${JSON.stringify(sample.wristR)})`)

  const renderRes = await rpc("tools/call", {
    name: "render_pose_views",
    arguments: { mpl: scratchMpl, modelId: "topaz", mode: "single", timeSec: 0.8 },
  })
  assert.equal(renderRes.content[0].type, "image")
  assert.equal(renderRes.content[0].mimeType, "image/png")
  assert(renderRes.content[0].data.length > 500)
  console.log(`  ok  render_pose_views (PNG base64 len=${renderRes.content[0].data.length})`)

  const exportRes = await rpc("tools/call", {
    name: "export_motion",
    arguments: { mpl: scratchMpl, modelId: "topaz", pushToStage: false },
  })
  const exported = JSON.parse(exportRes.content[0].text)
  assert.equal(exported.ok, true)
  assert(exported.vmdBytes > 0)
  assert.equal(typeof exported.baked, "boolean")
  assert(exported.groundContact && exported.groundContact.feet, "final export must carry ground telemetry")
  assert.match(exported.vmdSha256, /^[0-9a-f]{64}$/)
  console.log(`  ok  export_motion (vmdBytes=${exported.vmdBytes}, baked=${exported.baked}, ground=${exported.groundNotes[0] ?? "clean"})`)

  // Regression: broken squat-standard-3x.mpl must be caught by floating_foot + biomechanics + blocked on export
  const badSquatPath = path.join(root, ".tmp/mcp-verify/squat-standard-3x.mpl")
  if (fs.existsSync(badSquatPath)) {
    const badSquatMpl = fs.readFileSync(badSquatPath, "utf8")
    const badRes = JSON.parse(
      (await rpc("tools/call", { name: "compile_and_inspect_mpl2", arguments: { mpl: badSquatMpl, modelId: "topaz", sampleTimes: [1.2, 2.4] } })).content[0].text
    )
    assert.equal(badRes.ok, false, "Broken squat must NOT pass ok=true")
    assert(badRes.critic.issues.some((i) => i.code === "floating_foot"), "Must catch symmetric floating_foot at 2.4s")
    assert(badRes.actionableWarnings.some((w) => w.includes('unknown face morph "まじめ"')))
    assert(badRes.actionableWarnings.some((w) => w.includes("hipBackShift")))
    // Ground bake fixes frame-between sinking only — an authored floating-foot key pose must survive it untouched.
    assert(badRes.groundContact && badRes.groundContact.feet, "groundContact telemetry must be present")
    const blockedExport = JSON.parse(
      (await rpc("tools/call", { name: "export_motion", arguments: { mpl: badSquatMpl, modelId: "topaz", pushToStage: false } })).content[0].text
    )
    assert.equal(blockedExport.ok, false)
    assert.equal(blockedExport.blockedByQualityGate, true)
    assert(blockedExport.critic.issues.some((i) => i.code === "floating_foot"), "Export gate must still name floating_foot")
    console.log(`  ok  broken squat caught & blocked by quality gate (groundBake applied=${badRes.groundBake?.applied})`)
  }

  // Standard squat following inspect_pmx guide must pass cleanly with grounded feet & hip-hinge
  const goodSquatMpl = `@pose squat_stand {
    center reset;
    waist reset;
    upper_body reset;
    upper_body2 reset;
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
    ankle_l reset;
    ankle_r reset;
    arm_l reset;
    arm_r reset;
    elbow_l reset;
    elbow_r reset;
    plant feet;
    aim head at camera;
    face 真面目 0.4;
}
@pose squat_deep {
    center move backward 2.0;
    waist bend forward 28;
    upper_body bend forward 12;
    upper_body2 bend forward 10;
    leg_l bend forward 90, sway left 8;
    leg_r bend forward 90, sway right 8;
    knee_l bend backward 120;
    knee_r bend backward 120;
    ankle_l bend backward 30;
    ankle_r bend backward 30;
    plant feet;
    reach hand_l to front_l;
    reach hand_r to front_r;
    aim head at camera;
    face 真面目 0.4;
}
@animation squat_cycle {
    0: squat_stand;
    1.2: squat_deep;
    2.4: squat_stand;
}
main {
    squat_cycle;
}`
  const goodRes = JSON.parse(
    (await rpc("tools/call", { name: "compile_and_inspect_mpl2", arguments: { mpl: goodSquatMpl, modelId: "topaz", sampleTimes: [0, 1.2, 2.4] } })).content[0].text
  )
  assert.equal(goodRes.ok, true, `Good squat failed: ${JSON.stringify(goodRes)}`)
  assert.equal(goodRes.actionableWarnings.length, 0, `Unexpected warnings: ${JSON.stringify(goodRes.actionableWarnings)}`)
  const bottomPt = goodRes.keyframeCoords.find((p) => Math.abs(p.timeSec - 1.2) < 0.05)
  assert(bottomPt && Math.abs(bottomPt.footLiftL) < 0.2, `Expected grounded feet, got footLiftL=${bottomPt?.footLiftL}`)
  assert(bottomPt && bottomPt.hipBackShift >= 1.5, `Expected hips pushed back, got hipBackShift=${bottomPt?.hipBackShift}`)
  assert(bottomPt && bottomPt.hipDrop >= 4.0, `Expected deep hipDrop, got hipDrop=${bottomPt?.hipDrop}`)
  // Verdict is on the FINAL motion: every rendered frame within tolerance, transition sinking fixed by the bake.
  assert.equal(goodRes.groundContact.offendingFrames, 0, `Ground: ${JSON.stringify(goodRes.groundContact)}`)
  assert.equal(goodRes.groundBake.applied, true, "stand→squat transition sinks between keys; the bake must engage")
  assert.equal(goodRes.groundBake.residualAtEntries, 0)
  assert(goodRes.finalKeyCount > goodRes.rawKeyCount, "final = enhanced + baked, so it carries more keys than the raw compile")
  console.log(
    `  ok  standard squat passed (hipDrop=${bottomPt.hipDrop}u, hipBack=${bottomPt.hipBackShift}u, footLift=${bottomPt.footLiftL}u; ` +
      `raw critic ${goodRes.criticRaw ? "FAIL → fixed by ground bake" : "pass"}, +${goodRes.groundBake.insertedKeys} bake keys, keys ${goodRes.rawKeyCount}→${goodRes.finalKeyCount})`
  )

  // Blocking export for Blender handoff + inspect_vmd_file + push_vmd_to_stage gate
  const handoffBase = ".tmp/test-handoff/squat-blocking"
  const blockingExport = JSON.parse(
    (
      await rpc("tools/call", {
        name: "export_motion",
        arguments: { mpl: goodSquatMpl, modelId: "topaz", mode: "blocking", outBasePath: handoffBase },
      })
    ).content[0].text
  )
  assert.equal(blockingExport.ok, true)
  assert.equal(blockingExport.mode, "blocking")
  assert.equal(blockingExport.enhanced, false)
  assert.equal(blockingExport.stagePush.skipped, true)
  assert(blockingExport.blenderHandoff?.vmdPath && fs.existsSync(blockingExport.blenderHandoff.vmdPath))
  assert.equal(blockingExport.blenderHandoff.importArgs.margin, 0)
  // Guardrail: blocking keys are never enhanced, never baked — byte-for-byte the sparse compile output.
  assert.equal(blockingExport.baked, false)
  assert.equal(blockingExport.groundBake, null)
  // …but the gate is judged on a ground-baked preview of those keys, so blocking and final agree.
  assert.equal(blockingExport.qualityGate?.passed, true, JSON.stringify(blockingExport.qualityGate))
  assert.equal(blockingExport.qualityGate?.groundContact?.offendingFrames, 0)
  assert(blockingExport.groundContact.offendingFrames > 0, "un-baked blocking keys do sink between keys — that is what Blender/polish handles")
  const blockingKeys = readVmdBoneKeys(new Uint8Array(fs.readFileSync(blockingExport.blenderHandoff.vmdPath)))
  assert.equal(blockingKeys.length, goodRes.rawKeyCount, "blocking VMD key count must equal the raw compile")
  console.log(
    `  ok  export_motion (mode=blocking, bytes=${blockingExport.vmdBytes}, keys=${blockingKeys.length} = raw compile, unbaked; gate on baked preview)`
  )

  const inspectedVmd = await rpc("tools/call", {
    name: "inspect_vmd_file",
    arguments: { vmdPath: `${handoffBase}.vmd`, modelId: "topaz", renderViews: true },
  })
  assert.equal(inspectedVmd.content[0].type, "image")
  const vmdReport = JSON.parse(inspectedVmd.content[1].text)
  assert(vmdReport.boneKeyCount > 0)
  assert(vmdReport.groundContact && vmdReport.groundContact.feet, "inspect_vmd_file must carry ground telemetry")
  // The blocking file is un-baked by design: judged as-is it sinks between keys (ok=false, it would fail the stage gate),
  // while the bake preview shows the standard ground bake would fix every frame.
  assert(vmdReport.groundContact.offendingFrames > 0, "un-baked blocking VMD must report frame-between sinking")
  assert.equal(vmdReport.groundBakePreview?.after?.offendingFrames, 0, JSON.stringify(vmdReport.groundBakePreview))
  assert(vmdReport.groundNotes.some((n) => n.includes('mode="blocking"')), JSON.stringify(vmdReport.groundNotes))
  console.log(
    `  ok  inspect_vmd_file (keys=${vmdReport.boneKeyCount}, dur=${vmdReport.durationSec}s, as-is ok=${vmdReport.ok}, ` +
      `bake preview: +${vmdReport.groundBakePreview.insertedKeys} keys → ${vmdReport.groundBakePreview.after.offendingFrames} offending)`
  )

  // Quality gate on push_vmd_to_stage must block broken VMD
  const badVmdPath = path.join(root, ".tmp/mcp-verify/squat-standard-3x.vmd")
  if (fs.existsSync(badVmdPath)) {
    const blockedPush = JSON.parse(
      (
        await rpc("tools/call", {
          name: "push_vmd_to_stage",
          arguments: { vmdPath: badVmdPath, modelId: "topaz" },
        })
      ).content[0].text
    )
    assert.equal(blockedPush.ok, false)
    assert.equal(blockedPush.blockedByQualityGate, true)
    console.log("  ok  push_vmd_to_stage blocks broken external VMD")
  }

  // ---- make_motion: 一次调用 = 编译 → 成品管线 → 闸门 → 分镜 → 报告（词库原语）
  const mkBase = ".tmp/test-make/squat-default"
  const mkRes = await rpc("tools/call", {
    name: "make_motion",
    arguments: { primitive: "squat", outBasePath: mkBase, title: "squat default", sampleTimes: [1.2, 9.06] },
  })
  assert.equal(mkRes.isError, undefined, JSON.stringify(mkRes).slice(0, 600))
  assert.equal(mkRes.content[0].type, "image", "storyboard PNG must come first")
  assert.equal(mkRes.content[0].mimeType, "image/png")
  const mkText = mkRes.content[1].text
  const mk = JSON.parse(mkText)
  assert.equal(mk.ok, true, mkText.slice(0, 1500))
  assert.equal(mk.source.kind, "lexicon")
  assert.equal(mk.source.primitive, "squat")
  assert.deepEqual(mk.source.requestedParams, {})
  assert.equal(mk.source.effectiveParams.depth, 1)
  assert.equal(mk.source.effectiveParams.cycles, 3)
  assert.equal(mk.modelId, "topaz")
  // 成片 = 作者时间轴 + 增强器的收尾键：词库时长 9.05s → 作者末帧 f271 = 9.03s（帧量化）→ 成片末帧 f278 = 9.27s
  assert.equal(mk.source.durationSec, 9.05)
  assert.equal(mk.authoredSec, 9.03)
  assert.equal(mk.durationSec, 9.27)
  assert.equal(mk.frames, 279)
  assert.match(mk.vmd.sha256, /^[0-9a-f]{64}$/)
  assert.equal(mk.vmd.base64, undefined, "bytes stay out of the report unless includeVmdBase64")
  assert.equal(mk.pipeline.enhanced, true)
  assert.equal(mk.pipeline.baked, true)
  assert(mk.pipeline.groundBake.insertedKeys > 0)
  assert(mk.vmd.boneKeys > mk.vmd.rawBoneKeys, "final = enhanced + baked")
  // 结论：与 export_motion final / compile_and_inspect_mpl2 同一口径
  assert.equal(mk.verdict.passed, true)
  assert.deepEqual(mk.verdict.directiveErrors, [])
  assert.equal(mk.verdict.critic.passed, true)
  assert.equal(mk.verdict.critic.issueCount, 0)
  // 原始编译在关键帧之间沉地（ground_penetration）是预期——报告附上并标明成品已修掉
  assert.equal(mk.verdict.criticRaw.passed, false, "raw compile sinks between keys")
  assert.equal(mk.verdict.criticRaw.fixedByFinalize, true, "…and the final motion fixes it")
  assert.match(mk.verdict.criticRaw.summary, /ground_penetration/)
  assert.equal(mk.verdict.groundContact.offendingFrames, 0)
  // 管线默认容差 0.05u（4mm），不松于 5mm（0.0625u）的回归阈值
  assert(mk.verdict.groundContact.tolerance > 0 && mk.verdict.groundContact.tolerance <= 0.0625, `tolerance ${mk.verdict.groundContact.tolerance}`)
  assert.equal(mk.pipeline.groundBake.residualFrames, 0)
  // 逐帧曲线：脚底偏移全在容差内、髋降峰值、时间单调、末帧必采
  const c = mk.curves
  assert(c && c.stride >= 1, "curves missing")
  for (const k of ["footL", "footR", "footLiftL", "footLiftR", "hipDrop"]) assert.equal(c[k].length, c.t.length, `${k} length`)
  assert(c.t.every((t, i) => i === 0 || t > c.t[i - 1]), "curve time must increase")
  assert.equal(c.t[0], 0)
  assert.equal(c.t.at(-1), 9.267, "last frame must be sampled")
  assert.equal(c.tolerance, mk.verdict.groundContact.tolerance, "curves use the same tolerance as the verdict")
  assert(c.footL.concat(c.footR).every((v) => Math.abs(v) <= c.tolerance), "every sampled sole offset within tolerance")
  assert(Math.abs(c.peaks.hipDropMax.value - 5.71) < 0.02, `hip drop peak ${c.peaks.hipDropMax.value}`)
  assert(c.peaks.footLiftMaxL.value < 0.1 && c.peaks.footLiftMaxR.value < 0.1, "squat keeps both feet down")
  // 判定帧表：每个时间轴条目一行（姿势名 + 标量遥测），第一个触底帧髋降量与曲线峰值一致
  assert.equal(mk.keyframes.length, 27, "all 27 timeline entries (3 reps × 9) are reported")
  assert.equal(mk.keyframes[0].pose, "sq_top")
  assert.equal(mk.keyframes[0].frame, 0)
  assert.equal(mk.keyframes[0].t, 0)
  assert.equal(mk.keyframes[3].pose, "sq_bottom")
  assert.equal(mk.keyframes[3].frame, 36)
  assert.equal(mk.keyframes[3].t, 1.2)
  assert(Math.abs(mk.keyframes[3].hipDrop - c.peaks.hipDropMax.value) < 0.02)
  assert.equal(mk.keyframes[3].footLiftL, mk.keyframes[3].footLiftR, "symmetric squat")
  assert(mk.keyframes[3].squatDepthRatio > 0.5 && mk.keyframes[3].armExtL < 0.8)
  // 完整 3D 坐标按 sampleTimes 另取
  assert.equal(mk.coords.length, 2)
  assert.equal(mk.coords[0].frame, 36)
  assert.equal(mk.coords[1].timeSec, 9.03)
  assert(Math.abs(mk.coords[0].center.y - (8 - c.peaks.hipDropMax.value)) < 0.02, `centre y ${mk.coords[0].center.y}`)
  assert(Math.abs(mk.coords[0].ankleL.y - mk.verdict.groundContact.restAnkleY.l) < 0.01, "ankle stays at rest height at the bottom")
  assert(mk.coords[1].hipDrop < 0.2, `standing again at the last authored frame: hipDrop ${mk.coords[1].hipDrop}`)
  assert.equal(mk.storyboard.kind, "storyboard")
  assert.equal(mk.storyboard.tilesSec.length, 6)
  assert.equal(mk.stagePush, undefined, "no push unless asked")
  // 落盘：.mpl / .vmd / .png / .json，且 .vmd 的字节数与 sha256 与报告一致
  assert.equal(mk.writtenFiles.length, 4, JSON.stringify(mk.writtenFiles))
  for (const ext of [".mpl", ".vmd", ".png", ".json"]) assert(fs.existsSync(path.join(root, mkBase + ext)), `missing ${ext}`)
  const mkVmd = fs.readFileSync(path.join(root, mkBase + ".vmd"))
  assert.equal(mkVmd.length, mk.vmd.bytes)
  assert.equal(crypto.createHash("sha256").update(mkVmd).digest("hex"), mk.vmd.sha256)
  assert.equal(mk.vmd.path, path.join(root, mkBase + ".vmd"))
  const mkPng = fs.readFileSync(path.join(root, mkBase + ".png"))
  assert(mkPng.length > 500 && mkPng[0] === 0x89 && mkPng[1] === 0x50, "written PNG must be a real PNG")
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, mkBase + ".json"), "utf8")).vmd.sha256, mk.vmd.sha256)
  assert.match(fs.readFileSync(path.join(root, mkBase + ".mpl"), "utf8"), /main\s*\{/, "expanded MPL is saved compilable")
  // 报告排版省 token：曲线数组单行、判定帧表每项一行、嵌套对象仍缩进；整份报告保持在 ~12KB 量级
  assert(mkText.includes('"footL": [') && mkText.includes('"vmd": {"bytes"'), "inline number arrays / flat objects")
  assert.equal((mkText.match(/^\s+\{"frame":\d+,"t":[\d.]+,"pose":"/gm) ?? []).length, 27, "one line per timeline entry")
  assert(mkText.split("\n").length < 250 && mkText.length < 16000, `report too verbose: ${mkText.length} chars / ${mkText.split("\n").length} lines`)
  console.log(
    `  ok  make_motion (lexicon squat: ${mk.frames}f ${mk.durationSec}s, vmd ${mk.vmd.bytes}B sha ${mk.vmd.sha256.slice(0, 8)}, ` +
      `+${mk.pipeline.groundBake.insertedKeys} bake keys, hip drop ${c.peaks.hipDropMax.value}u, ${mk.storyboard.tilesSec.length} tiles, 4 files)`
  )

  // 参数：越界钳制、未知参数忽略、目标时长加循环、深度生效、镜像
  const halfRes = await rpc("tools/call", {
    name: "make_motion",
    arguments: { primitive: "squat", params: { depth: 0.5, tempo: 99, bogus: 1 }, targetDuration: 20, mirror: true, maxTiles: 4 },
  })
  const half = JSON.parse(halfRes.content[1].text)
  assert.equal(half.ok, true, halfRes.content[1].text.slice(0, 1500))
  assert.equal(half.source.effectiveParams.depth, 0.5)
  assert.equal(half.source.effectiveParams.tempo, 1.6, "out-of-range params are clamped")
  assert.equal(half.source.effectiveParams.bogus, undefined, "unknown params are ignored")
  assert.equal(half.source.effectiveParams.cycles, 6, "targetDuration adds cycles up to the primitive max")
  assert.equal(half.source.mirror, true)
  assert.equal(half.source.targetDuration, 20)
  assert(half.durationSec > 10 && half.durationSec < 13, `duration ${half.durationSec}`)
  assert.equal(half.verdict.groundContact.offendingFrames, 0)
  assert.equal(half.storyboard.tilesSec.length, 4, "maxTiles is honoured")
  assert(half.curves.peaks.hipDropMax.value < c.peaks.hipDropMax.value - 3, `half squat must be shallower: ${half.curves.peaks.hipDropMax.value}`)
  console.log(
    `  ok  make_motion params (depth 0.5 → hip drop ${half.curves.peaks.hipDropMax.value}u, tempo clamped 1.6, cycles 3→6 for 20s, ${half.durationSec}s, mirrored)`
  )

  // 直接给 MPL：<1.5s 的短动作返回三视图而不是分镜
  const shortMpl = `@pose p {\n  reach hand_r to wave_r;\n  hand_r open;\n  face にこり 0.7;\n}\n@animation a {\n  0: p;\n  1: p;\n}`
  const shortRes = await rpc("tools/call", { name: "make_motion", arguments: { mpl: shortMpl, modelId: "topaz", storyboard: true } })
  assert.equal(shortRes.isError, undefined)
  const short = JSON.parse(shortRes.content[1].text)
  assert.equal(short.source.kind, "mpl")
  assert.equal(short.ok, true, shortRes.content[1].text.slice(0, 1500))
  assert.equal(short.authoredSec, 1, "last authored entry at 1.0s")
  assert.equal(short.frames, 35, "1.0s clip + enhancer tail keys (f34)")
  assert.equal(short.durationSec, 1.13)
  assert.equal(short.storyboard.kind, "views")
  assert.equal(short.keyframes[0].pose, "p")
  const noSb = JSON.parse((await rpc("tools/call", { name: "make_motion", arguments: { mpl: shortMpl, storyboard: false } })).content[0].text)
  assert.equal(noSb.storyboard, undefined, "storyboard:false → text only")
  console.log(`  ok  make_motion mpl input (1.0s → 3-view PNG; storyboard:false → text only)`)

  // 闸门：作者姿势本身沉地（直腿 + 重心下移 4u，没有可修的过渡段）→ 报告作为 MCP 错误返回（仍带分镜与完整诊断）；force=true 则正常返回 ok=false
  const brokenMpl = `@pose sink {\n    center move down 4;\n    leg_l reset;\n    leg_r reset;\n    knee_l reset;\n    knee_r reset;\n}\n@animation a {\n    0: sink;\n    2: sink;\n}\nmain {\n    a;\n}`
  const blockedRes = await rpc("tools/call", { name: "make_motion", arguments: { mpl: brokenMpl, pushToStage: true } })
  assert.equal(blockedRes.isError, true, "failed gate must surface as an MCP error")
  assert.equal(blockedRes.content[0].type, "image", "diagnostics still carry the storyboard")
  const blocked = JSON.parse(blockedRes.content[1].text)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.verdict.passed, false)
  assert.equal(blocked.verdict.critic.passed, false)
  assert(blocked.verdict.critic.issues.length > 0 && blocked.verdict.critic.issueCount >= blocked.verdict.critic.issues.length)
  assert.equal(blocked.verdict.critic.issues[0].code, "ground_penetration")
  assert.equal(blocked.verdict.groundContact.offendingFrames, 122, "61 frames × 2 feet sunk 4u — authored, reported as-is")
  assert.equal(blocked.pipeline.groundBake.insertedKeys, 0, "held key poses are never rewritten")
  assert.equal(blocked.curves.peaks.footDeepestL.value, -4)
  assert.equal(blocked.curves.peaks.hipDropMax.value, 4)
  assert(
    blocked.verdict.groundNotes.some((n) => n.includes("authored pose")),
    `expected an authored-pose hint, got ${JSON.stringify(blocked.verdict.groundNotes)}`
  )
  assert.deepEqual(blocked.verdict.directiveErrors, [])
  assert.match(blocked.vmd.sha256, /^[0-9a-f]{64}$/)
  assert.equal(blocked.stagePush.ok, false, "a failed gate never reaches the stage")
  const forcedRes = await rpc("tools/call", { name: "make_motion", arguments: { mpl: brokenMpl, force: true, includeVmdBase64: true } })
  assert.equal(forcedRes.isError, undefined, "force=true returns the report instead of an error")
  const forced = JSON.parse(forcedRes.content[1].text)
  assert.equal(forced.ok, false)
  assert.equal(forced.forced, true)
  assert.equal(forced.vmd.bytes, Buffer.from(forced.vmd.base64, "base64").length, "includeVmdBase64 embeds the exact final bytes")
  console.log(
    `  ok  make_motion quality gate (authored sink: ${blocked.verdict.groundContact.offendingFrames} offending foot-frames, ` +
      `${blocked.verdict.critic.issueCount} issue(s) e.g. ${blocked.verdict.critic.issues[0].code}; isError + no push; force returns report)`
  )

  const unknownRes = await rpc("tools/call", { name: "make_motion", arguments: { primitive: "moonwalk" } })
  assert.equal(unknownRes.isError, true)
  assert.match(unknownRes.content[0].text, /unknown lexicon primitive "moonwalk"/)
  const neitherRes = await rpc("tools/call", { name: "make_motion", arguments: { modelId: "topaz" } })
  assert.equal(neitherRes.isError, true)
  assert.match(neitherRes.content[0].text, /mpl.*primitive/)
  console.log(`  ok  make_motion input validation (unknown primitive / neither mpl nor primitive → error)`)

  fs.rmSync(path.join(root, ".tmp/test-handoff"), { recursive: true, force: true })
  fs.rmSync(path.join(root, ".tmp/test-make"), { recursive: true, force: true })
  rawLog(`\n${okCount} MCP server tests passed.`)
} finally {
  child.kill()
}
