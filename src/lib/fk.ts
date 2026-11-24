/**
 * fk.ts — Layer 2 几何检查闭环：前向运动学 + 地面接触分析。
 *
 * 动机（docs/how-llm-understands-pmx.md §5-2）：LLM 生成的 MPL 编译合法
 * 不代表视觉正确——"撑地"是世界空间约束，MPL 只有关节角。本模块把 VMD
 * 帧应用到骨骼树做 FK，数值化回答：
 *   - 手腕/脚踝/头/腰在每一帧的世界 y 是多少？
 *   - 有没有末端穿地（y < 阈值）？
 *   - 声称"躺下"时腰是否真的降到了地面高度？
 * 检查结果可回填给 LLM 修正（自愈回路）或展示给用户。
 *
 * 位置语义：detectPosSemantics（绝对 vs 父偏移）自动检测，见 model-geometry.ts。
 * VMD 中心平移是相对绑定世界位置的世界系偏移，直接加到 センター 世界坐标上。
 *
 * 稳健性契约：任何解析/求值异常返回 null，调用方降级（与 vmd-enhancer 一致）。
 */

import { detectPosSemantics } from "./model-geometry.ts"
import type { PmxBones } from "./pmx-bones.ts"

// ---------------------------------------------------------------- 四元数最小集

export interface Quat { x: number; y: number; z: number; w: number }
export interface Vec3 { x: number; y: number; z: number }

const qIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 })

export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

function qNormalize(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}

export function qConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

/** v = q * v * q⁻¹ */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q
  const uv = { x: y * v.z - z * v.y, y: z * v.x - x * v.z, z: x * v.y - y * v.x }
  const uuv = { x: y * uv.z - z * uv.y, y: z * uv.x - x * uv.z, z: x * uv.y - y * uv.x }
  return {
    x: v.x + 2 * (w * uv.x + uuv.x),
    y: v.y + 2 * (w * uv.y + uuv.y),
    z: v.z + 2 * (w * uv.z + uuv.z),
  }
}

// ---------------------------------------------------------------- VMD 骨骼帧读取

export interface VmdBoneKey {
  jp: string
  frame: number
  /** VMD 位移（センター等 movable 骨骼才有意义，世界系相对绑定位置） */
  pos: [number, number, number]
  quat: [number, number, number, number] // x,y,z,w
  /**
   * 该关键帧的 64 字节 VMD 插值表（4 通道 × 16 字节：X/Y/Z 平移 + 旋转）。
   * 文件读出的关键帧必带；手工构造的可省略（采样时按 MMD 默认曲线 20,20,107,107 处理）。
   */
  interp?: Uint8Array
  /** 原始 15 字节骨名（Shift_JIS，补 0）；回写 VMD 时原样使用。 */
  raw?: Uint8Array
}

/** 读取 VMD 全部骨骼关键帧（15B 名 + 帧号 + 位移 + 四元数 + 64B 插值 = 111B/条）。 */
export function readVmdBoneKeys(vmd: Uint8Array): VmdBoneKey[] | null {
  try {
    if (vmd.byteLength < 54) return null
    const dv = new DataView(vmd.buffer, vmd.byteOffset, vmd.byteLength)
    const head = new TextDecoder("shift_jis").decode(vmd.subarray(0, 26)).replace(/\0+$/, "")
    if (head !== "Vocaloid Motion Data 0002") return null
    const boneCount = dv.getUint32(50, true)
    if (50 + 4 + boneCount * 111 > vmd.byteLength) return null
    const out: VmdBoneKey[] = []
    let o = 54
    for (let i = 0; i < boneCount; i++) {
      const nameBytes = vmd.subarray(o, o + 15)
      let end = 15
      for (let k = 0; k < 15; k++) if (nameBytes[k] === 0) { end = k; break }
      const jp = new TextDecoder("shift_jis").decode(nameBytes.subarray(0, end))
      const frame = dv.getUint32(o + 15, true)
      out.push({
        jp,
        frame,
        pos: [dv.getFloat32(o + 19, true), dv.getFloat32(o + 23, true), dv.getFloat32(o + 27, true)],
        quat: [dv.getFloat32(o + 31, true), dv.getFloat32(o + 35, true), dv.getFloat32(o + 39, true), dv.getFloat32(o + 43, true)],
        interp: vmd.slice(o + 47, o + 111),
        raw: vmd.slice(o, o + 15),
      })
      o += 111
    }
    return out
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 前向运动学（付与感知）

/**
 * 把某一帧的关键帧应用到骨骼树，返回全部骨骼的世界坐标（索引与 bones.bones 对齐）。
 *
 * v2（付与感知）：MMD 付与骨骼每帧额外复制"付与父骨骼的本地旋转×ratio"。
 * 游戏改模型（如 topaz）的视觉腿是 D 链（足D/ひざD/足首D，蒙皮全在 D 骨），
 * 通过 grant ratio=1 镜像标准链（足/ひざ/足首）的旋转；腰キャンセル grant 腰×-1
 * 抵消弯腰。不建模付与就会得出错误的视觉脚位置（v1 的教训）。
 * 支持 ratio=±1（覆盖常见 rig）；其他比率忽略付并保持向后兼容。
 */
export interface FrameTransforms {
  pos: Vec3[]
  quat: Quat[]
}

/**
 * 与 solveFrameWorld 相同，但同时返回每根骨骼的世界旋转四元数（供多视角包络渲染与视线投影使用）。
 */
export function solveFrameTransforms(
  bones: PmxBones,
  keysByJp: Map<string, VmdBoneKey>,
  semantics: "absolute" | "offset"
): FrameTransforms | null {
  try {
    const n = bones.bones.length
    // Pass 1: 本地旋转（含付与传导；按数组序解析，付与父通常是更早的标准链骨）
    const localQ: Quat[] = new Array(n)
    const resolving = new Set<number>()
    const localQOf = (i: number): Quat => {
      if (localQ[i]) return localQ[i]
      if (resolving.has(i)) return qIdentity() // 付与环保护
      resolving.add(i)
      const b = bones.bones[i]
      const key = keysByJp.get(b.jp)
      let own = qNormalize(key ? { x: key.quat[0], y: key.quat[1], z: key.quat[2], w: key.quat[3] } : qIdentity())
      const g = b.grant
      if (g && g.rotate && (g.ratio === 1 || g.ratio === -1) && g.parent >= 0 && g.parent < n) {
        const src = localQOf(g.parent)
        own = g.ratio === 1 ? qMul(own, src) : qMul(own, qConjugate(src))
      }
      resolving.delete(i)
      localQ[i] = own
      return own
    }
    for (let i = 0; i < n; i++) localQOf(i)

    // Pass 2: 世界位置 + 世界旋转
    const world: Vec3[] = []
    const worldQuat: Quat[] = []
    for (let i = 0; i < n; i++) {
      const b = bones.bones[i]
      const parent = b.parent >= 0 ? world[b.parent] : undefined
      const parentQ = b.parent >= 0 ? worldQuat[b.parent] : undefined
      let dx = b.pos[0], dy = b.pos[1], dz = b.pos[2]
      if (semantics === "absolute" && parent) {
        const pp = bones.bones[b.parent].pos
        dx = b.pos[0] - pp[0]
        dy = b.pos[1] - pp[1]
        dz = b.pos[2] - pp[2]
      }
      const R = parentQ ? qMul(parentQ, localQ[i]) : localQ[i]
      const rotated = parent ? qRotate(parentQ ?? qIdentity(), { x: dx, y: dy, z: dz }) : { x: dx, y: dy, z: dz }
      let w: Vec3 = parent
        ? { x: parent.x + rotated.x, y: parent.y + rotated.y, z: parent.z + rotated.z }
        : { x: dx, y: dy, z: dz }
      const key = keysByJp.get(b.jp)
      if (key) {
        w = { x: w.x + key.pos[0], y: w.y + key.pos[1], z: w.z + key.pos[2] }
      }
      world.push(w)
      worldQuat.push(R)
    }
    return { pos: world, quat: worldQuat }
  } catch {
    return null
  }
}

export function solveFrameWorld(
  bones: PmxBones,
  keysByJp: Map<string, VmdBoneKey>,
  semantics: "absolute" | "offset"
): Vec3[] | null {
  return solveFrameTransforms(bones, keysByJp, semantics)?.pos ?? null
}

// ---------------------------------------------------------------- 连续求值（与舞台引擎同源）

/**
 * 关键帧之间怎么走，由播放引擎决定。舞台用的 reze-engine（dist/model.js `getPoseAtTime`）约定：
 *   - 每根骨骼一条轨道，取「最后一个 time ≤ t」的键为 A、其后一键为 B；
 *   - **插值表取 B（后一键）的**，不是 MMD/Blender 约定的「起始键描述它之后的一段」；
 *   - 旋转权重 rotT = bezier(interp[0], interp[1], interp[2], interp[3])——读的是 X 平移通道的
 *     前 4 字节（含 3 个填充字节），真正的旋转通道（第 48–63 字节）被忽略；
 *   - 平移按通道 bezier：X 用 [0,8,4,12]、Y 用 [16,24,20,28]、Z 用 [32,40,36,44]；
 *   - 旋转 Quat.slerp(A, B, rotT)，平移 A + (B−A)·weight；末键之后直接保持。
 * 下面的采样器逐式照搬这套规则，所以 Node 端算出的就是舞台正在播的 FK 坐标；
 * 步进保持（step-hold，只看 ≤f 的最近键）会把帧间的下沉/过冲全部漏掉。
 */

/** reze-engine dist/math.js `bezierInterpolate` 的逐式复刻（二分 15 次）。 */
export function vmdBezierInterpolate(x1: number, x2: number, y1: number, y2: number, t: number): number {
  t = Math.max(0, Math.min(1, t))
  let start = 0
  let end = 1
  let mid = 0.5
  for (let i = 0; i < 15; i++) {
    const x = 3 * (1 - mid) * (1 - mid) * mid * x1 + 3 * (1 - mid) * mid * mid * x2 + mid * mid * mid
    if (Math.abs(x - t) < 0.0001) break
    if (x < t) start = mid
    else end = mid
    mid = (start + end) / 2
  }
  return 3 * (1 - mid) * (1 - mid) * mid * y1 + 3 * (1 - mid) * mid * mid * y2 + mid * mid * mid
}

/** reze-engine `Quat.slerp` 的逐式复刻（cos<0 走短弧；cos>0.9995 走归一化线性）。 */
export function vmdQuatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bx = b.x, by = b.y, bz = b.z, bw = b.w
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  if (cos > 0.9995) {
    const x = a.x + t * (bx - a.x)
    const y = a.y + t * (by - a.y)
    const z = a.z + t * (bz - a.z)
    const w = a.w + t * (bw - a.w)
    const invLen = 1 / Math.hypot(x, y, z, w)
    return { x: x * invLen, y: y * invLen, z: z * invLen, w: w * invLen }
  }
  const theta0 = Math.acos(cos)
  const sinTheta0 = Math.sin(theta0)
  const theta = theta0 * t
  const s0 = Math.sin(theta0 - theta) / sinTheta0
  const s1 = Math.sin(theta) / sinTheta0
  return { x: s0 * a.x + s1 * bx, y: s0 * a.y + s1 * by, z: s0 * a.z + s1 * bz, w: s0 * a.w + s1 * bw }
}

/** MMD 默认插值表（每通道 20,20,107,107；布局与 vmd-enhancer `interpBytes` 一致）。 */
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

/** 每根骨骼一条按帧号升序的关键帧轨道。 */
export type BoneTracks = Map<string, VmdBoneKey[]>

export function buildBoneTracks(keys: readonly VmdBoneKey[]): BoneTracks {
  const tracks: BoneTracks = new Map()
  for (const k of keys) {
    const list = tracks.get(k.jp)
    if (list) list.push(k)
    else tracks.set(k.jp, [k])
  }
  // 稳定排序：同帧同骨的多条键保持文件顺序（与引擎一致）
  for (const list of tracks.values()) {
    let sorted = true
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].frame > list[i].frame) { sorted = false; break }
    }
    if (!sorted) list.sort((a, b) => a.frame - b.frame)
  }
  return tracks
}

/** 最后一个 frame ≤ t 的键下标（无则 −1）。 */
function lastIndexAtOrBefore(keys: VmdBoneKey[], t: number): number {
  let lo = 0
  let hi = keys.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (keys[mid].frame <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/**
 * 按引擎规则采样单条轨道在（可含小数的）帧 t 处的姿态，返回可直接喂给
 * solveFrameTransforms 的关键帧对象（pos 已含插值结果）。
 */
export function sampleBoneTrack(keys: VmdBoneKey[], t: number, jp?: string): VmdBoneKey {
  const first = keys[0]
  const last = keys[keys.length - 1]
  const name = jp ?? first.jp
  const clamped = Math.max(first.frame, Math.min(last.frame, t))
  const idx = lastIndexAtOrBefore(keys, clamped)
  const a = idx >= 0 ? keys[idx] : first
  const b = idx >= 0 && idx + 1 < keys.length ? keys[idx + 1] : undefined
  if (!b || b.frame === a.frame) {
    return { jp: name, frame: clamped, pos: [a.pos[0], a.pos[1], a.pos[2]], quat: [a.quat[0], a.quat[1], a.quat[2], a.quat[3]] }
  }
  const gradient = (clamped - a.frame) / (b.frame - a.frame)
  const interp = b.interp ?? DEFAULT_INTERP
  const INV = 1 / 127
  const rotT = vmdBezierInterpolate(interp[0] * INV, interp[1] * INV, interp[2] * INV, interp[3] * INV, gradient)
  const q = vmdQuatSlerp(
    { x: a.quat[0], y: a.quat[1], z: a.quat[2], w: a.quat[3] },
    { x: b.quat[0], y: b.quat[1], z: b.quat[2], w: b.quat[3] },
    rotT
  )
  const wAt = (offset: number) =>
    vmdBezierInterpolate(interp[offset] * INV, interp[offset + 8] * INV, interp[offset + 4] * INV, interp[offset + 12] * INV, gradient)
  const wx = wAt(0)
  const wy = wAt(16)
  const wz = wAt(32)
  return {
    jp: name,
    frame: clamped,
    pos: [
      a.pos[0] + (b.pos[0] - a.pos[0]) * wx,
      a.pos[1] + (b.pos[1] - a.pos[1]) * wy,
      a.pos[2] + (b.pos[2] - a.pos[2]) * wz,
    ],
    quat: [q.x, q.y, q.z, q.w],
  }
}

/** 采样全部轨道，得到 t 帧的「每骨一键」状态（插值后的关键帧）。 */
export function sampleBoneTracks(tracks: BoneTracks, t: number): Map<string, VmdBoneKey> {
  const state = new Map<string, VmdBoneKey>()
  for (const [jp, keys] of tracks) state.set(jp, sampleBoneTrack(keys, t, jp))
  return state
}

/** t 帧的世界坐标 + 世界旋转（连续求值版 solveFrameTransforms）。 */
export function samplePoseTransforms(
  bones: PmxBones,
  tracks: BoneTracks,
  t: number,
  semantics: "absolute" | "offset" = detectPosSemantics(bones)
): FrameTransforms | null {
  return solveFrameTransforms(bones, sampleBoneTracks(tracks, t), semantics)
}

/** 整数帧序列 0..maxFrame（舞台 30fps 实际渲染的每一帧）。 */
export function integerFrames(keys: readonly VmdBoneKey[]): number[] {
  let max = 0
  for (const k of keys) if (k.frame > max) max = k.frame
  const out: number[] = []
  for (let f = 0; f <= max; f++) out.push(f)
  return out
}

// ---------------------------------------------------------------- 地面接触分析

export interface GroundFrameReport {
  frame: number
  /** 各末端骨骼的世界 y（缺失骨骼不出现） */
  terminals: Record<string, number>
  centerY: number | null
}

export interface GroundContactReport {
  semantics: "absolute" | "offset"
  frames: GroundFrameReport[]
  /** 全部帧中末端骨骼最低 y */
  lowestTerminalY: number | null
  /** 穿地帧数：任一末端 y < threshold */
  penetrationFrames: number
  /** 人类可读的检查结论（可直接回填 LLM 修正回路） */
  summary: string
}

// 观察点：标准链与 D 链（视觉）都报告——D 变体存在时它才是视觉真值
const DEFAULT_TERMINALS = [
  "左手首", "右手首",
  "左足首", "右足首", "左足首D", "右足首D",
  "左足先EX", "右足先EX",
  "左足D", "右足D",
]

export interface AnalyzeOptions {
  terminals?: string[]
  /** 穿地判定阈值（世界 y），默认 -0.5u（≈4cm 容差） */
  penetrationThreshold?: number
  /**
   * true = 按舞台引擎规则在帧间插值求值（见 sampleBoneTrack）；默认 step-hold，
   * 每根骨骼只看 ≤f 的最近关键帧（帧间下沉/过冲会被漏掉）。
   */
  interpolated?: boolean
  /** 要检查的帧号（升序）；缺省 = 全部关键帧。配合 interpolated 可覆盖关键帧之间的每一帧。 */
  frames?: number[]
}

/**
 * 对整个 VMD 做逐帧 FK + 地面接触分析。
 * frames/vmdBytes 二选一；解析或求值失败返回 null。
 */
export function analyzeGroundContact(
  bones: PmxBones,
  vmd: Uint8Array,
  opts: AnalyzeOptions = {}
): GroundContactReport | null {
  const keys = readVmdBoneKeys(vmd)
  if (!keys || keys.length === 0) return null
  return analyzeGroundContactKeys(bones, keys, opts)
}

export function analyzeGroundContactKeys(
  bones: PmxBones,
  keys: VmdBoneKey[],
  opts: AnalyzeOptions = {}
): GroundContactReport | null {
  try {
    const semantics = detectPosSemantics(bones)
    const terminals = opts.terminals ?? DEFAULT_TERMINALS
    const threshold = opts.penetrationThreshold ?? -0.5
    const sortedKeys = [...keys].sort((a, b) => a.frame - b.frame)
    const distinctFrames = opts.frames ?? [...new Set(sortedKeys.map((k) => k.frame))].sort((a, b) => a - b)
    const state = new Map<string, VmdBoneKey>()
    const tracks = opts.interpolated ? buildBoneTracks(keys) : null
    let ki = 0
    const reports: GroundFrameReport[] = []
    let lowest: number | null = null
    let penetration = 0
    for (const frame of distinctFrames) {
      while (ki < sortedKeys.length && sortedKeys[ki].frame <= frame) {
        state.set(sortedKeys[ki].jp, sortedKeys[ki])
        ki++
      }
      const world = tracks ? samplePoseTransforms(bones, tracks, frame, semantics)?.pos : solveFrameWorld(bones, state, semantics)
      if (!world) return null
      const terminalsY: Record<string, number> = {}
      let frameLowest: number | null = null
      for (const jp of terminals) {
        const idx = bones.indexByJp.get(jp)
        if (idx == null) continue
        const y = world[idx]?.y
        if (y == null || Number.isNaN(y)) continue
        terminalsY[jp] = Number(y.toFixed(3))
        if (frameLowest == null || y < frameLowest) frameLowest = y
      }
      const centerIdx = bones.indexByJp.get("センター")
      const centerY = centerIdx != null && world[centerIdx] ? Number(world[centerIdx].y.toFixed(3)) : null
      reports.push({ frame, terminals: terminalsY, centerY })
      if (frameLowest != null && (lowest == null || frameLowest < lowest)) lowest = frameLowest
      if (frameLowest != null && frameLowest < threshold) penetration++
    }

    const issues: string[] = []
    if (lowest != null && lowest > 1) {
      issues.push(`lowest terminal y=${lowest.toFixed(2)}u (≈${(lowest * 8).toFixed(0)}cm) — limbs appear to float above the ground`)
    }
    if (penetration > 0) {
      issues.push(`${penetration}/${reports.length} frames have terminals below y=${threshold} — ground penetration`)
    }
    if (issues.length === 0) {
      issues.push("ground contact plausible: all terminals within tolerance of the floor plane")
    }

    return {
      semantics,
      frames: reports,
      lowestTerminalY: lowest,
      penetrationFrames: penetration,
      summary: issues.join("; "),
    }
  } catch {
    return null
  }
}
