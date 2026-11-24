#!/usr/bin/env node
/**
 * benchmark-harness.mjs — Phase 1 Harness 自动化质量基线评测
 *
 * 默认离线模式（零 LLM 成本）：评测全量 19 条词库原语 + 8 个典型高难度复合姿势，
 * 输出编译通过率、运动学 Critic 通过率、手型/表情丰富度、穿模率。
 *
 * 加上 `--live` 标志可额外评测运行中的 http://localhost:4000/api/pose-generate-long：
 *   node scripts/benchmark-harness.mjs --live
 */

import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones, serializePmxBones } from "../src/lib/pmx-bones.ts"
import { buildModelConditioning } from "../src/lib/model-conditioning.ts"
import { compileMPL2, ensureMain } from "../src/lib/mpl2.ts"
import { critiquePoseVmd } from "../src/lib/pose-critic.ts"
import { POSE_EXEMPLARS } from "../src/lib/pose-exemplars.ts"
import { renderPoseMultiViewPng } from "../src/lib/pose-renderer.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"
import { finalizeMotion } from "../src/lib/motion-finalize.ts"
import { LEXICON } from "../src/lib/motion-lexicon.ts"
import { parseMorphFrames } from "../src/lib/vmd-morph.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()
const topaz = parsePmxBones(new Uint8Array(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url))))

const GOLDEN_POSES = [
  {
    name: "giggle_mouth_akimbo",
    mpl: `@pose s0 {\n  waist reset;\n  upper_body2 reset;\n}\n@pose p {\n  waist bend forward 10, turn right 8;\n  upper_body2 bend forward 15, sway left 5;\n  knee_l bend backward 10;\n  knee_r bend backward 10;\n  plant feet;\n  reach hand_r to mouth;\n  hand_r cup;\n  reach hand_l to hip_l;\n  hand_l akimbo;\n  aim head at camera;\n  face 笑い 0.7;\n  face 照れ 0.5;\n}\n@animation a {\n  0: s0;\n  0.8: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "half_kneel_touch",
    mpl: `@pose s0 {\n  center reset;\n}\n@pose p {\n  center move down 2;\n  leg_l bend forward 80, sway left 5;\n  knee_l bend backward 95;\n  leg_r bend backward 10;\n  knee_r bend backward 150;\n  plant feet;\n  upper_body2 bend backward 5;\n  reach hand_r to knee_l;\n  hand_r relax;\n  reach hand_l to hip_l;\n  aim head at camera;\n  face にこり 0.7;\n}\n@animation a {\n  0: s0;\n  1.0: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "peace_wink_lean",
    mpl: `@pose s0 {\n  waist reset;\n}\n@pose p {\n  waist sway left 5, turn right 10;\n  upper_body2 bend forward 10;\n  reach hand_r to cheek_r + [-0.4, 0, -0.3];\n  hand_r peace;\n  reach hand_l to hip_l;\n  hand_l akimbo;\n  aim head at camera;\n  face ウィンク 0.9;\n  face にこり 0.8;\n}\n@animation a {\n  0: s0;\n  0.7: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "salute_confident",
    mpl: `@pose s0 {\n  upper_body2 reset;\n}\n@pose p {\n  upper_body2 bend backward 5, turn right 10;\n  reach hand_r to salute_r;\n  hand_r open;\n  reach hand_l to hip_l;\n  aim head at camera;\n  face ｷﾘｯ 0.7;\n}\n@animation a {\n  0: s0;\n  0.6: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "shy_two_hands_cheek",
    mpl: `@pose s0 {\n  upper_body2 reset;\n}\n@pose p {\n  upper_body2 bend forward 10, sway right 5;\n  head sway left 10;\n  reach hand_l to cheek_l;\n  reach hand_r to cheek_r;\n  hand_l cup;\n  hand_r cup;\n  face 照れ 0.9;\n  face はぅ 0.6;\n}\n@animation a {\n  0: s0;\n  0.7: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "point_camera_pose",
    mpl: `@pose s0 {\n  waist reset;\n}\n@pose p {\n  waist turn left 15;\n  upper_body2 bend forward 8, turn left 10;\n  reach hand_r to front_r;\n  hand_r point;\n  reach hand_l to hip_l;\n  aim head at camera;\n  face にやり２ 0.7;\n}\n@animation a {\n  0: s0;\n  0.6: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "fist_cheer_pose",
    mpl: `@pose s0 {\n  upper_body2 reset;\n}\n@pose p {\n  upper_body2 bend backward 10;\n  reach hand_l to wave_l;\n  reach hand_r to wave_r;\n  hand_l fist;\n  hand_r fist;\n  aim head at camera;\n  face 笑い 0.9;\n  face ワ 0.5;\n}\n@animation a {\n  0: s0;\n  0.6: p;\n}\nmain {\n  a;\n}`,
  },
  {
    name: "lie_back_relaxed",
    mpl: `@pose s0 {\n  base reset;\n}\n@pose p {\n  base bend backward 90;\n  center move up 1;\n  leg_l sway right 8;\n  leg_r sway left 8;\n  knee_l bend backward 10;\n  knee_r bend backward 10;\n  reach hand_l to hip_l + [0.4, -0.8, 0.5];\n  reach hand_r to hip_r + [-0.4, -0.8, 0.5];\n  hand_l relax;\n  hand_r relax;\n  face にこり 0.6;\n}\n@animation a {\n  0: s0;\n  1.2: p;\n}\nmain {\n  a;\n}`,
  },
]

console.log("=== Offline Golden Harness Benchmark ===")
let okCount = 0
const allCases = [
  ...LEXICON.map((l) => ({ name: `lexicon:${l.name}`, mpl: `${l.build({})}\nmain {\n  ${l.build({}).match(/@animation\s+(\w+)/)[1]};\n}` })),
  ...POSE_EXEMPLARS.map((ex) => ({ name: `exemplar:${ex.id}`, mpl: ensureMain(ex.mpl) })),
  ...GOLDEN_POSES.map((g) => ({ name: `golden:${g.name}`, mpl: g.mpl })),
]

for (const tc of allCases) {
  const res = compileMPL2(compiler, tc.mpl, topaz)
  const critic = critiquePoseVmd(topaz, res.vmd, tc.mpl, undefined, { sampling: "keyframes" })
  const audit = auditVmd(res.vmd, topaz)
  const enh = finalizeMotion(audit.vmd, topaz, { mplSource: tc.mpl, enhanceOptions: { autoBlink: true } }).vmd
  const criticAfter = critiquePoseVmd(topaz, enh, tc.mpl)
  const rendered = tc.name.startsWith("golden:") ? renderPoseMultiViewPng(topaz, res.vmd) : true
  const morphs = parseMorphFrames(enh)
  const ok =
    res.vmd.length > 0 &&
    res.directiveErrors.length === 0 &&
    critic?.passed === true &&
    criticAfter?.passed === true &&
    enh.length > 0 &&
    Boolean(rendered)
  if (ok) okCount++
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${tc.name.padEnd(32)} | ik=${String(res.ikOps).padStart(2)} hand=${res.handPresets} morph=${String(morphs.length).padStart(2)} auditViol=${audit.violations.length} | ${criticAfter?.summary}`
  )
}
console.log(`\nOffline Score: ${okCount}/${allCases.length} passed (${((okCount / allCases.length) * 100).toFixed(1)}%)`)
if (okCount !== allCases.length) process.exitCode = 1

if (process.argv.includes("--live")) {
  const enableVisual = process.argv.includes("--visual")
  console.log(`\n=== Live LLM Harness Benchmark (http://localhost:4000${enableVisual ? ", visualCritic=ON" : ""}) ===`)
  const conditioning = buildModelConditioning(topaz).text
  const modelBones = serializePmxBones(topaz)
  const livePrompts = [
    "双手叉腰自信地看着我",
    "往前倾身子，右手捂嘴偷笑，左手叉腰，眼神看镜头",
    "比着剪刀手歪头wink微笑",
    "单膝蹲下并伸手扶住膝盖，微笑抬头看我",
    "微笑着回头看我，单手叉腰",
    "害羞地双手捧着脸脸红低头",
  ]
  let liveOk = 0
  for (const desc of livePrompts) {
    const t0 = Date.now()
    const r = await fetch("http://localhost:4000/api/pose-generate-long", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: desc, conditioning, modelBones, visualCritic: enableVisual }),
    })
    const dt = ((Date.now() - t0) / 1000).toFixed(1)
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.mpl) {
      console.log(`FAIL  "${desc}" -> HTTP ${r.status} (${dt}s)`)
      continue
    }
    const res = compileMPL2(compiler, j.mpl, topaz)
    const critic = critiquePoseVmd(topaz, res.vmd, j.mpl, j.timeline, { sampling: "keyframes" })
    const enh = finalizeMotion(auditVmd(res.vmd, topaz).vmd, topaz, { mplSource: j.mpl, enhanceOptions: { autoBlink: true } }).vmd
    const criticAfter = critiquePoseVmd(topaz, enh, j.mpl, j.timeline)
    const rag = (j.plan?.segments ?? []).flatMap((s) => s.exemplars ?? []).join(",") || "-"
    const vc = j.visualCritic
      ? ` vlm=${j.visualCritic.status}${j.visualCritic.score != null ? `(${j.visualCritic.score}/10)` : ""}${j.visualCritic.refined ? "+refined" : ""}`
      : ""
    const ok = res.vmd.length > 0 && res.directiveErrors.length === 0 && critic?.passed === true && criticAfter?.passed === true
    if (ok) liveOk++
    console.log(
      `${ok ? "PASS" : "FAIL"}  "${desc}" (${dt}s) | ik=${res.ikOps} hand=${res.handPresets} morph=${res.morphCount} rag=[${rag}] repairs=${j.fk?.repairs?.length ?? 0}${vc} | ${critic?.summary}`
    )
  }
  console.log(`\nLive Score: ${liveOk}/${livePrompts.length} passed`)
  if (liveOk !== livePrompts.length) process.exitCode = 1
}
