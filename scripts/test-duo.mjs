import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { duoYawQuat, localToDuoWorld, worldToActorLocal, toBlenderRootPlacement } from "../src/lib/duo.ts"
import { qRotate } from "../src/lib/fk.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")

let okCount = 0
const pass = (label) => {
  okCount++
  console.log(`  ok  ${label}`)
}

// 1. Pure math sanity checks on duo transforms & Blender root mapping
{
  const f = qRotate(duoYawQuat(90), { x: 0, y: 0, z: -1 })
  assert(Math.abs(f.x - 1) < 1e-4 && Math.abs(f.z) < 1e-4, `yaw +90 should face +X, got (${f.x}, ${f.z})`)

  const pA = { offset: [-5, 0, 0], yawDeg: 90 }
  const pB = { offset: [5, 0, 0], yawDeg: -90 }
  const wPt = localToDuoWorld({ x: 1.2, y: 12.5, z: -4.0 }, pA)
  const roundTrip = worldToActorLocal(wPt, pA)
  assert(
    Math.abs(roundTrip[0] - 1.2) < 1e-2 &&
      Math.abs(roundTrip[1] - 12.5) < 1e-2 &&
      Math.abs(roundTrip[2] - -4.0) < 1e-2,
    `worldToActorLocal round-trip mismatch: ${JSON.stringify(roundTrip)}`
  )

  const blA = toBlenderRootPlacement(pA)
  const blB = toBlenderRootPlacement(pB)
  assert.deepEqual(blA, { location: [-0.4, 0, 0], rotation_euler_z_deg: 90 })
  assert.deepEqual(blB, { location: [0.4, 0, 0], rotation_euler_z_deg: -90 })
  pass("duo math: yaw quat, worldToActorLocal round-trip, blenderRootPlacement")
}

// 2. MCP stdio end-to-end duo tests
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
    }, 20000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
  })
}

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} })

  // Test pmxPath override on inspect_pmx
  const pmxRes = await rpc("tools/call", {
    name: "inspect_pmx",
    arguments: { pmxPath: "public/models/caelus/男主1.0.pmx" },
  })
  const pmxInfo = JSON.parse(pmxRes.content[0].text)
  assert(pmxInfo.measurements.heightCm > 170, "caelus heightCm should be > 170")
  pass("pmxPath override on inspect_pmx")

  // Face-to-face reach setup: topaz (-5, yaw +90) and caelus (+5, yaw -90)
  const mplB = `@pose reach_l {\n  reach hand_l to front_l;\n  hand_l open;\n}\n@animation anim_b {\n  0: reach_l;\n  1: reach_l;\n}`
  const mplAInit = `@pose reach_r {\n  reach hand_r to front_r;\n  hand_r open;\n}\n@animation anim_a {\n  0: reach_r;\n  1: reach_r;\n}`

  const step1 = await rpc("tools/call", {
    name: "inspect_duo",
    arguments: {
      actorA: { modelId: "topaz", mpl: mplAInit, offset: [-5, 0, 0], yawDeg: 90 },
      actorB: { modelId: "caelus", mpl: mplB, offset: [5, 0, 0], yawDeg: -90 },
      sampleTimes: [0.5],
      mode: "single",
      timeSec: 0.5,
      renderViews: true,
    },
  })
  const img1 = step1.content.find((c) => c.type === "image")
  assert(img1, "inspect_duo single mode must return PNG image")
  const pngMagic = Buffer.from(img1.data, "base64").subarray(0, 4).toString("hex")
  assert.equal(pngMagic, "89504e47")
  const rep1 = JSON.parse(step1.content.find((c) => c.type === "text").text)
  assert.equal(rep1.ok, true, `separated duo should have zero clipping, got ${JSON.stringify(rep1.issues)}`)
  assert.deepEqual(rep1.actorA.blenderRoot, { location: [-0.4, 0, 0], rotation_euler_z_deg: 90 })
  assert.deepEqual(rep1.actorB.blenderRoot, { location: [0.4, 0, 0], rotation_euler_z_deg: -90 })

  // Convert partner's left wrist into Actor A's local coordinates and reach straight for it
  const bHandL = rep1.frames[0].landmarksWorld.B["左手首"]
  assert(Array.isArray(bHandL) && bHandL.length === 3)
  const stepConv = await rpc("tools/call", {
    name: "inspect_duo",
    arguments: {
      actorA: { modelId: "topaz", mpl: mplAInit, offset: [-5, 0, 0], yawDeg: 90 },
      actorB: { modelId: "caelus", mpl: mplB, offset: [5, 0, 0], yawDeg: -90 },
      sampleTimes: [0.5],
      convertWorldPointFor: { actor: "A", worldPoint: bHandL },
      renderViews: false,
    },
  })
  const repConv = JSON.parse(stepConv.content.find((c) => c.type === "text").text)
  const [lx, ly, lz] = repConv.convertedLocalPoint.localPoint
  const mplAReached = `@pose reach_r {\n  reach hand_r to [${lx}, ${ly}, ${lz}];\n  hand_r open;\n}\n@animation anim_a {\n  0: reach_r;\n  1: reach_r;\n}`

  const step2 = await rpc("tools/call", {
    name: "inspect_duo",
    arguments: {
      actorA: { modelId: "topaz", mpl: mplAReached, offset: [-5, 0, 0], yawDeg: 90 },
      actorB: { modelId: "caelus", mpl: mplB, offset: [5, 0, 0], yawDeg: -90 },
      sampleTimes: [0.5],
      renderViews: false,
    },
  })
  const rep2 = JSON.parse(step2.content.find((c) => c.type === "text").text)
  const minDist = rep2.frames[0].distancesUnits.minWristPair.distUnits
  assert(minDist < 1.2, `expected targeted reach to bring wrists < 1.2u apart, got ${minDist}u`)
  pass(`duo worldToActorLocal reach targeting (minWristPair=${minDist}u / ${(minDist * 8).toFixed(1)}cm)`)

  // Clipping check when actors overlap at [0, 0, 0]
  const stepClip = await rpc("tools/call", {
    name: "inspect_duo",
    arguments: {
      actorA: { modelId: "topaz", mpl: mplAInit, offset: [0, 0, 0], yawDeg: 0 },
      actorB: { modelId: "caelus", mpl: mplB, offset: [0, 0, 0], yawDeg: 0 },
      sampleTimes: [0.5],
      renderViews: false,
    },
  })
  const repClip = JSON.parse(stepClip.content.find((c) => c.type === "text").text)
  assert.equal(repClip.ok, false)
  assert(
    repClip.issues.some((i) => i.code === "torso_clipping" || i.code === "head_clipping"),
    `expected clipping issue when overlapping, got ${JSON.stringify(repClip.issues)}`
  )
  pass(`duo clipping detection (${repClip.issues.map((i) => i.code).join(", ")})`)

  // Storyboard mode (>= 1.5s)
  const mplALong = `@pose p1 {\n  arm_l bend forward 25;\n  arm_r bend forward 25;\n}\n@pose p2 {\n  reach hand_r to wave_r;\n}\n@animation anim_a {\n  0: p1;\n  1: p2;\n  2: p1;\n}`
  const mplBLong = `@pose p1 {\n  arm_l bend forward 25;\n  arm_r bend forward 25;\n}\n@animation anim_b {\n  0: p1;\n  2: p1;\n}`
  const stepSb = await rpc("tools/call", {
    name: "inspect_duo",
    arguments: {
      actorA: { modelId: "topaz", mpl: mplALong, offset: [-6, 0, 0], yawDeg: 90 },
      actorB: { modelId: "caelus", mpl: mplBLong, offset: [6, 0, 0], yawDeg: -90 },
      mode: "storyboard",
      maxTiles: 4,
      renderViews: true,
    },
  })
  const imgSb = stepSb.content.find((c) => c.type === "image")
  assert(imgSb, "inspect_duo storyboard mode must return PNG image")
  const repSb = JSON.parse(stepSb.content.find((c) => c.type === "text").text)
  assert.equal(repSb.render.mode, "storyboard")
  assert(repSb.render.tiles.length >= 2)
  pass(`duo storyboard render (${repSb.render.tiles.length} tiles, ${repSb.render.width}x${repSb.render.height})`)

  // Verify caelus squat primitive passes with 0 offending ground-contact frames
  const stepCaelusSquat = await rpc("tools/call", {
    name: "make_motion",
    arguments: { primitive: "squat", modelId: "caelus", storyboard: false },
  })
  const repCaelus = JSON.parse(stepCaelusSquat.content.find((c) => c.type === "text").text)
  assert.equal(repCaelus.ok, true, `caelus squat ok should be true: ${JSON.stringify(repCaelus.verdict)}`)
  assert.equal(repCaelus.verdict.passed, true)
  assert.equal(repCaelus.verdict.groundContact.offendingFrames, 0, "caelus squat must have 0 offending ground frames")
  pass(`caelus squat ground-bake (0 offending, worst=${repCaelus.verdict.groundContact.worst}u)`)

  // Verify compile_duo_motion_intent (non-eye-contact side-by-side + dynamic partner:shoulder_r tracking)
  const stepCompileDuo = await rpc("tools/call", {
    name: "compile_duo_motion_intent",
    arguments: {
      renderViews: false,
      intent: {
        title: "Side-by-side duo test",
        actors: {
          A: { modelId: "topaz", placement: { offset: [2.6, 0, 0], yawDeg: 0 } },
          B: { modelId: "caelus", placement: { offset: [-2.6, 0, 0], yawDeg: 0 } },
        },
        beats: [
          {
            at: 0,
            A: { gaze: { target: "camera" }, hand_r: { mode: "rest" } },
            B: { gaze: { target: "camera" }, hand_l: { mode: "reach", target: "partner:shoulder_r", grip: "open" } },
          },
          {
            at: 1.0,
            A: { stance: { squat: 0.6 }, gaze: { target: "camera" }, hand_r: { mode: "reach", target: "wave_r", grip: "open" } },
            B: { gaze: { target: "camera" }, hand_l: { mode: "reach", target: "partner:shoulder_r", grip: "open" } },
          },
          {
            at: 2.0,
            A: { stance: { squat: 0.0 }, gaze: { target: "camera" }, hand_r: { mode: "rest" } },
            B: { gaze: { target: "camera" }, hand_l: { mode: "reach", target: "partner:shoulder_r", grip: "open" } },
          },
        ],
      },
    },
  })
  const repDuo = JSON.parse(stepCompileDuo.content.find((c) => c.type === "text").text)
  assert.equal(repDuo.ok, true, `side-by-side duo ok should be true: ${JSON.stringify(repDuo.duoAnalysis?.issues)}`)
  assert.equal(repDuo.actorA.critic.passed, true, `actorA critic failed: ${JSON.stringify(repDuo.actorA.critic)}`)
  assert.equal(repDuo.actorB.critic.passed, true, `actorB critic failed: ${JSON.stringify(repDuo.actorB.critic)}`)
  assert.equal(repDuo.actorA.groundContact.offendingFrames, 0)
  assert.equal(repDuo.actorB.groundContact.offendingFrames, 0)
  assert(repDuo.blenderScene?.actorA?.pmxPath && repDuo.blenderScene?.actorB?.vmdPath, "blenderScene must be populated")
  pass(`compile_duo_motion_intent side-by-side (solve=${repDuo.solveTimeMs}ms, ok=${repDuo.ok})`)

  console.log(`\nALL ${okCount} DUO CHECKS PASSED`)
} finally {
  child.kill()
}
