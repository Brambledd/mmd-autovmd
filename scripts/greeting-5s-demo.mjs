#!/usr/bin/env node
// greeting-5s-demo.mjs — 5-second multi-gesture test: MPL → compile → enhance → validate.
// Produces examples/greeting-5s.vmd (enhanced) and prints polish statistics.
// Run: node scripts/greeting-5s-demo.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"
import { enhanceVmdDetailed } from "../src/lib/vmd-enhancer.ts"

const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()

const mpl = readFileSync(new URL("../examples/greeting-5s.mpl", import.meta.url), "utf8")

const before = compiler.compile(mpl)
const { vmd: after, stats } = enhanceVmdDetailed(before)

console.log(`MPL ${mpl.length} chars -> VMD ${before.length} B -> enhanced ${after.length} B`)
console.log(
  `keyframes ${stats.framesBefore} -> ${stats.framesAfter}` +
    ` | anticipation +${stats.insertedAnticipation} overshoot +${stats.insertedOvershoot} settle +${stats.insertedSettle}` +
    ` | staggered bones ${stats.staggeredBones} | legIK re-enabled: ${stats.legIkReenabled}`
)

// Structural validation through the reverse compiler (must parse enhanced output).
const reversed = compiler.reverse_compile("vmd", after)
console.log(`reverse_compile: ${(reversed.match(/@pose/g) ?? []).length} poses parsed — structure OK`)

// Dump per-bone key timelines (frame numbers + angle vs rest) for the star bones.
const dec = new TextDecoder("shift_jis")
const dv = new DataView(after.buffer, after.byteOffset, after.byteLength)
const count = dv.getUint32(50, true)
const tracks = new Map()
let maxFrame = 0
for (let i = 0; i < count; i++) {
  const o = 54 + i * 111
  const jp = dec.decode(after.subarray(o, o + 15)).split("\0")[0]
  const frame = dv.getUint32(o + 15, true)
  const q = [0, 1, 2, 3].map((k) => dv.getFloat32(o + 31 + k * 4, true))
  maxFrame = Math.max(maxFrame, frame)
  if (!tracks.has(jp)) tracks.set(jp, [])
  tracks.get(jp).push({ frame, q })
}
console.log(`duration: f0 -> f${maxFrame} = ${(maxFrame / 30).toFixed(2)}s @30fps`)
for (const jp of ["右手首", "頭", "腰"]) {
  const rows = (tracks.get(jp) ?? []).sort((a, b) => a.frame - b.frame)
  if (!rows.length) continue
  const q0 = rows[0].q
  const line = rows
    .map(({ frame, q }) => {
      const d = Math.min(1, Math.abs(q0[0] * q[0] + q0[1] * q[1] + q0[2] * q[2] + q0[3] * q[3]))
      return `f${frame}:${((2 * Math.acos(d) * 180) / Math.PI).toFixed(0)}°`
    })
    .join(" ")
  console.log(`${jp}: ${line}`)
}

// Emit the enhanced VMD for direct use (dev server serves public/ at /demo/...).
mkdirSync(new URL("../public/demo/", import.meta.url), { recursive: true })
writeFileSync(new URL("../examples/greeting-5s.vmd", import.meta.url), after)
writeFileSync(new URL("../public/demo/greeting-5s.vmd", import.meta.url), after)
console.log(`written: examples/greeting-5s.vmd + public/demo/greeting-5s.vmd`)
