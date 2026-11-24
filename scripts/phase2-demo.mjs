#!/usr/bin/env node
// phase2-demo.mjs — collision pre-check + per-model conditioning, verified on real PMX data.
// Run: node scripts/phase2-demo.mjs
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"
import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { auditVmd, formatAuditReport, skeletonAt } from "../src/lib/pose-audit.ts"
import { enhanceVmdDetailed, parseVmd } from "../src/lib/vmd-enhancer.ts"
import { buildModelConditioning } from "../src/lib/model-conditioning.ts"

const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()

const bones = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))
console.log(`model: ${bones.modelName} | bones=${bones.bones.length} rigids=${bones.rigids.length} faceMorphs=${bones.faceMorphs.length}`)

// FK sanity: with identity keys the evaluated skeleton must equal rest positions.
{
  const identityKeys = bones.bones.map((b) => ({
    frame: 0,
    pos: [0, 0, 0],
    quat: { x: 0, y: 0, z: 0, w: 1 },
    name: new Uint8Array(15),
    jp: b.jp,
    curve: { x1: 20, y1: 20, x2: 107, y2: 107 },
  }))
  const world = skeletonAt(bones, identityKeys, 0)
  let maxErr = 0
  for (const b of bones.bones) {
    const p = world.get(b.jp)
    maxErr = Math.max(maxErr, Math.abs(p[0] - b.pos[0]), Math.abs(p[1] - b.pos[1]), Math.abs(p[2] - b.pos[2]))
  }
  console.log(`FK identity check: max |world-rest| = ${maxErr.toExponential(2)} (expect ~1e-6)`)
}

const clip = (body) => `@pose start {
    arm_l reset;
    arm_r reset;
    elbow_l reset;
    elbow_r reset;
    upper_body reset;
    center reset;
}
@pose act {
${body}
}
@animation a {
    0: start;
    1: act;
}
main {
    a;
}
`

const cases = [
  { name: "wave hand (realistic, expect clean)", mpl: `@pose wave_start {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway left 20;
}
@pose wave_left {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway left 30;
}
@animation wave {
    0: wave_start;
    0.3: wave_left;
    0.6: wave_start;
}
main {
    wave;
}
` },
  { name: "sit (realistic, expect clean)", mpl: clip(`    center move down 3;
    leg_l bend forward 90;
    leg_r bend forward 90;
    knee_l bend backward 90;
    knee_r bend backward 90;
    arm_l bend forward 25;
    arm_r bend forward 25;
    elbow_l bend forward 40;
    elbow_r bend forward 40;`) },
  { name: "hand through chest (expect violation + auto-fix)", mpl: clip(`    arm_l bend forward 70;
    elbow_l bend forward 135;
    upper_body turn left 20;`) },
  { name: "hands rest between knees (realistic, expect clean)", mpl: clip(`    center move down 3;
    leg_l bend forward 90;
    leg_r bend forward 90;
    knee_l bend backward 90;
    knee_r bend backward 90;
    upper_body bend forward 20;
    arm_l bend forward 35, sway right 40;
    arm_r bend forward 35, sway left 40;
    elbow_l bend forward 130;
    elbow_r bend forward 130;
    wrist_l sway right 15;
    wrist_r sway left 15;`) },
  { name: "extreme elbow fold (verified clean at default calibration)", mpl: clip(`    upper_body bend backward 10;
    arm_l bend backward 70, sway right 30;
    elbow_l bend forward 140;`) },
]

for (const c of cases) {
  const compiled = compiler.compile(c.mpl)

  // Strict-radii demo on the borderline pose: fatter capsules catch grazes.
  if (c.name.startsWith("hands rest between knees")) {
    const strict = auditVmd(compiled, bones, { radiiScale: 1.6 })
    console.log(`  [strict ×1.6] violations=${strict.violations.length} fixed=${strict.fixed.length} ${strict.violations.length > 0 ? "| " + formatAuditReport(strict).split("\n")[0] : ""}`)
  }

  // Print the audit's own FK geometry for the jam case.
  if (c.name.startsWith("elbow jammed")) {
    const pv = parseVmd(compiled)
    const last = Math.max(...pv.boneKeys.map((k) => k.frame))
    const world = skeletonAt(bones, pv.boneKeys, last)
    const fmt = (v) => Array.from(v).map((x) => x.toFixed(2)).join(",")
    for (const jp of ["首", "左腕", "左ひじ", "左手首"]) {
      console.log(`  [fk] ${jp}: ${fmt(world.get(jp))}`)
    }
  }

  const result = auditVmd(compiled, bones)
  const stillValid = (() => {
    try {
      compiler.reverse_compile("vmd", result.vmd)
      return true
    } catch {
      return false
    }
  })()
  const enhanced = enhanceVmdDetailed(result.vmd)
  console.log(`=== ${c.name} ===`)
  console.log(`bytes ${compiled.length} -> audited ${result.vmd.length} -> enhanced ${enhanced.vmd.length} | frames checked: ${result.checkedFrames} | reverse-valid: ${stillValid}`)
  if (result.violations.length === 0) console.log("violations: none")
  else console.log(formatAuditReport(result))
}

// Per-model conditioning: topaz vs caelus (男主1.0).
console.log("\n=== conditioning: topaz ===")
console.log(buildModelConditioning(bones).text)
console.log("\n=== conditioning: 星穹铁道-男主 (caelus) ===")
const caelus = parsePmxBones(readFileSync(new URL("../public/models/caelus/男主1.0.pmx", import.meta.url)))
console.log(buildModelConditioning(caelus).text)
