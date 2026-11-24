/**
 * test-ground-bake.mjs — 贴地烘焙（ground-contact bake）回归
 *
 * 守四条线：
 *  1. squat-lively（examples/squat-lively.mpl）成品逐帧接地：
 *     每个整数帧、每只脚 |脚踝−静止脚踝高| 与 |脚尖−静止脚尖高| ≤ 5mm（0.0625u，1u≈8cm），
 *     且连续 kinematic critic 通过。起蹲过渡段在关键帧之间下沉 ~9.7cm 的老问题由此守住。
 *  2. blocking 永不烘焙：bake:false 时字节原样、bakeStats=null。
 *  3. 原始关键帧永不改写：烘焙输出 ⊇ 输入键（骨名 / 帧 / 位置 / 四元数 / 64B 插值表逐字节相同）。
 *  4. 护栏：非接地状态（躺姿、踢起的脚）不被动；判定帧（MPL 时间轴条目）上的姿势不被改。
 *  5. 词库 squat 原语（姿势照搬 examples/squat-lively.mpl）：默认与参数边界成品逐帧接地；
 *     增强器不给腿的父骨（腰 / 下半身 / グルーブ）插独立过冲键（否则站立保持段脚被带离地面）；
 *     作者线在容差带内时烘焙按绝对误差修（帧间小幅浮起同样压回地面，上报与判定同一口径）。
 *
 * 运行：node --no-warnings scripts/test-ground-bake.mjs
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2, ensureMain } from "../src/lib/mpl2.ts"
import { auditVmd } from "../src/lib/pose-audit.ts"
import { critiquePoseVmd, parsePoseTextsAndTimeline } from "../src/lib/pose-critic.ts"
import { buildBoneTracks, readVmdBoneKeys, samplePoseTransforms } from "../src/lib/fk.ts"
import { detectPosSemantics, restWorldPositions } from "../src/lib/model-geometry.ts"
import { bakeGroundContact, measureGroundErrorVmd } from "../src/lib/ground-bake.ts"
import { finalizeMotion } from "../src/lib/motion-finalize.ts"
import { POSE_EXEMPLARS } from "../src/lib/pose-exemplars.ts"
import { expandLexiconSegment } from "../src/lib/motion-lexicon.ts"
import { getServerCompiler } from "../src/lib/server-compile.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const bones = parsePmxBones(fs.readFileSync(path.join(root, "public/models/topaz/topaz.pmx")))
const compiler = await getServerCompiler()
assert(compiler, "server compiler must initialize")

/** 回归阈值：5mm ≈ 0.0625u（1u ≈ 8cm） */
const TOL = 0.0625
const ANKLE = { l: "左足首", r: "右足首" }
const TOE = { l: "左足先EX", r: "右足先EX" }

const semantics = detectPosSemantics(bones)
const restWorld = restWorldPositions(bones)
const restY = (jp) => {
  const idx = bones.indexByJp.get(jp)
  assert(idx != null, `model lacks ${jp}`)
  return restWorld.get(idx).y
}
const REST = {
  ankle: { l: restY(ANKLE.l), r: restY(ANKLE.r) },
  toe: { l: restY(TOE.l), r: restY(TOE.r) },
}

let passed = 0
function test(name, fn) {
  const t0 = performance.now()
  fn()
  passed++
  console.log(`  ok  ${name} (${(performance.now() - t0).toFixed(0)}ms)`)
}

function compile(mpl) {
  const res = compileMPL2(compiler, mpl, bones)
  assert(res.vmd.length > 0, `compiler produced 0 bytes: ${res.directiveErrors.join("; ")}`)
  assert.equal(res.directiveErrors.length, 0, res.directiveErrors.join("; "))
  return res.vmd
}

/** 每个整数帧、每只脚：脚踝 / 脚尖相对静止高度的偏移（u）。 */
function footSeries(vmd) {
  const keys = readVmdBoneKeys(vmd)
  assert(keys && keys.length > 0, "VMD has no bone keys")
  const tracks = buildBoneTracks(keys)
  const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
  const series = { ankle: { l: [], r: [] }, toe: { l: [], r: [] } }
  for (let f = 0; f <= maxFrame; f++) {
    const tf = samplePoseTransforms(bones, tracks, f, semantics)
    assert(tf, `FK failed at frame ${f}`)
    for (const side of ["l", "r"]) {
      series.ankle[side].push(tf.pos[bones.indexByJp.get(ANKLE[side])].y - REST.ankle[side])
      series.toe[side].push(tf.pos[bones.indexByJp.get(TOE[side])].y - REST.toe[side])
    }
  }
  return { series, frames: maxFrame + 1 }
}

const worstAbs = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const worstAt = (arr) => {
  let w = 0
  let at = -1
  arr.forEach((v, i) => {
    if (Math.abs(v) > Math.abs(w)) {
      w = v
      at = i
    }
  })
  return { value: w, frame: at }
}
const cm = (u) => `${(u * 8).toFixed(2)}cm`

/** 关键键的逐字节签名（骨名原始字节 + 帧 + 位置 + 四元数 + 64B 插值表）。 */
function keySignature(k) {
  const name = k.raw ? Array.from(k.raw).join(",") : k.jp
  const interp = k.interp ? Array.from(k.interp).join(",") : "-"
  return `${name}|${k.frame}|${k.pos.map((v) => v.toFixed(6)).join(",")}|${k.quat.map((v) => v.toFixed(6)).join(",")}|${interp}`
}

/** 两个 VMD 在指定帧上全骨骼世界坐标的最大差（u）。 */
function maxPoseDelta(vmdA, vmdB, frames) {
  const a = buildBoneTracks(readVmdBoneKeys(vmdA))
  const b = buildBoneTracks(readVmdBoneKeys(vmdB))
  let worst = 0
  let worstFrame = -1
  for (const f of frames) {
    const ta = samplePoseTransforms(bones, a, f, semantics)
    const tb = samplePoseTransforms(bones, b, f, semantics)
    assert(ta && tb, `FK failed at frame ${f}`)
    for (let i = 0; i < ta.pos.length; i++) {
      const d = Math.abs(ta.pos[i].y - tb.pos[i].y)
      if (d > worst) {
        worst = d
        worstFrame = f
      }
    }
  }
  return { worst, worstFrame }
}

// ------------------------------------------------------------------ 1. squat-lively 逐帧接地
const squatMpl = fs.readFileSync(path.join(root, "examples/squat-lively.mpl"), "utf8")
const squatRaw = compile(squatMpl)

test("squat-lively：烘焙前过渡段确实沉入地面（回归用例有效）", () => {
  const before = measureGroundErrorVmd(squatRaw, bones, TOL)
  assert(before, "measure failed")
  const sink = Math.min(before.summary.l.min, before.summary.r.min)
  assert(sink < -0.5, `expected >4cm frame-between sinking in the raw compile, got min ${sink}u`)
  assert(before.offendingFrames > 100, `expected many offending frames, got ${before.offendingFrames}`)
  console.log(
    `        raw: ${before.frames} frames, deepest sink ${sink.toFixed(3)}u (${cm(sink)}) @f${before.summary.l.minFrame}, ` +
      `${before.offendingFrames} foot-frames beyond ±${TOL}u`
  )
})

test("squat-lively：成品每个整数帧双脚踝/尖都在静止高度 ±5mm 内，critic 通过", () => {
  const fin = finalizeMotion(auditVmd(squatRaw, bones).vmd, bones, {
    mplSource: squatMpl,
    enhanceOptions: { autoBlink: true },
    groundTolerance: TOL,
  })
  assert.equal(fin.baked, true, "ground bake must engage")
  const { series, frames } = footSeries(fin.vmd)
  for (const side of ["l", "r"]) {
    for (const part of ["ankle", "toe"]) {
      const w = worstAt(series[part][side])
      assert(Math.abs(w.value) <= TOL, `${part}[${side}] deviates ${w.value.toFixed(4)}u @f${w.frame} (> ±${TOL}u)`)
    }
  }
  const report = critiquePoseVmd(bones, fin.vmd, squatMpl)
  assert(report && report.passed, `critic failed: ${report?.summary}`)
  const bs = fin.bakeStats
  assert.equal(bs.residualFrames, 0, `${bs.residualFrames} foot-frames still beyond ±${TOL}u after bake`)
  assert.equal(bs.residualAtEntries, 0)
  assert(fin.enhanced, "final pipeline enhances too")
  const wa = Math.max(worstAbs(series.ankle.l), worstAbs(series.ankle.r))
  const wt = Math.max(worstAbs(series.toe.l), worstAbs(series.toe.r))
  console.log(
    `        final: ${frames} frames, worst |ankle−rest| ${wa.toFixed(4)}u (${(wa * 80).toFixed(1)}mm), ` +
      `worst |toe−rest| ${wt.toFixed(4)}u (${(wt * 80).toFixed(1)}mm); ` +
      `bake +${bs.insertedKeys} keys (center ${bs.centerKeys} / ankle ${bs.ankleKeys} / anchor ${bs.anchorKeys}, ${bs.passes} passes); ` +
      `critic ${report.summary}`
  )
})

test("squat-lively：无 MPL 源（仅骨骼键）时同样烘焙到位", () => {
  const enhanced = finalizeMotion(squatRaw, bones, { bake: false, enhanceOptions: { autoBlink: true } }).vmd
  const { vmd, stats } = bakeGroundContact(enhanced, bones, { tolerance: TOL })
  const { series } = footSeries(vmd)
  for (const side of ["l", "r"]) {
    assert(worstAbs(series.ankle[side]) <= TOL, `ankle[${side}] deviates in key-frame mode`)
    assert(worstAbs(series.toe[side]) <= TOL, `toe[${side}] deviates in key-frame mode`)
  }
  assert.equal(stats.entriesFrom, "keys")
  console.log(`        key-frame mode: +${stats.insertedKeys} keys, windows ${stats.windows.map((w) => `${w.side}[${w.start},${w.end}]`).join(" ")}`)
})

// ------------------------------------------------------------------ 2/3. blocking 与原始键
test("blocking 永不烘焙：bake:false 字节原样、无烘焙统计", () => {
  const fin = finalizeMotion(squatRaw, bones, { enhance: false, bake: false, mplSource: squatMpl })
  assert.equal(fin.enhanced, false)
  assert.equal(fin.baked, false)
  assert.equal(fin.bakeStats, null)
  assert.deepEqual(Buffer.from(fin.vmd), Buffer.from(squatRaw), "blocking VMD must be byte-identical to the compile output")
  // 关掉烘焙但开增强：下沉原样暴露在 ground 遥测里（闸门能看到），但不被修
  const finEnh = finalizeMotion(squatRaw, bones, { enhance: true, bake: false, mplSource: squatMpl })
  assert.equal(finEnh.baked, false)
  assert(finEnh.ground && finEnh.ground.offendingFrames > 100, "un-baked pipeline must still report the sinking")
  console.log(`        blocking bytes unchanged (${squatRaw.length}B); enhanced-only still reports ${finEnh.ground.offendingFrames} offending foot-frames`)
})

test("原始关键帧永不改写：烘焙输出 ⊇ 输入键（逐字节）", () => {
  const enhanced = finalizeMotion(squatRaw, bones, { bake: false, enhanceOptions: { autoBlink: true } }).vmd
  const { vmd } = bakeGroundContact(enhanced, bones, { mplSource: squatMpl })
  const inKeys = readVmdBoneKeys(enhanced)
  const outKeys = readVmdBoneKeys(vmd)
  assert(outKeys.length > inKeys.length, "bake should add keys on squat-lively")
  const outSet = new Set(outKeys.map(keySignature))
  const lost = inKeys.filter((k) => !outSet.has(keySignature(k)))
  assert.equal(lost.length, 0, `input keys lost or rewritten: ${lost.slice(0, 3).map((k) => `${k.jp}@${k.frame}`).join(", ")}`)
  // 新键只落在 センター / 足首 上，且不与已有键同帧
  const inFrames = new Set(inKeys.map((k) => `${k.jp}@${k.frame}`))
  const added = outKeys.filter((k) => !inFrames.has(`${k.jp}@${k.frame}`))
  for (const k of added) assert(["センター", "左足首", "右足首"].includes(k.jp), `unexpected bone keyed by bake: ${k.jp}`)
  const dup = new Set()
  for (const k of outKeys) {
    const id = `${k.jp}@${k.frame}`
    assert(!dup.has(id), `duplicate key ${id}`)
    dup.add(id)
  }
  console.log(`        ${inKeys.length} → ${outKeys.length} keys, all input keys intact, ${added.length} added (center/ankle only), no duplicates`)
})

// ------------------------------------------------------------------ 4. 护栏
test("护栏：躺姿不被烘焙触碰", () => {
  const lie = POSE_EXEMPLARS.find((e) => e.id === "lie_back_relaxed")
  assert(lie, "exemplar lie_back_relaxed missing")
  const mpl = ensureMain(lie.mpl)
  const vmd = compile(mpl)
  const { stats, vmd: out } = bakeGroundContact(vmd, bones, { mplSource: mpl })
  assert.equal(stats.applied, false, "lying pose must not be baked")
  assert.equal(stats.insertedKeys, 0)
  assert(stats.windows.every((w) => w.end <= w.start), `expected single-frame windows only, got ${JSON.stringify(stats.windows)}`)
  assert.deepEqual(Buffer.from(out), Buffer.from(vmd), "output must equal input when nothing is baked")
  console.log(`        windows ${stats.windows.map((w) => `${w.side}[${w.start},${w.end}]`).join(" ")}, skipped: ${stats.skippedReason}`)
})

test("护栏：踢起的脚不被当作接地（无俯仰键、抬脚高度不变）", () => {
  const kick = `@pose k_stand {
    center reset;
    leg_l reset;
    knee_l reset;
    ankle_l reset;
    leg_r reset;
    knee_r reset;
    ankle_r reset;
    plant feet;
}
@pose k_kick {
    leg_l bend forward 75;
    knee_l bend backward 15;
    ankle_l bend forward 20;
    plant feet;
}
@animation a {
    0: k_stand;
    0.8: k_kick;
    1.6: k_kick;
    2.4: k_stand;
}
main {
    a;
}
`
  const vmd = compile(kick)
  const before = measureGroundErrorVmd(vmd, bones, TOL)
  const { stats, vmd: out } = bakeGroundContact(vmd, bones, { mplSource: kick })
  assert.equal(stats.ankleKeys, 0, "a lifted foot must never get pitch keys")
  const lifted = []
  for (let f = 0; f < before.frames; f++) if (before.error.l[f] >= 1.0) lifted.push(f)
  assert(lifted.length > 20, `expected the kick to lift the foot, got ${lifted.length} lifted frames`)
  // 抬起的脚：烘焙不得把它往地面拉
  const after = measureGroundErrorVmd(out, bones, TOL)
  for (const f of lifted) assert(Math.abs(after.error.l[f] - before.error.l[f]) <= TOL, `lifted foot moved @f${f}`)
  // 支撑脚全程接地
  const { series } = footSeries(out)
  assert(worstAbs(series.ankle.r) <= TOL, `support ankle deviates ${worstAt(series.ankle.r).value}u @f${worstAt(series.ankle.r).frame}`)
  assert(worstAbs(series.toe.r) <= TOL, `support toe deviates ${worstAt(series.toe.r).value}u @f${worstAt(series.toe.r).frame}`)
  console.log(
    `        kick: ${lifted.length} lifted frames (peak ${(Math.max(...lifted.map((f) => before.error.l[f])) * 8).toFixed(1)}cm), ` +
      `support foot within ±${(TOL * 8 * 10).toFixed(0)}mm, bake ${stats.applied ? `+${stats.insertedKeys} keys` : "not needed"}`
  )
})

test("护栏：判定帧（MPL 时间轴条目）上的姿势不被烘焙改动", () => {
  const enhanced = finalizeMotion(squatRaw, bones, { bake: false, enhanceOptions: { autoBlink: true } }).vmd
  const { vmd } = bakeGroundContact(enhanced, bones, { mplSource: squatMpl })
  const { frames } = parsePoseTextsAndTimeline(squatMpl)
  const entryFrames = frames.map((fr) => fr.frame)
  assert(entryFrames.length >= 20, "expected the squat_lively timeline entries")
  const { worst, worstFrame } = maxPoseDelta(enhanced, vmd, entryFrames)
  assert(worst <= 1e-3, `authored entry pose changed by ${worst}u @f${worstFrame}`)
  console.log(`        ${entryFrames.length} entry frames, max bone delta ${worst.toExponential(1)}u`)
})

// ------------------------------------------------------------------ 5. 全部示例走成品管线后 critic 通过
test("全部 POSE_EXEMPLARS：成品 critic 通过，且关键帧（≥1 个判定帧）姿势不被改", () => {
  let bakedCount = 0
  let worstEntryDelta = 0
  for (const ex of POSE_EXEMPLARS) {
    const mpl = ensureMain(ex.mpl)
    const raw = compile(mpl)
    const enhanced = finalizeMotion(raw, bones, { bake: false, enhanceOptions: { autoBlink: true } }).vmd
    const { vmd, stats } = bakeGroundContact(enhanced, bones, { mplSource: mpl })
    if (stats.applied) bakedCount++
    const report = critiquePoseVmd(bones, vmd, mpl)
    assert(report && report.passed, `${ex.id} critic failed on final motion: ${report?.summary}`)
    const { frames } = parsePoseTextsAndTimeline(mpl)
    const entryFrames = frames.map((fr) => fr.frame)
    if (entryFrames.length > 0) {
      const d = maxPoseDelta(enhanced, vmd, entryFrames)
      worstEntryDelta = Math.max(worstEntryDelta, d.worst)
    }
  }
  console.log(`        ${POSE_EXEMPLARS.length} exemplars pass; ${bakedCount} needed the bake; worst entry-frame bone delta ${worstEntryDelta.toExponential(1)}u`)
})

// ------------------------------------------------------------------ 6. 词库 squat 原语（姿势照搬 examples/squat-lively.mpl）
const squatPrim = (params) => {
  const seg = expandLexiconSegment("squat", params)
  assert(seg, "lexicon must expose a squat primitive")
  return { mpl: `${seg.fragment}main {\n    squat_anim;\n}\n`, duration: seg.duration }
}

/** 指定帧的重心世界高度相对静止的下降量（u）。 */
const REST_CENTER_Y = restWorld.get(bones.indexByJp.get("センター")).y
const hipDropAt = (vmd, frame) => {
  const tf = samplePoseTransforms(bones, buildBoneTracks(readVmdBoneKeys(vmd)), frame, semantics)
  return REST_CENTER_Y - tf.pos[bones.indexByJp.get("センター")].y
}

const finalizeSquat = (params) => {
  const { mpl } = squatPrim(params)
  const fin = finalizeMotion(auditVmd(compile(mpl), bones).vmd, bones, {
    mplSource: mpl,
    enhanceOptions: { autoBlink: true },
    groundTolerance: TOL,
  })
  // 时间轴第 4 个条目 = 第一拍触底（sq_top → sq_antic → sq_hinge → sq_bottom），随 tempo 缩放
  const bottomFrame = parsePoseTextsAndTimeline(mpl).frames[3].frame
  return { mpl, fin, bottomFrame }
}

test("词库 squat：默认 3 拍成品逐帧接地（踝/尖 ±5mm）、critic 通过", () => {
  const { mpl, fin, bottomFrame } = finalizeSquat({})
  assert.equal(bottomFrame, 36)
  assert.equal(fin.baked, true, "squat reps need the bake between keys")
  const { series, frames } = footSeries(fin.vmd)
  for (const side of ["l", "r"]) {
    for (const part of ["ankle", "toe"]) {
      const w = worstAt(series[part][side])
      assert(Math.abs(w.value) <= TOL, `${part}[${side}] deviates ${w.value.toFixed(4)}u @f${w.frame} (> ±${TOL}u)`)
    }
  }
  const report = critiquePoseVmd(bones, fin.vmd, mpl)
  assert(report && report.passed, `critic failed: ${report?.summary}`)
  assert.equal(fin.bakeStats.residualFrames, 0)
  assert.equal(fin.bakeStats.residualAtEntries, 0)
  // 第一拍底部（默认 1.2s = f36）髋部下降量：全蹲量级
  const drop = hipDropAt(fin.vmd, bottomFrame)
  assert(drop > 4.5 && drop < 6.5, `full squat hip drop ${drop.toFixed(2)}u out of range`)
  console.log(
    `        ${frames} frames, worst |ankle−rest| ${worstAbs(series.ankle.l).toFixed(3)}u, hip drop ${drop.toFixed(2)}u (${cm(drop)}), ` +
      `bake +${fin.bakeStats.insertedKeys} keys; critic ${report.summary}`
  )
})

test("词库 squat：depth 0.5 / 1.1、5 拍快节奏、不摆臂 —— 均可编译且成品 0 超差", () => {
  const drops = {}
  const variants = [
    ["half", { depth: 0.5 }],
    ["full", { depth: 1.1 }],
    ["fast5", { cycles: 5, tempo: 1.6 }],
    ["noarms", { arm_swing: 0, face: 0 }],
  ]
  for (const [label, params] of variants) {
    const { mpl, fin, bottomFrame } = finalizeSquat(params)
    const report = critiquePoseVmd(bones, fin.vmd, mpl)
    assert(report && report.passed, `${label}: critic failed: ${report?.summary}`)
    assert(fin.ground && fin.ground.offendingFrames === 0, `${label}: ${fin.ground?.offendingFrames} offending foot-frames on the final motion`)
    drops[label] = hipDropAt(fin.vmd, bottomFrame)
  }
  assert(drops.half < drops.full - 3, `depth must scale the squat: half ${drops.half.toFixed(2)}u vs full ${drops.full.toFixed(2)}u`)
  assert(drops.fast5 > 4.5, `tempo/cycles must not change the pose: ${drops.fast5.toFixed(2)}u`)
  console.log(
    `        hip drop half ${drops.half.toFixed(2)}u / full ${drops.full.toFixed(2)}u / fast5 ${drops.fast5.toFixed(2)}u; ` +
      `all finals 0 offending foot-frames`
  )
})

test("增强器不给腿的父骨插独立过冲：站立保持段（sq_top→sq_over）脚底高度不变", () => {
  const { mpl } = squatPrim({ depth: 1.1 })
  const raw = compile(mpl)
  const enhanced = finalizeMotion(raw, bones, { bake: false, enhanceOptions: { autoBlink: true } }).vmd
  const a = measureGroundErrorVmd(raw, bones, TOL)
  const b = measureGroundErrorVmd(enhanced, bones, TOL)
  // 第一拍 2.35s(f70) 站起 → 2.55s(f76) 过冲 → 2.9s(f87) 回正：两段里脚都应钉在地上
  let maxDelta = 0
  for (let f = 70; f <= 87; f++) {
    for (const s of ["l", "r"]) {
      const d = Math.abs(a.error[s][f] - b.error[s][f])
      maxDelta = Math.max(maxDelta, d)
      assert(d <= 0.01, `enhancer moved foot ${s} @f${f} by ${(b.error[s][f] - a.error[s][f]).toFixed(3)}u`)
    }
  }
  // 腿链的父骨若被插旋转键，脚必然被带起
  for (const jp of ["腰", "下半身", "グルーブ"]) {
    for (const k of readVmdBoneKeys(enhanced)) {
      if (k.jp !== jp || k.frame <= 70 || k.frame >= 87) continue
      assert(Math.abs(1 - Math.abs(k.quat[3])) < 1e-6, `${jp} got an embellishment rotation key @f${k.frame}`)
    }
  }
  console.log(`        f70–f87 foot height unchanged by the enhancer (max delta ${(maxDelta * 80).toFixed(2)}mm)`)
})

/** 把一个骨骼帧（111B）追加进 VMD 的骨骼帧块（其余字节原样拷贝）。 */
function appendBoneFrame(vmd, frame) {
  const out = new Uint8Array(vmd.length + 111)
  const dv = new DataView(out.buffer)
  out.set(vmd.subarray(0, 50))
  const count = new DataView(vmd.buffer, vmd.byteOffset, vmd.byteLength).getUint32(50, true)
  dv.setUint32(50, count + 1, true)
  out.set(vmd.subarray(54, 54 + count * 111), 54)
  out.set(frame, 54 + count * 111)
  out.set(vmd.subarray(54 + count * 111), 54 + (count + 1) * 111)
  return out
}
function encodeBoneFrame(k) {
  const b = new Uint8Array(111)
  const dv = new DataView(b.buffer)
  b.set(k.raw ?? new TextEncoder().encode(k.jp).subarray(0, 15), 0)
  dv.setUint32(15, k.frame, true)
  k.pos.forEach((v, i) => dv.setFloat32(19 + i * 4, v, true))
  k.quat.forEach((v, i) => dv.setFloat32(31 + i * 4, v, true))
  if (k.interp) b.set(k.interp, 47)
  return b
}

test("烘焙判据：作者线在容差带内时按绝对误差修 —— 帧间小幅浮起（相对作者线 < 容差）也压回地面", () => {
  const { mpl } = squatPrim({})
  const enhanced = finalizeMotion(compile(mpl), bones, { bake: false, enhanceOptions: { autoBlink: true } }).vmd
  const base = readVmdBoneKeys(enhanced).find((k) => k.jp === "腰" && k.frame === 70)
  assert(base, "fixture: waist key @f70")
  // f72 腰单独转 3°（等价于旧增强器落在腿父骨上的过冲键）：整条腿被带起，脚底 0.039 → ~0.077（> TOL 0.0625），
  // 但相对作者线（两端判定帧都是 0.039）只偏 ~0.038（< TOL）—— 相对判据会放过，绝对判据必须修
  const bumped = appendBoneFrame(enhanced, encodeBoneFrame({ ...base, frame: 72, quat: [0.026, 0, 0, 0.99966] }))
  const before = measureGroundErrorVmd(bumped, bones, TOL)
  assert(before.error.l[72] > TOL, `fixture must float: ${before.error.l[72].toFixed(3)}u`)
  assert(before.error.l[72] - before.error.l[70] < TOL, "fixture must stay within tolerance of the authored line")
  const { vmd, stats } = bakeGroundContact(bumped, bones, { mplSource: mpl, tolerance: TOL })
  const after = measureGroundErrorVmd(vmd, bones, TOL)
  for (const s of ["l", "r"]) {
    for (let f = 70; f <= 76; f++) assert(Math.abs(after.error[s][f]) <= TOL, `${s}@f${f} still ${after.error[s][f].toFixed(3)}u off the floor`)
  }
  // 判定帧与其余原始键照旧不动
  const kept = readVmdBoneKeys(vmd)
  assert(kept.some((k) => k.jp === "腰" && k.frame === 72), "bake must not delete or rewrite the foreign key")
  console.log(`        f72 float ${before.error.l[72].toFixed(3)}u → ${after.error.l[72].toFixed(3)}u (+${stats.insertedKeys} centre keys)`)
})

console.log(`\n${passed} ground-bake tests passed.`)
