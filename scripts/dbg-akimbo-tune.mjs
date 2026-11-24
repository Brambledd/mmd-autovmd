#!/usr/bin/env node
// dbg-akimbo-tune.mjs — 叉腰臂参数搜索：让右手落到右髋附近，且不触发胶囊审计
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld } from "../src/lib/fk.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()
const bones = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))

// 参考点：rest 姿势下 腰 / センター / 下半身 的世界坐标
const rest = solveFrameWorld(bones, new Map(), "absolute")
const iWaist = bones.indexByJp.get("腰")
const iCenter = bones.indexByJp.get("センター")
const iLower = bones.indexByJp.get("下半身")
console.log(`rest: 腰=(${rest[iWaist].x.toFixed(2)}, ${rest[iWaist].y.toFixed(2)}, ${rest[iWaist].z.toFixed(2)})`)
console.log(`rest: センター=(${rest[iCenter].x.toFixed(2)}, ${rest[iCenter].y.toFixed(2)}, ${rest[iCenter].z.toFixed(2)})`)
console.log(`rest: 下半身=(${rest[iLower].x.toFixed(2)}, ${rest[iLower].y.toFixed(2)}, ${rest[iLower].z.toFixed(2)})`)

const cands = [
  ["shB10 swL30 e100", "shoulder_r bend backward 10, sway left 30;\n    elbow_r bend forward 100;\n    wrist_r bend forward 15;"],
  ["shB15 swL35 e110", "shoulder_r bend backward 15, sway left 35;\n    elbow_r bend forward 110;\n    wrist_r bend forward 15;"],
  ["shF10 swL35 e110", "shoulder_r bend forward 10, sway left 35;\n    elbow_r bend forward 110;\n    wrist_r bend forward 15;"],
  ["shB10 swL40 e120", "shoulder_r bend backward 10, sway left 40;\n    elbow_r bend forward 120;\n    wrist_r bend forward 20;"],
  ["shB05 swL35 e115", "shoulder_r bend backward 5, sway left 35;\n    elbow_r bend forward 115;\n    wrist_r bend forward 20;"],
  ["shF15 swL40 e115", "shoulder_r bend forward 15, sway left 40;\n    elbow_r bend forward 115;\n    wrist_r bend forward 20;"],
]

for (const [name, arm] of cands) {
  const script = `@pose a {\n    ${arm}\n}\n\n@animation w {\n    0: a;\n}\n\nmain {\n    w;\n}\n`
  const res = compileMPL2(compiler, script)
  if (res.vmd.length === 0) { console.log(`${name}: compile 0B`); continue }
  const keys = readVmdBoneKeys(res.vmd)
  const at = new Map()
  for (const k of keys) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  const hand = w[bones.indexByJp.get("右手首")]
  const dWaist = Math.hypot(hand.x - rest[iWaist].x, hand.y - rest[iWaist].y, hand.z - rest[iWaist].z) * 8
  const dLower = Math.hypot(hand.x - rest[iLower].x, hand.y - rest[iLower].y, hand.z - rest[iLower].z) * 8
  const audit = auditVmd(res.vmd, bones)
  console.log(`${name}: 手=(${hand.x.toFixed(2)}, ${hand.y.toFixed(2)}, ${hand.z.toFixed(2)}) | 距腰=${dWaist.toFixed(0)}cm 距下半身=${dLower.toFixed(0)}cm | 审计violation=${audit.violations.length} retreat=${audit.fixed.length}`)
}
