#!/usr/bin/env node
// test-phase1.mjs — Phase 1 端到端验证：宏展开 → 词库展开 → 缝合 → wasm 编译 → 反编译往返
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import init, { WasmMPLCompiler } from "mmd-mpl"

import { desugarMPL, mirrorStatementLine } from "../src/lib/mpl-macros.ts"
import { LEXICON, LEXICON_MAP, expandLexiconSegment, fragmentDuration } from "../src/lib/motion-lexicon.ts"
import { stitchSegments, normalizePlan, extractJSON, STITCH_GAP } from "../src/lib/long-motion.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"

// ---------------------------------------------------------------- wasm init
const wasmBytes = readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url))
await init(wasmBytes)
const compiler = new WasmMPLCompiler()
// 片段没有 main 块时编译器产出 0 帧（to_key_frames 以 main 为入口），补一个再编译；
// 词库片段现含 face 语句（Phase 2），一律走 compileMPL2 完整管道（宏→组合→face 剥离→wasm→morph 注入）
const compileFrag = (frag) => {
  const animName = frag.match(/@animation\s+(\w+)/)?.[1]
  assert.ok(animName, "fragment has no @animation block")
  const { vmd } = compileMPL2(compiler, `${frag}\nmain {\n    ${animName};\n}\n`)
  assert.ok(vmd.length > 0, "compileMPL2 returned empty VMD")
  return vmd
}
const compileOK = (mpl) => {
  const bytes = compiler.compile(mpl)
  assert.ok(bytes.length > 0, "compile returned empty VMD")
  return bytes
}

let passed = 0
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}

// ---------------------------------------------------------------- 1. 宏展开
console.log("[1] mpl-macros")
test("mirror: 方向词与骨骼后缀互换", () => {
  assert.equal(mirrorStatementLine("arm_l turn left 30;"), "arm_r turn right 30;")
  assert.equal(mirrorStatementLine("leg_l sway left 180;"), "leg_r sway right 180;")
  assert.equal(mirrorStatementLine("head bend forward 20;"), "head bend forward 20;")
  assert.equal(mirrorStatementLine("wrist_r sway right 10, turn left 5;"), "wrist_l sway left 10, turn right 5;")
})
test("repeat: 3 次循环，接缝同时刻帧按先写者优先去重", () => {
  const r = desugarMPL("#repeat 3 {\n0: a;\n0.5: b;\n}")
  const times = [...r.output.matchAll(/^\s*([\d.]+)\s*:/gm)].map((m) => m[1])
  assert.deepEqual(times, ["0", "0.5", "1", "1.5"])
  assert.equal(r.repeat, 1)
})
test("speed: 2 倍速减半时间戳", () => {
  const r = desugarMPL("#speed 2 {\n0: a;\n0.6: b;\n}")
  assert.match(r.output, /0: a;/)
  assert.match(r.output, /0\.3: b;/)
})
test("hold: 末帧姿势保持", () => {
  const r = desugarMPL("#hold 2 {\n0: a;\n0.6: b;\n}")
  assert.match(r.output, /2\.6: b;/)
})
test("无指令时原文通过", () => {
  const src = "@pose a {\n    head reset;\n}"
  assert.equal(desugarMPL(src).output, src)
})

// ---------------------------------------------------------------- 2. 词库
console.log("[2] motion-lexicon（全部原语逐个过 wasm 编译器 = 极限表真值校验）")
for (const prim of LEXICON) {
  test(`compile ${prim.name}`, () => {
    const frag = prim.build({})
    compileFrag(frag)
    assert.ok(fragmentDuration(frag) > 0, "fragmentDuration should be > 0")
  })
}
test("词库参数边界：wave_hand cycles=6 amp=1.5", () => {
  compileFrag(LEXICON_MAP.wave_hand.build({ cycles: 6, amplitude: 1.5 }))
})
test("词库参数边界：jumping_jack cycles=8", () => {
  compileFrag(LEXICON_MAP.jumping_jack.build({ cycles: 8 }))
})
test("词库参数越界被钳制：bow depth=500 → 90", () => {
  const seg = expandLexiconSegment("bow", { depth: 500 })
  assert.match(seg.fragment, /bend forward 90;/)
})
test("镜像分段可编译且左右翻转", () => {
  const seg = expandLexiconSegment("wave_hand", { cycles: 1 }, true)
  assert.match(seg.fragment, /arm_l bend backward 60;/) // arm_r → arm_l
  compileFrag(seg.fragment)
})
test("未知动作返回 null", () => {
  assert.equal(expandLexiconSegment("moonwalk"), null)
})

// ---------------------------------------------------------------- 3. Plan 归一化
console.log("[3] plan 归一化")
test("未知动作：模糊匹配 + custom 兜底保留（不丢弃）", () => {
  const json = extractJSON(`{"segments":[{"action":"wave"},{"action":"fly_to_moon"},{"action":"BOW","params":{"depth":60}}]}`)
  const plan = normalizePlan(json, LEXICON.map((m) => m.name))
  assert.deepEqual(plan.segments.map((s) => s.action), ["wave_hand", "fly_to_moon", "bow"])
  // wave → 模糊匹配警告；fly_to_moon → 保留为 custom 段（Stage 2 LLM 兜底）；BOW → 小写直配无警告
  assert.equal(plan.warnings.length, 1)
  assert.ok(plan.warnings[0].includes(`matched to "wave_hand"`))
  assert.equal(plan.segments[1].custom, true)
})
test("custom 段上限 8，超出丢弃并警告", () => {
  const segs = Array.from({ length: 9 }, (_, i) => ({ action: `act_${i}` }))
  const json = extractJSON(JSON.stringify({ segments: segs }))
  const plan = normalizePlan(json, LEXICON.map((m) => m.name))
  const customs = plan.segments.filter((s) => s.custom)
  assert.equal(customs.length, 8)
  assert.ok(plan.warnings.some((w) => w.includes("custom cap 8")))
})
test("段数与总时长钳制", () => {
  const segs = Array.from({ length: 100 }, () => ({ action: "idle_stand", duration: 5 }))
  const plan = normalizePlan({ segments: segs }, LEXICON.map((m) => m.name))
  assert.ok(plan.segments.length <= 40)
  assert.ok(plan.totalDuration <= 120 + 5)
})

// ---------------------------------------------------------------- 4. 缝合 + 全链路
console.log("[4] stitch + 端到端（长动作 30s+）")
const scenario = [
  expandLexiconSegment("wave_hand", { cycles: 2 }),
  expandLexiconSegment("bow", { depth: 45 }),
  expandLexiconSegment("sit", { deep: 1 }),
  expandLexiconSegment("look_around", { cycles: 2 }),
  expandLexiconSegment("stand_up"),
  expandLexiconSegment("jumping_jack", { cycles: 3 }),
  expandLexiconSegment("punch"),
  expandLexiconSegment("wave_hand", { cycles: 1 }, true),
]
const stitched = stitchSegments(scenario.map((s) => ({ fragment: s.fragment, duration: s.duration })))

test("接缝 GAP 正确（0.25s）", () => {
  assert.equal(stitched.timeline[1].start - stitched.timeline[0].end, STITCH_GAP)
})
test("时间轴单调递增", () => {
  for (let i = 1; i < stitched.timeline.length; i++) {
    assert.ok(stitched.timeline[i].start >= stitched.timeline[i - 1].end, `segment ${i} overlaps`)
  }
})
test("缝合后脚本过 wasm 编译", () => {
  const mpl2 = compileMPL2(compiler, stitched.script)
  console.log(`    → 总时长 ${stitched.totalDuration}s, VMD ${mpl2.vmd.length} bytes, morph ${mpl2.morphCount} 帧`)
})
test("反编译往返：单动画 + 首尾时间戳一致", () => {
  const { vmd } = compileMPL2(compiler, stitched.script)
  const reversed = compiler.reverse_compile("vmd", vmd)
  const animBlock = reversed.match(/@animation extracted_animation \{([\s\S]*?)\n\}/)?.[1] ?? ""
  const times = [...animBlock.matchAll(/^\s*([\d.]+)\s*:/gm)].map((m) => parseFloat(m[1]))
  const isIncreasing = times.every((t, i) => i === 0 || t > times[i - 1])
  assert.ok(isIncreasing, `timestamps not increasing: ${times.slice(0, 8)}`)
  assert.equal(times[0], 0)
  // VMD 是 30fps 整数帧网格（12.15s×30=364.5 帧会被截断），容差 1 帧
  assert.ok(Math.abs(times[times.length - 1] - stitched.totalDuration) <= 1 / 30 + 1e-6,
    `last frame ${times[times.length - 1]} != total ${stitched.totalDuration}`)
  console.log(`    → 反编译 ${times.length} 关键帧, 首帧 ${times[0]}s, 末帧 ${times[times.length - 1]}s`)
})
test("无 main 多动画碰撞（只有 long_sequence 一个动画引用）", () => {
  const { output } = desugarMPL(stitched.script)
  const animNames = [...output.matchAll(/@animation\s+(\w+)/g)].map((m) => m[1])
  assert.deepEqual(animNames, ["long_sequence"])
})

console.log(`\n${passed} tests passed${process.exitCode ? " (WITH FAILURES)" : ""}`)
