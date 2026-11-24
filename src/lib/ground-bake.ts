/**
 * ground-bake.ts — 贴地烘焙（final 专用）
 *
 * 为什么需要：MPL 的 "plant feet;" 只保证**关键帧那一瞬**脚在地面；关键帧之间，
 * 腿部各关节各自做 slerp、重心按 bezier 平移，两条路径不同步，脚底就会在过渡段
 * 沉入地面或浮起（实测下蹲过渡段可沉到 −0.98u ≈ 地面下 8cm，连续 20+ 帧）。
 *
 * 做什么：在“接地窗口”内逐帧求值（与 reze-engine 同一套插值规则，见 fk.ts
 * sampleBoneTrack），只对误差超过阈值的**中间帧**插修补键：
 *   - 重心 センター 的 y 平移（整体抬/降）
 *   - 足首 绕世界侧向轴的俯仰（平脚窗口内，让脚掌回到与静止态相同的姿态）
 * 原始关键帧一律不动；blocking 导出不经过这里（稀疏键要留给 Blender 精修）。
 *
 * 三条边界：
 *  1. 只处理接地窗口：窗口由“判定帧”（MPL 时间轴条目帧，或腿部/重心关键帧）上
 *     FK 实测的接地状态决定——最低观测点在地面 ±0.3u 内才算接地。坐姿、腾空、
 *     踢腿、躺姿的判定帧不在窗口内，不会被改。
 *  2. 这里只有骨骼关节坐标，没有鞋底网格：以**静止态脚踝/脚尖高度**为基准做相对修正
 *     （骨骼级可压到毫米级）；鞋跟厚度等交给 Blender。
 *  3. 判定帧本身（作者写的姿势）如果有错，这里不修——那是 critic 的事。
 *     中间帧的目标误差因此不是死板的 0，而是“两端判定帧作者误差的线性过渡”：
 *     修补量在判定帧处归零，作者姿势自带的下沉/浮起被平滑保留，不会在关键帧旁制造单帧跳变。
 *
 * 与舞台足 IK 的关系（无需按 IK 状态分流，别“修”掉）：
 *  舞台按 vmd-enhancer.computeIkSchedule 的时间窗切换足 IK。
 *  - IK 关闭的窗口（如下蹲→站起）舞台播纯 FK，这里修的就是实际看到的下沉；
 *  - IK 开着的窗口（如站起→下蹲，腿链在起始键还是单位旋转）引擎会折叠膝盖把脚留在 IK 目标上。
 *    烘焙让 FK 自洽后，这些窗口里 IK 需要补的修正量最小，两类窗口视觉一致；
 *  - 纯手势 + 重心平移但没有腿部键（IK 全程开）：作者误差沿线性目标分布，δ≈0，不会插键。
 *
 * 稳健性契约：任何异常都原样返回输入 VMD（stats.skippedReason 说明原因）。
 */

import { detectPosSemantics, restWorldPositions } from "./model-geometry.ts"
import {
  buildBoneTracks,
  qConjugate,
  qMul,
  readVmdBoneKeys,
  sampleBoneTrack,
  sampleBoneTracks,
  solveFrameTransforms,
  type FrameTransforms,
  type Quat,
  type VmdBoneKey,
} from "./fk.ts"
import type { PmxBones } from "./pmx-bones.ts"
import { parsePoseTextsAndTimeline } from "./pose-critic.ts"

export type FootSide = "l" | "r"
const SIDES: readonly FootSide[] = ["l", "r"]

const SIDE_JP = {
  l: {
    ankle: "左足首",
    ankleD: "左足首D",
    toe: "左足先EX",
    toeAlt: "左つま先",
    leg: ["左足", "左ひざ", "左足首", "左足D", "左ひざD", "左足首D", "左つま先", "左足先EX"],
  },
  r: {
    ankle: "右足首",
    ankleD: "右足首D",
    toe: "右足先EX",
    toeAlt: "右つま先",
    leg: ["右足", "右ひざ", "右足首", "右足D", "右ひざD", "右足首D", "右つま先", "右足先EX"],
  },
} as const

/** 根骨/重心：它们的平移同样会把脚带着走，几何模式下作为判定帧来源 */
const ROOT_JPS = ["全ての親", "センター", "グルーブ", "腰", "下半身"]
const CENTER_JP = "センター"
const BONE_FRAME_BYTES = 111

/** 最低观测点高出静止高度 ≥ 此值视为“脚被抬起”（不算贴地误差） */
const LIFT_BAND = 1.0

export const GROUND_BAKE_DEFAULTS = {
  /** 中间帧允许的贴地误差（u；0.05u ≈ 4mm） */
  tolerance: 0.05,
  /** 判定帧上最低观测点落在地面 ±contactTolerance 内才算“接地” */
  contactTolerance: 0.3,
  /**
   * 判定帧脚踝高度与静止高度相差 ≤ 此值视为平脚（全脚掌着地，可修俯仰）；
   * 否则整窗按“脚尖触地”处理（脚跟抬起是作者意图：只看脚尖、不动俯仰）。
   */
  flatAnkleTolerance: 0.15,
  maxPasses: 3,
} as const

const DEG = Math.PI / 180
/** 小于该俯仰角不值得为它插键 */
const MIN_PITCH = 0.3 * DEG

// ---------------------------------------------------------------- 脚部基准

interface FootRig {
  side: FootSide
  /** 被打键/旋转的骨骼（标准链 足首；D 链经付与镜像跟随） */
  ankleJp: string
  ankleIdx: number
  /** 量高度用的脚踝（D 链优先：游戏改模型的蒙皮在 D 骨上） */
  measureAnkleIdx: number
  toeIdx: number | null
  restAnkleY: number
  restToeY: number | null
  /** 俯仰轴（世界系单位向量）：静止姿势下脚踝→脚尖前向的侧向垂线 */
  axis: Quat
  legJps: string[]
}

function resolveRigs(bones: PmxBones): Record<FootSide, FootRig> | null {
  try {
    const rest = restWorldPositions(bones)
    const out = {} as Record<FootSide, FootRig>
    for (const side of SIDES) {
      const jp = SIDE_JP[side]
      const ankleIdx = bones.indexByJp.get(jp.ankle)
      if (ankleIdx == null) return null
      const ankleDIdx = bones.indexByJp.get(jp.ankleD)
      const measureAnkleIdx = ankleDIdx ?? ankleIdx
      const toeIdx = bones.indexByJp.get(jp.toe) ?? bones.indexByJp.get(jp.toeAlt) ?? null
      const a = rest.get(ankleIdx)
      const ma = rest.get(measureAnkleIdx)
      const t = toeIdx != null ? rest.get(toeIdx) : undefined
      if (!a || !ma) return null
      let axis: Quat = { x: 1, y: 0, z: 0, w: 0 }
      if (t) {
        const fx = t.x - a.x
        const fz = t.z - a.z
        const len = Math.hypot(fx, fz)
        if (len > 1e-6) axis = { x: fz / len, y: 0, z: -fx / len, w: 0 }
      }
      out[side] = {
        side,
        ankleJp: jp.ankle,
        ankleIdx,
        measureAnkleIdx,
        toeIdx,
        restAnkleY: ma.y,
        restToeY: t ? t.y : null,
        axis,
        legJps: [...jp.leg],
      }
    }
    return out
  } catch {
    return null
  }
}

/** 脚踝/脚尖相对静止高度的有符号偏移（u）。 */
function footOffsets(rig: FootRig, tf: FrameTransforms): { dA: number; dT: number | null } {
  const dA = tf.pos[rig.measureAnkleIdx].y - rig.restAnkleY
  const dT = rig.toeIdx != null && rig.restToeY != null ? tf.pos[rig.toeIdx].y - rig.restToeY : null
  return { dA, dT }
}

/** 最低观测点的离地偏移：负 = 沉入地面，正 = 浮起。 */
function lowestOffset(rig: FootRig, tf: FrameTransforms): number {
  const { dA, dT } = footOffsets(rig, tf)
  return dT == null ? dA : Math.min(dA, dT)
}

/** 窗口内该脚“着地参照点”的误差：平脚窗看脚踝（俯仰已让脚尖对齐），脚尖触地窗看脚尖。 */
function contactError(rig: FootRig, tf: FrameTransforms, flat: boolean): number {
  const { dA, dT } = footOffsets(rig, tf)
  return !flat && dT != null ? dT : dA
}

/** 平脚度：脚踝−脚尖高度差相对静止态的偏差（0 = 与静止态同样平贴）。 */
function flatnessError(rig: FootRig, tf: FrameTransforms): number | null {
  if (rig.toeIdx == null || rig.restToeY == null) return null
  const { dA, dT } = footOffsets(rig, tf)
  return dA - (dT as number)
}

// ---------------------------------------------------------------- 逐帧测量

export interface FootGroundError {
  /** 最深下沉（u，≤0）：负 = 沉入地面 */
  min: number
  minFrame: number
  /** 近地段（脚未被抬起）的最大浮起（u，≥0） */
  max: number
  maxFrame: number
  /** |误差| > tol 的帧数（下沉 + 近地段浮起） */
  offending: number
  /** 脚被抬起（≥ LIFT_BAND）的帧数，仅供参考 */
  lifted: number
}

export interface GroundMeasure {
  tolerance: number
  frames: number
  /** 每帧每侧最低观测点的离地偏移（u），下标 = 帧号 */
  error: Record<FootSide, Float64Array>
  restAnkleY: Record<FootSide, number>
  restToeY: Record<FootSide, number | null>
  summary: Record<FootSide, FootGroundError>
  /** 双脚中最差的贴地误差 |u| */
  worst: number
  /** 任一脚 |误差| > tol 的帧数 */
  offendingFrames: number
}

/** 可直接 JSON 序列化的测量摘要（MCP 工具输出用）。 */
export interface GroundSummary {
  tolerance: number
  frames: number
  unit: string
  restAnkleY: Record<FootSide, number>
  restToeY: Record<FootSide, number | null>
  feet: Record<FootSide, FootGroundError>
  worst: number
  offendingFrames: number
}

function summarize(err: Float64Array, tol: number): FootGroundError {
  let min = 0
  let minFrame = -1
  let max = 0
  let maxFrame = -1
  let offending = 0
  let lifted = 0
  for (let f = 0; f < err.length; f++) {
    const v = err[f]
    if (v < min) {
      min = v
      minFrame = f
    }
    if (v < LIFT_BAND) {
      if (v > max) {
        max = v
        maxFrame = f
      }
    } else lifted++
    if (isOffending(v, tol)) offending++
  }
  return { min, minFrame, max, maxFrame, offending, lifted }
}

/** 是否算贴地超差：下沉超过容差，或近地段（脚没被抬起）浮起超过容差。 */
export function isOffending(e: number, tol: number): boolean {
  return e < -tol || (e > tol && e < LIFT_BAND)
}

/**
 * 逐帧测量双脚最低观测点相对静止高度的偏移（引擎同源插值）。
 * 解析/求值失败返回 null。
 */
export function measureGroundError(
  bones: PmxBones,
  keys: readonly VmdBoneKey[],
  tolerance: number = GROUND_BAKE_DEFAULTS.tolerance
): GroundMeasure | null {
  try {
    const rigs = resolveRigs(bones)
    if (!rigs || keys.length === 0) return null
    const tracks = buildBoneTracks(keys)
    const semantics = detectPosSemantics(bones)
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const error = { l: new Float64Array(maxFrame + 1), r: new Float64Array(maxFrame + 1) }
    for (let f = 0; f <= maxFrame; f++) {
      const tf = solveFrameTransforms(bones, sampleBoneTracks(tracks, f), semantics)
      if (!tf) return null
      for (const side of SIDES) error[side][f] = lowestOffset(rigs[side], tf)
    }
    return buildMeasure(error, rigs, tolerance)
  } catch {
    return null
  }
}

function buildMeasure(
  error: Record<FootSide, Float64Array>,
  rigs: Record<FootSide, FootRig>,
  tolerance: number
): GroundMeasure {
  const summary = { l: summarize(error.l, tolerance), r: summarize(error.r, tolerance) }
  return {
    tolerance,
    frames: error.l.length,
    error,
    restAnkleY: { l: rigs.l.restAnkleY, r: rigs.r.restAnkleY },
    restToeY: { l: rigs.l.restToeY, r: rigs.r.restToeY },
    summary,
    worst: Math.max(
      Math.abs(summary.l.min),
      Math.abs(summary.l.max),
      Math.abs(summary.r.min),
      Math.abs(summary.r.max)
    ),
    offendingFrames: summary.l.offending + summary.r.offending,
  }
}

/** 逐帧测量一个 VMD 文件的贴地情况（引擎同源插值）。 */
export function measureGroundErrorVmd(
  vmd: Uint8Array,
  bones: PmxBones,
  tolerance: number = GROUND_BAKE_DEFAULTS.tolerance
): GroundMeasure | null {
  const keys = readVmdBoneKeys(vmd)
  return keys ? measureGroundError(bones, keys, tolerance) : null
}

/** 把测量结果压成可 JSON 序列化的摘要。 */
export function summarizeGroundMeasure(m: GroundMeasure): GroundSummary {
  return {
    tolerance: m.tolerance,
    frames: m.frames,
    unit: "u (1u ≈ 8cm; offset vs rest ankle/toe height; negative = below floor)",
    restAnkleY: m.restAnkleY,
    restToeY: m.restToeY,
    feet: m.summary,
    worst: round3(m.worst),
    offendingFrames: m.offendingFrames,
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

// ---------------------------------------------------------------- 小工具

function hasKeyAt(track: VmdBoneKey[] | undefined, frame: number): boolean {
  if (!track) return false
  let lo = 0
  let hi = track.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (track[mid].frame === frame) return true
    if (track[mid].frame < frame) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/** 插入位置：首个 frame > 新键帧号的位置（稳定） */
function insertIndex(track: VmdBoneKey[], frame: number): number {
  let lo = 0
  let hi = track.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (track[mid].frame <= frame) lo = mid + 1
    else hi = mid
  }
  return lo
}

function insertKey(track: VmdBoneKey[], key: VmdBoneKey): void {
  track.splice(insertIndex(track, key.frame), 0, key)
}

function axisAngle(ax: Quat, angle: number): Quat {
  const s = Math.sin(angle / 2)
  return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(angle / 2) }
}

function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let f = a; f <= b; f++) out.push(f)
  return out
}

function mean(v: readonly number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length
}

// ---------------------------------------------------------------- VMD 回写

const DEFAULT_INTERP = (() => {
  const b = new Uint8Array(64)
  for (let ch = 0; ch < 4; ch++) {
    b[ch * 16] = 20
    b[ch * 16 + 4] = 20
    b[ch * 16 + 8] = 107
    b[ch * 16 + 12] = 107
  }
  return b
})()

/**
 * 只重写骨骼帧块：头部 + 新关键帧列表 + 其余字节（表情/相机/灯光/自拍/属性帧）原样拷贝。
 * 原始键的 15 字节骨名与 64 字节插值表原样写回（不经过任何曲线库）。
 */
function serializeWithKeys(vmd: Uint8Array, keys: readonly VmdBoneKey[]): Uint8Array | null {
  try {
    if (vmd.byteLength < 54) return null
    const dv = new DataView(vmd.buffer, vmd.byteOffset, vmd.byteLength)
    const oldCount = dv.getUint32(50, true)
    const tailStart = 54 + oldCount * BONE_FRAME_BYTES
    if (tailStart > vmd.byteLength) return null
    const sorted = [...keys].sort((a, b) => a.frame - b.frame)
    const out = new Uint8Array(54 + sorted.length * BONE_FRAME_BYTES + (vmd.byteLength - tailStart))
    out.set(vmd.subarray(0, 50), 0)
    const odv = new DataView(out.buffer)
    odv.setUint32(50, sorted.length, true)
    const enc = new TextEncoder()
    let o = 54
    for (const k of sorted) {
      const raw = k.raw && k.raw.byteLength === 15 ? k.raw : enc.encode(k.jp).subarray(0, 15)
      out.set(raw, o)
      odv.setUint32(o + 15, Math.max(0, Math.round(k.frame)), true)
      odv.setFloat32(o + 19, k.pos[0], true)
      odv.setFloat32(o + 23, k.pos[1], true)
      odv.setFloat32(o + 27, k.pos[2], true)
      odv.setFloat32(o + 31, k.quat[0], true)
      odv.setFloat32(o + 35, k.quat[1], true)
      odv.setFloat32(o + 39, k.quat[2], true)
      odv.setFloat32(o + 43, k.quat[3], true)
      out.set(k.interp && k.interp.byteLength === 64 ? k.interp : DEFAULT_INTERP, o + 47)
      o += BONE_FRAME_BYTES
    }
    out.set(vmd.subarray(tailStart), o)
    return out
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 烘焙

export interface GroundBakeWindow {
  side: FootSide
  /** 闭区间帧号（判定帧本身） */
  start: number
  end: number
  /** true = 全脚掌着地（窗口内判定帧脚踝都在静止高度附近）；false = 脚尖触地（不动俯仰） */
  flat: boolean
}

export interface GroundBakeStats {
  applied: boolean
  skippedReason?: string
  /** 判定帧来源：mpl = 时间轴条目帧；keys = 腿部/重心关键帧 */
  entriesFrom: "mpl" | "keys"
  windows: GroundBakeWindow[]
  passes: number
  insertedKeys: number
  centerKeys: number
  ankleKeys: number
  anchorKeys: number
  before: Record<FootSide, FootGroundError>
  after: Record<FootSide, FootGroundError>
  /** 烘焙后仍超阈值的帧数（含判定帧上作者姿势自带的误差） */
  residualFrames: number
  /** 其中落在判定帧上的帧数：作者姿势自带、按约定不修（想修就给该姿势加 plant feet） */
  residualAtEntries: number
}

export interface GroundBakeOptions {
  /** 中间帧允许的贴地误差（u），默认 0.05 */
  tolerance?: number
  /** MPL 源码：有则用时间轴条目帧做接地判定帧（更准），没有则退回腿部/重心关键帧 */
  mplSource?: string
  maxPasses?: number
}

export interface GroundBakeResult {
  vmd: Uint8Array
  stats: GroundBakeStats
}

function emptyStats(reason: string, entriesFrom: "mpl" | "keys" = "keys"): GroundBakeStats {
  const zero = summarize(new Float64Array(0), 0)
  return {
    applied: false,
    skippedReason: reason,
    entriesFrom,
    windows: [],
    passes: 0,
    insertedKeys: 0,
    centerKeys: 0,
    ankleKeys: 0,
    anchorKeys: 0,
    before: { l: zero, r: zero },
    after: { l: zero, r: zero },
    residualFrames: 0,
    residualAtEntries: 0,
  }
}

/**
 * 贴地烘焙。只改接地窗口内、误差超阈值的中间帧；原始关键帧不动。
 * 调用方负责保证只在 final 导出/舞台播放路径上使用（blocking 永不烘焙）。
 * 任何异常都原样返回输入。
 */
export function bakeGroundContact(
  vmd: Uint8Array,
  bones: PmxBones,
  opts: GroundBakeOptions = {}
): GroundBakeResult {
  const untouched = (stats: GroundBakeStats): GroundBakeResult => ({ vmd, stats })
  try {
    const keys = readVmdBoneKeys(vmd)
    if (!keys || keys.length === 0) return untouched(emptyStats("vmd has no bone keyframes"))
    const rigs = resolveRigs(bones)
    if (!rigs) return untouched(emptyStats("model lacks foot bones (足首)"))
    if (bones.indexByJp.get(CENTER_JP) == null) return untouched(emptyStats("model lacks センター"))

    const tolerance = opts.tolerance ?? GROUND_BAKE_DEFAULTS.tolerance
    const contactTol = GROUND_BAKE_DEFAULTS.contactTolerance
    const flatTol = GROUND_BAKE_DEFAULTS.flatAnkleTolerance
    const maxPasses = Math.max(1, Math.min(6, opts.maxPasses ?? GROUND_BAKE_DEFAULTS.maxPasses))

    const semantics = detectPosSemantics(bones)
    const tracks = buildBoneTracks(keys)
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const fkOfState = (state: Map<string, VmdBoneKey>) => solveFrameTransforms(bones, state, semantics)
    const fkAt = (f: number) => fkOfState(sampleBoneTracks(tracks, f))

    // ---- 判定帧：MPL 时间轴条目优先，否则腿部/重心关键帧
    const mpl = opts.mplSource?.trim() ?? ""
    let entryFrames: number[] = []
    let entriesFrom: "mpl" | "keys" = "keys"
    if (mpl) {
      try {
        entryFrames = [...new Set(parsePoseTextsAndTimeline(mpl).frames.map((r) => r.frame))].sort((a, b) => a - b)
      } catch {
        entryFrames = []
      }
      if (entryFrames.length > 0) entriesFrom = "mpl"
    }
    if (entryFrames.length === 0) {
      const legSets = new Set<string>([...rigs.l.legJps, ...rigs.r.legJps])
      const set = new Set<number>([0, maxFrame])
      for (const k of keys) {
        if (k.jp === CENTER_JP || ROOT_JPS.includes(k.jp) || legSets.has(k.jp)) set.add(k.frame)
      }
      entryFrames = [...set].sort((a, b) => a - b)
    }
    const first = entryFrames[0]
    const last = entryFrames[entryFrames.length - 1]

    // ---- 每侧接地窗口：判定帧上实测接地的连续区间（窗口含其间的过渡段）
    const windows: GroundBakeWindow[] = []
    /** 每个窗口包含的判定帧（按序） */
    const winEntries = new Map<GroundBakeWindow, number[]>()
    /** 判定帧上作者姿势自带的误差（`${side}:${frame}` → 最低观测点偏移） */
    const authored = new Map<string, number>()
    for (const side of SIDES) {
      const rig = rigs[side]
      let run: GroundBakeWindow | null = null
      let runFrames: number[] = []
      const flush = () => {
        if (run) {
          if (run.start === first) run.start = 0
          if (run.end === last) run.end = maxFrame
          windows.push(run)
          winEntries.set(run, runFrames)
        }
        run = null
        runFrames = []
      }
      for (const e of entryFrames) {
        const tf = fkAt(e)
        if (!tf) {
          flush()
          continue
        }
        const lowest = lowestOffset(rig, tf)
        if (lowest < -contactTol || lowest > contactTol) {
          flush()
          continue
        }
        const flat = Math.abs(footOffsets(rig, tf).dA) <= flatTol
        if (!run) run = { side, start: e, end: e, flat }
        run.end = e
        run.flat = run.flat && flat
        runFrames.push(e)
        authored.set(`${side}:${e}`, lowest)
      }
      flush()
    }

    /**
     * 中间帧的目标误差：不是死板的 0，而是两端判定帧“作者误差”的线性过渡。
     * 这样修补量在判定帧处归零 —— 作者姿势自带的下沉/浮起被平滑保留，
     * 不会在关键帧旁制造单帧跳变；过渡段里超出这条直线的下沉/鼓包才被修掉。
     */
    const intendedError = (w: GroundBakeWindow, f: number): number => {
      const es = winEntries.get(w)
      if (!es || es.length === 0) return 0
      const at = (frame: number) => authored.get(`${w.side}:${frame}`) ?? 0
      if (f <= es[0]) return at(es[0])
      if (f >= es[es.length - 1]) return at(es[es.length - 1])
      let i = 0
      while (i < es.length - 2 && es[i + 1] < f) i++
      const a = es[i]
      const b = es[i + 1]
      const t = b > a ? (f - a) / (b - a) : 0
      return at(a) * (1 - t) + at(b) * t
    }

    const before = measureGroundError(bones, keys, tolerance)
    const stats: GroundBakeStats = {
      applied: false,
      entriesFrom,
      windows: windows.map((w) => ({ ...w, start: w.start, end: w.end })),
      passes: 0,
      insertedKeys: 0,
      centerKeys: 0,
      ankleKeys: 0,
      anchorKeys: 0,
      before: before?.summary ?? emptyStats("").before,
      after: before?.summary ?? emptyStats("").after,
      residualFrames: before?.offendingFrames ?? 0,
      residualAtEntries: 0,
    }

    const windowAt = (side: FootSide, f: number) =>
      windows.find((w) => w.side === side && f > w.start && f < w.end)
    const interior = windows.filter((w) => w.end - w.start >= 2)
    if (interior.length === 0) {
      stats.skippedReason = "no grounded transition (nothing between contact keys)"
      return untouched(stats)
    }
    const candidates = [...new Set(interior.flatMap((w) => range(w.start + 1, w.end - 1)))].sort((a, b) => a - b)

    // 新键沿用**后一键**的插值表：reze 取后一键的表管进入段，Blender/MMD 取起始键的表管离开段，
    // 两种约定下修补段都保持原段的缓动。
    const interpFor = (track: VmdBoneKey[], frame: number): Uint8Array | undefined => {
      const next = track[insertIndex(track, frame)]
      return (next ?? track[0])?.interp
    }
    const rawFor = (track: VmdBoneKey[]): Uint8Array | undefined => track[0]?.raw

    /** 保证轨道在窗口两端各有锚点键（否则新键的值会被引擎保持到窗口之外）。返回该轨道。 */
    const ensureAnchors = (jp: string, start: number, end: number): VmdBoneKey[] => {
      let track = tracks.get(jp)
      if (!track) {
        track = []
        tracks.set(jp, track)
      }
      const t = track as VmdBoneKey[]
      // 采样值可夹到首末键，但帧号必须是指定帧（否则锚点会变成重复键，“已有锚点”判断永远不成立）
      const anchor = (frame: number): VmdBoneKey =>
        t.length === 0
          ? { jp, frame, pos: [0, 0, 0], quat: [0, 0, 0, 1] }
          : { ...sampleBoneTrack(t, frame, jp), frame, raw: rawFor(t) }
      if (!t.some((k) => k.frame <= start)) {
        insertKey(t, anchor(start))
        stats.anchorKeys++
      }
      if (!t.some((k) => k.frame >= end)) {
        insertKey(t, anchor(end))
        stats.anchorKeys++
      }
      return t
    }

    /** 给 state 里的 足首 叠加世界系俯仰 θ（绕脚踝原点），返回新 Map。 */
    const withPitch = (
      rig: FootRig,
      state: Map<string, VmdBoneKey>,
      tf: FrameTransforms,
      theta: number
    ): Map<string, VmdBoneKey> => {
      const ankleBone = bones.bones[rig.ankleIdx]
      const parentQ: Quat =
        ankleBone.parent >= 0 ? tf.quat[ankleBone.parent] : { x: 0, y: 0, z: 0, w: 1 }
      // R' = Rp ⊗ R ；L' = P⁻¹ ⊗ R' = P⁻¹ ⊗ Rp ⊗ (P ⊗ L)
      const local = qMul(qMul(qConjugate(parentQ), axisAngle(rig.axis, theta)), tf.quat[rig.ankleIdx])
      const cur = state.get(rig.ankleJp) as VmdBoneKey
      const next = new Map(state)
      next.set(rig.ankleJp, { ...cur, quat: [local.x, local.y, local.z, local.w] })
      return next
    }

    /** 割线法解俯仰角，使脚掌回到与静止态相同的平贴姿态。返回最优解。 */
    const solvePitch = (
      rig: FootRig,
      state: Map<string, VmdBoneKey>,
      tf: FrameTransforms
    ): { theta: number; state: Map<string, VmdBoneKey>; tf: FrameTransforms; key: VmdBoneKey } | null => {
      const p0 = flatnessError(rig, tf)
      if (p0 == null || Math.abs(p0) <= tolerance) return null
      let best = { theta: 0, p: p0, state, tf }
      const t1 = 2 * DEG
      const s1 = withPitch(rig, state, tf, t1)
      const tf1 = fkOfState(s1)
      if (!tf1) return null
      const p1 = flatnessError(rig, tf1)
      if (p1 == null) return null
      if (Math.abs(p1) < Math.abs(best.p)) best = { theta: t1, p: p1, state: s1, tf: tf1 }
      const slope = (p1 - p0) / t1
      if (!Number.isFinite(slope) || Math.abs(slope) < 1e-7) return null
      let tPrev = t1
      let pPrev = p1
      let theta = -p0 / slope
      for (let i = 0; i < 4; i++) {
        const st = withPitch(rig, state, tf, theta)
        const tfx = fkOfState(st)
        if (!tfx) break
        const p = flatnessError(rig, tfx)
        if (p == null) break
        if (Math.abs(p) < Math.abs(best.p)) best = { theta, p, state: st, tf: tfx }
        if (Math.abs(p) <= 0.02) break
        const s2 = (p - pPrev) / (theta - tPrev)
        if (!Number.isFinite(s2) || Math.abs(s2) < 1e-9) break
        tPrev = theta
        pPrev = p
        theta = theta - p / s2
      }
      const key = best.state.get(rig.ankleJp) as VmdBoneKey
      return { theta: best.theta, state: best.state, tf: best.tf, key }
    }

    for (let pass = 1; pass <= maxPasses; pass++) {
      stats.passes = pass
      let insertedThisPass = 0
      for (const f of candidates) {
        const active = SIDES.map((side) => ({ side, w: windowAt(side, f) })).filter(
          (x): x is { side: FootSide; w: GroundBakeWindow } => x.w != null
        )
        if (active.length === 0) continue
        let state = sampleBoneTracks(tracks, f)
        let tf = fkOfState(state)
        if (!tf) continue

        // 1) 平脚窗口：先修脚掌俯仰（脚尖回到与脚踝同样的离地量）
        const pitched: Partial<Record<FootSide, VmdBoneKey>> = {}
        for (const { side, w } of active) {
          const rig = rigs[side]
          if (!w.flat || rig.toeIdx == null || hasKeyAt(tracks.get(rig.ankleJp), f)) continue
          const solved = solvePitch(rig, state, tf)
          if (solved && Math.abs(solved.theta) > MIN_PITCH) {
            pitched[side] = solved.key
            state = solved.state
            tf = solved.tf
          }
        }

        // 2) 重心 y 平移：抵消脚相对“目标误差曲线”的公共偏差（双脚都在时取均值）
        const errs = active.map(({ side, w }) => contactError(rigs[side], tf, w.flat) - intendedError(w, f))
        const needFix = errs.some((e) => Math.abs(e) > tolerance)
        if (!needFix && Object.keys(pitched).length === 0) continue
        const dy = errs.length > 0 ? -mean(errs) : 0
        if (!hasKeyAt(tracks.get(CENTER_JP), f) && Math.abs(dy) > tolerance * 0.5) {
          const start = Math.min(...active.map((a) => a.w.start))
          const end = Math.max(...active.map((a) => a.w.end))
          const track = ensureAnchors(CENTER_JP, start, end)
          const sample = state.get(CENTER_JP)
          if (sample) {
            insertKey(track, {
              jp: CENTER_JP,
              frame: f,
              pos: [sample.pos[0], sample.pos[1] + dy, sample.pos[2]],
              quat: [sample.quat[0], sample.quat[1], sample.quat[2], sample.quat[3]],
              interp: interpFor(track, f),
              raw: rawFor(track),
            })
            stats.centerKeys++
            insertedThisPass++
          }
        }

        // 3) 俯仰修补键
        for (const { side, w } of active) {
          const key = pitched[side]
          if (!key) continue
          const track = ensureAnchors(rigs[side].ankleJp, w.start, w.end)
          insertKey(track, { ...key, frame: f, interp: interpFor(track, f), raw: rawFor(track) })
          stats.ankleKeys++
          insertedThisPass++
        }
      }
      stats.insertedKeys = stats.centerKeys + stats.ankleKeys + stats.anchorKeys
      if (insertedThisPass === 0) break
    }
    stats.insertedKeys = stats.centerKeys + stats.ankleKeys + stats.anchorKeys
    if (stats.insertedKeys === 0) {
      stats.skippedReason = "no frame between contact keys deviates from the floor"
      return untouched(stats)
    }

    const allKeys: VmdBoneKey[] = []
    for (const list of tracks.values()) for (const k of list) allKeys.push(k)
    const out = serializeWithKeys(vmd, allKeys)
    if (!out) {
      stats.skippedReason = "serialization failed"
      return untouched(stats)
    }
    const finalKeys = readVmdBoneKeys(out)
    const after = finalKeys ? measureGroundError(bones, finalKeys, tolerance) : null
    if (after) {
      stats.after = after.summary
      stats.residualFrames = after.offendingFrames
      let atEntries = 0
      for (const e of entryFrames) {
        if (isOffending(after.error.l[e], tolerance)) atEntries++
        if (isOffending(after.error.r[e], tolerance)) atEntries++
      }
      stats.residualAtEntries = atEntries
    }
    stats.applied = true
    return { vmd: out, stats }
  } catch (err) {
    return untouched(emptyStats(`ground bake failed: ${err instanceof Error ? err.message : String(err)}`))
  }
}
