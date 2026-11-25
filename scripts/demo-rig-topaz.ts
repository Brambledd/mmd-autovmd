import fs from "node:fs"
import path from "node:path"
import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { buildRigProfile } from "../src/lib/rig-profile.ts"
import { solveMotionIntent, type MotionIntent } from "../src/lib/rig-solver.ts"

const pmxPath = path.resolve("public/models/topaz/topaz.pmx")
const profilePath = path.resolve("public/models/topaz/topaz.rig-profile.json")
const outDir = path.resolve(".tmp")
fs.mkdirSync(outDir, { recursive: true })

const bones = parsePmxBones(new Uint8Array(fs.readFileSync(pmxPath)))
const profile = buildRigProfile(bones, "topaz")
fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2))

const intent: MotionIntent = {
  title: "Topaz Shy-to-Wave Demo (Rig Solver v2 Calibrated)",
  breathing: true,
  autoBlink: true,
  beats: [
    {
      at: 0.0,
      effort: "soft",
      stance: { weightShift: 0.0, squat: 0.02 },
      spine: { curl: 0.0, twist: 0.0, lean: 0.0 },
      hand_l: { mode: "rest", grip: "relax" },
      hand_r: { mode: "rest", grip: "relax" },
      gaze: { target: "camera", headTiltDeg: 0 },
      face: { warm_smile: 0.35 },
    },
    {
      at: 1.1,
      effort: "soft",
      stance: { weightShift: 0.65, squat: 0.06, hipYawDeg: 8 },
      spine: { curl: 0.06, twist: 0.16, lean: 0.14 },
      hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "cup:0.5,relax:0.5" },
      hand_r: { mode: "reach", target: "cheek_r", endEffector: "fingertip", arc: "outward", grip: "open:0.4,relax:0.6" },
      gaze: { target: "camera", headTiltDeg: -10, headPitchDeg: 4 },
      face: { shy: 0.75, smile: 0.55 },
    },
    {
      at: 1.8,
      effort: "soft",
      stance: { weightShift: 0.62, squat: 0.05, hipYawDeg: 8 },
      spine: { curl: 0.05, twist: 0.15, lean: 0.13 },
      hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "cup:0.5,relax:0.5" },
      hand_r: { mode: "reach", target: "cheek_r", endEffector: "fingertip", arc: "outward", grip: "open:0.4,relax:0.6" },
      gaze: { target: "camera", headTiltDeg: -11, headPitchDeg: 4 },
      face: { shy: 0.75, smile: 0.6 },
    },
    {
      at: 2.6,
      effort: "snappy",
      stance: { weightShift: -0.55, squat: 0.14, hipYawDeg: -10 },
      spine: { curl: -0.06, twist: -0.22, lean: -0.12 },
      hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "relax" },
      hand_r: { mode: "reach", target: "wave_r", arc: "outward", grip: "open:0.9,relax:0.1" },
      gaze: { target: "camera", headTiltDeg: 8, headPitchDeg: -3 },
      face: { smile: 0.85, shy: 0.15 },
    },
    {
      at: 3.1,
      effort: "bouncy",
      stance: { weightShift: -0.35, squat: 0.05, hipYawDeg: -6 },
      spine: { curl: -0.04, twist: -0.10, lean: -0.04 },
      hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "relax" },
      hand_r: { mode: "reach", target: "wave_r", offsetCm: [8, 2, 0], arc: "outward", grip: "open:0.95" },
      gaze: { target: "camera", headTiltDeg: 5, headPitchDeg: -2 },
      face: { smile: 0.9 },
    },
    {
      at: 3.6,
      effort: "bouncy",
      stance: { weightShift: -0.50, squat: 0.08, hipYawDeg: -8 },
      spine: { curl: -0.04, twist: -0.18, lean: -0.10 },
      hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "relax" },
      hand_r: { mode: "reach", target: "wave_r", offsetCm: [-6, 0, 0], arc: "outward", grip: "open:0.95" },
      gaze: { target: "camera", headTiltDeg: 9, headPitchDeg: -2 },
      face: { smile: 0.85 },
    },
    {
      at: 4.5,
      effort: "soft",
      stance: { weightShift: 0.10, squat: 0.02, hipYawDeg: 0 },
      spine: { curl: 0.0, twist: 0.0, lean: 0.0 },
      hand_l: { mode: "rest", grip: "relax" },
      hand_r: { mode: "rest", grip: "relax" },
      gaze: { target: "camera", headTiltDeg: 2, headPitchDeg: 0 },
      face: { warm_smile: 0.45 },
    },
  ],
}

const result = solveMotionIntent(intent, profile, bones)
const outVmd = path.join(outDir, "topaz-rig-demo.vmd")
fs.writeFileSync(outVmd, result.vmd)

console.log(JSON.stringify({
  outVmd,
  bytes: result.vmd.byteLength,
  durationSec: result.durationSec,
  frameCount: result.frameCount,
  rawKeyCount: result.rawKeyCount,
  decimatedKeyCount: result.decimatedKeyCount,
  compressionRatio: Number((result.decimatedKeyCount / Math.max(1, result.rawKeyCount)).toFixed(3)),
  morphKeyCount: result.morphKeyCount,
  solveTimeMs: result.solveTimeMs,
}, null, 2))
