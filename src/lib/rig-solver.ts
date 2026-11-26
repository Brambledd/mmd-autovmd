/**
 * rig-solver.ts — 连续帧混合动力学全身求解器（30fps）
 *
 * 架构设计（对齐方案 A2）：
 *  - 主控目标（重心左右移、下蹲深度、手部空间目标、表情权重）：
 *    按节拍走带质感曲线（soft / snappy / bouncy / heavy）的精准插值，保证准时到位、不吃幅度。
 *  - 次级联动与缓冲（脊柱波浪、骨盆微弹、头部滞后、肩部追随）：
 *    走三参数二阶弹簧-阻尼动力学（f, z, r），自然产生惯性、预备与 Follow-through。
 *  - 分层全身运动学（逐帧 30fps 求解）：
 *    Layer 1: 重心与双脚 2-bone Leg IK（从源头保证每帧贴地，支持骨盆自由左右摆动与下蹲）
 *    Layer 2: 脊柱样条联动 + 重心平衡补偿（告别铁棍脊柱）
 *    Layer 3: 身体胶囊避障 + 肩肱耦合 + 2-bone Arm IK + 手型基底混合
 *    Layer 4: 视线（眼→头分级）+ 连续呼吸微动 + 自然眨眼
 *  - 输出：四元数误差抽稀后的标准 VMD（附带关闭足 IK 的首帧属性帧，跨引擎一致）。
 */

import Encoding from "encoding-japanese"
import { restWorldPositions } from "./model-geometry.ts"
import type { EllipticalSlice, PmxBones } from "./pmx-bones.ts"
import type { ArmRig, HandGripSpec, Quat, RigProfile, V3 } from "./rig-profile.ts"
import { serializeVmd, type BoneKey, type ParsedVmd, type PropertyFrame, type VmdCurve } from "./vmd-enhancer.ts"
import { injectMorphFrames, type MorphKey } from "./vmd-morph.ts"

// ------------------------------------------------------------------ MotionIntent Schema

export type EffortStyle = "soft" | "snappy" | "bouncy" | "heavy"

export interface HandIntent {
  /** "rest" = relaxed at side (Neutral Pose), "reach" = IK to semantic anchor or [x,y,z] */
  mode: "rest" | "reach"
  /** Semantic anchor name from rig-profile (e.g. "cheek_r", "wave_r", "chest_center") or world [x,y,z] */
  target?: string | V3
  /** Optional offset in cm [right/left(+X=left), up(+Y), back(+Z, -Z=forward)] */
  offsetCm?: V3
  /** Elbow arc preference ("akimbo" = hands-on-hips outward elbow) */
  arc?: "outward" | "inward" | "natural" | "akimbo"
  /** Which part of the hand should land on the anchor (auto-defaults to "palm" for surface anchors) */
  endEffector?: "wrist" | "palm" | "fingertip"
  /** Desired palm facing: "surface" (into anchor normal), "camera" (toward -Z), "inward", "down", or "natural" */
  palm?: "surface" | "camera" | "inward" | "down" | "natural"
  /** Hand grip blend e.g. "relax", "open", "fist", or "open:0.4,relax:0.6" */
  grip?: string
}

export interface MotionBeat {
  /** Beat timestamp in seconds */
  at: number
  /** Effort/dynamics flavor entering this beat */
  effort?: EffortStyle
  /** If true, motion flows smoothly through this beat (Catmull-Rom) instead of slowing to a stop */
  passThrough?: boolean
  stance?: {
    /** -1 = full right foot, 0 = centered, +1 = full left foot */
    weightShift?: number
    /** 0 = standing, 1 = deep squat (~5.5u hip drop) */
    squat?: number
    /** Pelvis yaw in degrees (+left, -right) */
    hipYawDeg?: number
  }
  spine?: {
    /** Forward(+) / backward(-) curl, normalized [-1, 1] -> ~[-35°, +45°] total */
    curl?: number
    /** Left(+) / right(-) twist, normalized [-1, 1] -> ~[-40°, +40°] total */
    twist?: number
    /** Left(+) / right(-) side lean, normalized [-1, 1] -> ~[-25°, +25°] total */
    lean?: number
  }
  hand_l?: HandIntent
  hand_r?: HandIntent
  gaze?: {
    /** "camera" | "left" | "right" | "up" | "down" | "hand_l" | "hand_r" */
    target?: string
    /** Expressive head tilt (roll) in degrees (+tilt left, -tilt right) */
    headTiltDeg?: number
    /** Head pitch bias in degrees (+nod down, -look up) */
    headPitchDeg?: number
  }
  /** Semantic morph channels from rig-profile.morphMap (0..1) */
  face?: Record<string, number>
}

export interface SceneObstacle {
  id?: string
  a: V3
  b: V3
  radius: number
}

export interface MotionIntent {
  title?: string
  fps?: number
  /** Auto breathing micro-motion (default true) */
  breathing?: boolean
  /** Auto natural eye blinks (default true) */
  autoBlink?: boolean
  /** Lightweight acceleration-driven secondary spring physics for hair/ribbons/skirts (default true; set false if using native Blender Bullet physics) */
  secondaryPhysics?: boolean
  /** Optional static scene collision capsules (e.g. chairs, tables, walls) in model/world space */
  obstacles?: SceneObstacle[]
  beats: MotionBeat[]
}

export interface RigSolveResult {
  vmd: Uint8Array
  frameCount: number
  durationSec: number
  rawKeyCount: number
  decimatedKeyCount: number
  morphKeyCount: number
  solveTimeMs: number
}

// ------------------------------------------------------------------ Math helpers

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }
const LINEAR_CURVE: VmdCurve = { x1: 20, y1: 20, x2: 107, y2: 107 }
const DEG = Math.PI / 180

function vAdd(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function vSub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function vScale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s] }
function vDot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function vCross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function vLen(a: V3): number { return Math.hypot(a[0], a[1], a[2]) }
function vNorm(a: V3): V3 {
  const l = vLen(a)
  return l > 1e-7 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1]
}
function vLerp(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
function smoothstep01(x: number): number {
  const c = Math.max(0, Math.min(1, x))
  return c * c * (3 - 2 * c)
}
/** Centripetal-like Catmull-Rom cubic interpolation for continuous motion-through-beats. */
function catmullRomScalar(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  const v = 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  )
  // Softly prevent wild ringing on flat holds
  const lo = Math.min(p1, p2) - Math.abs(p2 - p1) * 0.25
  const hi = Math.max(p1, p2) + Math.abs(p2 - p1) * 0.25
  return Math.max(lo, Math.min(hi, v))
}
function catmullRomV3(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  return [
    catmullRomScalar(p0[0], p1[0], p2[0], p3[0], t),
    catmullRomScalar(p0[1], p1[1], p2[1], p3[1], t),
    catmullRomScalar(p0[2], p1[2], p2[2], p3[2], t),
  ]
}
/** Shoulder-centered spherical arc interpolation (natural anatomical arcs instead of robotic straight lines). */
function slerpAroundPivot(pivot: V3, posA: V3, posB: V3, t: number, outwardDir: V3, bulgeScale = 0.14): V3 {
  const vA = vSub(posA, pivot)
  const vB = vSub(posB, pivot)
  const rA = vLen(vA)
  const rB = vLen(vB)
  const chord = vLen(vSub(posB, posA))
  if (rA < 0.2 || rB < 0.2 || chord < 0.35) return vLerp(posA, posB, t)
  const uA = vScale(vA, 1 / rA)
  const uB = vScale(vB, 1 / rB)
  const qRot = qFromTwoVectors(uA, uB)
  const qStep = qSlerp(IDENTITY, qRot, t)
  const uCur = qRotate(qStep, uA)
  const rCur = rA + (rB - rA) * t
  // Gentle outward arc lift on long vertical/cross-body sweeps so hands glide cleanly around chest
  const arcBulge = Math.sin(Math.PI * t) * Math.min(0.85, chord * bulgeScale)
  return vAdd(vAdd(pivot, vScale(uCur, rCur)), vScale(outwardDir, arcBulge))
}

function qNorm(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w)
  return l > 1e-7 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : IDENTITY
}
function qConj(q: Quat): Quat { return { x: -q.x, y: -q.y, z: -q.z, w: q.w } }
function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}
function qRotate(q: Quat, v: V3): V3 {
  const tx = 2 * (q.y * v[2] - q.z * v[1])
  const ty = 2 * (q.z * v[0] - q.x * v[2])
  const tz = 2 * (q.x * v[1] - q.y * v[0])
  return [
    v[0] + q.w * tx + (q.y * tz - q.z * ty),
    v[1] + q.w * ty + (q.z * tx - q.x * tz),
    v[2] + q.w * tz + (q.x * ty - q.y * tx),
  ]
}
function qFromAxisAngle(axis: V3, deg: number): Quat {
  if (Math.abs(deg) < 1e-4) return IDENTITY
  const n = vNorm(axis)
  const half = (deg * DEG) * 0.5
  const s = Math.sin(half)
  return qNorm({ x: n[0] * s, y: n[1] * s, z: n[2] * s, w: Math.cos(half) })
}
function qFromTwoVectors(from: V3, to: V3): Quat {
  const u = vNorm(from)
  const v = vNorm(to)
  const d = Math.max(-1, Math.min(1, vDot(u, v)))
  if (d > 0.99999) return IDENTITY
  if (d < -0.99999) {
    let ortho = vCross([1, 0, 0], u)
    if (vLen(ortho) < 1e-4) ortho = vCross([0, 1, 0], u)
    return qFromAxisAngle(ortho, 180)
  }
  const c = vCross(u, v)
  return qNorm({ x: c[0], y: c[1], z: c[2], w: 1 + d })
}
function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot }
  if (dot > 0.9995) {
    return qNorm({ x: a.x + t * (bx - a.x), y: a.y + t * (by - a.y), z: a.z + t * (bz - a.z), w: a.w + t * (bw - a.w) })
  }
  const theta0 = Math.acos(Math.min(1, dot))
  const theta = theta0 * t
  const sinT = Math.sin(theta)
  const sinT0 = Math.sin(theta0)
  const s0 = Math.cos(theta) - dot * sinT / sinT0
  const s1 = sinT / sinT0
  return qNorm({ x: s0 * a.x + s1 * bx, y: s0 * a.y + s1 * by, z: s0 * a.z + s1 * bz, w: s0 * a.w + s1 * bw })
}
function qAngleDeg(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))
  return (2 * Math.acos(d)) / DEG
}
function qClampDeg(q: Quat, maxDeg: number): Quat {
  const nq = qNorm(q)
  const w = Math.max(-1, Math.min(1, nq.w))
  const ang = (2 * Math.acos(Math.abs(w))) / DEG
  if (ang <= maxDeg) return nq
  const s = Math.hypot(nq.x, nq.y, nq.z)
  if (s < 1e-7) return IDENTITY
  const half = (maxDeg * DEG) * 0.5
  const sign = w < 0 ? -1 : 1
  const scale = (Math.sin(half) / s) * sign
  return qNorm({ x: nq.x * scale, y: nq.y * scale, z: nq.z * scale, w: Math.cos(half) })
}
/** Build unit quaternion from 3 orthonormal right-handed basis columns (c0, c1, c2). */
function qFromBasis(c0: V3, c1: V3, c2: V3): Quat {
  const m00 = c0[0], m01 = c1[0], m02 = c2[0]
  const m10 = c0[1], m11 = c1[1], m12 = c2[1]
  const m20 = c0[2], m21 = c1[2], m22 = c2[2]
  const tr = m00 + m11 + m22
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2
    return qNorm({ w: 0.25 * S, x: (m21 - m12) / S, y: (m02 - m20) / S, z: (m10 - m01) / S })
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2
    return qNorm({ w: (m21 - m12) / S, x: 0.25 * S, y: (m01 + m10) / S, z: (m02 + m20) / S })
  } else if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2
    return qNorm({ w: (m02 - m20) / S, x: (m01 + m10) / S, y: 0.25 * S, z: (m12 + m21) / S })
  } else {
    const S = Math.sqrt(1 + m22 - m00 - m11) * 2
    return qNorm({ w: (m10 - m01) / S, x: (m02 + m20) / S, y: (m12 + m21) / S, z: 0.25 * S })
  }
}
/** Shortest-arc rotation mapping orthonormal basis (f0, n0) -> (ft, nt). */
function qBasisToBasis(f0: V3, n0: V3, ft: V3, nt: V3): Quat {
  const a0 = vNorm(f0)
  const b0 = vNorm(vSub(n0, vScale(a0, vDot(n0, a0))))
  const c0 = vNorm(vCross(a0, b0))
  const at = vNorm(ft)
  const bt = vNorm(vSub(nt, vScale(at, vDot(nt, at))))
  const ct = vNorm(vCross(at, bt))
  return qNorm(qMul(qFromBasis(at, bt, ct), qConj(qFromBasis(a0, b0, c0))))
}
/** Decompose qRel = qTwist * qSwing where qTwist rotates around unit axis. */
function decomposeTwistSwing(qRel: Quat, axis: V3): { twist: Quat; swing: Quat } {
  const nq = qRel.w < 0 ? { x: -qRel.x, y: -qRel.y, z: -qRel.z, w: -qRel.w } : qNorm(qRel)
  const ax = vNorm(axis)
  const proj = vDot([nq.x, nq.y, nq.z], ax)
  const twist = qNorm({ x: ax[0] * proj, y: ax[1] * proj, z: ax[2] * proj, w: nq.w })
  const swing = qNorm(qMul(qConj(twist), nq))
  return { twist, swing }
}

// ------------------------------------------------------------------ Second-Order Dynamics

class SecondOrderScalar {
  y: number
  yd = 0
  xp: number
  constructor(x0: number) { this.y = x0; this.xp = x0 }
  step(dt: number, x: number, f: number, z: number, r: number): number {
    const xd = (x - this.xp) / dt
    this.xp = x
    const k1 = z / (Math.PI * f)
    const k2 = 1 / ((2 * Math.PI * f) * (2 * Math.PI * f))
    const k3 = (r * z) / (2 * Math.PI * f)
    // Stability clamp for k2 at 30fps
    const k2Stable = Math.max(k2, dt * dt / 2 + dt * k1 / 2, dt * k1)
    this.y += dt * this.yd
    this.yd += (dt * (x + k3 * xd - this.y - k1 * this.yd)) / k2Stable
    return this.y
  }
}

const EFFORT_EASE: Record<EffortStyle, (t: number) => number> = {
  soft:   (t) => t * t * (3 - 2 * t), // smoothstep
  snappy: (t) => 1 - Math.pow(1 - t, 3), // fast out
  bouncy: (t) => {
    const s = t * t * (3 - 2 * t)
    return s + 0.08 * Math.sin(Math.PI * t) * Math.sin(2 * Math.PI * t)
  },
  heavy:  (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
}

const EFFORT_SPRING: Record<EffortStyle, { f: number; z: number; r: number }> = {
  soft:   { f: 1.8, z: 0.95, r: 0.0 },
  snappy: { f: 3.4, z: 0.65, r: 1.2 },
  bouncy: { f: 2.8, z: 0.48, r: 0.6 },
  heavy:  { f: 1.4, z: 0.85, r: -0.4 },
}

// ------------------------------------------------------------------ Analytical 2-Bone IK

/**
 * Solves a 2-bone chain in world space: returns exact world mid-joint position K
 * given root H, end target T, bone lengths L1/L2, and pole direction P.
 */
function solveTwoBoneMid(H: V3, T: V3, L1: number, L2: number, poleDir: V3): { K: V3; endPos: V3 } {
  const diff = vSub(T, H)
  const rawDist = vLen(diff)
  const minD = Math.abs(L1 - L2) + 0.05
  const maxD = L1 + L2 - 0.02
  const d = Math.max(minD, Math.min(maxD, rawDist))
  const dir = rawDist > 1e-6 ? vScale(diff, 1 / rawDist) : [0, -1, 0] as V3
  const endPos = vAdd(H, vScale(dir, d))

  const cosA = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)))
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))

  // Project poleDir perpendicular to dir
  const proj = vSub(poleDir, vScale(dir, vDot(poleDir, dir)))
  let perp = vLen(proj) > 1e-4 ? vNorm(proj) : vNorm(vCross(dir, [1, 0, 0]))
  if (vLen(perp) < 1e-4) perp = [0, 0, -1]

  const K = vAdd(vAdd(H, vScale(dir, L1 * cosA)), vScale(perp, L1 * sinA))
  return { K, endPos }
}

// ------------------------------------------------------------------ Capsule Push-out

function pushOutOfCapsule(p: V3, a: V3, b: V3, radiusA: number, radiusB = radiusA): V3 {
  const ab = vSub(b, a)
  const ab2 = vDot(ab, ab)
  const t = ab2 > 1e-7 ? Math.max(0, Math.min(1, vDot(vSub(p, a), ab) / ab2)) : 0
  const closest = vAdd(a, vScale(ab, t))
  const radius = radiusA + (radiusB - radiusA) * t
  const delta = vSub(p, closest)
  const dist = vLen(delta)
  if (dist >= radius) return p
  const n = dist > 1e-5 ? vScale(delta, 1 / dist) : [0, 0, -1] as V3
  return vAdd(closest, vScale(n, radius))
}

export interface WorldHull {
  id: string
  bonePos: V3
  boneRot: Quat
  a: V3
  b: V3
  radiusA: number
  radiusB: number
  slices?: EllipticalSlice[]
}

function pushOutOfHull(p: V3, hull: WorldHull, margin: number): V3 {
  if (hull.slices && hull.slices.length >= 2) {
    // Transform world point into bone-local space and evaluate exact multi-slice elliptical cross-section
    const lp = qRotate(qConj(hull.boneRot), vSub(p, hull.bonePos))
    const slices = hull.slices
    const yLo = slices[0].y
    const yHi = slices[slices.length - 1].y
    if (lp[1] < yLo - margin - 0.15 || lp[1] > yHi + margin + 0.15) return p
    const yClamped = Math.max(yLo, Math.min(yHi, lp[1]))
    // Find bracketing slices
    let s0 = slices[0], s1 = slices[slices.length - 1]
    for (let i = 0; i < slices.length - 1; i++) {
      if (yClamped >= slices[i].y && yClamped <= slices[i + 1].y) {
        s0 = slices[i]; s1 = slices[i + 1]; break
      }
    }
    const span = Math.max(1e-4, s1.y - s0.y)
    const u = Math.max(0, Math.min(1, (yClamped - s0.y) / span))
    const cx = s0.cx + (s1.cx - s0.cx) * u
    const cz = s0.cz + (s1.cz - s0.cz) * u
    const rx = s0.rx + (s1.rx - s0.rx) * u + margin
    const rz = s0.rz + (s1.rz - s0.rz) * u + margin

    const dx = lp[0] - cx
    const dz = lp[2] - cz
    const rNorm = Math.hypot(dx / rx, dz / rz)
    if (rNorm >= 1.0) return p
    let pushedLocal: V3
    if (rNorm > 1e-4) {
      const s = 1.0 / rNorm
      pushedLocal = [cx + dx * s, lp[1], cz + dz * s]
    } else {
      pushedLocal = [cx, lp[1], cz - rz]
    }
    return vAdd(hull.bonePos, qRotate(hull.boneRot, pushedLocal))
  }
  return pushOutOfCapsule(p, hull.a, hull.b, hull.radiusA + margin, hull.radiusB + margin)
}

// ------------------------------------------------------------------ VMD encoding helpers

function encodeBoneName(jp: string): Uint8Array {
  const out = new Uint8Array(15)
  try {
    const codes = Encoding.stringToCode(jp)
    const sjis = Encoding.convert(codes, { to: "SJIS", from: "UNICODE" }) as number[]
    for (let i = 0; i < Math.min(15, sjis.length); i++) out[i] = sjis[i] & 0xff
  } catch {
    for (let i = 0; i < Math.min(15, jp.length); i++) out[i] = jp.charCodeAt(i) & 0xff
  }
  return out
}

// ------------------------------------------------------------------ Hand grip expansion

function parseGripSpec(gripStr: string | undefined, profile: RigProfile): HandGripSpec {
  const def = profile.handGrips["relax"]
  if (!gripStr) return def
  if (profile.handGrips[gripStr]) return profile.handGrips[gripStr]
  const out: HandGripSpec = { thumbCurl: 0, indexCurl: 0, middleCurl: 0, ringCurl: 0, pinkyCurl: 0, spread: 0 }
  let totalW = 0
  for (const part of gripStr.split(",")) {
    const [name, wStr] = part.split(":").map((s) => s.trim())
    const spec = profile.handGrips[name]
    const w = wStr != null ? parseFloat(wStr) : 1
    if (spec && Number.isFinite(w) && w > 0) {
      out.thumbCurl += spec.thumbCurl * w
      out.indexCurl += spec.indexCurl * w
      out.middleCurl += spec.middleCurl * w
      out.ringCurl += spec.ringCurl * w
      out.pinkyCurl += spec.pinkyCurl * w
      out.spread += spec.spread * w
      totalW += w
    }
  }
  if (totalW <= 1e-4) return def
  return {
    thumbCurl: out.thumbCurl / totalW,
    indexCurl: out.indexCurl / totalW,
    middleCurl: out.middleCurl / totalW,
    ringCurl: out.ringCurl / totalW,
    pinkyCurl: out.pinkyCurl / totalW,
    spread: out.spread / totalW,
  }
}

function applyHandGripToFrame(
  side: "l" | "r",
  grip: HandGripSpec,
  bones: PmxBones,
  rotOut: Map<string, Quat>,
  armRig?: ArmRig,
) {
  const p = side === "l" ? "左" : "右"
  const s = side === "l" ? 1 : -1
  // Use PMX-derived finger axes when available; fall back to standard MMD A-pose axes
  const fingerCurl: Array<[string, number, number]> = [
    ["人指", grip.indexCurl, 0.4],
    ["中指", grip.middleCurl, 0.0],
    ["薬指", grip.ringCurl, -0.35],
    ["小指", grip.pinkyCurl, -0.7],
  ]
  for (const [fName, curl, spreadDir] of fingerCurl) {
    const segAngles = [curl * 68, curl * 75, curl * 55]
    for (let k = 0; k < 3; k++) {
      const jp = `${p}${fName}${["１", "２", "３"][k]}`
      if (!bones.indexByJp.has(jp)) continue
      const fa = armRig?.fingerAxes?.[jp]
      const curlAxis: V3 = fa?.curlAxis ?? [0, 0, -s]
      const spreadAxis: V3 = fa?.spreadAxis ?? [0, 1, 0]
      let q = qFromAxisAngle(curlAxis, segAngles[k])
      if (k === 0 && Math.abs(spreadDir * grip.spread) > 0.01) {
        q = qMul(q, qFromAxisAngle(spreadAxis, s * spreadDir * grip.spread * 22))
      }
      rotOut.set(jp, q)
    }
  }
  // Thumb curls inward around anatomical spread+curl axes
  const thumbAngles = [grip.thumbCurl * 28, grip.thumbCurl * 38, grip.thumbCurl * 45]
  for (let k = 0; k < 3; k++) {
    const jp = `${p}親指${["０", "１", "２"][k]}`
    if (!bones.indexByJp.has(jp)) continue
    const fa = armRig?.fingerAxes?.[jp]
    const curlAxis: V3 = fa?.curlAxis ?? [0, 0, -s]
    const spreadAxis: V3 = fa?.spreadAxis ?? [0, 1, 0]
    const q = qMul(
      qFromAxisAngle(spreadAxis, s * thumbAngles[k] * 0.7),
      qFromAxisAngle(curlAxis, thumbAngles[k] * 0.5),
    )
    rotOut.set(jp, q)
  }
}

// ------------------------------------------------------------------ Mini Grant-Aware FK

export interface FkState {
  pos: Map<number, V3>
  rot: Map<number, Quat>
}

function solveFkSnapshot(
  bones: PmxBones,
  restWorld: Map<number, V3>,
  localRots: Map<string, Quat>,
  localTrans: Map<string, V3>,
): FkState {
  const pos = new Map<number, V3>()
  const rot = new Map<number, Quat>()
  const localRotByIdx = new Map<number, Quat>()

  for (let i = 0; i < bones.bones.length; i++) {
    const b = bones.bones[i]
    let qLocal = localRots.get(b.jp) ?? IDENTITY
    if (b.grant && b.grant.rotate && b.grant.parent >= 0 && b.grant.parent < i) {
      const gp = localRotByIdx.get(b.grant.parent) ?? IDENTITY
      if (Math.abs(b.grant.ratio) > 1e-4) {
        const gq = b.grant.ratio >= 0
          ? qSlerp(IDENTITY, gp, Math.min(1, b.grant.ratio))
          : qSlerp(IDENTITY, qConj(gp), Math.min(1, -b.grant.ratio))
        qLocal = qMul(gq, qLocal)
      }
    }
    localRotByIdx.set(i, qLocal)

    const rw = restWorld.get(i) ?? [0, 0, 0] as V3
    const tLocal = localTrans.get(b.jp) ?? [0, 0, 0] as V3
    if (b.parent >= 0 && b.parent < i) {
      const pPos = pos.get(b.parent) ?? [0, 0, 0] as V3
      const pRot = rot.get(b.parent) ?? IDENTITY
      const pRest = restWorld.get(b.parent) ?? [0, 0, 0] as V3
      const restOff = vSub(rw, pRest)
      pos.set(i, vAdd(pPos, qRotate(pRot, vAdd(restOff, tLocal))))
      rot.set(i, qMul(pRot, qLocal))
    } else {
      pos.set(i, vAdd(rw, tLocal))
      rot.set(i, qLocal)
    }
  }
  return { pos, rot }
}

// ------------------------------------------------------------------ Keyframe Decimation

interface RawBoneSample {
  frame: number
  pos: V3
  quat: Quat
}

/** Zero-phase 3-tap SLERP smoothing filter [0.22, 0.56, 0.22] to eliminate micro-jitter on upper-body/arm tracks. */
function smoothQuatTrack(samples: RawBoneSample[], passes = 2): RawBoneSample[] {
  if (samples.length <= 2 || passes <= 0) return samples
  let cur = samples
  for (let p = 0; p < passes; p++) {
    const next: RawBoneSample[] = [cur[0]]
    for (let i = 1; i < cur.length - 1; i++) {
      const qNeighbors = qSlerp(cur[i - 1].quat, cur[i + 1].quat, 0.5)
      const qSmooth = qSlerp(cur[i].quat, qNeighbors, 0.44)
      next.push({ frame: cur[i].frame, pos: cur[i].pos, quat: qNorm(qSmooth) })
    }
    next.push(cur[cur.length - 1])
    cur = next
  }
  return cur
}

function decimateTrack(samples: RawBoneSample[], angleTolDeg = 0.25, posTol = 0.008): RawBoneSample[] {
  if (samples.length <= 2) return samples
  const keep = new Uint8Array(samples.length)
  keep[0] = 1
  keep[samples.length - 1] = 1

  const rdp = (lo: number, hi: number) => {
    if (hi - lo <= 1) return
    const a = samples[lo]
    const b = samples[hi]
    const span = b.frame - a.frame
    let maxIdx = -1
    let maxErr = 0
    for (let i = lo + 1; i < hi; i++) {
      const t = (samples[i].frame - a.frame) / span
      const qInterp = qSlerp(a.quat, b.quat, t)
      const pInterp = vLerp(a.pos, b.pos, t)
      const angErr = qAngleDeg(samples[i].quat, qInterp)
      const posErr = vLen(vSub(samples[i].pos, pInterp))
      const err = Math.max(angErr / angleTolDeg, posErr / posTol)
      if (err > maxErr) {
        maxErr = err
        maxIdx = i
      }
    }
    if (maxErr > 1.0 && maxIdx > lo) {
      keep[maxIdx] = 1
      rdp(lo, maxIdx)
      rdp(maxIdx, hi)
    }
  }
  rdp(0, samples.length - 1)
  return samples.filter((_, i) => keep[i] === 1)
}

// ------------------------------------------------------------------ Main Solver

export interface SolveMotionIntentOptions {
  /** Inject partner body hulls (in this actor's local space) for arm & cloth/hair collision avoidance */
  externalWorldHulls?: (frame: number, timeSec: number) => WorldHull[]
  /** Override hand target in this actor's local space (for dynamic partner:* targets & mutual contacts) */
  overrideHandTarget?: (
    frame: number,
    side: "l" | "r",
    timeSec: number,
    beatAtSec?: number,
  ) => {
    localTarget: V3
    localNormal?: V3
    palmMode?: string
    endEffector?: "wrist" | "palm" | "fingertip"
    grip?: string
  } | null
  /** Optional dynamic gaze override (in degrees, actor-local). Return null to keep normal single-actor gaze. */
  overrideGaze?: (
    frame: number,
    headLocalPos: V3,
    timeSec: number,
  ) => { headYawDeg?: number; headPitchDeg?: number } | null
  /** Optional dynamic root placement (全ての親) offset/yaw relative to initial placement */
  rootLocalTransform?: (
    frame: number,
    timeSec: number,
  ) => { pos: V3; yawDeg: number } | null
  /** Beat timestamps (sec) where Lead & Follow phase lag should taper to 0 for tight duo sync */
  syncContactTimes?: number[]
  /** Callback fired after each frame is solved (gives exact local FK & hulls) */
  onFrameSolved?: (frame: number, fk: FkState, worldHulls: WorldHull[]) => void
}

export function solveMotionIntent(
  intent: MotionIntent,
  profile: RigProfile,
  bones: PmxBones,
  options?: SolveMotionIntentOptions,
): RigSolveResult {
  const tStart = performance.now()
  if (intent.fps != null && intent.fps !== 30) {
    throw new Error(`VMD output requires fps=30 (got ${intent.fps})`)
  }
  const fps = 30
  const dt = 1 / fps
  const beats = [...intent.beats].sort((a, b) => a.at - b.at)
  if (beats.length === 0) throw new Error("MotionIntent must contain at least one beat")

  const durationSec = Math.max(0.5, beats[beats.length - 1].at)
  const totalFrames = Math.max(1, Math.round(durationSec * fps))

  const restWorldVec = restWorldPositions(bones)
  const restWorld = new Map<number, V3>()
  restWorldVec.forEach((v, idx) => restWorld.set(idx, [v.x, v.y, v.z]))

  // Helper: sample beat window (prev, a, b, next) at any phase-shifted time!
  const sampleBeats = (timeSec: number) => {
    const tClamped = Math.max(beats[0].at, Math.min(beats[beats.length - 1].at, timeSec))
    if (beats.length === 1) {
      return { prev: beats[0], a: beats[0], b: beats[0], next: beats[0], rawT: 0, t: 0, span: 1, effort: beats[0].effort ?? "soft" as EffortStyle, passThrough: false }
    }
    for (let i = 0; i < beats.length - 1; i++) {
      if (tClamped >= beats[i].at && (tClamped <= beats[i + 1].at || i === beats.length - 2)) {
        const prev = beats[Math.max(0, i - 1)]
        const a = beats[i]
        const b = beats[i + 1]
        const next = beats[Math.min(beats.length - 1, i + 2)]
        const span = Math.max(1e-4, b.at - a.at)
        const rawT = Math.max(0, Math.min(1, (tClamped - a.at) / span))
        const effort: EffortStyle = b.effort ?? "soft"
        const ease = EFFORT_EASE[effort]
        // Auto-detect rhythmic pass-through (e.g. rapid waving <= 0.65s between beats) or explicit passThrough flag
        const passThrough = Boolean(a.passThrough || b.passThrough || (span <= 0.65 && i > 0 && i < beats.length - 2))
        const t = passThrough ? rawT : Math.max(0, Math.min(1, ease(rawT)))
        return { prev, a, b, next, rawT, t, span, effort, passThrough }
      }
    }
    const last = beats[beats.length - 1]
    return { prev: last, a: last, b: last, next: last, rawT: 1, t: 1, span: 1, effort: last.effort ?? "soft" as EffortStyle, passThrough: false }
  }

  // Upgrade C: Body-Part Lead & Follow phase-shifted time (smoothly tapered to 0 at clip start, end & duo contact beats for arms/hands!)
  const phaseTime = (timeSec: number, leadSec: number, isContactSynced = false) => {
    let edge = Math.min(1, timeSec / 0.25, (durationSec - timeSec) / 0.25)
    if (isContactSynced && options?.syncContactTimes && options.syncContactTimes.length > 0) {
      for (const ct of options.syncContactTimes) {
        const d = Math.abs(timeSec - ct)
        if (d < 0.35) edge = Math.min(edge, d / 0.35)
      }
    }
    return Math.max(0, Math.min(durationSec, timeSec + leadSec * Math.max(0, edge)))
  }

  // Helper: evaluate scalar beat channel with Catmull-Rom flow when moving through beats, or smooth effort ease
  const evalScalar = (
    sample: ReturnType<typeof sampleBeats>,
    pick: (bt: MotionBeat) => number,
  ): number => {
    const v0 = pick(sample.prev), v1 = pick(sample.a), v2 = pick(sample.b), v3 = pick(sample.next)
    if (Math.abs(v2 - v1) < 1e-5) return v1
    if (sample.passThrough) return catmullRomScalar(v0, v1, v2, v3, sample.rawT)
    return v1 + (v2 - v1) * sample.t
  }

  // Secondary spring-damper states (for natural follow-through, ripple & bounce)
  const s0 = beats[0]
  const sprCurl = new SecondOrderScalar(s0.spine?.curl ?? 0)
  const sprTwist = new SecondOrderScalar(s0.spine?.twist ?? 0)
  const sprLean = new SecondOrderScalar(s0.spine?.lean ?? 0)
  const sprHeadTilt = new SecondOrderScalar(s0.gaze?.headTiltDeg ?? 0)
  const sprHeadPitch = new SecondOrderScalar(s0.gaze?.headPitchDeg ?? 0)
  const sprHeadYaw = new SecondOrderScalar(0)
  const sprPelvisBounce = new SecondOrderScalar(0)
  const sprWeightLag = new SecondOrderScalar(s0.stance?.weightShift ?? 0)

  // Upgrade D: Wrist 3D velocity springs for authentic inertial drag & wave follow-through
  const wristVelSprings = {
    l: { x: new SecondOrderScalar(0), y: new SecondOrderScalar(0), z: new SecondOrderScalar(0) },
    r: { x: new SecondOrderScalar(0), y: new SecondOrderScalar(0), z: new SecondOrderScalar(0) },
  }
  const prevWristWorld: { l: V3 | null; r: V3 | null } = { l: null, r: null }

  // Phase 1 Soft-Tissue Dynamics: torso acceleration springs for pose + inertia driven chest deformation
  const sprChestInertiaY = new SecondOrderScalar(0)
  const sprChestInertiaX = new SecondOrderScalar(0)
  let prevChestWorld: V3 | null = null
  let prevChestVel: V3 = [0, 0, 0]

  // Phase 2 Secondary Physics Chains: Verlet world-space tip particles for hair/ribbons/skirts
  const physNodes = intent.secondaryPhysics !== false ? (profile.softTissue?.physicsNodes ?? []) : []
  const physBoneSet = new Set(physNodes.map((n) => n.boneJp))
  const physTipPos = new Map<string, V3>()
  const physPrevTipPos = new Map<string, V3>()

  const tracks = new Map<string, RawBoneSample[]>()
  const recordBone = (jp: string, frame: number, pos: V3, quat: Quat) => {
    if (!bones.indexByJp.has(jp)) return
    let arr = tracks.get(jp)
    if (!arr) { arr = []; tracks.set(jp, arr) }
    arr.push({ frame, pos, quat })
  }

  const hipSpreadX = Math.abs(profile.legs.l.restAnklePos[0] - profile.legs.r.restAnklePos[0]) * 0.5
  const maxSquatDrop = Math.min(5.5, (profile.legs.l.thighLen + profile.legs.l.shinLen) * 0.48)

  // Morph keys collected at beats + safe auto-blinks (skip blinks when eyes are already closed by laugh/squint/wink!)
  const EYE_CLOSED_SEM = new Set(["laugh", "happy_squint", "wink_l", "wink_r"])
  const morphKeys: MorphKey[] = []
  const allSemanticMorphs = new Set<string>()
  for (const b of beats) {
    if (b.face) for (const k of Object.keys(b.face)) allSemanticMorphs.add(k)
  }
  for (const b of beats) {
    const f = Math.round(b.at * fps)
    // Aggregate max weight per PMX morph name at this beat frame (prevents overlapping aliases like smile & warm_smile from overwriting each other!)
    const maxByPmx = new Map<string, number>()
    // Also allow driving any discovered PMX morph verbatim if not aliased in profile.morphMap (e.g. material/bone/body morphs)
    const knownExtraMorphs = new Set((profile.softTissue?.extraMorphs ?? []).map((m) => m.jp))
    for (const sem of allSemanticMorphs) {
      const w = Math.max(0, Math.min(1, b.face?.[sem] ?? 0))
      const pmxNames = profile.morphMap[sem] ?? (knownExtraMorphs.has(sem) ? [sem] : undefined)
      if (!pmxNames) continue
      for (const name of pmxNames) {
        const prev = maxByPmx.get(name) ?? 0
        if (w > prev || !maxByPmx.has(name)) maxByPmx.set(name, Math.max(prev, w))
      }
    }
    for (const [name, weight] of maxByPmx.entries()) {
      morphKeys.push({ name, frame: f, weight })
    }
  }
  if (intent.autoBlink !== false && totalFrames >= 45 && profile.morphMap["blink"]) {
    const blinkName = profile.morphMap["blink"][0]
    for (let f = 45; f + 6 <= totalFrames; f += 82) {
      const sample = sampleBeats(f * dt)
      let eyesBusy = false
      for (const sem of EYE_CLOSED_SEM) {
        if ((sample.a.face?.[sem] ?? 0) > 0.2 || (sample.b.face?.[sem] ?? 0) > 0.2) {
          eyesBusy = true; break
        }
      }
      if (eyesBusy) continue
      morphKeys.push({ name: blinkName, frame: f - 2, weight: 0 })
      morphKeys.push({ name: blinkName, frame: f, weight: 1 })
      morphKeys.push({ name: blinkName, frame: f + 4, weight: 0 })
    }
  }

  // Precompute dynamic root velocity & walk-cycle phase when rootLocalTransform is provided
  const walkAmpByFrame = new Float32Array(totalFrames + 1)
  const walkPhaseByFrame = new Float32Array(totalFrames + 1)
  if (options?.rootLocalTransform) {
    const roots = Array.from({ length: totalFrames + 1 }, (_, f) => options.rootLocalTransform!(f, f * dt))
    let phase = 0
    for (let f = 0; f <= totalFrames; f++) {
      const prev = roots[Math.max(0, f - 1)]
      const next = roots[Math.min(totalFrames, f + 1)]
      const spanDt = (Math.min(totalFrames, f + 1) - Math.max(0, f - 1)) * dt
      if (prev && next && spanDt > 1e-5) {
        const horizSpeed = Math.hypot(next.pos[0] - prev.pos[0], next.pos[2] - prev.pos[2]) / spanDt
        const yawSpeed = Math.abs(next.yawDeg - prev.yawDeg) / spanDt
        const rawAmp = Math.max(
          horizSpeed > 0.5 ? Math.min(1, (horizSpeed - 0.5) / 2.0) : 0,
          yawSpeed > 12 ? Math.min(0.7, (yawSpeed - 12) / 45) : 0,
        )
        const edgeFade = Math.min(1, f / 6, (totalFrames - f) / 6)
        walkAmpByFrame[f] = rawAmp * edgeFade
        if (walkAmpByFrame[f] > 0.02) {
          phase += 2 * Math.PI * 1.75 * dt
        }
      }
      walkPhaseByFrame[f] = phase
    }
  }

  // ---- Per-frame 30fps continuous solve loop ----
  for (let frame = 0; frame <= totalFrames; frame++) {
    const timeSec = frame * dt

    // Upgrade C: Per-body-layer Lead & Follow timing (eliminates robotic lockstep!)
    // Eyes (+0.12s) -> Head (+0.06s) -> Pelvis/Stance (+0.04s) -> Spine (0.0s) -> Arms (-0.05s) -> Hand/Grip (-0.09s)
    const sEye = sampleBeats(phaseTime(timeSec, +0.12))
    const sHead = sampleBeats(phaseTime(timeSec, +0.06))
    const sStance = sampleBeats(phaseTime(timeSec, +0.04))
    const sSpine = sampleBeats(timeSec)
    const sArm = sampleBeats(phaseTime(timeSec, -0.05, true))
    const sHand = sampleBeats(phaseTime(timeSec, -0.09, true))

    const sp = EFFORT_SPRING[sSpine.effort]

    // Continuous living breath + Moving Hold organic micro-drift (eliminates frozen-statue holds!)
    const breath = intent.breathing !== false ? Math.sin(timeSec * 2 * Math.PI * 0.28) : 0
    const lifeEdge = Math.min(1, timeSec / 0.3, (durationSec - timeSec) / 0.3)
    const livingSway = intent.breathing !== false ? Math.sin(timeSec * 1.45) * 0.032 * lifeEdge : 0
    const livingHeadNod = intent.breathing !== false ? Math.sin(timeSec * 1.65 + 0.7) * 1.1 * lifeEdge : 0
    const livingHeadTilt = intent.breathing !== false ? Math.cos(timeSec * 1.18) * 0.9 * lifeEdge : 0

    // 1. Primary targets evaluated at their anatomical lead/lag phase
    const weightTarget = evalScalar(sStance, (bt) => bt.stance?.weightShift ?? 0) + livingSway
    const squatTarget = evalScalar(sStance, (bt) => bt.stance?.squat ?? 0)
    const hipYawTarget = evalScalar(sStance, (bt) => bt.stance?.hipYawDeg ?? 0)
    const curlTarget = evalScalar(sSpine, (bt) => bt.spine?.curl ?? 0)
    const twistTarget = evalScalar(sSpine, (bt) => bt.spine?.twist ?? 0)
    const leanTarget = evalScalar(sSpine, (bt) => bt.spine?.lean ?? 0)
    const headTiltTarget = evalScalar(sHead, (bt) => bt.gaze?.headTiltDeg ?? 0) + livingHeadTilt
    const headPitchTarget = evalScalar(sHead, (bt) => bt.gaze?.headPitchDeg ?? 0) + livingHeadNod

    // 2. Secondary dynamics (natural inertia, ripple & follow-through)
    const curlDyn = sprCurl.step(dt, curlTarget, sp.f * 0.92, sp.z, sp.r)
    const twistDyn = sprTwist.step(dt, twistTarget, sp.f * 0.88, sp.z, sp.r)
    const leanDyn = sprLean.step(dt, leanTarget, sp.f * 0.88, sp.z, sp.r)
    const headTiltDyn = sprHeadTilt.step(dt, headTiltTarget, sp.f * 0.82, sp.z * 0.9, sp.r)
    const headPitchDyn = sprHeadPitch.step(dt, headPitchTarget, sp.f * 0.82, sp.z * 0.9, sp.r)
    const weightLag = sprWeightLag.step(dt, weightTarget, sp.f * 0.95, sp.z, sp.r * 0.5)
    // Subtle vertical bounce coupled to weight shifts
    const bounceInput = -Math.abs(weightTarget - weightLag) * 0.45
    const pelvisBounce = sprPelvisBounce.step(dt, bounceInput, sp.f * 1.1, Math.max(0.45, sp.z * 0.8), 0.3)

    // Start from Neutral Pose (not bind pose!)
    const localRots = new Map<string, Quat>()
    const localTrans = new Map<string, V3>()
    for (const [jp, q] of Object.entries(profile.neutralPose)) {
      localRots.set(jp, q)
    }

    // Optional dynamic root placement (全ての親) for duo walking/approach
    const rootDyn = options?.rootLocalTransform?.(frame, timeSec)
    const qRootDyn = rootDyn ? qFromAxisAngle([0, 1, 0], -rootDyn.yawDeg) : IDENTITY
    if (rootDyn && bones.indexByJp.has("全ての親")) {
      localTrans.set("全ての親", rootDyn.pos)
      localRots.set("全ての親", qRootDyn)
    }

    // ---- Layer 1: Pelvis / Center + Elastic Groove + Exact 2-Bone Leg IK (Source-level Grounding) ----
    const grooveJp = profile.softTissue?.grooveJp
    const centerShiftX = weightTarget * hipSpreadX * 0.78
    const elasticY = pelvisBounce * 0.35 + breath * 0.03
    // Natural hip hinge: hips shift slightly backward (+Z) when squatting
    const centerShiftZ = squatTarget * 1.65
    if (grooveJp && bones.indexByJp.has(grooveJp)) {
      localTrans.set("センター", [centerShiftX, -(squatTarget * maxSquatDrop), centerShiftZ])
      localTrans.set(grooveJp, [0, elasticY, 0])
    } else {
      localTrans.set("センター", [centerShiftX, -(squatTarget * maxSquatDrop) + elasticY, centerShiftZ])
    }

    // Subtle contrapposto hip roll when weight shifts to one foot
    const pelvisRollDeg = -weightLag * 4.5
    const pelvisPitchDeg = squatTarget * 14
    const qWaist = qMul(
      qFromAxisAngle([0, 1, 0], hipYawTarget),
      qMul(qFromAxisAngle([0, 0, 1], pelvisRollDeg), qFromAxisAngle([1, 0, 0], pelvisPitchDeg)),
    )
    if (bones.indexByJp.has("腰")) localRots.set("腰", qWaist)

    // ---- Layer 2: Spine Spline Synergy + Counter-balance ----
    // Counter-lean upper body slightly against weight shift for authentic contrapposto balance
    const totalCurlDeg = curlDyn * 38 + squatTarget * 16 + breath * 1.1
    const totalTwistDeg = twistDyn * 36
    const totalLeanDeg = leanDyn * 24 - weightLag * 6.5

    for (const link of profile.spineChain) {
      if (link.boneJp === "腰") continue // waist already carries pelvis orientation
      const baseQ = localRots.get(link.boneJp) ?? IDENTITY
      const qPitch = qFromAxisAngle([1, 0, 0], totalCurlDeg * link.curlWeight)
      const qYaw = qFromAxisAngle([0, 1, 0], totalTwistDeg * link.twistWeight)
      const qRoll = qFromAxisAngle([0, 0, 1], totalLeanDeg * link.leanWeight)
      localRots.set(link.boneJp, qMul(baseQ, qMul(qYaw, qMul(qPitch, qRoll))))
    }

    // Snapshot FK for legs & torso
    let fk = solveFkSnapshot(bones, restWorld, localRots, localTrans)

    // Solve both legs with analytical 2-bone IK so feet stay glued to rest floor contact
    for (const side of ["l", "r"] as const) {
      const leg = profile.legs[side]
      const hipIdx = bones.indexByJp.get(leg.hipJp)
      const kneeIdx = bones.indexByJp.get(leg.kneeJp)
      const ankleIdx = bones.indexByJp.get(leg.ankleJp)
      if (hipIdx == null || kneeIdx == null || ankleIdx == null) continue

      const hipPos = fk.pos.get(hipIdx)!
      const hipParentIdx = bones.bones[hipIdx].parent
      const hipParentRot = hipParentIdx >= 0 ? (fk.rot.get(hipParentIdx) ?? IDENTITY) : IDENTITY

      const soleBiasY = Math.abs(leg.restFootMinY) <= 0.25 ? -leg.restFootMinY : 0
      const walkAmp = walkAmpByFrame[frame] ?? 0
      const walkSin = Math.sin(walkPhaseByFrame[frame] ?? 0)
      const stepLiftY = walkAmp > 0.02
        ? Math.max(0, (side === "l" ? 1 : -1) * walkSin) * walkAmp * 0.52
        : 0
      const baseAnkle: V3 = [leg.restAnklePos[0], leg.restAnklePos[1] + soleBiasY + stepLiftY, leg.restAnklePos[2]]
      const targetAnkle: V3 = rootDyn
        ? vAdd(qRotate(qRootDyn, baseAnkle), rootDyn.pos)
        : baseAnkle
      const basePole: V3 = [side === "l" ? 0.12 : -0.12, 0, -1]
      const kneePole: V3 = rootDyn ? qRotate(qRootDyn, basePole) : basePole
      const { K, endPos } = solveTwoBoneMid(hipPos, targetAnkle, leg.thighLen, leg.shinLen, kneePole)

      const restHip = restWorld.get(hipIdx)!
      const restKnee = restWorld.get(kneeIdx)!
      const restAnkle = restWorld.get(ankleIdx)!
      const restThighDir = vNorm(vSub(restKnee, restHip))
      const restShinDir = vNorm(vSub(restAnkle, restKnee))

      const curThighDir = vNorm(vSub(K, hipPos))
      const curShinDir = vNorm(vSub(endPos, K))

      const restThighAfterRoot = rootDyn ? qRotate(qRootDyn, restThighDir) : restThighDir
      const qThighWorld = rootDyn
        ? qMul(qFromTwoVectors(restThighAfterRoot, curThighDir), qRootDyn)
        : qFromTwoVectors(restThighDir, curThighDir)
      const qHipLocal = qMul(qConj(hipParentRot), qThighWorld)
      localRots.set(leg.hipJp, qHipLocal)

      const shinRestAfterHip = qRotate(qThighWorld, restShinDir)
      const qKneeDelta = qFromTwoVectors(shinRestAfterHip, curShinDir)
      // Convert world delta to knee local space (child of thigh)
      const qKneeLocal = qMul(qConj(qThighWorld), qMul(qKneeDelta, qThighWorld))
      localRots.set(leg.kneeJp, qKneeLocal)

      // Keep ankle flat in world space (exact sole grounding, aligned to rootDyn!)
      const qShinWorld = qMul(qThighWorld, qKneeLocal)
      localRots.set(leg.ankleJp, rootDyn ? qMul(qConj(qShinWorld), qRootDyn) : qConj(qShinWorld))
    }

    // ---- Layer 3: Gaze (Head + Eyes) — leads torso (Upgrade C) and runs BEFORE Hands so face anchors stay exact! ----
    if (bones.indexByJp.has("頭")) {
      const gazeYawOf = (gt: string | undefined) => {
        if (gt === "left") return 22
        if (gt === "right") return -22
        if (gt === "camera" || !gt) return -totalTwistDeg * 0.55
        return 0
      }
      const gazePitchBiasOf = (gt: string | undefined) => {
        if (gt === "up") return -14
        if (gt === "down") return 16
        return 0
      }
      let headYawTarget = gazeYawOf(sHead.a.gaze?.target) + (gazeYawOf(sHead.b.gaze?.target) - gazeYawOf(sHead.a.gaze?.target)) * sHead.t
      let headPitchBias = gazePitchBiasOf(sHead.a.gaze?.target) + (gazePitchBiasOf(sHead.b.gaze?.target) - gazePitchBiasOf(sHead.a.gaze?.target)) * sHead.t
      if (options?.overrideGaze) {
        const headIdx = bones.indexByJp.get("頭")
        const headLocalPos = headIdx != null ? (fk.pos.get(headIdx) ?? [0, 16, 0] as V3) : ([0, 16, 0] as V3)
        const ov = options.overrideGaze(frame, headLocalPos, timeSec)
        if (ov) {
          if (ov.headYawDeg != null) headYawTarget = Math.max(-65, Math.min(65, ov.headYawDeg))
          if (ov.headPitchDeg != null) headPitchBias = Math.max(-35, Math.min(35, ov.headPitchDeg))
        }
      }
      const headYawDyn = sprHeadYaw.step(dt, headYawTarget, sp.f * 0.9, sp.z * 0.9, sp.r)

      const qHead = qMul(
        qFromAxisAngle([0, 1, 0], headYawDyn),
        qMul(qFromAxisAngle([1, 0, 0], headPitchDyn + headPitchBias), qFromAxisAngle([0, 0, 1], headTiltDyn)),
      )
      localRots.set("頭", qHead)

      // Eyes lead head by +0.12s (sEye) so character looks BEFORE turning!
      if (bones.indexByJp.has("両目")) {
        const eyeYaw = gazeYawOf(sEye.a.gaze?.target) + (gazeYawOf(sEye.b.gaze?.target) - gazeYawOf(sEye.a.gaze?.target)) * sEye.t
        const eyePitch = gazePitchBiasOf(sEye.a.gaze?.target) + (gazePitchBiasOf(sEye.b.gaze?.target) - gazePitchBiasOf(sEye.a.gaze?.target)) * sEye.t
        localRots.set("両目", qMul(qFromAxisAngle([0, 1, 0], eyeYaw * 0.35), qFromAxisAngle([1, 0, 0], eyePitch * 0.25)))
      }
    }

    // Re-snapshot FK with solved torso + legs + head so anchors & tapered capsules are exact in world space
    fk = solveFkSnapshot(bones, restWorld, localRots, localTrans)

    // Transform multi-slice elliptical body hulls into current world space
    const worldHulls: WorldHull[] = profile.capsules.map((cap) => {
      const idx = bones.indexByJp.get(cap.boneJp)
      if (idx == null) return null
      const bp = fk.pos.get(idx)!
      const br = fk.rot.get(idx)!
      return {
        id: cap.id,
        bonePos: bp,
        boneRot: br,
        a: vAdd(bp, qRotate(br, cap.localA)),
        b: vAdd(bp, qRotate(br, cap.localB)),
        radiusA: cap.radiusA ?? cap.radius,
        radiusB: cap.radiusB ?? cap.radius,
        slices: cap.slices,
      }
    }).filter((c): c is NonNullable<typeof c> => c !== null)
    const extHulls = options?.externalWorldHulls?.(frame, timeSec) ?? []
    for (const eh of extHulls) worldHulls.push(eh)
    if (intent.obstacles && intent.obstacles.length > 0) {
      for (let oi = 0; oi < intent.obstacles.length; oi++) {
        const ob = intent.obstacles[oi]
        worldHulls.push({
          id: ob.id ? `obstacle_${ob.id}` : `obstacle_${oi}`,
          bonePos: ob.a,
          boneRot: IDENTITY,
          a: ob.a,
          b: ob.b,
          radiusA: ob.radius,
          radiusB: ob.radius,
        })
      }
    }

    const FACE_ANCHORS = new Set(["cheek_l", "cheek_r", "mouth", "chin", "forehead"])
    const WAIST_ANCHORS = new Set(["waist_side_l", "waist_side_r", "hip_side_l", "hip_side_r"])

    // Helper: compute desired palm normal & finger direction for a surface/air contact
    const computeHandFrameHint = (palmMode: string, anchorNormal: V3, targetName: string, sSign: number): { palmN: V3; fingerDir: V3 } => {
      let palmN: V3 = [0, -1, 0]
      let hint: V3 = [0, 1, 0]
      if (palmMode === "surface") {
        palmN = vScale(anchorNormal, -1)
        if (FACE_ANCHORS.has(targetName)) hint = [-sSign * 0.18, 0.97, 0.10]
        else if (WAIST_ANCHORS.has(targetName)) hint = [-sSign * 0.25, -0.50, -0.82]
        else hint = [-sSign * 0.85, 0.45, 0.05]
      } else if (palmMode === "camera") {
        palmN = rootDyn ? qRotate(qRootDyn, [0, 0, -1]) : [0, 0, -1]
        hint = [0, 1, 0]
      } else if (palmMode === "inward") {
        palmN = rootDyn ? qRotate(qRootDyn, [-sSign, 0, 0]) : [-sSign, 0, 0]
        hint = [0, 1, 0]
      } else if (palmMode === "down") {
        palmN = [0, -1, 0]
        hint = rootDyn ? qRotate(qRootDyn, [0, 0, -1]) : [0, 0, -1]
      } else if (rootDyn) {
        palmN = qRotate(qRootDyn, palmN)
      }
      if (palmMode === "surface" && rootDyn) {
        hint = qRotate(qRootDyn, hint)
      }
      const d = vDot(hint, palmN)
      const f = vSub(hint, vScale(palmN, d))
      return { palmN, fingerDir: vLen(f) > 1e-3 ? vNorm(f) : [0, 1, 0] }
    }

    // Helper: resolve semantic anchor to exact wrist-target world position via Exact End-Effector Inverse
    const resolveHandTarget = (intentHand: HandIntent | undefined, side: "l" | "r", beatAtSec?: number): {
      active: boolean
      pos: V3
      surfacePos: V3
      normal: V3
      arc: string
      targetName: string
      palmMode: string
    } => {
      const arm = profile.arms[side]
      const palmLen = arm.palmLen ?? 0.85
      const sSign = side === "l" ? 1 : -1

      const dynOv = options?.overrideHandTarget?.(frame, side, timeSec, beatAtSec)
      if (dynOv) {
        const worldNormal: V3 = dynOv.localNormal ? vNorm(dynOv.localNormal) : [0, 0, -1]
        const palmMode = dynOv.palmMode ?? intentHand?.palm ?? "surface"
        const eff = dynOv.endEffector ?? intentHand?.endEffector ?? "palm"
        let basePos = dynOv.localTarget
        const surfacePos = dynOv.localTarget
        if (eff !== "wrist") {
          const { fingerDir } = computeHandFrameHint(palmMode, worldNormal, "partner", sSign)
          const lEff = eff === "fingertip" ? palmLen * 0.92 : palmLen * 0.50
          const dPalm = 0.14
          basePos = vSub(vAdd(surfacePos, vScale(worldNormal, dPalm)), vScale(fingerDir, lEff))
        }
        return {
          active: true,
          pos: basePos,
          surfacePos,
          normal: worldNormal,
          arc: intentHand?.arc ?? "natural",
          targetName: "partner",
          palmMode,
        }
      }

      if (!intentHand || intentHand.mode === "rest" || !intentHand.target) {
        const wIdx = bones.indexByJp.get(side === "l" ? "左手首" : "右手首")
        const wp = wIdx != null ? fk.pos.get(wIdx)! : [0, 12, 0] as V3
        return { active: false, pos: wp, surfacePos: wp, normal: [sSign, 0, 0], arc: "natural", targetName: "", palmMode: "natural" }
      }
      let basePos: V3
      let surfacePos: V3
      let worldNormal: V3 = [0, 0, -1]
      let targetName = ""
      let palmMode = intentHand.palm ?? "natural"
      if (Array.isArray(intentHand.target)) {
        const tgt = rootDyn ? vAdd(qRotate(qRootDyn, intentHand.target), rootDyn.pos) : intentHand.target
        basePos = tgt
        surfacePos = tgt
      } else {
        targetName = intentHand.target
        const anc = profile.anchors[intentHand.target]
        if (!anc) {
          const wIdx = bones.indexByJp.get(side === "l" ? "左手首" : "右手首")
          const wp = wIdx != null ? fk.pos.get(wIdx)! : [0, 12, 0] as V3
          return { active: false, pos: wp, surfacePos: wp, normal: [sSign, 0, 0], arc: "natural", targetName: "", palmMode: "natural" }
        }
        const bIdx = bones.indexByJp.get(anc.boneJp)
        const bp = bIdx != null ? fk.pos.get(bIdx)! : [0, 15, 0] as V3
        const br = bIdx != null ? fk.rot.get(bIdx)! : IDENTITY
        surfacePos = vAdd(bp, qRotate(br, anc.localPos))
        basePos = surfacePos
        worldNormal = vNorm(qRotate(br, anc.localNormal))

        const defaultPalm = (FACE_ANCHORS.has(targetName) || WAIST_ANCHORS.has(targetName) || targetName.startsWith("chest") || targetName === "heart")
          ? "surface"
          : targetName.startsWith("wave_") ? "camera" : "natural"
        palmMode = intentHand.palm ?? defaultPalm

        // Exact End-Effector Inverse: P_wrist = P_anchor + n * d_palm - f_target * L_eff
        const eff = intentHand.endEffector ?? (FACE_ANCHORS.has(targetName) ? "fingertip" : WAIST_ANCHORS.has(targetName) ? "palm" : "wrist")
        if (eff !== "wrist") {
          const { fingerDir } = computeHandFrameHint(palmMode, worldNormal, targetName, sSign)
          const lEff = eff === "fingertip" ? palmLen * 0.92 : palmLen * 0.50
          const dPalm = FACE_ANCHORS.has(targetName) ? 0.10 : 0.16 // ~0.8-1.3cm palm half-thickness
          basePos = vSub(vAdd(surfacePos, vScale(worldNormal, dPalm)), vScale(fingerDir, lEff))
        }
      }
      if (intentHand.offsetCm) {
        const off: V3 = [intentHand.offsetCm[0] / 8, intentHand.offsetCm[1] / 8, intentHand.offsetCm[2] / 8]
        basePos = vAdd(basePos, off)
        surfacePos = vAdd(surfacePos, off)
      }
      return {
        active: true,
        pos: basePos,
        surfacePos,
        normal: worldNormal,
        arc: intentHand.arc ?? (WAIST_ANCHORS.has(targetName) ? "akimbo" : "natural"),
        targetName,
        palmMode,
      }
    }

    // ---- Layer 4: Zero-Pop Continuous Arm IK + Spherical Arcs + 6-DOF Palm + Inertial Drag ----
    const rom = profile.jointRom ?? { forearmTwistMaxDeg: 85, wristSwingMaxDeg: 58, shoulderLiftMaxDeg: 20, kneeFlexMaxDeg: 142 }
    const solvedArmObstacles: WorldHull[] = [] // enables Arm-L <-> Arm-R mutual collision!

    const computePoleFor = (res: ReturnType<typeof resolveHandTarget>, armPosRef: V3, sSign: number): V3 => {
      let basePole: V3
      if (!res.active) basePole = vNorm([sSign * 0.32, -1.0, 0.25])
      else if (res.arc === "akimbo") basePole = vNorm([sSign * 1.15, -0.15, 0.38])
      else {
        const highReach = res.pos[1] > armPosRef[1] + 0.3
        const poleX = res.arc === "outward" ? sSign * (highReach ? 0.42 : 0.78) : res.arc === "inward" ? sSign * 0.15 : sSign * 0.42
        const poleY = highReach ? -1.65 : -0.95
        basePole = vNorm([poleX, poleY, highReach ? 0.18 : 0.38])
      }
      return rootDyn ? vNorm(qRotate(qRootDyn, basePole)) : basePole
    }

    for (const side of ["l", "r"] as const) {
      const arm = profile.arms[side]
      const pickHand = (bt: MotionBeat) => (side === "l" ? bt.hand_l : bt.hand_r)
      const hPrev = pickHand(sArm.prev)
      const hA = pickHand(sArm.a)
      const hB = pickHand(sArm.b)
      const hNext = pickHand(sArm.next)

      const resPrev = resolveHandTarget(hPrev, side, sArm.prev.at)
      const resA = resolveHandTarget(hA, side, sArm.a.at)
      const resB = resolveHandTarget(hB, side, sArm.b.at)
      const resNext = resolveHandTarget(hNext, side, sArm.next.at)

      const tArm = sArm.t
      const tHand = sHand.t
      const sSign = side === "l" ? 1 : -1
      const pPrefix = side === "l" ? "左" : "右"
      const breathShoulder = qFromAxisAngle([0, 0, 1], sSign * breath * 0.9)
      localRots.set(arm.shoulderJp, breathShoulder)

      // Continuous scalar weights (ZERO hard boolean flips at beat boundaries!)
      const activeW = (resA.active ? 1 : 0) + ((resB.active ? 1 : 0) - (resA.active ? 1 : 0)) * tArm
      const isFaceA = resA.active && FACE_ANCHORS.has(resA.targetName) ? 1 : 0
      const isFaceB = resB.active && FACE_ANCHORS.has(resB.targetName) ? 1 : 0
      const isWaistA = resA.active && WAIST_ANCHORS.has(resA.targetName) ? 1 : 0
      const isWaistB = resB.active && WAIST_ANCHORS.has(resB.targetName) ? 1 : 0
      const faceContactW = isFaceA + (isFaceB - isFaceA) * tArm
      const waistContactW = isWaistA + (isWaistB - isWaistA) * tArm
      const contactW = Math.max(faceContactW, waistContactW)

      // Hand grip sampled at lagging hand phase (Upgrade C: wrist/fingers settle after arm!)
      const hGripA = pickHand(sHand.a)
      const hGripB = pickHand(sHand.b)
      const gA0 = parseGripSpec(hGripA?.grip, profile)
      const gB0 = parseGripSpec(hGripB?.grip, profile)
      let gCur: HandGripSpec = {
        thumbCurl: gA0.thumbCurl + (gB0.thumbCurl - gA0.thumbCurl) * tHand,
        indexCurl: gA0.indexCurl + (gB0.indexCurl - gA0.indexCurl) * tHand,
        middleCurl: gA0.middleCurl + (gB0.middleCurl - gA0.middleCurl) * tHand,
        ringCurl: gA0.ringCurl + (gB0.ringCurl - gA0.ringCurl) * tHand,
        pinkyCurl: gA0.pinkyCurl + (gB0.pinkyCurl - gA0.pinkyCurl) * tHand,
        spread: gA0.spread + (gB0.spread - gA0.spread) * tHand,
      }

      const armIdx = bones.indexByJp.get(arm.armJp)!
      const shoulderWorld = fk.pos.get(armIdx)!

      if (activeW > 1e-4) {
        // Upgrade B: Continuous Catmull-Rom pass-through for rhythmic waves, or Shoulder-Centered Spherical Arcs!
        let targetPos: V3
        if (sArm.passThrough && resA.active && resB.active) {
          targetPos = catmullRomV3(resPrev.pos, resA.pos, resB.pos, resNext.pos, sArm.rawT)
        } else {
          // Outward-forward arc bulge keeps sweeping arms curving gracefully around self & partner
          const nearPartner = extHulls.length > 0 && (resA.targetName === "partner" || resB.targetName === "partner")
          const rawArcDir: V3 = nearPartner
            ? vNorm([sSign * 0.65, 0.72, -0.25])
            : vNorm([sSign * 0.72, 0.12, -0.68])
          const outwardArcDir = rootDyn ? qRotate(qRootDyn, rawArcDir) : rawArcDir
          const bulge = nearPartner ? 0.38 : (isFaceA || isFaceB || isWaistA || isWaistB) ? 0.14 : 0.16
          targetPos = slerpAroundPivot(shoulderWorld, resA.pos, resB.pos, tArm, outwardArcDir, bulge)
        }

        // Moving Hold subtle float when hand is free in air (fades smoothly to 0 during face/waist contact!)
        if (intent.breathing !== false) {
          const floatW = (1 - smoothstep01(contactW)) * smoothstep01(activeW) * lifeEdge
          targetPos = vAdd(targetPos, [
            Math.cos(timeSec * 1.4 + sSign) * 0.05 * floatW,
            Math.sin(timeSec * 1.85 + sSign * 1.2) * 0.08 * floatW,
            0,
          ])
        }

        // Continuous Pre-IK elliptical hull push-out (NO hard skip cliffs!)
        const allHulls = [...worldHulls, ...solvedArmObstacles]
        for (const hull of allHulls) {
          let wPush = 1.0
          let margin = hull.id === "chest" ? 0.36 : hull.id.startsWith("arm_") ? 0.25 : 0.20
          if (hull.id === "pelvis" || hull.id === "abdomen") {
            wPush = 1 - smoothstep01(waistContactW)
          } else if (hull.id === "head") {
            margin = 0.20 * (1 - faceContactW) + 0.04 * faceContactW
          }
          if (wPush > 1e-3) {
            const pushed = pushOutOfHull(targetPos, hull, margin)
            targetPos = vLerp(targetPos, pushed, wPush)
          }
        }

        // Shoulder-arm coupling (Scapulohumeral Rhythm) scaled smoothly by activeW
        const elevY = targetPos[1] - shoulderWorld[1]
        const fwdZ = -(targetPos[2] - shoulderWorld[2])
        const liftDeg = Math.max(-6, Math.min(rom.shoulderLiftMaxDeg, (elevY + 1.5) * 3.8 * arm.shoulderCoupling * 2.5)) * smoothstep01(activeW)
        const protractDeg = Math.max(-8, Math.min(14, fwdZ * 1.6 * arm.shoulderCoupling * 2.0)) * smoothstep01(activeW)
        const qShoulder = qMul(
          breathShoulder,
          qMul(qFromAxisAngle([0, 0, 1], sSign * liftDeg), qFromAxisAngle([0, 1, 0], sSign * protractDeg)),
        )
        localRots.set(arm.shoulderJp, qShoulder)

        // Update FK for accurate post-clavicle shoulder position
        fk = solveFkSnapshot(bones, restWorld, localRots, localTrans)
        const armPos = fk.pos.get(armIdx)!
        const armParentIdx = bones.bones[armIdx].parent
        const armParentRot = armParentIdx >= 0 ? (fk.rot.get(armParentIdx) ?? IDENTITY) : IDENTITY

        // Continuous Elbow Pole Vector (smoothly blends A -> B, ZERO 90° boundary flips!)
        const poleA = computePoleFor(resA, armPos, sSign)
        const poleB = computePoleFor(resB, armPos, sSign)
        const poleDir = vNorm(vLerp(poleA, poleB, smoothstep01(tArm)))

        // Helper to solve 2-bone arm IK + Continuous 6-DOF Palm Alignment (blends qHandA -> qHandB cleanly!)
        const solveArmAndPalm = (wristGoal: V3) => {
          const { K, endPos } = solveTwoBoneMid(armPos, wristGoal, arm.upperLen, arm.foreLen, poleDir)
          const curUpperDir = vNorm(vSub(K, armPos))
          const curForeDir = vNorm(vSub(endPos, K))

          const qUpperWorld = qFromTwoVectors(arm.restUpperDir, curUpperDir)
          const qArmLocal = qMul(qConj(armParentRot), qUpperWorld)

          const foreRestAfterArm = qRotate(qUpperWorld, arm.restForeDir)
          const qElbowDelta = qFromTwoVectors(foreRestAfterArm, curForeDir)
          const qElbowLocal = qMul(qConj(qUpperWorld), qMul(qElbowDelta, qUpperWorld))
          const qForeWorld = qMul(qUpperWorld, qElbowLocal)

          // Continuous 6-DOF hand orientation: solve Beat A & Beat B hand world rotations independently, then SLERP!
          const handGoalOf = (res: ReturnType<typeof resolveHandTarget>): Quat => {
            if (!res.active || res.palmMode === "natural" || !arm.restFingerDir || !arm.restPalmNormal) return qForeWorld
            const { palmN, fingerDir } = computeHandFrameHint(res.palmMode, res.normal, res.targetName, sSign)
            return qBasisToBasis(arm.restFingerDir, arm.restPalmNormal, fingerDir, palmN)
          }

          let qTwistLocal = IDENTITY
          let qWristLocal = qFromAxisAngle([0, 0, 1], sSign * 6)
          let worldFingerDir = qRotate(qForeWorld, arm.restFingerDir ?? arm.restForeDir)
          let worldPalmN = qRotate(qForeWorld, arm.restPalmNormal ?? [0, -1, 0])

          if (arm.restFingerDir && arm.restPalmNormal) {
            const qHandA = handGoalOf(resA)
            const qHandB = handGoalOf(resB)
            const qHandBlended = qSlerp(qHandA, qHandB, smoothstep01(tArm))
            const qRel = qMul(qConj(qForeWorld), qHandBlended)

            const { twist, swing } = decomposeTwistSwing(qRel, arm.wristTwistAxis ?? arm.restForeDir)
            const clampedTwist = qClampDeg(twist, rom.forearmTwistMaxDeg)
            const clampedSwing = qClampDeg(swing, rom.wristSwingMaxDeg)
            if (arm.wristTwistJp && bones.indexByJp.has(arm.wristTwistJp)) {
              qTwistLocal = qSlerp(IDENTITY, clampedTwist, 0.60)
              const qTwistRem = qSlerp(IDENTITY, clampedTwist, 0.40)
              qWristLocal = qMul(qTwistRem, clampedSwing)
            } else {
              qWristLocal = qMul(clampedTwist, clampedSwing)
            }
            const qFinalHandWorld = qMul(qForeWorld, qMul(qTwistLocal, qWristLocal))
            worldFingerDir = vNorm(qRotate(qFinalHandWorld, arm.restFingerDir))
            worldPalmN = vNorm(qRotate(qFinalHandWorld, arm.restPalmNormal))
          }

          return { elbowPos: K, endPos, qArmLocal, qElbowLocal, qTwistLocal, qWristLocal, qForeWorld, worldFingerDir, worldPalmN }
        }

        const commitArm = (curSol: ReturnType<typeof solveArmAndPalm>, blendToNeutral = false) => {
          const wAct = blendToNeutral ? smoothstep01(Math.min(1, activeW / 0.25)) : 1.0
          const qNeutralArm = profile.neutralPose[arm.armJp] ?? IDENTITY
          const qNeutralElb = profile.neutralPose[arm.elbowJp] ?? IDENTITY
          const qArmFull = wAct < 1 ? qSlerp(qNeutralArm, curSol.qArmLocal, wAct) : curSol.qArmLocal

          // Phase 1 Upper-Arm Muscle Twist Split (左腕捩 / 右腕捩 -> auto-drives 腕捩1/2/3 grant chain!):
          // Decompose qArmFull = qSwing * qTwist around restUpperDir; child armTwist gets 45% of axial twist
          // while parent arm keeps qSwing * qTwist55 -> preserves exact elbow/wrist world positions to 0.000mm!
          if (arm.armTwistJp && bones.indexByJp.has(arm.armTwistJp)) {
            const nq = qArmFull.w < 0 ? { x: -qArmFull.x, y: -qArmFull.y, z: -qArmFull.z, w: -qArmFull.w } : qNorm(qArmFull)
            const ax = vNorm(arm.armTwistAxis ?? arm.restUpperDir)
            const proj = vDot([nq.x, nq.y, nq.z], ax)
            const qTwistAll = qNorm({ x: ax[0] * proj, y: ax[1] * proj, z: ax[2] * proj, w: nq.w })
            const qTwistChild = qClampDeg(qSlerp(IDENTITY, qTwistAll, 0.45), 55)
            const qArmParent = qNorm(qMul(qArmFull, qConj(qTwistChild)))
            localRots.set(arm.armJp, qArmParent)
            localRots.set(arm.armTwistJp, qTwistChild)
          } else {
            localRots.set(arm.armJp, qArmFull)
          }

          localRots.set(arm.elbowJp, wAct < 1 ? qSlerp(qNeutralElb, curSol.qElbowLocal, wAct) : curSol.qElbowLocal)
          if (arm.wristTwistJp && bones.indexByJp.has(arm.wristTwistJp)) {
            localRots.set(arm.wristTwistJp, wAct < 1 ? qSlerp(IDENTITY, curSol.qTwistLocal, wAct) : curSol.qTwistLocal)
          }
          localRots.set(arm.wristJp, wAct < 1 ? qSlerp(IDENTITY, curSol.qWristLocal, wAct) : curSol.qWristLocal)
        }

        // Helper: REAL FK 5-fingertip + forearm midpoint + wrist elliptical collision check (with continuous margins!)
        const tipBoneJps = [`${pPrefix}親指２`, `${pPrefix}人指３`, `${pPrefix}中指３`, `${pPrefix}薬指３`, `${pPrefix}小指３`]
        const measureRealHandPenetration = (curSol: ReturnType<typeof solveArmAndPalm>) => {
          commitArm(curSol, false)
          const fkNow = solveFkSnapshot(bones, restWorld, localRots, localTrans)
          const pts: Array<{ pt: V3; isTip: boolean }> = [
            { pt: curSol.endPos, isTip: false },
            { pt: vLerp(curSol.elbowPos, curSol.endPos, 0.5), isTip: false },
          ]
          for (const tipJp of tipBoneJps) {
            const idx = bones.indexByJp.get(tipJp)
            if (idx != null) pts.push({ pt: fkNow.pos.get(idx)!, isTip: true })
          }
          let maxPush: V3 = [0, 0, 0]
          let maxPushLen = 0
          let tipPenLen = 0
          for (const hull of allHulls) {
            let margin = hull.id === "chest" ? 0.42 : 0.18
            if (hull.id === "head") margin = 0.18 * (1 - faceContactW) + 0.03 * faceContactW
            else if (hull.id === "pelvis" || hull.id === "abdomen") margin = 0.18 * (1 - waistContactW) + 0.08 * waistContactW
            for (const { pt, isTip } of pts) {
              const pushed = pushOutOfHull(pt, hull, margin)
              const delta = vSub(pushed, pt)
              const dl = vLen(delta)
              if (dl > maxPushLen) {
                maxPushLen = dl
                maxPush = delta
              }
              if (isTip && dl > tipPenLen) tipPenLen = dl
            }
          }
          return { maxPush, maxPushLen, tipPenLen }
        }

        applyHandGripToFrame(side, gCur, bones, localRots, arm)

        // First pass solve
        let sol = solveArmAndPalm(targetPos)

        // Continuous Closed-Loop Surface Contact Feedback (ramps smoothly 0 -> 1, ZERO threshold cliff!)
        const smoothFaceW = smoothstep01(faceContactW)
        const smoothWaistW = smoothstep01(waistContactW)
        const bestContactW = Math.max(smoothFaceW, smoothWaistW)
        if (bestContactW > 0.01) {
          commitArm(sol, false)
          const useFace = smoothFaceW >= smoothWaistW
          const padBoneJp = `${pPrefix}${useFace ? "中指２" : "人指１"}`
          const padIdx = bones.indexByJp.get(padBoneJp)
          if (padIdx != null) {
            const fkCheck = solveFkSnapshot(bones, restWorld, localRots, localTrans)
            const actualPad = fkCheck.pos.get(padIdx)!
            // Blend surface anchor smoothly between A and B when both are contacting, else pick the contacting beat
            const pickSurf = (isFaceB || isWaistB) && !(isFaceA || isWaistA)
              ? resB
              : (isFaceA || isWaistA) && !(isFaceB || isWaistB)
                ? resA
                : null
            const surfTarget = pickSurf ? pickSurf.surfacePos : vLerp(resA.surfacePos, resB.surfacePos, tArm)
            const surfNormal = pickSurf ? pickSurf.normal : vNorm(vLerp(resA.normal, resB.normal, tArm))
            const standOff = useFace ? 0.08 : 0.22
            const contactGoal = vAdd(surfTarget, vScale(surfNormal, standOff))
            const err = vSub(contactGoal, actualPad)
            if (vLen(err) > 0.015) {
              targetPos = vAdd(targetPos, vScale(err, bestContactW))
              sol = solveArmAndPalm(targetPos)
            }
          }
        }

        // Smooth Contact Adaptation: gradually relax finger curl proportional to fingertip penetration (ZERO sudden snap!)
        let pen = measureRealHandPenetration(sol)
        if (faceContactW < 0.5 && pen.tipPenLen > 0.02) {
          const relaxRatio = Math.max(0.28, 1 - Math.min(0.72, pen.tipPenLen * 2.5))
          gCur = {
            thumbCurl: gCur.thumbCurl * relaxRatio,
            indexCurl: gCur.indexCurl * relaxRatio,
            middleCurl: gCur.middleCurl * relaxRatio,
            ringCurl: gCur.ringCurl * relaxRatio,
            pinkyCurl: gCur.pinkyCurl * relaxRatio,
            spread: Math.min(0.15, gCur.spread),
          }
          applyHandGripToFrame(side, gCur, bones, localRots, arm)
          pen = measureRealHandPenetration(sol)
        }

        // CRITICAL FINAL INVARIANT: Elliptical hard-core collision push-out ALWAYS runs LAST!
        for (let pass = 0; pass < 2 && pen.maxPushLen > 0.015; pass++) {
          targetPos = vAdd(targetPos, pen.maxPush)
          sol = solveArmAndPalm(targetPos)
          pen = measureRealHandPenetration(sol)
        }

        // Upgrade D: Inertial Wrist & Finger Drag / Follow-Through (authentic whip on waves & raises, masked to 0 during surface contact!)
        const prevW = prevWristWorld[side] ?? sol.endPos
        const rawVel = vScale(vSub(sol.endPos, prevW), 1 / dt)
        const rawSpeed = vLen(rawVel)
        const clampedVel = rawSpeed > 16 ? vScale(rawVel, 16 / rawSpeed) : rawVel
        prevWristWorld[side] = sol.endPos

        const vs = wristVelSprings[side]
        const vSmooth: V3 = [
          vs.x.step(dt, clampedVel[0], 4.2, 0.62, 0.25),
          vs.y.step(dt, clampedVel[1], 4.2, 0.62, 0.25),
          vs.z.step(dt, clampedVel[2], 4.2, 0.62, 0.25),
        ]
        const dragMask = (1 - smoothstep01(Math.min(1, contactW * 1.5))) * smoothstep01(activeW)
        if (dragMask > 0.02) {
          const worldSideAxis = vNorm(vCross(sol.worldFingerDir, sol.worldPalmN))
          const vPalm = vDot(vSmooth, sol.worldPalmN)
          const vSide = vDot(vSmooth, worldSideAxis)
          const dragFlexDeg = Math.max(-16, Math.min(16, -vPalm * 1.65)) * dragMask
          const dragWaveDeg = Math.max(-20, Math.min(20, -vSide * 2.05)) * dragMask
          // Convert world drag axes into wrist-local space and post-multiply cleanly
          const qDragWorld = qMul(
            qFromAxisAngle(worldSideAxis, dragFlexDeg),
            qFromAxisAngle(sol.worldPalmN, dragWaveDeg),
          )
          const qHandBeforeDrag = qMul(sol.qForeWorld, qMul(sol.qTwistLocal, sol.qWristLocal))
          const qHandAfterDrag = qMul(qDragWorld, qHandBeforeDrag)
          const qWristWithDrag = qMul(qConj(qMul(sol.qForeWorld, sol.qTwistLocal)), qHandAfterDrag)
          sol = { ...sol, qWristLocal: qWristWithDrag }

          // Subtle trailing finger flutter coupled to palm-normal velocity
          const fingerDrag = Math.max(-0.16, Math.min(0.20, -vPalm * 0.022)) * dragMask
          if (Math.abs(fingerDrag) > 0.01) {
            const c01 = (v: number) => Math.max(0.02, Math.min(0.95, v))
            applyHandGripToFrame(side, {
              thumbCurl: c01(gCur.thumbCurl + fingerDrag * 0.5),
              indexCurl: c01(gCur.indexCurl + fingerDrag * 0.8),
              middleCurl: c01(gCur.middleCurl + fingerDrag),
              ringCurl: c01(gCur.ringCurl + fingerDrag * 1.1),
              pinkyCurl: c01(gCur.pinkyCurl + fingerDrag * 1.2),
              spread: gCur.spread,
            }, bones, localRots, arm)
          }
        }

        commitArm(sol, true)

        // Register solved forearm as mutual collision obstacle for the opposite arm
        solvedArmObstacles.push({
          id: `arm_${side}`,
          bonePos: sol.elbowPos,
          boneRot: IDENTITY,
          a: sol.elbowPos,
          b: sol.endPos,
          radiusA: 0.42,
          radiusB: 0.36,
        })
      } else {
        // Track resting wrist position so velocity spring stays warm & continuous when arm lifts!
        const wIdx = bones.indexByJp.get(`${pPrefix}手首`)
        const restW = wIdx != null ? fk.pos.get(wIdx)! : shoulderWorld
        prevWristWorld[side] = restW
        wristVelSprings[side].x.step(dt, 0, 4.2, 0.62, 0.25)
        wristVelSprings[side].y.step(dt, 0, 4.2, 0.62, 0.25)
        wristVelSprings[side].z.step(dt, 0, 4.2, 0.62, 0.25)
        applyHandGripToFrame(side, gCur, bones, localRots, arm)
      }
    }

    // ---- Layer 5: Dynamic Pose + Inertia Driven Soft-Tissue Coupling (Chest L/R) ----
    const st = profile.softTissue
    if (st && (st.chestL || st.chestR)) {
      const chestParentJp = bones.indexByJp.has("上半身2") ? "上半身2" : "上半身"
      const chestIdx = bones.indexByJp.get(chestParentJp)
      if (chestIdx != null) {
        const fkSoft = solveFkSnapshot(bones, restWorld, localRots, localTrans)
        const curChestPos = fkSoft.pos.get(chestIdx)!
        const prevCP = prevChestWorld ?? curChestPos
        const curVel = vScale(vSub(curChestPos, prevCP), 1 / dt)
        const rawAcc = vScale(vSub(curVel, prevChestVel), 1 / dt)
        prevChestWorld = curChestPos
        prevChestVel = curVel

        // Soft-tissue 2nd-order inertial response to torso vertical/lateral acceleration (subtle & physically damped)
        const accYClamped = Math.max(-25, Math.min(25, rawAcc[1]))
        const accXClamped = Math.max(-20, Math.min(20, rawAcc[0]))
        const inertiaY = sprChestInertiaY.step(dt, -accYClamped * 0.22, 3.1, 0.44, 0.1)
        const inertiaX = sprChestInertiaX.step(dt, -accXClamped * 0.18, 2.9, 0.48, 0.1)

        for (const side of ["l", "r"] as const) {
          const boneJp = side === "l" ? st.chestL : st.chestR
          if (!boneJp || !bones.indexByJp.has(boneJp)) continue
          const sSign = side === "l" ? 1 : -1
          const armIdx = bones.indexByJp.get(profile.arms[side].armJp)
          const elbowIdx = bones.indexByJp.get(profile.arms[side].elbowJp)
          const wristIdx = bones.indexByJp.get(profile.arms[side].wristJp)
          let elevLift = 0
          let inwardCompress = 0
          if (armIdx != null && elbowIdx != null && wristIdx != null) {
            const shP = fkSoft.pos.get(armIdx)!
            const elP = fkSoft.pos.get(elbowIdx)!
            const wrP = fkSoft.pos.get(wristIdx)!
            // Arm elevation above relaxed hang lifts pectoralis/chest gently upward
            elevLift = Math.max(0, Math.min(1.5, (elP[1] - (shP[1] - 2.6)) / 3.0))
            // Arm reaching inward across front of chest compresses lateral chest slightly
            const inwardX = (shP[0] - wrP[0]) * sSign
            const inFront = -(wrP[2] - shP[2])
            if (inwardX > 0.3 && inFront > 0.4) {
              inwardCompress = Math.min(1.0, inwardX / 2.2)
            }
          }
          const pitchDeg = Math.max(-9, Math.min(9, -elevLift * 4.2 + inertiaY * 1.4 - breath * 1.1))
          const yawDeg = Math.max(-5, Math.min(5, sSign * (elevLift * 1.2 - inwardCompress * 3.0) + inertiaX * 1.1))
          const rollDeg = Math.max(-4, Math.min(4, inertiaX * 0.9))
          localRots.set(
            boneJp,
            qMul(qFromAxisAngle([1, 0, 0], pitchDeg), qMul(qFromAxisAngle([0, 1, 0], yawDeg), qFromAxisAngle([0, 0, 1], rollDeg))),
          )
        }
      }
    }

    // ---- Layer 6: Lightweight Acceleration-Driven Secondary Physics Chains (Hair / Ribbons / Skirts) ----
    if (physNodes.length > 0) {
      const fkPhys = solveFkSnapshot(bones, restWorld, localRots, localTrans)
      const solvedPhysPos = new Map<string, V3>()
      const solvedPhysRot = new Map<string, Quat>()
      const anchorRotByNode = new Map<string, Quat>() // rigid skeleton anchor rotation (prevents cumulative scorpion-tail curl!)
      const dt2 = dt * dt

      // Rebuild elliptical hulls in final post-Layer-5 world space for hair/cloth collision
      const physHulls: WorldHull[] = profile.capsules.map((cap) => {
        const idx = bones.indexByJp.get(cap.boneJp)
        if (idx == null) return null
        const bp = fkPhys.pos.get(idx)!
        const br = fkPhys.rot.get(idx)!
        return {
          id: cap.id,
          bonePos: bp,
          boneRot: br,
          a: vAdd(bp, qRotate(br, cap.localA)),
          b: vAdd(bp, qRotate(br, cap.localB)),
          radiusA: cap.radiusA ?? cap.radius,
          radiusB: cap.radiusB ?? cap.radius,
          slices: cap.slices,
        }
      }).filter((c): c is NonNullable<typeof c> => c !== null)
      for (const eh of extHulls) physHulls.push(eh)

      for (let ni = 0; ni < physNodes.length; ni++) {
        const node = physNodes[ni]
        if (!bones.indexByJp.has(node.boneJp)) continue

        let parentPos: V3
        let parentRot: Quat
        let anchorRot: Quat
        if (node.parentIsPhysics && solvedPhysPos.has(node.parentJp)) {
          parentPos = solvedPhysPos.get(node.parentJp)!
          parentRot = solvedPhysRot.get(node.parentJp)!
          anchorRot = anchorRotByNode.get(node.parentJp) ?? parentRot
        } else {
          const pIdx = bones.indexByJp.get(node.parentJp)
          parentPos = pIdx != null ? fkPhys.pos.get(pIdx)! : [0, 15, 0]
          parentRot = pIdx != null ? fkPhys.rot.get(pIdx)! : IDENTITY
          anchorRot = parentRot
        }
        anchorRotByNode.set(node.boneJp, anchorRot)

        const rootPos = vAdd(parentPos, qRotate(parentRot, node.restOffsetFromParent))
        // Parent-frame rest axis (for local quaternion) vs rigid-anchor rest axis (for spring return & anti-curl cone clamp!)
        const restDirParentWorld = vNorm(qRotate(parentRot, node.restDir))
        const restDirAnchorWorld = vNorm(qRotate(anchorRot, node.restDir))
        // Long cloth drapes naturally toward gravity (-Y) blended with rigid-anchor hang
        const isHair = node.kind === "hair"
        const targetDrapeDir = isHair
          ? restDirAnchorWorld
          : vNorm(vLerp(restDirAnchorWorld, [0, -1, 0], Math.min(0.65, 0.25 + node.depth * 0.06)))
        const restTip = vAdd(rootPos, vScale(targetDrapeDir, node.segLen))

        const prevTip = physPrevTipPos.get(node.boneJp)
        const curTip = physTipPos.get(node.boneJp)

        if (!curTip || !prevTip || frame === 0) {
          physTipPos.set(node.boneJp, restTip)
          physPrevTipPos.set(node.boneJp, restTip)
          solvedPhysPos.set(node.boneJp, rootPos)
          solvedPhysRot.set(node.boneJp, parentRot)
          localRots.set(node.boneJp, IDENTITY)
          continue
        }

        const drag = node.damping ?? (isHair ? 0.78 : 0.82)
        const stiffness = node.stiffness ?? (isHair
          ? Math.max(0.18, 0.36 - node.depth * 0.04)
          : Math.max(0.14, 0.30 - node.depth * 0.018))
        const gravity = isHair ? 14.0 : 28.0
        // Cone clamp measured against targetDrapeDir (anchored to rigid skeleton + gravity, NEVER compounds per-link curl!)
        const maxConeDeg = node.maxConeDeg ?? (isHair
          ? Math.min(22, 10 + node.depth * 3.0)
          : Math.min(28, 12 + node.depth * 2.2))

        const vel = vScale(vSub(curTip, prevTip), drag)
        const springPull = vScale(vSub(restTip, curTip), stiffness)
        const breezeScale = Math.min(1, node.depth * 0.20) * (isHair ? 0.10 : 0.22)
        const phase = ni * 0.73
        const breeze: V3 = [
          Math.sin(timeSec * 1.7 + phase) * breezeScale * dt2 * 16,
          0,
          Math.cos(timeSec * 1.25 + phase) * breezeScale * 0.7 * dt2 * 16,
        ]
        const gravPull: V3 = [0, -gravity * dt2 * (isHair ? 0.14 : 0.28), 0]
        let candTip = vAdd(vAdd(vAdd(curTip, vel), springPull), vAdd(gravPull, breeze))

        let candDir = vNorm(vSub(candTip, rootPos))
        const dotRest = Math.max(-1, Math.min(1, vDot(targetDrapeDir, candDir)))
        const angDeg = (Math.acos(dotRest)) / DEG
        if (angDeg > maxConeDeg) {
          const qClamp = qSlerp(IDENTITY, qFromTwoVectors(targetDrapeDir, candDir), maxConeDeg / angDeg)
          candDir = vNorm(qRotate(qClamp, targetDrapeDir))
        }
        candTip = vAdd(rootPos, vScale(candDir, node.segLen))

        // Elliptical Body Hull Collision Push-out (keeps hair/ribbons outside head/chest/torso/thighs!)
        for (const hull of physHulls) {
          const isPartner = hull.id.startsWith("partner_")
          if (isHair && !isPartner && hull.id !== "head" && hull.id !== "chest") continue
          if (!isHair && !isPartner && hull.id === "head") continue
          const margin = (isHair && hull.id === "head") ? 0.01 : 0.03
          const pushed = pushOutOfHull(candTip, hull, margin)
          if (vLen(vSub(pushed, candTip)) > 1e-4) {
            candDir = vNorm(vSub(pushed, rootPos))
            candTip = vAdd(rootPos, vScale(candDir, node.segLen))
          }
        }

        const qDeltaWorld = qFromTwoVectors(restDirParentWorld, candDir)
        const qWorld = qNorm(qMul(qDeltaWorld, parentRot))
        const qLocal = qNorm(qMul(qConj(parentRot), qWorld))

        physPrevTipPos.set(node.boneJp, curTip)
        physTipPos.set(node.boneJp, candTip)
        solvedPhysPos.set(node.boneJp, rootPos)
        solvedPhysRot.set(node.boneJp, qWorld)
        localRots.set(node.boneJp, qLocal)
      }
    }

    // Record all touched bones for this frame
    for (const [jp, q] of localRots.entries()) {
      const tr = localTrans.get(jp) ?? [0, 0, 0] as V3
      recordBone(jp, frame, tr, qNorm(q))
    }
    for (const [jp, tr] of localTrans.entries()) {
      if (!localRots.has(jp)) recordBone(jp, frame, tr, IDENTITY)
    }

    if (options?.onFrameSolved) {
      const fkFinal = solveFkSnapshot(bones, restWorld, localRots, localTrans)
      options.onFrameSolved(frame, fkFinal, worldHulls)
    }
  }

  // ---- Upgrade A: Zero-Phase Upper-Body & Arm SLERP Smoothing (legs/pelvis strictly untouched to keep <1mm grounding!) ----
  const GROUND_LOCKED_BONES = new Set(["全ての親", "センター", "グルーブ", "腰", "下半身", "左足", "右足", "左ひざ", "右ひざ", "左足首", "右足首"])

  // ---- Decimate & Serialize to VMD ----
  let rawKeyCount = 0
  const boneKeys: BoneKey[] = []
  const seenVmdNames = new Set<string>()
  for (const [jp, rawSamples] of tracks.entries()) {
    const nameBytes = encodeBoneName(jp)
    const sig = Array.from(nameBytes).join(",")
    if (seenVmdNames.has(sig)) continue // prevent 15-byte Shift-JIS truncation collisions from overwriting tracks
    seenVmdNames.add(sig)
    rawKeyCount += rawSamples.length
    const isPhys = physBoneSet.has(jp)
    const samples = GROUND_LOCKED_BONES.has(jp)
      ? rawSamples
      : smoothQuatTrack(rawSamples, 2)
    // Secondary physics chains use 1.4° angle tolerance to keep VMD compact & silky
    const kept = decimateTrack(samples, isPhys ? 1.4 : 0.25, 0.008)
    for (const s of kept) {
      boneKeys.push({
        frame: s.frame,
        pos: s.pos,
        quat: s.quat,
        name: nameBytes,
        jp,
        curve: LINEAR_CURVE,
      })
    }
  }

  // Property frame 0: disable leg IK so FK leg chains play identically in reze-engine & Blender
  const ikNames = ["左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ"]
  const propFrame: PropertyFrame = {
    frame: 0,
    visible: true,
    ikEntries: ikNames.map((jp) => ({ jp, raw: encodeBoneName(jp), enabled: false })),
  }

  const header = new Uint8Array(30)
  header.set(new TextEncoder().encode("Vocaloid Motion Data 0002"), 0)
  const modelName = new Uint8Array(20)
  modelName.set(encodeBoneName(profile.modelName || "topaz"), 0)

  const parsedStub: ParsedVmd = {
    header,
    modelName,
    boneKeys,
    morphBytes: new Uint8Array(0),
    cameraBytes: new Uint8Array(0),
    lightBytes: new Uint8Array(0),
    shadowBytes: new Uint8Array(0),
    propertyFrames: [propFrame],
    trailing: new Uint8Array(0),
  }
  let vmd = serializeVmd(parsedStub, boneKeys)
  if (morphKeys.length > 0) {
    vmd = injectMorphFrames(vmd, morphKeys)
  }

  return {
    vmd,
    frameCount: totalFrames + 1,
    durationSec,
    rawKeyCount,
    decimatedKeyCount: boneKeys.length,
    morphKeyCount: morphKeys.length,
    solveTimeMs: Number((performance.now() - tStart).toFixed(1)),
  }
}
