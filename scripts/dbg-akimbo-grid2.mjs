#!/usr/bin/env node
// dbg-akimbo-grid2.mjs — 叉腰搜索 v2：+躯干侧倾（肩腰互相靠近）+ 更宽臂姿
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

const leans = [0, 10, 15] // upper_body sway right N
const shB = [0, 20, 40]
const shS = [10, 20, 30]
const shT = [-25, -10, 0, 10, 25]
const elbow = [100, 120, 140]

const results = []
for (const L of leans) for (const B of shB) for (const S of shS) for (const T of shT) for (const E of elbow) {
  const tStr = T > 0 ? `, turn left ${T}` : T < 0 ? `, turn right ${-T}` : ""
  const script =
    `@pose a {\n    upper_body sway right ${L};\n    shoulder_r bend backward ${B}, sway left ${S}${tStr};\n` +
    `    arm_r bend backward 10;\n    elbow_r bend forward ${E};\n    wrist_r bend forward 20;\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`
  let res
  try { res = compileMPL2(compiler, script) } catch { continue }
  if (res.vmd.length === 0) continue
  const keys = readVmdBoneKeys(res.vmd)
  const at = new Map()
  for (const k of keys) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  const hand = w[bones.indexByJp.get("右手首")]
  const waist = w[iWaist]
  // 目标随躯干倾斜移动：腰世界坐标向外侧偏 1.4u、向下 0.6u
  const target = { x: waist.x - 1.4, y: waist.y - 0.6, z: waist.z }
  const d = Math.hypot(hand.x - target.x, hand.y - target.y, hand.z - target.z) * 8
  results.push({ d, L, B, S, T, E, hand })
}

results.sort((a, b) => a.d - b.d)
console.log(`共 ${results.length} 组合，最优 10 组：`)
for (const r of results.slice(0, 10)) {
  const tStr = r.T > 0 ? `, turn left ${r.T}` : r.T < 0 ? `, turn right ${-r.T}` : ""
  console.log(
    `d=${r.d.toFixed(1)}cm | lean=${r.L} sh=(bwd${r.B},swL${r.S}${tStr}) e=${r.E} | 手=(${r.hand.x.toFixed(2)}, ${r.hand.y.toFixed(2)}, ${r.hand.z.toFixed(2)})`
  )
}
// 最优组合跑胶囊审计
const best = results[0]
const tStr = best.T > 0 ? `, turn left ${best.T}` : best.T < 0 ? `, turn right ${-best.T}` : ""
const script =
  `@pose a {\n    upper_body sway right ${best.L};\n    shoulder_r bend backward ${best.B}, sway left ${best.S}${tStr};\n` +
  `    arm_r bend backward 10;\n    elbow_r bend forward ${best.E};\n    wrist_r bend forward 20;\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`
const res = compileMPL2(compiler, script)
const audit = auditVmd(res.vmd, bones)
console.log(`最优组合胶囊审计: violation=${audit.violations.length} retreat=${audit.fixed.length}`)
