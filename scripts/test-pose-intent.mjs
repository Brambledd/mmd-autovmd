import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { critiquePoseVmd } from "../src/lib/pose-critic.ts"
import { stitchSegments } from "../src/lib/long-motion.ts"
import { getServerCompiler } from "../src/lib/server-compile.ts"
import { compilePoseIntentToMPL2, parsePoseIntentJSON } from "../src/lib/pose-intent.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const pmxPath = path.join(root, "public/models/topaz/topaz.pmx")
const bones = parsePmxBones(fs.readFileSync(pmxPath))
const compiler = await getServerCompiler()
assert(compiler, "server compiler must initialize")

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

test("parsePoseIntentJSON sanitizes unsafe morphs and clamps weights/count", () => {
  const raw = JSON.stringify({
    beats: [
      {
        time: 1.5,
        torso: "lean_forward",
        lower: "relaxed",
        hand_l: "hip",
        hand_r: "mouth",
        head: "camera",
        face: [
          { morph: "上", weight: 0.9 },
          { morph: "笑い", weight: 1.8 },
          { morph: "照れ", weight: 0.5 },
          { morph: "ワ", weight: 0.4 },
        ],
      },
      { time: 0.5, torso: "upright", lower: "stand", hand_l: "rest", hand_r: "rest", head: "camera" },
    ],
  })
  const parsed = parsePoseIntentJSON(raw)
  assert(parsed, "parsed must not be null")
  assert.equal(parsed.beats.length, 2)
  assert.equal(parsed.beats[0].time, 0.5)
  assert.equal(parsed.beats[1].time, 1.5)
  assert.deepEqual(parsed.beats[1].face, [
    { morph: "笑い", weight: 1 },
    { morph: "照れ", weight: 0.5 },
  ])
})

test("compilePoseIntentToMPL2 crouch+shoe passes compileMPL2 + critiquePoseVmd", () => {
  const intent = parsePoseIntentJSON(
    JSON.stringify({
      beats: [
        { time: 0.8, torso: "lean_forward", lower: "crouch", hand_l: "shoe", hand_r: "shoe", head: "down" },
        { time: 2.5, torso: "upright", lower: "relaxed", hand_l: "hip", hand_r: "peace", head: "tilt_left", face: [{ morph: "にこり", weight: 0.8 }] },
      ],
    })
  )
  assert(intent)
  const frag = compilePoseIntentToMPL2(intent, 3.5)
  const stitched = stitchSegments([{ fragment: frag, duration: 3.5 }], { seamless: true })
  const res = compileMPL2(compiler, stitched.script, bones)
  assert(res.vmd.length > 0, "VMD must be non-empty")
  assert.equal(res.directiveErrors.length, 0)
  const report = critiquePoseVmd(bones, res.vmd, stitched.script, stitched.timeline)
  assert(report && report.passed, `critiquePoseVmd failed: ${report?.summary}`)
})

test("compilePoseIntentToMPL2 sit + wave passes compileMPL2 + critiquePoseVmd", () => {
  const intent = parsePoseIntentJSON(
    JSON.stringify({
      beats: [
        { time: 0.8, torso: "upright", lower: "sit", hand_l: "knee", hand_r: "wave", head: "camera", face: [{ morph: "なごみ", weight: 0.7 }] },
      ],
    })
  )
  assert(intent)
  const frag = compilePoseIntentToMPL2(intent, 2.5)
  const stitched = stitchSegments([{ fragment: frag, duration: 2.5 }], { seamless: true })
  const res = compileMPL2(compiler, stitched.script, bones)
  assert(res.vmd.length > 0)
  assert.equal(res.directiveErrors.length, 0)
  const report = critiquePoseVmd(bones, res.vmd, stitched.script, stitched.timeline)
  assert(report && report.passed, `critiquePoseVmd failed: ${report?.summary}`)
})

console.log(`\n${passed} pose-intent tests passed.`)
