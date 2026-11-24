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

function qMul(a: Quat, b: Quat): Quat {
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

function qConjugate(q: Quat): Quat {
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
    const distinctFrames = [...new Set(sortedKeys.map((k) => k.frame))].sort((a, b) => a - b)
    const state = new Map<string, VmdBoneKey>()
    let ki = 0
    const reports: GroundFrameReport[] = []
    let lowest: number | null = null
    let penetration = 0
    for (const frame of distinctFrames) {
      while (ki < sortedKeys.length && sortedKeys[ki].frame <= frame) {
        state.set(sortedKeys[ki].jp, sortedKeys[ki])
        ki++
      }
      const world = solveFrameWorld(bones, state, semantics)
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
