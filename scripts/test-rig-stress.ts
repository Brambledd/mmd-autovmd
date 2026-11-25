import fs from "node:fs"
import path from "node:path"
import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { buildRigProfile } from "../src/lib/rig-profile.ts"
import { solveMotionIntent, type MotionIntent } from "../src/lib/rig-solver.ts"
import { critiquePoseVmd } from "../src/lib/pose-critic.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"

const CASES: Array<{ name: string; intent: MotionIntent }> = [
  {
    name: "1_shy_cheek_akimbo_wave",
    intent: {
      beats: [
        { at: 0.0, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" }, face: { warm_smile: 0.3 } },
        { at: 1.1, effort: "soft", stance: { weightShift: 0.65, squat: 0.06, hipYawDeg: 8 }, spine: { curl: 0.06, twist: 0.16, lean: 0.14 }, hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "cup:0.5,relax:0.5" }, hand_r: { mode: "reach", target: "cheek_r", endEffector: "fingertip", arc: "outward", grip: "open:0.4,relax:0.6" }, gaze: { target: "camera", headTiltDeg: -10, headPitchDeg: 4 }, face: { shy: 0.75, smile: 0.55 } },
        { at: 2.3, effort: "snappy", stance: { weightShift: -0.5, squat: 0.12, hipYawDeg: -8 }, spine: { curl: -0.05, twist: -0.18, lean: -0.10 }, hand_l: { mode: "reach", target: "waist_side_l", arc: "akimbo", grip: "relax" }, hand_r: { mode: "reach", target: "wave_r", arc: "outward", grip: "open:0.9" }, gaze: { target: "camera", headTiltDeg: 8 }, face: { smile: 0.85 } },
        { at: 3.3, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" }, face: { warm_smile: 0.4 } },
      ],
    },
  },
  {
    name: "2_think_chin_chest",
    intent: {
      beats: [
        { at: 0.0, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" } },
        { at: 1.0, effort: "soft", stance: { weightShift: -0.45, squat: 0.04, hipYawDeg: -6 }, spine: { curl: 0.10, twist: -0.12, lean: -0.08 }, hand_l: { mode: "reach", target: "chest_l", grip: "relax" }, hand_r: { mode: "reach", target: "chin", endEffector: "fingertip", grip: "cup:0.6,relax:0.4" }, gaze: { target: "up", headTiltDeg: 8, headPitchDeg: -4 }, face: { serious: 0.6 } },
        { at: 2.2, effort: "soft", stance: { weightShift: -0.40, squat: 0.04 }, spine: { curl: 0.08, twist: -0.10, lean: -0.06 }, hand_l: { mode: "reach", target: "chest_l", grip: "relax" }, hand_r: { mode: "reach", target: "chin", endEffector: "fingertip", grip: "cup:0.6,relax:0.4" }, gaze: { target: "camera", headTiltDeg: 6 }, face: { smile: 0.5 } },
        { at: 3.0, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" }, face: { warm_smile: 0.4 } },
      ],
    },
  },
  {
    name: "3_happy_cheer_bounce",
    intent: {
      beats: [
        { at: 0.0, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" } },
        { at: 0.5, effort: "heavy", stance: { weightShift: 0, squat: 0.35 }, spine: { curl: 0.12 }, hand_l: { mode: "rest", grip: "fist:0.7,relax:0.3" }, hand_r: { mode: "rest", grip: "fist:0.7,relax:0.3" }, gaze: { target: "camera", headPitchDeg: 5 }, face: { smile: 0.6 } },
        { at: 1.1, effort: "bouncy", stance: { weightShift: 0.25, squat: 0.02 }, spine: { curl: -0.14, lean: 0.08 }, hand_l: { mode: "reach", target: "cheer_l", palm: "camera", grip: "open:0.95" }, hand_r: { mode: "reach", target: "cheer_r", palm: "camera", grip: "open:0.95" }, gaze: { target: "camera", headTiltDeg: -6, headPitchDeg: -6 }, face: { laugh: 0.85, grin: 0.6 } },
        { at: 2.0, effort: "bouncy", stance: { weightShift: -0.25, squat: 0.06 }, spine: { curl: -0.10, lean: -0.08 }, hand_l: { mode: "reach", target: "cheer_l", palm: "camera", grip: "open:0.95" }, hand_r: { mode: "reach", target: "cheer_r", palm: "camera", grip: "open:0.95" }, gaze: { target: "camera", headTiltDeg: 6, headPitchDeg: -4 }, face: { laugh: 0.85, grin: 0.5 } },
        { at: 3.0, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" }, face: { smile: 0.5 } },
      ],
    },
  },
  {
    name: "4_polite_bow_smile",
    intent: {
      beats: [
        { at: 0.0, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" }, face: { warm_smile: 0.4 } },
        { at: 1.0, effort: "soft", stance: { weightShift: 0, squat: 0.08 }, spine: { curl: 0.72 }, hand_l: { mode: "rest", grip: "relax" }, hand_r: { mode: "rest", grip: "relax" }, gaze: { target: "down", headPitchDeg: 18 }, face: { warm_smile: 0.7 } },
        { at: 1.6, effort: "soft", stance: { weightShift: 0, squat: 0.08 }, spine: { curl: 0.72 }, hand_l: { mode: "rest", grip: "relax" }, hand_r: { mode: "rest", grip: "relax" }, gaze: { target: "down", headPitchDeg: 18 }, face: { warm_smile: 0.7 } },
        { at: 2.6, effort: "soft", stance: { weightShift: 0, squat: 0.02 }, spine: { curl: 0.0 }, hand_l: { mode: "rest" }, hand_r: { mode: "rest" }, gaze: { target: "camera", headPitchDeg: 0 }, face: { smile: 0.65 } },
      ],
    },
  },
]

const outDir = path.resolve(".tmp/rig-stress")
fs.mkdirSync(outDir, { recursive: true })

for (const model of [
  { id: "topaz", pmx: "public/models/topaz/topaz.pmx" },
  { id: "caelus", pmx: "public/models/caelus/男主1.0.pmx" },
]) {
  const bones = parsePmxBones(new Uint8Array(fs.readFileSync(model.pmx)))
  const profile = buildRigProfile(bones, model.id)
  console.log(`\n=== MODEL: ${model.id} (slices=${Object.keys(bones.boneSlices ?? {}).length}, snapped=${Object.keys(bones.snappedSurfaces ?? {}).length}) ===`)
  for (const c of CASES) {
    const res = solveMotionIntent(c.intent, profile, bones)
    const vmdPath = path.join(outDir, `${model.id}_${c.name}.vmd`)
    fs.writeFileSync(vmdPath, res.vmd)
    const critic = critiquePoseVmd(bones, res.vmd, "", [{ index: 0, start: 0, end: res.durationSec }])
    const audit = auditVmd(res.vmd, bones)
    console.log(
      `  ${c.name.padEnd(24)} | ${String(res.solveTimeMs).padStart(5)}ms | keys=${String(res.decimatedKeyCount).padStart(4)} | critic=${critic?.passed ? "PASS" : "FAIL(" + (critic?.issues.map(i => i.code).join(",") ?? "null") + ")"} | auditViolations=${audit.violations.length}`,
    )
  }
}
