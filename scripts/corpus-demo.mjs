#!/usr/bin/env node
// corpus-demo.mjs — Phase 3 ⑥+⑧B verification: corpus pipeline + idle loop.
// Run: node scripts/corpus-demo.mjs
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"
import Encoding from "encoding-japanese"
import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { buildCorpusEntry, parseVpd } from "../src/lib/motion-corpus.ts"
import { buildIdleVmd } from "../src/lib/idle-motion.ts"
import { parseVmd, enhanceVmd } from "../src/lib/vmd-enhancer.ts"
import { LEXICON_MAP } from "../src/lib/motion-lexicon.ts"

const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()
const bones = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))

// ---- helpers
const sjis = (s) => Uint8Array.from(Encoding.convert(Encoding.stringToCode(s), { to: "SJIS", from: "UNICODE" }))
const axisQuat = (ax, deg) => {
  const r = (deg * Math.PI) / 180
  const s = Math.sin(r / 2)
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1
  return [ax[0] / l * s, ax[1] / l * s, ax[2] / l * s, Math.cos(r / 2)]
}

// ---- Sample A: hand-authored VPD (what a captured pose file looks like)
const vpdPose = (i, jp, quat) =>
  `Bone${i}{${jp}\n  0.000000,0.000000,0.000000;\t\t// trans x,y,z\n  ${quat.map((v) => v.toFixed(6)).join(",")};\t// Quaternion\n}\n`
const vpdText =
  "Vocaloid Pose Data file\n\n" +
  "topaz.pmx;\t\t// model\n" +
  "3;\t\t// bone count\n\n" +
  vpdPose(0, "右腕", axisQuat([0, 0, 1], 60)) +
  vpdPose(1, "右ひじ", axisQuat([0.6, -0.8, 0], 90)) +
  vpdPose(2, "右手首", axisQuat([0, 0, -1], 20))
const vpdBytes = sjis(vpdText)
const parsedVpd = parseVpd(vpdBytes)
console.log(`VPD parsed: ${parsedVpd.map((p) => p.jp).join(", ")} (bones=${parsedVpd.length})`)

const entryA = buildCorpusEntry({ compiler, bones, name: "corpus_wave", source: { kind: "vpd", bytes: vpdBytes }, holdSeconds: 1 })
console.log(`\n=== A. VPD → fragment (${entryA ? "ok" : "FAILED"}) ===`)
if (entryA) {
  console.log(`duration=${entryA.duration}s | audit: ${entryA.audit.report}`)
  console.log("--- fragment ---")
  console.log(entryA.fragment)
}

// ---- Sample B: lexicon fragment → mpl2 compile (runtime pipeline) → VMD → corpus round-trip
const waveMpl = LEXICON_MAP["wave_hand"].build({ cycles: 2, face: 0.8 })
const { compileMPL2 } = await import("../src/lib/mpl2.ts")
const waveVmd = compileMPL2(compiler, waveMpl).vmd
const entryB = buildCorpusEntry({ compiler, bones, name: "corpus_wave_rt", source: { kind: "vmd", bytes: waveVmd }, intervalFrames: 6 })
console.log(`\n=== B. lexicon→VMD→downsample→fragment (${entryB ? "ok" : "FAILED"}) ===`)
if (entryB) {
  console.log(`vmd frames ${entryB.framesBefore} -> ${entryB.framesAfter} | duration=${entryB.duration}s | audit: ${entryB.audit.report}`)
  const poseCount = (entryB.fragment.match(/@pose/g) ?? []).length
  const hasMain = /main\s*\{/.test(entryB.fragment)
  const singleAnim = (entryB.fragment.match(/@animation/g) ?? []).length === 1
  console.log(`contract: poses=${poseCount} single-animation=${singleAnim} main-stripped=${!hasMain}`)
}

// ---- Sample C: idle loop — seamless wrap + audit + structural validity
const idle = buildIdleVmd({ seconds: 8 })
const idleParsed = parseVmd(idle.vmd)
const upperKeys = idleParsed.boneKeys.filter((k) => k.jp === "上半身").sort((a, b) => a.frame - b.frame)
const first = upperKeys[0]
const last = upperKeys[upperKeys.length - 1]
const seam = Math.hypot(first.quat.x - last.quat.x, first.quat.y - last.quat.y, first.quat.z - last.quat.z, first.quat.w - last.quat.w)
// audit the idle VMD directly
const { auditVmd } = await import("../src/lib/pose-audit.ts")
const idleAuditResult = auditVmd(idle.vmd, bones)
const idleReverseOk = (() => {
  try {
    compiler.reverse_compile("vmd", idle.vmd)
    return true
  } catch {
    return false
  }
})()
console.log(`\n=== C. idle loop ===`)
console.log(`bytes=${idle.vmd.length} frames=${idle.frames} keys=${idle.keys} | seam |Δq(frame0→frameN)|=${seam.toExponential(2)} (expect ~0)`)
console.log(`audit: ${idleAuditResult.violations.length} violations | reverse-valid: ${idleReverseOk}`)

// idle runs through the Phase 1 enhancer without damage
const idleEnhanced = enhanceVmd(idle.vmd)
console.log(`enhancer passthrough: ${idle.vmd.length} -> ${idleEnhanced.length} bytes (identity curves already soft)`)
