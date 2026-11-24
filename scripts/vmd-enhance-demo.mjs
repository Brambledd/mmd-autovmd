#!/usr/bin/env node
// vmd-enhance-demo.mjs — Phase 1 verification: compile MPL → enhance VMD → validate.
// Run: node scripts/vmd-enhance-demo.mjs
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"
import { enhanceVmdDetailed } from "../src/lib/vmd-enhancer.ts"

const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()

// Motion A: upper-body only (no leg keys) — leg IK must be re-enabled.
const waveMpl = `@pose wave_start {
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
@pose wave_right {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway right 10;
}
@animation wave {
    0: wave_start;
    0.3: wave_left;
    0.6: wave_right;
    0.9: wave_left;
    1.2: wave_right;
    1.5: wave_start;
}
main {
    wave;
}
`

// Motion B: legs keyed — leg IK must stay disabled (FK as authored).
const sitMpl = `@pose stand {
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
}
@pose sit {
    leg_l bend forward 90;
    leg_r bend forward 90;
    knee_l bend backward 90;
    knee_r bend backward 90;
}
@animation sitting {
    0: stand;
    1: sit;
}
main {
    sitting;
}
`

function rawInterpOf(vmd, index) {
  const off = 54 + index * 111 + 47
  return [vmd[off], vmd[off + 4], vmd[off + 8], vmd[off + 12]].join(",")
}

function report(name, mpl) {
  const before = compiler.compile(mpl)
  const { vmd: after, stats } = enhanceVmdDetailed(before)

  console.log(`\n=== ${name} ===`)
  console.log(
    `bytes ${before.length} -> ${after.length} | frames ${stats.framesBefore} -> ${stats.framesAfter}` +
      ` | anticipation +${stats.insertedAnticipation} overshoot +${stats.insertedOvershoot} settle +${stats.insertedSettle}` +
      ` | staggered bones ${stats.staggeredBones} | legIK re-enabled: ${stats.legIkReenabled}`
  )

  // Curve check: first key's rotation channel was (64,0,63,127) hardcoded, now from the library.
  console.log(`curve(key0 rotation channel x1,y1,x2,y2): ${rawInterpOf(before, 0)} -> ${rawInterpOf(after, 0)}`)

  // Structural validation: the reverse compiler must parse the enhanced VMD.
  const reversed = compiler.reverse_compile("vmd", after)
  const poses = (reversed.match(/@pose/g) ?? []).length
  const bones = (reversed.match(/shoulder_r|wrist_r|knee_l/g) ?? []).length
  console.log(`reverse_compile(validated): ${poses} poses, ${bones} tracked-bone statements — OK`)

  // Timeline of one key bone to eyeball anticipation -> attack -> overshoot -> settle.
  const dv = new DataView(after.buffer, after.byteOffset, after.byteLength)
  const count = dv.getUint32(50, true)
  const rows = []
  for (let i = 0; i < count; i++) {
    const o = 54 + i * 111
    const name = new TextDecoder("shift_jis").decode(after.subarray(o, o + 15)).replace(/\0.*$/, "")
    if (name !== "右手首") continue
    const frame = dv.getUint32(o + 15, true)
    const q = [1, 2, 3, 4].map((k) => dv.getFloat32(o + 27 + k * 4, true))
    rows.push({ frame, q })
  }
  rows.sort((a, b) => a.frame - b.frame)
  const q0 = rows[0]?.q
  const ang = (q) => {
    const d = Math.min(1, Math.abs(q0[0] * q[0] + q0[1] * q[1] + q0[2] * q[2] + q0[3] * q[3]))
    return ((2 * Math.acos(d) * 180) / Math.PI).toFixed(1)
  }
  console.log(
    `右手首 timeline (deg vs rest): ` +
      rows.map((r) => `f${r.frame}:${ang(r.q)}°`).join("  ")
  )
}

report("wave hand (upper-body only)", waveMpl)
report("sit (legs keyed)", sitMpl)

// Robustness: garbage input must pass through unchanged.
const junk = new Uint8Array([1, 2, 3])
console.log(`\nrobustness(garbage input): ${enhanceVmdDetailed(junk).vmd === junk ? "passthrough OK" : "FAIL"}`)
