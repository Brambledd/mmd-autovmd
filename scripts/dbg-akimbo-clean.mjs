#!/usr/bin/env node
// dbg-akimbo-clean.mjs — 在"胶囊审计 0 违例"约束下找最优叉腰参数
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld } from "../src/lib/fk.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()
const bones = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))
const rest = solveFrameWorld(bones, new Map(), "absolute")
const iWaist = bones.indexByJp.get("腰")

const mkScript = (F, S, T, AB, E, WF) =>
  `@pose a {\n    head turn left 10;\n    shoulder_r bend forward ${F}, sway left ${S}, turn left ${T};\n` +
  `    arm_r bend backward ${AB};\n    elbow_r bend forward ${E};\n    wrist_r bend forward ${WF};\n` +
  `    shoulder_l bend backward 20;\n    arm_l bend backward 45;\n    elbow_l bend forward 115;\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`

const clean = []
for (const F of [25, 30, 35]) for (const S of [30, 35, 40]) for (const T of [35, 45, 55]) for (const AB of [10, 20]) for (const E of [75, 80, 85, 90, 95]) for (const WF of [10, 25]) {
  const script = mkScript(F, S, T, AB, E, WF)
  let res
  try { res = compileMPL2(compiler, script) } catch { continue }
  if (res.vmd.length === 0) continue
  const audit = auditVmd(res.vmd, bones)
  if (audit.violations.length > 0) continue
  const keys = readVmdBoneKeys(res.vmd)
  const at = new Map()
  for (const k of keys) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  const hand = w[bones.indexByJp.get("右手首")]
  const waist = w[iWaist]
  const d = Math.hypot(hand.x - (waist.x - 1.2), hand.y - (waist.y - 0.5), hand.z - waist.z) * 8
  clean.push({ d, F, S, T, AB, E, WF, hand })
}

clean.sort((a, b) => a.d - b.d)
console.log(`审计干净的组合 ${clean.length} 个，最优 8 个：`)
for (const r of clean.slice(0, 8)) {
  console.log(`d=${r.d.toFixed(1)}cm | sh=(fwd${r.F},swL${r.S},tL${r.T}) arm_bwd=${r.AB} e=${r.E} wrist_fwd=${r.WF} | 手=(${r.hand.x.toFixed(2)}, ${r.hand.y.toFixed(2)}, ${r.hand.z.toFixed(2)})`)
}
