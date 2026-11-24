import assert from "node:assert/strict"
import fs from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readVmdBoneKeys } from "../src/lib/fk.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

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
    "list_models",
    "inspect_pmx",
    "compile_and_inspect_mpl2",
    "render_pose_views",
    "export_motion",
    "inspect_vmd_file",
    "push_vmd_to_stage",
  ])
  console.log("  ok  tools/list (7 tools)")

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

  fs.rmSync(path.join(root, ".tmp/test-handoff"), { recursive: true, force: true })
  console.log("\n10 MCP server tests passed.")
} finally {
  child.kill()
}
