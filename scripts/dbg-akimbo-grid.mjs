#!/usr/bin/env node
// dbg-akimbo-grid.mjs — 叉腰臂网格搜索：肩(bend/sway/turn) × 肘(bend) → 右手贴近右腰侧
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

// 目标：右腰侧（腰骨外侧面向外 ~1.4u，稍低于腰骨）
const target = { x: rest[iWaist].x - 1.4, y: rest[iWaist].y - 0.6, z: rest[iWaist].z }

const bends = [-20, -10, 0, 10] // backward(+)/forward(-) 试探：MPL bend backward N / bend forward N
const sways = [10, 20, 30]
const turns = [-25, -15, 0, 15, 25] // MPL turn left(+)/right(-)？符号两边都试
const elbows = [95, 110, 125, 140]

const results = []
for (const B of bends) for (const S of sways) for (const T of turns) for (const E of elbows) {
  const bStr = B >= 0 ? `bend backward ${B}` : `bend forward ${-B}`
  const tStr = T > 0 ? `turn left ${T}` : T < 0 ? `turn right ${-T}` : null
  const st = [`shoulder_r ${bStr}, sway left ${S}`]
  if (tStr) st[0] += `, ${tStr}`
  const script = `@pose a {\n    ${st[0]};\n    arm_r bend backward 10;\n    elbow_r bend forward ${E};\n    wrist_r bend forward 20;\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`
  let res
  try { res = compileMPL2(compiler, script) } catch { continue }
  if (res.vmd.length === 0) continue
  const keys = readVmdBoneKeys(res.vmd)
  const at = new Map()
  for (const k of keys) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  const hand = w[bones.indexByJp.get("右手首")]
  const d = Math.hypot(hand.x - target.x, hand.y - target.y, hand.z - target.z) * 8
  results.push({ d, str: `${st[0]}; arm_r bend backward 10; elbow_r bend forward ${E}; wrist_r bend forward 20;`, hand })
}

results.sort((a, b) => a.d - b.d)
console.log(`目标点: (${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)})，共 ${results.length} 组合`)
for (const r of results.slice(0, 8)) {
  console.log(`d=${r.d.toFixed(1)}cm | 手=(${r.hand.x.toFixed(2)}, ${r.hand.y.toFixed(2)}, ${r.hand.z.toFixed(2)}) | ${r.str}`)
}
