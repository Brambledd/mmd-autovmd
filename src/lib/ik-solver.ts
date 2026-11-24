/**
 * ik-solver.ts — Topaz-aware MPL2 extended bone + analytical IK solver.
 *
 * Runs inside compileMPL2() after mmd-mpl WASM compilation (zero Rust changes):
 *  1. Extended bones that mmd-mpl's 61-word table omits:
 *       upper_body2 (上半身2), groove (グルーブ),
 *       arm_twist_l/r (左腕捩/右腕捩), wrist_twist_l/r (左手捩/右手捩), eyes (両目)
 *  2. Spatial goal directives solved against the active PMX skeleton & envelopes:
 *       reach <hand_l|hand_r> to <anchor> [+ [dx,dy,dz]];
 *       aim <head|eyes> at <camera|up|down|left|right|hand_l|hand_r>;
 *       plant <feet|foot_l|foot_r>;
 *
 * Robustness contract: unknown anchors/missing bones are skipped cleanly without throwing.
 */

import Encoding from "encoding-japanese"
import { detectPosSemantics, restWorldPositions } from "./model-geometry.ts"
import type { PmxBones } from "./pmx-bones.ts"
import { parseVmd, serializeVmd } from "./vmd-enhancer.ts"
import type { BoneKey, ParsedVmd, Quat, VmdCurve } from "./vmd-enhancer.ts"

export type V3 = [number, number, number]

export interface ExtendedBoneOp {
  bone: string // MPL name e.g. "upper_body2", "wrist_twist_r"
  reset?: boolean
  actions: Array<{ action: "bend" | "turn" | "sway" | "move"; direction: string; amount: number }>
}

export interface ReachOp {
  limb: "hand_l" | "hand_r"
  target: string // semantic anchor or "[x,y,z]"
  offset?: V3
}

export interface AimOp {
  part: "head" | "eyes"
  target: string // camera | up | down | left | right | hand_l | hand_r | "[x,y,z]"
}

export interface PlantOp {
  target: "feet" | "foot_l" | "foot_r"
}

export interface PoseDirectives {
  extendedBones: ExtendedBoneOp[]
  reaches: ReachOp[]
  aims: AimOp[]
  plants: PlantOp[]
}

const DEFAULT_CURVE: VmdCurve = { x1: 20, y1: 20, x2: 107, y2: 107 }
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

// ------------------------------------------------------------------ math

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
  return l > 1e-8 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

function qNorm(q: Quat): Quat {
  const l = Math.hypot(q.x, q.y, q.z, q.w)
  return l > 1e-8 ? { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l } : IDENTITY
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
  const n = vNorm(axis)
  if (vLen(n) < 1e-6) return IDENTITY
  const half = ((deg * Math.PI) / 180) * 0.5
  const s = Math.sin(half)
  return qNorm({ x: n[0] * s, y: n[1] * s, z: n[2] * s, w: Math.cos(half) })
}

function qFromTwoVectors(from: V3, to: V3): Quat {
  const u = vNorm(from)
  const v = vNorm(to)
  const d = Math.max(-1, Math.min(1, vDot(u, v)))
  if (d > 0.999999) return IDENTITY
  if (d < -0.999999) {
    let ortho = vCross([1, 0, 0], u)
    if (vLen(ortho) < 1e-4) ortho = vCross([0, 1, 0], u)
    return qFromAxisAngle(ortho, 180)
  }
  const c = vCross(u, v)
  return qNorm({ x: c[0], y: c[1], z: c[2], w: 1 + d })
}

/** Build quaternion from orthonormal basis columns X (left), Y (up), Z (back). */
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

function clampAngle(q: Quat, maxDeg: number): Quat {
  const nq = qNorm(q)
  const w = Math.max(-1, Math.min(1, nq.w))
  const ang = 2 * Math.acos(Math.abs(w)) * (180 / Math.PI)
  if (ang <= maxDeg) return nq
  const s = Math.hypot(nq.x, nq.y, nq.z)
  if (s < 1e-8) return IDENTITY
  const half = ((maxDeg * Math.PI) / 180) * 0.5
  const sign = w < 0 ? -1 : 1
  const scale = (Math.sin(half) / s) * sign
  return qNorm({ x: nq.x * scale, y: nq.y * scale, z: nq.z * scale, w: Math.cos(half) })
}

// ------------------------------------------------------------------ VMD helpers

function boneNameBytes(jp: string): Uint8Array {
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

export function createMinimalVmd(): Uint8Array {
  const buf = new Uint8Array(50 + 4 + 4 + 4 + 4 + 4 + 4)
  const dv = new DataView(buf.buffer)
  buf.set(new TextEncoder().encode("Vocaloid Motion Data 0002"), 0)
  dv.setUint32(50, 0, true)
  return buf
}

// ------------------------------------------------------------------ extended bones

const EXTENDED_JP: Record<string, string> = {
  upper_body2: "上半身2",
  groove: "グルーブ",
  arm_twist_l: "左腕捩",
  arm_twist_r: "右腕捩",
  wrist_twist_l: "左手捩",
  wrist_twist_r: "右手捩",
  eyes: "両目",
}

export const EXTENDED_BONE_NAMES = new Set(Object.keys(EXTENDED_JP))

function twistAxis(bones: PmxBones | undefined, aJp: string, bJp: string, fallback: V3): V3 {
  if (!bones) return fallback
  const ia = bones.indexByJp.get(aJp)
  const ib = bones.indexByJp.get(bJp)
  if (ia == null || ib == null) return fallback
  const d = vSub(bones.bones[ib].pos, bones.bones[ia].pos)
  return vLen(d) > 1e-4 ? vNorm(d) : fallback
}

function evalExtendedBone(
  op: ExtendedBoneOp,
  bones?: PmxBones
): { jp: string; pos: V3; quat: Quat } | null {
  const jp = EXTENDED_JP[op.bone]
  if (!jp) return null
  if (op.reset && op.actions.length === 0) {
    return { jp, pos: [0, 0, 0], quat: IDENTITY }
  }

  let q = IDENTITY
  const pos: V3 = [0, 0, 0]

  for (const act of op.actions) {
    const dir = act.direction
    const amt = act.amount
    if (op.bone === "upper_body2") {
      const deg = Math.min(60, Math.max(0, amt))
      if (act.action === "bend") {
        q = qMul(q, qFromAxisAngle(dir === "forward" ? [-1, 0, 0] : [1, 0, 0], deg))
      } else if (act.action === "turn") {
        q = qMul(q, qFromAxisAngle(dir === "left" ? [0, -1, 0] : [0, 1, 0], deg))
      } else if (act.action === "sway") {
        q = qMul(q, qFromAxisAngle(dir === "left" ? [0, 0, -1] : [0, 0, 1], deg))
      }
    } else if (op.bone === "groove") {
      if (act.action === "move") {
        const d = Math.min(30, Math.max(0, amt))
        if (dir === "up") pos[1] += d
        else if (dir === "down") pos[1] -= d
        else if (dir === "left") pos[0] += d
        else if (dir === "right") pos[0] -= d
        else if (dir === "forward") pos[2] -= d
        else if (dir === "backward") pos[2] += d
      } else {
        const deg = Math.min(90, Math.max(0, amt))
        if (act.action === "bend") q = qMul(q, qFromAxisAngle(dir === "forward" ? [-1, 0, 0] : [1, 0, 0], deg))
        else if (act.action === "turn") q = qMul(q, qFromAxisAngle(dir === "left" ? [0, -1, 0] : [0, 1, 0], deg))
        else if (act.action === "sway") q = qMul(q, qFromAxisAngle(dir === "left" ? [0, 0, -1] : [0, 0, 1], deg))
      }
    } else if (op.bone === "eyes") {
      const deg = Math.min(35, Math.max(0, amt))
      if (act.action === "bend") q = qMul(q, qFromAxisAngle(dir === "forward" ? [-1, 0, 0] : [1, 0, 0], Math.min(25, deg)))
      else if (act.action === "turn") q = qMul(q, qFromAxisAngle(dir === "left" ? [0, -1, 0] : [0, 1, 0], deg))
      else if (act.action === "sway") q = qMul(q, qFromAxisAngle(dir === "left" ? [0, 0, -1] : [0, 0, 1], Math.min(15, deg)))
    } else if (op.bone === "arm_twist_l" || op.bone === "wrist_twist_l") {
      const deg = Math.min(120, Math.max(0, amt))
      const ax =
        op.bone === "arm_twist_l"
          ? twistAxis(bones, "左腕", "左ひじ", [0.8, -0.6, 0])
          : twistAxis(bones, "左ひじ", "左手首", [0.8, -0.6, 0])
      // Left arm: turn left = -ax (palm/inner forearm rotates backward/upward symmetrically with mmd-mpl)
      const signed = dir === "left" ? vScale(ax, -1) : ax
      q = qMul(q, qFromAxisAngle(signed, deg))
    } else if (op.bone === "arm_twist_r" || op.bone === "wrist_twist_r") {
      const deg = Math.min(120, Math.max(0, amt))
      const ax =
        op.bone === "arm_twist_r"
          ? twistAxis(bones, "右腕", "右ひじ", [-0.8, -0.6, 0])
          : twistAxis(bones, "右ひじ", "右手首", [-0.8, -0.6, 0])
      const signed = dir === "right" ? vScale(ax, -1) : ax
      q = qMul(q, qFromAxisAngle(signed, deg))
    }
  }

  return { jp, pos, quat: qNorm(q) }
}

// ------------------------------------------------------------------ grant-aware FK

interface SkeletonPose {
  pos: V3[]
  rot: Quat[]
}

function solveSkeletonPose(
  bones: PmxBones,
  keysByJp: Map<string, BoneKey>,
  semantics: "absolute" | "offset"
): SkeletonPose {
  const n = bones.bones.length
  const localQ: Quat[] = new Array(n)
  const resolving = new Set<number>()

  const localQOf = (i: number): Quat => {
    if (localQ[i]) return localQ[i]
    if (resolving.has(i)) return IDENTITY
    resolving.add(i)
    const b = bones.bones[i]
    const key = keysByJp.get(b.jp)
    let own = qNorm(key ? key.quat : IDENTITY)
    const g = b.grant
    if (g && g.rotate && (g.ratio === 1 || g.ratio === -1) && g.parent >= 0 && g.parent < n) {
      const src = localQOf(g.parent)
      own = g.ratio === 1 ? qMul(own, src) : qMul(own, qConj(src))
    }
    resolving.delete(i)
    localQ[i] = own
    return own
  }
  for (let i = 0; i < n; i++) localQOf(i)

  const pos: V3[] = new Array(n)
  const rot: Quat[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const b = bones.bones[i]
    const hasParent = b.parent >= 0 && b.parent < n
    const parentPos = hasParent ? pos[b.parent] : undefined
    const parentRot = hasParent ? rot[b.parent] : undefined
    let off: V3 = [b.pos[0], b.pos[1], b.pos[2]]
    if (semantics === "absolute" && hasParent) {
      const pp = bones.bones[b.parent].pos
      off = [b.pos[0] - pp[0], b.pos[1] - pp[1], b.pos[2] - pp[2]]
    }
    const worldRot = parentRot ? qMul(parentRot, localQ[i]) : localQ[i]
    const rotated = parentRot ? qRotate(parentRot, off) : off
    let worldPos: V3 = parentPos ? vAdd(parentPos, rotated) : rotated
    const key = keysByJp.get(b.jp)
    if (key) {
      worldPos = vAdd(worldPos, key.pos)
    }
    pos[i] = worldPos
    rot[i] = worldRot
  }

  return { pos, rot }
}

// ------------------------------------------------------------------ semantic anchors (Topaz envelopes)

function parseVecLiteral(s: string): V3 | null {
  const m = s.trim().match(/^\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]$/)
  if (!m) return null
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]
}

function resolveReachTarget(
  op: ReachOp,
  bones: PmxBones,
  pose: SkeletonPose
): { target: V3; poleHint: "back_out" | "chest_front" | "face_cup" | "overhead" | "side_out" } | null {
  const isLeft = op.limb === "hand_l"
  const s = isLeft ? 1 : -1

  const hostPoint = (jp: string, fallbackJp: string, localOffset: V3): V3 | null => {
    const idx = bones.indexByJp.get(jp) ?? bones.indexByJp.get(fallbackJp)
    if (idx == null) return null
    return vAdd(pose.pos[idx], qRotate(pose.rot[idx], localOffset))
  }

  const env = bones.envelopes ?? {}
  const hipHalfW = env["下半身"] ? Math.max(Math.abs(env["下半身"].min[0]), Math.abs(env["下半身"].max[0])) : 1.81
  const waistHalfW = env["上半身"] ? Math.max(Math.abs(env["上半身"].min[0]), Math.abs(env["上半身"].max[0])) : 1.26
  const upper2Idx = bones.indexByJp.get("上半身2") ?? bones.indexByJp.get("上半身")
  const upper2RestZ = upper2Idx != null ? bones.bones[upper2Idx].pos[2] : -0.37
  const chestFrontOff = env["上半身2"] ? env["上半身2"].min[2] - upper2RestZ : -1.63
  const headR = env["頭"] ? (env["頭"].max[0] - env["頭"].min[0]) * 0.5 : 1.32

  const t = op.target.trim().toLowerCase()
  const rawVec = parseVecLiteral(t)
  let base: V3 | null = null
  let poleHint: "back_out" | "chest_front" | "face_cup" | "overhead" | "side_out" = "back_out"

  if (rawVec) {
    base = rawVec
  } else if (t === "hip_l" || t === "hip_r" || t === "hip") {
    const side = t === "hip_l" ? 1 : t === "hip_r" ? -1 : s
    base = hostPoint("下半身", "腰", [side * (hipHalfW - 0.05), 0.15, -0.1])
    poleHint = "side_out"
  } else if (t === "waist_l" || t === "waist_r" || t === "waist") {
    const side = t === "waist_l" ? 1 : t === "waist_r" ? -1 : s
    base = hostPoint("上半身", "腰", [side * (waistHalfW + 0.25), 0.1, -0.15])
    poleHint = "side_out"
  } else if (t === "chest" || t === "heart") {
    const xOff = t === "heart" ? 0.55 : s * 0.3
    base = hostPoint("上半身2", "上半身", [xOff, 0.85, chestFrontOff - 0.35])
    poleHint = "chest_front"
  } else if (t === "cheek_l" || t === "cheek_r" || t === "cheek") {
    const side = t === "cheek_l" ? 1 : t === "cheek_r" ? -1 : s
    base = hostPoint("頭", "首", [side * (headR + 0.28), -0.22, -1.15])
    poleHint = "face_cup"
  } else if (t === "peace" || t === "peace_l" || t === "peace_r") {
    const side = t === "peace_l" ? 1 : t === "peace_r" ? -1 : s
    base = hostPoint("頭", "首", [side * (headR + 0.72), 0.0, -(headR + 0.25)])
    poleHint = "face_cup"
  } else if (t === "chin") {
    base = hostPoint("頭", "首", [s * 0.18, -0.72, -(headR + 0.18)])
    poleHint = "face_cup"
  } else if (t === "mouth") {
    // Wrist sits below chin/jaw slightly forward so palm + fingers cup mouth cleanly without clipping face on settle
    base = hostPoint("頭", "首", [s * 0.12, -0.68, -(headR + 0.35)])
    poleHint = "face_cup"
  } else if (t === "forehead" || t === "forehead_l" || t === "forehead_r" || t === "salute" || t === "salute_l" || t === "salute_r") {
    const side = t.endsWith("_l") ? 1 : t.endsWith("_r") ? -1 : s
    base = hostPoint("頭", "首", [side * 0.72, 1.35, -(headR + 0.05)])
    poleHint = "side_out"
  } else if (t === "head_top") {
    base = hostPoint("頭", "首", [s * 0.2, 2.75, -0.1])
    poleHint = "overhead"
  } else if (t === "back_of_head") {
    base = hostPoint("頭", "首", [s * 0.35, 0.65, headR + 0.35])
    poleHint = "side_out"
  } else if (t === "nape") {
    base = hostPoint("頭", "首", [s * 0.25, -0.35, headR + 0.25])
    poleHint = "side_out"
  } else if (t === "ear_l" || t === "ear_r" || t === "ear") {
    const side = t === "ear_l" ? 1 : t === "ear_r" ? -1 : s
    base = hostPoint("頭", "首", [side * (headR + 0.32), 0.15, 0.1])
    poleHint = "side_out"
  } else if (t === "shoulder_l" || t === "shoulder_r" || t === "shoulder") {
    const side = t === "shoulder_l" ? 1 : t === "shoulder_r" ? -1 : s
    base = hostPoint("上半身2", "上半身", [side * 1.25, 1.95, -0.45])
    poleHint = "chest_front"
  } else if (t === "knee_l" || t === "knee_r" || t === "knee") {
    const kneeJp = t === "knee_l" ? "左ひざ" : t === "knee_r" ? "右ひざ" : isLeft ? "左ひざ" : "右ひざ"
    base = hostPoint(kneeJp, "下半身", [0, 0.25, -0.85])
    poleHint = "back_out"
  } else if (
    t === "foot_l" || t === "foot_r" || t === "foot" ||
    t === "shoe_l" || t === "shoe_r" || t === "shoe" ||
    t === "ankle_l" || t === "ankle_r" || t === "ankle"
  ) {
    const sideJp = t.endsWith("_l") ? "左" : t.endsWith("_r") ? "右" : isLeft ? "左" : "右"
    const toeIdx = bones.indexByJp.get(`${sideJp}足先EX`)
    const ankleIdx = bones.indexByJp.get(`${sideJp}足首D`) ?? bones.indexByJp.get(`${sideJp}足首`)
    if (toeIdx != null) {
      base = vAdd(pose.pos[toeIdx], [s * 0.42, 0.85, -0.55])
    } else if (ankleIdx != null) {
      base = vAdd(pose.pos[ankleIdx], [s * 0.42, 0.75, -1.55])
    }
    poleHint = "back_out"
  } else if (t === "front" || t === "front_l" || t === "front_r") {
    const side = t === "front_l" ? 1 : t === "front_r" ? -1 : s
    base = hostPoint("上半身2", "上半身", [side * 1.25, 0.5, -4.3])
    poleHint = "chest_front"
  } else if (t === "up" || t === "up_l" || t === "up_r") {
    const side = t === "up_l" ? 1 : t === "up_r" ? -1 : s
    base = hostPoint("上半身2", "上半身", [side * 1.65, 5.5, -0.45])
    poleHint = "overhead"
  } else if (t === "out" || t === "out_l" || t === "out_r") {
    const side = t === "out_l" ? 1 : t === "out_r" ? -1 : s
    base = hostPoint("上半身2", "上半身", [side * 5.2, 1.75, -0.1])
    poleHint = "back_out"
  } else if (t === "wave" || t === "wave_l" || t === "wave_r") {
    const side = t === "wave_l" ? 1 : t === "wave_r" ? -1 : s
    base = hostPoint("上半身2", "上半身", [side * 2.55, 3.65, -1.45])
    poleHint = "side_out"
  } else if (t === "hand_l" || t === "hand_r" || t === "other_hand") {
    const targetWrist = t === "hand_l" ? "左手首" : t === "hand_r" ? "右手首" : isLeft ? "右手首" : "左手首"
    const idx = bones.indexByJp.get(targetWrist)
    if (idx != null) {
      base = vAdd(pose.pos[idx], [s * 0.12, 0, -0.05])
      poleHint = "chest_front"
    }
  }

  if (!base) return null
  if (op.offset) base = vAdd(base, op.offset)
  return { target: base, poleHint }
}

// ------------------------------------------------------------------ 2-bone analytical arm IK

function solveArmReachIK(
  op: ReachOp,
  bones: PmxBones,
  pose: SkeletonPose,
  semantics: "absolute" | "offset"
): Array<{ jp: string; quat: Quat }> | null {
  const resolved = resolveReachTarget(op, bones, pose)
  if (!resolved) return null

  const isLeft = op.limb === "hand_l"
  const s = isLeft ? 1 : -1
  const armJp = isLeft ? "左腕" : "右腕"
  const elbowJp = isLeft ? "左ひじ" : "右ひじ"
  const wristJp = isLeft ? "左手首" : "右手首"

  const armIdx = bones.indexByJp.get(armJp)
  const elbowIdx = bones.indexByJp.get(elbowJp)
  const wristIdx = bones.indexByJp.get(wristJp)
  if (armIdx == null || elbowIdx == null || wristIdx == null) return null

  const armParentIdx = bones.bones[armIdx].parent
  const parentRot = armParentIdx >= 0 ? pose.rot[armParentIdx] : IDENTITY
  const shoulderWorldPos = pose.pos[armIdx]

  // Rest-pose segment vectors (exact model proportions)
  const restPos = (i: number): V3 => bones.bones[i].pos
  const u0: V3 =
    semantics === "absolute"
      ? vSub(restPos(elbowIdx), restPos(armIdx))
      : restPos(elbowIdx)
  const f0: V3 =
    semantics === "absolute"
      ? vSub(restPos(wristIdx), restPos(elbowIdx))
      : restPos(wristIdx)
  const l1 = vLen(u0)
  const l2 = vLen(f0)
  if (l1 < 1e-4 || l2 < 1e-4) return null

  // Target in arm parent's local frame
  const targetVecWorld = vSub(resolved.target, shoulderWorldPos)
  const targetLocalRaw = qRotate(qConj(parentRot), targetVecWorld)
  const rawDist = vLen(targetLocalRaw)
  if (rawDist < 1e-5) return null
  const dirT = vScale(targetLocalRaw, 1 / rawDist)
  const minD = Math.abs(l1 - l2) + 0.08
  const maxD = l1 + l2 - 0.03
  const d = Math.max(minD, Math.min(maxD, rawDist))
  const targetLocal = vScale(dirT, d)

  // 1) Elbow bend (single anatomical forward hinge axis derived directly from rest arm!)
  // Both left (+X) and right (-X) arms bend forward (-Z) via cross(u0, [0, 0, -1])
  const cosAlpha = Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)))
  const bendDeg = 180 - (Math.acos(cosAlpha) * 180) / Math.PI
  const hingeAxis = vNorm(vCross(u0, [0, 0, -1]))
  const qElbow = qFromAxisAngle(hingeAxis, Math.max(0, Math.min(175, bendDeg)))

  // Wrist position after elbow bend (before arm rotation)
  const wBent = vAdd(u0, qRotate(qElbow, f0))
  const qSwing = qFromTwoVectors(wBent, targetLocal)

  // 2) Align elbow pole plane cleanly in torso/world frame so elbow points naturally
  const torsoIdx = bones.indexByJp.get("上半身2") ?? bones.indexByJp.get("上半身")
  const torsoRot = torsoIdx != null ? pose.rot[torsoIdx] : IDENTITY
  let poleTorso: V3
  if (resolved.poleHint === "side_out") poleTorso = [s * 0.92, -0.05, 0.42]
  else if (resolved.poleHint === "face_cup") poleTorso = [s * 0.42, -1.0, -0.35]
  else if (resolved.poleHint === "chest_front") poleTorso = [s * 0.72, -0.82, 0.12]
  else if (resolved.poleHint === "overhead") poleTorso = [s * 0.65, 0.25, 0.7]
  else poleTorso = [s * 0.6, -0.4, 0.7]

  const poleWorld = qRotate(torsoRot, poleTorso)
  const poleLocal = qRotate(qConj(parentRot), poleWorld)

  const eAfterSwing = qRotate(qSwing, u0)
  const ePerp = vSub(eAfterSwing, vScale(dirT, vDot(eAfterSwing, dirT)))
  const pPerp = vSub(poleLocal, vScale(dirT, vDot(poleLocal, dirT)))
  let qArm = qSwing
  if (vLen(ePerp) > 1e-4 && vLen(pPerp) > 1e-4) {
    const qTwist = qFromTwoVectors(ePerp, pPerp)
    qArm = qNorm(qMul(qTwist, qSwing))
  }

  return [
    { jp: armJp, quat: qArm },
    { jp: elbowJp, quat: qNorm(qElbow) },
  ]
}

// ------------------------------------------------------------------ aim (head / eyes)

function solveAimIK(
  op: AimOp,
  bones: PmxBones,
  pose: SkeletonPose,
  authoredLocalQuat?: Quat
): { jp: string; quat: Quat } | null {
  const jp = op.part === "eyes" ? "両目" : "頭"
  const idx = bones.indexByJp.get(jp)
  if (idx == null) return null
  const parentIdx = bones.bones[idx].parent
  const parentRot = parentIdx >= 0 ? pose.rot[parentIdx] : IDENTITY
  const origin = pose.pos[idx]

  const t = op.target.trim().toLowerCase()
  let dirWorld: V3 | null = null
  const vec = parseVecLiteral(t)
  if (vec) {
    dirWorld = vNorm(vSub(vec, origin))
  } else if (t === "camera" || t === "front") {
    dirWorld = vNorm(vSub([0, origin[1], origin[2] - 20], origin))
  } else if (t === "up") {
    dirWorld = vNorm([0, 0.5, -0.866])
  } else if (t === "down") {
    dirWorld = vNorm([0, -0.55, -0.835])
  } else if (t === "left") {
    dirWorld = vNorm([0.65, 0, -0.76])
  } else if (t === "right") {
    dirWorld = vNorm([-0.65, 0, -0.76])
  } else if (t === "hand_l" || t === "hand_r") {
    const hIdx = bones.indexByJp.get(t === "hand_l" ? "左手首" : "右手首")
    if (hIdx != null) dirWorld = vNorm(vSub(pose.pos[hIdx], origin))
  }
  if (!dirWorld || vLen(dirWorld) < 1e-5) return null

  const fwdLocal = qRotate(qConj(parentRot), dirWorld)
  const worldUpLocal = qRotate(qConj(parentRot), [0, 1, 0])
  let left = vCross(fwdLocal, worldUpLocal)
  if (vLen(left) < 1e-4) left = [1, 0, 0]
  left = vNorm(left)
  const up = vNorm(vCross(left, fwdLocal))
  const back = vScale(fwdLocal, -1)

  let q = qFromBasis(left, up, back)
  // Preserve authored head roll/tilt (e.g. `head sway right 12;`) when aiming head
  if (op.part === "head" && authoredLocalQuat) {
    const curUp = qRotate(authoredLocalQuat, [0, 1, 0])
    const rollDeg = (Math.atan2(-curUp[0], curUp[1]) * 180) / Math.PI
    if (Math.abs(rollDeg) > 1.5 && Math.abs(rollDeg) <= 65) {
      q = qMul(q, qFromAxisAngle([0, 0, 1], rollDeg))
    }
  }
  return { jp, quat: clampAngle(q, op.part === "eyes" ? 30 : 75) }
}

// ------------------------------------------------------------------ plant (feet grounding)

function solvePlantFeet(
  ops: PlantOp[],
  bones: PmxBones,
  pose: SkeletonPose,
  currentCenterPos: V3
): V3 | null {
  if (ops.length === 0) return null
  const wantL = ops.some((o) => o.target === "feet" || o.target === "foot_l")
  const wantR = ops.some((o) => o.target === "feet" || o.target === "foot_r")

  const pairs: Array<{ jp: string }> = []
  if (wantL) pairs.push({ jp: "左足先EX" }, { jp: "左足首D" }, { jp: "左足首" })
  if (wantR) pairs.push({ jp: "右足先EX" }, { jp: "右足首D" }, { jp: "右足首" })

  const restWorld = restWorldPositions(bones)
  let maxDelta = -Infinity
  let found = false
  for (const { jp } of pairs) {
    const idx = bones.indexByJp.get(jp)
    if (idx == null) continue
    const restY = restWorld.get(idx)?.y ?? bones.bones[idx].pos[1]
    const curY = pose.pos[idx][1]
    const dy = restY - curY
    if (dy > maxDelta) {
      maxDelta = dy
      found = true
    }
  }
  if (!found || !Number.isFinite(maxDelta)) return null
  // Move center vertically so the lowest selected foot sits at its rest ground plane
  return [currentCenterPos[0], currentCenterPos[1] + maxDelta, currentCenterPos[2]]
}

// ------------------------------------------------------------------ VMD application

function upsertKey(
  allKeys: BoneKey[],
  jp: string,
  frame: number,
  pos: V3,
  quat: Quat
) {
  const existing = allKeys.find((k) => k.jp === jp && k.frame === frame)
  if (existing) {
    existing.pos = [pos[0], pos[1], pos[2]]
    existing.quat = qNorm(quat)
  } else {
    allKeys.push({
      frame,
      pos: [pos[0], pos[1], pos[2]],
      quat: qNorm(quat),
      name: boneNameBytes(jp),
      jp,
      curve: { ...DEFAULT_CURVE },
    })
  }
}

function stepStateAtFrame(allKeys: BoneKey[], frame: number): Map<string, BoneKey> {
  const latest = new Map<string, BoneKey>()
  // Sort temporarily by frame so step-hold finds latest key <= frame
  const ordered = [...allKeys].sort((a, b) => a.frame - b.frame)
  for (const k of ordered) {
    if (k.frame <= frame) latest.set(k.jp, k)
    else break
  }
  return latest
}

export interface FrameDirectives {
  frame: number
  directives: PoseDirectives
}

export const VALID_REACH_ANCHORS = new Set([
  "hip_l", "hip_r", "hip",
  "waist_l", "waist_r", "waist",
  "chest", "heart",
  "cheek_l", "cheek_r", "cheek",
  "peace", "peace_l", "peace_r",
  "chin", "mouth",
  "forehead", "forehead_l", "forehead_r",
  "salute", "salute_l", "salute_r",
  "head_top", "back_of_head", "nape", "ear_l", "ear_r", "ear",
  "shoulder_l", "shoulder_r", "shoulder",
  "knee_l", "knee_r", "knee",
  "foot_l", "foot_r", "foot",
  "shoe_l", "shoe_r", "shoe",
  "ankle_l", "ankle_r", "ankle",
  "front", "front_l", "front_r",
  "up", "up_l", "up_r",
  "out", "out_l", "out_r",
  "wave", "wave_l", "wave_r",
  "hand_l", "hand_r", "other_hand",
])

export const VALID_AIM_TARGETS = new Set([
  "camera", "front", "up", "down", "left", "right", "hand_l", "hand_r",
])

export function isValidReachTarget(target: string): boolean {
  const t = target.trim().toLowerCase()
  return VALID_REACH_ANCHORS.has(t) || parseVecLiteral(t) !== null
}

export function isValidAimTarget(target: string): boolean {
  const t = target.trim().toLowerCase()
  return VALID_AIM_TARGETS.has(t) || parseVecLiteral(t) !== null
}

/**
 * Apply extended-bone rotations and analytical IK directives (reach/aim/plant)
 * onto compiled VMD bytes, returning updated VMD bytes and a count of solved ops.
 */
export function applyPoseDirectivesToVmd(
  vmd: Uint8Array,
  frameDirectives: FrameDirectives[],
  bones?: PmxBones | null
): { vmd: Uint8Array; solvedOps: number } {
  if (frameDirectives.length === 0) return { vmd, solvedOps: 0 }
  const sourceVmd = vmd.length > 0 ? vmd : createMinimalVmd()
  const parsed: ParsedVmd | null = parseVmd(sourceVmd)
  if (!parsed) return { vmd, solvedOps: 0 }

  const keys = parsed.boneKeys.map((k) => ({ ...k, pos: [...k.pos] as V3, quat: { ...k.quat } }))
  const semantics = bones ? detectPosSemantics(bones) : "absolute"
  let solvedOps = 0

  const sorted = [...frameDirectives].sort((a, b) => a.frame - b.frame)
  for (const { frame, directives } of sorted) {
    // 1) Extended bones (can run even without full PMX, using Topaz fallback axes)
    for (const op of directives.extendedBones) {
      const res = evalExtendedBone(op, bones ?? undefined)
      if (res) {
        upsertKey(keys, res.jp, frame, res.pos, res.quat)
        solvedOps++
      }
    }

    if (!bones) continue

    // 2) Aim (head/eyes) solved before arm reach, in case hand targets head or head aims at hand
    for (const aim of directives.aims) {
      const state = stepStateAtFrame(keys, frame)
      const pose = solveSkeletonPose(bones, state, semantics)
      const headJp = aim.part === "eyes" ? "両目" : "頭"
      const curHeadKey = state.get(headJp)
      const authoredLocal = curHeadKey?.frame === frame ? curHeadKey.quat : undefined
      const res = solveAimIK(aim, bones, pose, authoredLocal)
      if (res) {
        const existingPos = state.get(res.jp)?.frame === frame ? state.get(res.jp)!.pos : ([0, 0, 0] as V3)
        upsertKey(keys, res.jp, frame, existingPos, res.quat)
        solvedOps++
      }
    }

    // 3) Plant feet (adjusts center Y before final arm reach if target is world-space)
    if (directives.plants.length > 0) {
      const state = stepStateAtFrame(keys, frame)
      const pose = solveSkeletonPose(bones, state, semantics)
      const curCenter = state.get("センター")?.pos ?? ([0, 0, 0] as V3)
      const newCenterPos = solvePlantFeet(directives.plants, bones, pose, curCenter)
      if (newCenterPos) {
        const curCenterQuat = state.get("センター")?.quat ?? IDENTITY
        upsertKey(keys, "センター", frame, newCenterPos, curCenterQuat)
        solvedOps++
      }
    }

    // 4) Analytical 2-bone arm reach IK
    for (const reach of directives.reaches) {
      // arm_twist sits between arm and elbow; neutralise it so elbow bends purely in-plane and wrist lands on target
      const twistJp = reach.limb === "hand_l" ? "左腕捩" : "右腕捩"
      if (bones.indexByJp.has(twistJp)) {
        upsertKey(keys, twistJp, frame, [0, 0, 0], IDENTITY)
      }
      const state = stepStateAtFrame(keys, frame)
      const pose = solveSkeletonPose(bones, state, semantics)
      const solved = solveArmReachIK(reach, bones, pose, semantics)
      if (solved) {
        for (const item of solved) {
          upsertKey(keys, item.jp, frame, [0, 0, 0], item.quat)
        }
        // Subtle natural wrist angle when wrist wasn't explicitly keyed at this frame
        const wristJp = reach.limb === "hand_l" ? "左手首" : "右手首"
        const hasExplicitWrist = keys.some((k) => k.jp === wristJp && k.frame === frame)
        if (!hasExplicitWrist) {
          const t = reach.target.trim().toLowerCase()
          const s = reach.limb === "hand_l" ? 1 : -1
          if (t.startsWith("hip") || t.startsWith("waist")) {
            // Angle palm inward against waistband/hip instead of hanging straight down
            upsertKey(keys, wristJp, frame, [0, 0, 0], qFromAxisAngle([0, 0, s], 55))
          } else if (t.startsWith("cheek")) {
            // Curve fingers gently outward along outer cheek contour instead of stabbing into skull/neck
            upsertKey(keys, wristJp, frame, [0, 0, 0], qMul(qFromAxisAngle([0, 0, s], 18), qFromAxisAngle([0, -s, 0], 12)))
          } else if (t === "chin") {
            // Cup gently beneath chin from the front without poking into neck
            upsertKey(keys, wristJp, frame, [0, 0, 0], qFromAxisAngle([0, 0, s], 30))
          } else if (t === "mouth") {
            // Gently cup hand in front of mouth
            upsertKey(keys, wristJp, frame, [0, 0, 0], qFromAxisAngle([0, s, 0], 20))
          }
        }
        solvedOps++
      }
    }
  }

  keys.sort((a, b) => a.frame - b.frame)
  return { vmd: serializeVmd(parsed, keys), solvedOps }
}
