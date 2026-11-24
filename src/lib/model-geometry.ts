/**
 * model-geometry.ts — 模型几何层（Layer 1/2 共用基础）。
 *
 * 关键事实（docs/how-llm-understands-pmx.md §5）：
 *  - PMX 规范规定骨骼 position 是父骨偏移，但部分转换模型（游戏改）直接存绝对坐标。
 *    工作区三个模型（topaz/梵天/梵天2）实测全部是绝对语义——父链累加会算出 7 米身高。
 *    启发式：标准脊柱链上（全ての親→…→頭），chainY 远大于 rawY → absolute。
 *  - MMD 单位 1u ≈ 8cm。
 *
 * 本模块被 model-conditioning.ts（LLM 条件化）与 fk.ts（几何检查闭环）共用。
 */

import type { PmxBones } from "./pmx-bones.ts"

export type PosSemantics = "absolute" | "offset"
export interface Vec3 { x: number; y: number; z: number }

/** 语义检测：頭 骨骼的链条累加 y vs 原始 y（chainY > 3×rawY → absolute） */
export function detectPosSemantics(bones: PmxBones): PosSemantics {
  const headIdx = bones.indexByJp.get("頭")
  if (headIdx == null) return "offset"
  let y = 0
  let i = headIdx
  const seen = new Set<number>()
  let guard = bones.bones.length
  while (i >= 0 && i < bones.bones.length && guard-- > 0) {
    if (seen.has(i)) break
    seen.add(i)
    y += bones.bones[i].pos[1]
    i = bones.bones[i].parent
  }
  const rawY = bones.bones[headIdx].pos[1]
  if (rawY > 0 && y > rawY * 3) return "absolute"
  return "offset"
}

/** 静止姿势（bind pose）的世界坐标表。 */
export function restWorldPositions(bones: PmxBones): Map<number, Vec3> {
  const semantics = detectPosSemantics(bones)
  const out = new Map<number, Vec3>()
  bones.bones.forEach((b, i) => {
    const p = b.parent >= 0 ? out.get(b.parent) : undefined
    if (semantics === "absolute") {
      out.set(i, { x: b.pos[0], y: b.pos[1], z: b.pos[2] })
    } else {
      out.set(i, p ? { x: p.x + b.pos[0], y: p.y + b.pos[1], z: p.z + b.pos[2] } : { x: b.pos[0], y: b.pos[1], z: b.pos[2] })
    }
  })
  return out
}

export interface ModelMeasurements {
  posSemantics: PosSemantics
  heightUnits: number
  heightCm: number
  hipY: number | null
  armLenUnits: number
  armLenCm: number
  legLenUnits: number
  legLenCm: number
  headY: number | null
  footY: number | null
  /** Real silhouette metrics derived from vertex envelopes & bind pose */
  shoulderHalfWidth: number | null
  hipHalfWidth: number | null
  chestFrontZ: number | null
  headRadius: number | null
  /** A-pose arm downward angle below horizontal (degrees) */
  armRestAngleDeg: number | null
}

const U2CM = 8 // MMD 1 unit ≈ 8cm
const f2 = (n: number) => Number(n.toFixed(2))

/** 身高/腰高/臂长/腿长/关键骨骼高度 + 真实包络轮廓（pmx-info.mjs 同源实现）。 */
export function measureModelGeometry(bones: PmxBones): ModelMeasurements {
  const world = restWorldPositions(bones)
  const w = (jp: string): Vec3 | null => {
    const i = bones.indexByJp.get(jp)
    return i != null ? world.get(i) ?? null : null
  }
  const seg = (a: Vec3 | null, b: Vec3 | null) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0)
  const head = w("頭"), footL = w("左足首"), center = w("センター")
  const armL = w("左腕"), wristL = w("左手首")
  const armChain = [w("左肩"), armL, w("左ひじ"), wristL].filter(Boolean) as Vec3[]
  const legChain = [w("左足"), w("左ひざ"), footL].filter(Boolean) as Vec3[]
  let armLen = 0
  for (let i = 1; i < armChain.length; i++) armLen += seg(armChain[i - 1], armChain[i])
  let legLen = 0
  for (let i = 1; i < legChain.length; i++) legLen += seg(legChain[i - 1], legChain[i])
  const ys = [...world.values()].map((v) => v.y)
  const topY = Math.max(...ys)
  const bottomY = Math.min(...ys)

  const env = bones.envelopes ?? {}
  const upper2Env = env["上半身2"] ?? env["上半身"]
  const hipEnv = env["下半身"]
  const headEnv = env["頭"]

  const shoulderHalfWidth = armL ? f2(Math.abs(armL.x)) : null
  const hipHalfWidth = hipEnv ? f2(Math.max(Math.abs(hipEnv.min[0]), Math.abs(hipEnv.max[0]))) : null
  const chestFrontZ = upper2Env ? f2(upper2Env.min[2]) : null
  const headRadius = headEnv
    ? f2(Math.max(headEnv.max[0] - headEnv.min[0], headEnv.max[2] - headEnv.min[2]) / 2)
    : null
  let armRestAngleDeg: number | null = null
  if (armL && wristL) {
    const dx = Math.abs(wristL.x - armL.x)
    const dy = armL.y - wristL.y
    if (dx > 0.01) armRestAngleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI)
  }

  return {
    posSemantics: detectPosSemantics(bones),
    heightUnits: f2(topY - bottomY),
    heightCm: Math.round((topY - bottomY) * U2CM),
    hipY: center ? f2(center.y) : null,
    armLenUnits: f2(armLen),
    armLenCm: Math.round(armLen * U2CM),
    legLenUnits: f2(legLen),
    legLenCm: Math.round(legLen * U2CM),
    headY: head ? f2(head.y) : null,
    footY: footL ? f2(footL.y) : null,
    shoulderHalfWidth,
    hipHalfWidth,
    chestFrontZ,
    headRadius,
    armRestAngleDeg,
  }
}
