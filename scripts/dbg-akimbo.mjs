#!/usr/bin/env node
// dbg-akimbo.mjs — 实测用户贴的 akimbo_wave 脚本：编译 + FK 地面接触 + 关键帧高度
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { analyzeGroundContact, solveFrameWorld, readVmdBoneKeys } from "../src/lib/fk.ts"

const script = readFileSync(new URL("../.tmp-akimbo-debug.mpl", import.meta.url), "utf8")

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()

for (const model of ["topaz", "梵天2"]) {
  const path = model === "topaz"
    ? "../public/models/topaz/topaz.pmx"
    : "../public/models/深空之眼-梵天2/深空之眼-梵天2.pmx"
  const bones = parsePmxBones(readFileSync(new URL(path, import.meta.url)))
  console.log(`\n===== ${model} =====`)

  let res
  try {
    res = compileMPL2(compiler, script)
  } catch (e) {
    console.log("compile threw:", e.message)
    continue
  }
  console.log(`vmd=${res.vmd.length}B | baseRotated=${res.baseRotated} | collisions=${res.collisions.length}`)
  if (res.vmd.length === 0) continue

  const report = analyzeGroundContact(bones, res.vmd)
  if (!report) { console.log("FK 分析返回 null"); continue }
  console.log(`穿地帧=${report.penetrationFrames}/${report.frames?.length ?? "?"} | ${report.summary}`)

  // 逐姿势看关键末端高度（0=stand_ready, 0.6=up, 2.5=hold）
  const keys = readVmdBoneKeys(res.vmd)
  const watch = ["センター", "腰", "左足首", "左足首D", "左足先EX", "右手首", "右手首D", "左手首"]
  for (const f of [0, 18, 75]) {
    const at = new Map()
    for (const k of keys ?? []) {
      if (k.frame <= f) at.set(k.jp, k) // 最近的关键帧（引擎按帧插值，这里取≤f 的最后一条做近似）
    }
    const world = solveFrameWorld(bones, at, bones.posSemantics ?? "absolute")
    if (!world) { console.log(`frame ${f}: FK 返回 null`); continue }
    const parts = []
    for (const jp of watch) {
      const b = bones.indexByJp.get(jp)
      if (b == null) continue
      parts.push(`${jp}=y${world[b]?.y?.toFixed(2) ?? "?"}`)
    }
    console.log(`frame ${f} (t=${(f / 30).toFixed(1)}s): ${parts.join("  ")}`)
  }
}
