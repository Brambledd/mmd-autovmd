#!/usr/bin/env node
// dbg-wave-trace.mjs — 挥手质量分析：左手腕世界轨迹 / 摆动平面 / 振幅
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld } from "../src/lib/fk.ts"

const script = readFileSync(new URL("../.tmp-akimbo-debug.mpl", import.meta.url), "utf8")
await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()

const bones = parsePmxBones(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url)))
const res = compileMPL2(compiler, script)
const keys = readVmdBoneKeys(res.vmd)

// 关键帧时刻：0, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.5 (s) → 帧
const marks = [
  [0, "ready"], [18, "up(w+20)"], [27, "l(w+30)"], [36, "r(w-10,e72)"],
  [45, "l(w+30)"], [54, "r(w-10,e72)"], [63, "l(w+30)"], [75, "hold"],
]
const trace = []
for (const [f, label] of marks) {
  const at = new Map()
  for (const k of keys ?? []) if (k.frame === f) at.set(k.jp, k)
  const w = solveFrameWorld(bones, at, "absolute")
  if (!w) { console.log(`frame ${f}: FK null`); continue }
  const hand = bones.indexByJp.get("左手首")
  const elbow = bones.indexByJp.get("左ひじ")
  const shoulder = bones.indexByJp.get("左肩")
  const handP = w[hand], elbowP = w[elbow], shP = w[shoulder]
  trace.push({ f, label, hand: handP })
  console.log(
    `f${String(f).padStart(3)} ${label.padEnd(12)} 左手首 xyz=(${handP.x.toFixed(2)}, ${handP.y.toFixed(2)}, ${handP.z.toFixed(2)})` +
    ` | 肘=(${elbowP.x.toFixed(2)}, ${elbowP.y.toFixed(2)}, ${elbowP.z.toFixed(2)})`
  )
}

// 挥动段（frame 27..63）的轨迹跨度
const wavePts = trace.filter((p) => p.f >= 27 && p.f <= 63).map((p) => p.hand)
const span = (ax) => Math.max(...wavePts.map((p) => p[ax])) - Math.min(...wavePts.map((p) => p[ax]))
const mid = (ax) => (Math.max(...wavePts.map((p) => p[ax])) + Math.min(...wavePts.map((p) => p[ax]))) / 2
console.log(`\n挥动段轨迹跨度：左右向 X=${span("x").toFixed(2)}u (${(span("x") * 8).toFixed(0)}cm) | 上下向 Y=${span("y").toFixed(2)}u (${(span("y") * 8).toFixed(0)}cm) | 前后向 Z=${span("z").toFixed(2)}u (${(span("z") * 8).toFixed(0)}cm)`)
console.log(`轨迹中心偏移：X中点=${mid("x").toFixed(2)}（肩 x=${trace[0] ? "" : ""}参考） Y中点=${mid("y").toFixed(2)}u`)
