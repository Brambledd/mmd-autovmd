#!/usr/bin/env node
// dbg-akimbo-verify.mjs — 新叉腰挥手全套验证：穿地/挥幅/叉腰落点/胶囊审计/碰撞
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld, analyzeGroundContact } from "../src/lib/fk.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()
const bones = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))
const script = readFileSync(new URL("../examples/akimbo-wave-topaz.mpl", import.meta.url), "utf8")

const res = compileMPL2(compiler, script)
console.log(`编译: vmd=${res.vmd.length}B collisions=${res.collisions.length} baseRotated=${res.baseRotated} morphKeys=${res.morphCount}`)

// 1) 地面接触
const g = analyzeGroundContact(bones, res.vmd)
console.log(`穿地: ${g.penetrationFrames} 帧 | ${g.summary}`)

// 2) 逐帧检查：叉腰手到腰侧距离 + 挥手手高度/横向位置
const keys = readVmdBoneKeys(res.vmd)
const rest = solveFrameWorld(bones, new Map(), "absolute")
const iWaist = bones.indexByJp.get("腰")
const waveFrames = [18, 26, 36, 47, 57, 69] // 0.6/0.87/1.2/1.57/1.9/2.3s 附近的采样
let maxAkimboD = 0
let minHandX = 1e9, maxHandX = -1e9
for (const f of waveFrames) {
  const at = new Map()
  for (const k of keys ?? []) if (k.frame <= f) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  const rHand = w[bones.indexByJp.get("右手首")]
  const lHand = w[bones.indexByJp.get("左手首")]
  const waist = w[iWaist]
  const d = Math.hypot(rHand.x - (waist.x - 1.2), rHand.y - (waist.y - 0.5), rHand.z - waist.z) * 8
  maxAkimboD = Math.max(maxAkimboD, d)
  minHandX = Math.min(minHandX, lHand.x)
  maxHandX = Math.max(maxHandX, lHand.x)
  console.log(`f${String(f).padStart(2)}: 右手(叉腰)=(${rHand.x.toFixed(2)}, ${rHand.y.toFixed(2)}) 距腰侧 ${d.toFixed(1)}cm | 左手(挥手) x=${lHand.x.toFixed(2)} y=${lHand.y.toFixed(2)} z=${lHand.z.toFixed(2)}`)
}
console.log(`挥手横向弧度: ${(maxHandX - minHandX) * 8}cm`)

// 3) 胶囊审计
const audit = auditVmd(res.vmd, bones)
console.log(`胶囊审计: violation=${audit.violations.length} auto-fixed=${audit.fixed.length}`)
if (audit.violations.length > 0) console.log(formatAudit(audit))
function formatAudit(a) {
  return a.violations.slice(0, 5).map((v) => JSON.stringify(v)).join("\n")
}
