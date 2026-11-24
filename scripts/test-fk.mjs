#!/usr/bin/env node
// test-fk.mjs — Layer 1+2 验证：几何测量注入 conditioning + FK 地面接触分析
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { detectPosSemantics, measureModelGeometry } from "../src/lib/model-geometry.ts"
import { buildModelConditioning } from "../src/lib/model-conditioning.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld, analyzeGroundContactKeys } from "../src/lib/fk.ts"

await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()

const bones = parsePmxBones(new Uint8Array(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url))))

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}

// ---------------------------------------------------------------- Layer 1
console.log("[1] 几何测量 + conditioning 注入")
test("语义检测：topaz = absolute", () => {
  assert.equal(detectPosSemantics(bones), "absolute")
})
test("测量数字与 pmx-info 一致", () => {
  const m = measureModelGeometry(bones)
  assert.equal(m.heightCm, 170)
  assert.equal(m.hipY, 8)
  assert.equal(m.armLenUnits, 6.46)
  assert.equal(m.legLenUnits, 10.71)
  assert.equal(m.headY, 18.03)
  assert.equal(m.footY, 1.49)
})
test("conditioning 文本包含 Geometry 与使用指引", () => {
  const c = buildModelConditioning(bones)
  assert.match(c.text, /Geometry: height ≈170cm/)
  assert.match(c.text, /center move down ≈8u/)
  assert.match(c.text, /The ground is y=0/)
  assert.ok(c.measurements.armLenUnits > 0)
})
test("静止姿势 FK：頭/センター 世界 y 与 bind 一致", () => {
  const world = solveFrameWorld(bones, new Map(), "absolute")
  const headIdx = bones.indexByJp.get("頭")
  const centerIdx = bones.indexByJp.get("センター")
  assert.ok(Math.abs(world[headIdx].y - 18.03) < 0.02)
  assert.ok(Math.abs(world[centerIdx].y - 8) < 0.02)
})

// ---------------------------------------------------------------- Layer 2
console.log("[2] FK 地面接触分析")
// 修正版蟹式：base 后仰 90° 的枢轴在地面，放平后 センター 已在 y≈0 → move up 3 抬臀（旧版 move down 6 会穿地）
const crabMpl = `@pose crab_base {
    base bend backward 90;
    center move up 3, bend backward 10;
    neck bend forward 20;
    head bend forward 10;
    shoulder_l bend backward 80;
    shoulder_r bend backward 80;
    arm_l bend backward 85;
    arm_r bend backward 85;
    elbow_l bend forward 10;
    elbow_r bend forward 10;
    wrist_l bend backward 30;
    wrist_r bend backward 30;
    leg_l bend forward 70, sway left 25;
    leg_r bend forward 70, sway right 25;
    knee_l bend backward 130;
    knee_r bend backward 130;
    ankle_l bend forward 40;
    ankle_r bend forward 40;
}

@animation crab {
    0.8: crab_base;
    1.6: crab_base;
}

main {
    crab;
}
`
test("蟹式撑地：FK 抓住 move down 穿地错误并验证修正（闭环）", () => {
  // 旧版（move down 6）被 FK 判定穿地：base 后仰 90° 的枢轴在地面，
  // 放平后 センター 已在 y≈0，再下移 6 → y=-6。修正为 move up 3 抬臀。
  const oldMpl = crabMpl.replace("center move up 3", "center move down 6")
  const oldReport = analyzeGroundContactKeys(bones, readVmdBoneKeys(compileMPL2(compiler, oldMpl).vmd))
  assert.ok(oldReport && oldReport.frames.some((f) => (f.centerY ?? 0) < -3), "old version should sink below ground — FK must catch it")

  const { vmd } = compileMPL2(compiler, crabMpl)
  const keys = readVmdBoneKeys(vmd)
  assert.ok(keys && keys.length > 0)
  const report = analyzeGroundContactKeys(bones, keys)
  assert.ok(report, "analysis should not fail")
  const f24 = report.frames.find((f) => f.frame === 24)
  assert.ok(f24, "frame 24 (0.8s) missing")
  assert.ok(f24.centerY != null && Math.abs(f24.centerY - 3) < 1.5, `center raised: got ${f24.centerY}, expect ≈3`)
  assert.ok(report.penetrationFrames === 0, `corrected crab should not penetrate: ${report.summary}`)
  console.log(`    → frame24 手腕 y=${Object.entries(f24.terminals).filter(([k]) => k.includes("手首")).map(([, v]) => v).join("/")} | 足首 y=${Object.entries(f24.terminals).filter(([k]) => k.includes("足首") && !k.includes("手")).map(([, v]) => v).join("/")} | 腰 y=${f24.centerY}`)
  console.log(`    → 结论: ${report.summary}`)
})
test("站立挥手：双脚不漂移（足首 y 保持 ≈1.49）", () => {
  const mpl = `@pose wave_r {
    shoulder_r bend backward 30, sway left 20;
    arm_r bend backward 60;
    elbow_r bend forward 90;
    wrist_r sway left 20;
}

@animation wave {
    0.5: wave_r;
    1.5: wave_r;
}

main {
    wave;
}
`
  const { vmd } = compileMPL2(compiler, mpl)
  const report = analyzeGroundContactKeys(bones, readVmdBoneKeys(vmd))
  assert.ok(report)
  for (const f of report.frames) {
    const ankleL = f.terminals["左足首"], ankleR = f.terminals["右足首"]
    assert.ok(ankleL != null && Math.abs(ankleL - 1.49) < 0.3, `ankle_l drifted: ${ankleL}`)
    assert.ok(ankleR != null && Math.abs(ankleR - 1.49) < 0.3, `ankle_r drifted: ${ankleR}`)
  }
  const raised = report.frames.every((f) => (f.terminals["右手首"] ?? 0) > 8)
  assert.ok(raised, "right wrist should be raised while waving")
})
test("穿地检测：center move down 20 → 腰部穿地告警", () => {
  const mpl = `@pose sunk {
    center move down 20;
    arm_l reset;
    arm_r reset;
}

@animation sunk_anim {
    1: sunk;
}

main {
    sunk_anim;
}
`
  const { vmd } = compileMPL2(compiler, mpl)
  const report = analyzeGroundContactKeys(bones, readVmdBoneKeys(vmd))
  assert.ok(report)
  const sunk = report.frames.find((f) => f.frame === 30)
  assert.ok(sunk && sunk.centerY != null && sunk.centerY < 0, `center below ground expected, got ${sunk?.centerY}`)
  assert.ok(report.penetrationFrames > 0, "penetration should be flagged")
  assert.match(report.summary, /penetration/)
})
test("异常输入稳健性：垃圾字节返回 null 不抛错", () => {
  const report = analyzeGroundContactKeys(bones, [{ jp: "頭", frame: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] }])
  assert.ok(report) // 合法键可用
  const bad = analyzeGroundContactKeys(bones, [{ jp: "不存在的骨骼", frame: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] }])
  assert.ok(bad) // 未知骨骼只是 terminals 缺失，不失败
  assert.equal(readVmdBoneKeys(new Uint8Array([1, 2, 3])), null)
})

console.log(`\n${passed} tests passed${process.exitCode ? " (WITH FAILURES)" : ""}`)
