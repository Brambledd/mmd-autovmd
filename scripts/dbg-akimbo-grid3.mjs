#!/usr/bin/env node
// dbg-akimbo-grid3.mjs — 定向扫描：肩 turn 扩大到 65 + arm/wrist 扭转，目标=腰侧面
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

const shT = [25, 35, 45, 55, 65]
const shF = [20, 30] // bend forward
const shS = [25, 30, 35]
const armT = [-30, 0, 30]
const armB = [0, 10]
const elbow = [85, 95, 105]
const wristS = [-15, 0, 15]

const results = []
for (const T of shT) for (const F of shF) for (const S of shS) for (const AT of armT) for (const AB of armB) for (const E of elbow) for (const WS of wristS) {
  const atS = AT > 0 ? `, turn left ${AT}` : AT < 0 ? `, turn right ${-AT}` : ""
  const wsS = WS > 0 ? `, sway left ${WS}` : WS < 0 ? `, sway right ${-WS}` : ""
  const script =
    `@pose a {\n    shoulder_r bend forward ${F}, sway left ${S}, turn left ${T};\n` +
    `    arm_r bend backward ${AB}${atS};\n    elbow_r bend forward ${E};\n    wrist_r bend forward 20${wsS};\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`
  let res
  try { res = compileMPL2(compiler, script) } catch { continue }
  if (res.vmd.length === 0) continue
  const keys = readVmdBoneKeys(res.vmd)
  const at = new Map()
  for (const k of keys) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  const hand = w[bones.indexByJp.get("右手首")]
  const waist = w[iWaist]
  const target = { x: waist.x - 1.2, y: waist.y - 0.5, z: waist.z }
  const d = Math.hypot(hand.x - target.x, hand.y - target.y, hand.z - target.z) * 8
  results.push({ d, F, S, T, AT, AB, E, WS, hand })
}

results.sort((a, b) => a.d - b.d)
console.log(`共 ${results.length} 组合，最优 8 组：`)
for (const r of results.slice(0, 8)) {
  const atS = r.AT > 0 ? `, turn left ${r.AT}` : r.AT < 0 ? `, turn right ${-r.AT}` : ""
  const wsS = r.WS > 0 ? `, sway left ${r.WS}` : r.WS < 0 ? `, sway right ${-r.WS}` : ""
  console.log(`d=${r.d.toFixed(1)}cm | sh=(fwd${r.F},swL${r.S},tL${r.T}) arm=(bwd${r.AB}${atS}) e=${r.E} wrist=(fwd20${wsS}) | 手=(${r.hand.x.toFixed(2)}, ${r.hand.y.toFixed(2)}, ${r.hand.z.toFixed(2)})`)
}
// 最优跑审计
const b = results[0]
const atS = b.AT > 0 ? `, turn left ${b.AT}` : b.AT < 0 ? `, turn right ${-b.AT}` : ""
const wsS = b.WS > 0 ? `, sway left ${b.WS}` : b.WS < 0 ? `, sway right ${-b.WS}` : ""
const script =
  `@pose a {\n    shoulder_r bend forward ${b.F}, sway left ${b.S}, turn left ${b.T};\n` +
  `    arm_r bend backward ${b.AB}${atS};\n    elbow_r bend forward ${b.E};\n    wrist_r bend forward 20${wsS};\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`
const audit = auditVmd(res.vmd, bones)
console.log(`最优组合胶囊审计: violation=${audit.violations.length} retreat=${audit.fixed.length}`)
