/**
 * duo.ts — Two-person (duo) world-space FK transform, coordinate conversion,
 * and cross-actor collision / contact distance analysis.
 *
 * Coordinate contract (matches MMD / PoPo renderer AND Blender mmd_tools):
 *   - MMD local space: +X = character left, +Y = up, -Z = forward (toward camera)
 *   - Placement `yawDeg`: 0 = facing -Z, +90 = facing +X (viewer right),
 *     -90 = facing -X (viewer left), 180 = facing +Z.
 *     This sign convention matches Blender `root.rotation_euler.z`!
 *   - Blender root location: `[offset[0] * 0.08, offset[2] * 0.08, offset[1] * 0.08]`.
 */

import {
  buildBoneTracks,
  qConjugate,
  qMul,
  qRotate,
  readVmdBoneKeys,
  sampleBoneTracks,
  solveFrameTransforms,
  type BoneTracks,
  type FrameTransforms,
  type Quat,
  type Vec3,
} from "./fk.ts"
import { detectPosSemantics, measureModelGeometry } from "./model-geometry.ts"
import type { PmxBones } from "./pmx-bones.ts"

export interface DuoPlacement {
  /** World position offset in MMD units (1u ≈ 8cm). */
  offset: [number, number, number]
  /** Facing angle in degrees around +Y (0 = camera -Z, +90 = +X, -90 = -X). */
  yawDeg: number
}

export interface DuoActorInput {
  label?: string
  bones: PmxBones
  vmd: Uint8Array
  placement: DuoPlacement
}

export interface DuoActorPrepared {
  label: string
  bones: PmxBones
  tracks: BoneTracks
  semantics: "absolute" | "offset"
  placement: DuoPlacement
  headRadius: number
  torsoRadius: number
  maxFrame: number
}

export interface DuoIssue {
  code:
    | "torso_clipping"
    | "head_clipping"
    | "hand_inside_partner"
    | "arm_clipping"
    | "leg_clipping"
    | "fingertip_inside_partner"
  frame: number
  timeSec: number
  distUnits: number
  message: string
}

export interface DuoFrameMetrics {
  frame: number
  timeSec: number
  landmarksWorld: {
    A: Record<string, [number, number, number] | null>
    B: Record<string, [number, number, number] | null>
  }
  distancesUnits: {
    centerToCenter: number | null
    headToHead: number | null
    aWristR_to_bWristL: number | null
    aWristL_to_bWristR: number | null
    aWristR_to_bWristR: number | null
    aWristL_to_bWristL: number | null
    minWristPair: { pair: string; distUnits: number; distCm: number } | null
  }
  issues: DuoIssue[]
}

const r2 = (n: number) => Number(n.toFixed(2))

/**
 * Facing quaternion around +Y where +yawDeg rotates MMD forward (0,0,-1)
 * toward +X when yawDeg = +90 (matching Blender Z-up rotation_euler.z).
 */
export function duoYawQuat(yawDeg: number): Quat {
  const rad = (yawDeg * Math.PI) / 180
  return { x: 0, y: -Math.sin(rad / 2), z: 0, w: Math.cos(rad / 2) }
}

export function localToDuoWorld(localPos: Vec3, placement: DuoPlacement): Vec3 {
  const rotated = qRotate(duoYawQuat(placement.yawDeg), localPos)
  return {
    x: rotated.x + placement.offset[0],
    y: rotated.y + placement.offset[1],
    z: rotated.z + placement.offset[2],
  }
}

/**
 * Convert a shared duo world point [x,y,z] into an actor's local MPL2 coordinates,
 * ready to pass into `reach hand_<l|r> to [x, y, z];`.
 */
export function worldToActorLocal(worldPos: Vec3, placement: DuoPlacement): [number, number, number] {
  const shifted: Vec3 = {
    x: worldPos.x - placement.offset[0],
    y: worldPos.y - placement.offset[1],
    z: worldPos.z - placement.offset[2],
  }
  const local = qRotate(qConjugate(duoYawQuat(placement.yawDeg)), shifted)
  return [r2(local.x), r2(local.y), r2(local.z)]
}

/**
 * Compute matching Blender mmd_tools ROOT transform for a DuoPlacement.
 */
export function toBlenderRootPlacement(placement: DuoPlacement) {
  return {
    location: [
      Number((placement.offset[0] * 0.08).toFixed(4)),
      Number((placement.offset[2] * 0.08).toFixed(4)),
      Number((placement.offset[1] * 0.08).toFixed(4)),
    ] as [number, number, number],
    rotation_euler_z_deg: placement.yawDeg,
  }
}

export function prepareDuoActor(actor: DuoActorInput, fallbackLabel: string): DuoActorPrepared | null {
  const keys = readVmdBoneKeys(actor.vmd)
  if (!keys || keys.length === 0) return null
  const tracks = buildBoneTracks(keys)
  const semantics = detectPosSemantics(actor.bones)
  const geom = measureModelGeometry(actor.bones)
  let maxFrame = 0
  for (const k of keys) if (k.frame > maxFrame) maxFrame = k.frame
  return {
    label: actor.label || fallbackLabel,
    bones: actor.bones,
    tracks,
    semantics,
    placement: actor.placement,
    headRadius: geom.headRadius ?? 1.5,
    torsoRadius: Math.max(1.1, Math.min(2.1, (geom.shoulderHalfWidth ?? 1.8) * 0.72)),
    maxFrame,
  }
}

export function solveActorWorldFrame(actor: DuoActorPrepared, frame: number): FrameTransforms | null {
  const tf = solveFrameTransforms(actor.bones, sampleBoneTracks(actor.tracks, frame), actor.semantics)
  if (!tf) return null
  const qYaw = duoYawQuat(actor.placement.yawDeg)
  const [ox, oy, oz] = actor.placement.offset
  const pos: Vec3[] = tf.pos.map((p) => {
    const r = qRotate(qYaw, p)
    return { x: r.x + ox, y: r.y + oy, z: r.z + oz }
  })
  const quat: Quat[] = tf.quat.map((q) => qMul(qYaw, q))
  return { pos, quat }
}

function posOf(bones: PmxBones, tf: FrameTransforms, jp: string): Vec3 | null {
  const idx = bones.indexByJp.get(jp)
  return idx != null ? tf.pos[idx] ?? null : null
}

function quatOf(bones: PmxBones, tf: FrameTransforms, jp: string): Quat | null {
  const idx = bones.indexByJp.get(jp)
  return idx != null ? tf.quat[idx] ?? null : null
}

function dist3(a: Vec3 | null, b: Vec3 | null): number | null {
  if (!a || !b) return null
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function distPointToSeg(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const ab2 = abx * abx + aby * aby + abz * abz
  const t = ab2 > 1e-6 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / ab2)) : 0
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t))
}

function distSegToSeg(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3): number {
  const ux = a1.x - a0.x, uy = a1.y - a0.y, uz = a1.z - a0.z
  const vx = b1.x - b0.x, vy = b1.y - b0.y, vz = b1.z - b0.z
  const wx = a0.x - b0.x, wy = a0.y - b0.y, wz = a0.z - b0.z
  const a = ux * ux + uy * uy + uz * uz
  const b = ux * vx + uy * vy + uz * vz
  const c = vx * vx + vy * vy + vz * vz
  const d = ux * wx + uy * wy + uz * wz
  const e = vx * wx + vy * wy + vz * wz
  const D = a * c - b * b
  let sN: number, sD = D
  let tN: number, tD = D
  if (D < 1e-6) {
    sN = 0; sD = 1; tN = e; tD = c
  } else {
    sN = b * e - c * d
    tN = a * e - b * d
    if (sN < 0) { sN = 0; tN = e; tD = c }
    else if (sN > sD) { sN = sD; tN = e + b; tD = c }
  }
  if (tN < 0) {
    tN = 0
    if (-d < 0) sN = 0
    else if (-d > a) sN = sD
    else { sN = -d; sD = a }
  } else if (tN > tD) {
    tN = tD
    if (-d + b < 0) sN = 0
    else if (-d + b > a) sN = sD
    else { sN = -d + b; sD = a }
  }
  const sc = Math.abs(sN) < 1e-6 ? 0 : sN / sD
  const tc = Math.abs(tN) < 1e-6 ? 0 : tN / tD
  const dx = wx + sc * ux - tc * vx
  const dy = wy + sc * uy - tc * vy
  const dz = wz + sc * uz - tc * vz
  return Math.hypot(dx, dy, dz)
}

function headCenterWorld(actor: DuoActorPrepared, tf: FrameTransforms): Vec3 | null {
  const p = posOf(actor.bones, tf, "頭")
  const q = quatOf(actor.bones, tf, "頭")
  if (!p || !q) return p
  const off = qRotate(q, { x: 0, y: actor.headRadius * 0.72, z: 0 })
  return { x: p.x + off.x, y: p.y + off.y, z: p.z + off.z }
}

const LANDMARKS = ["センター", "頭", "左手首", "右手首", "左足首", "右足首"] as const

export function analyzeDuoFrame(
  actorA: DuoActorPrepared,
  actorB: DuoActorPrepared,
  frame: number
): DuoFrameMetrics | null {
  const tfA = solveActorWorldFrame(actorA, frame)
  const tfB = solveActorWorldFrame(actorB, frame)
  if (!tfA || !tfB) return null

  const timeSec = r2(frame / 30)
  const dumpLandmarks = (actor: DuoActorPrepared, tf: FrameTransforms) => {
    const out: Record<string, [number, number, number] | null> = {}
    for (const jp of LANDMARKS) {
      const p = posOf(actor.bones, tf, jp)
      out[jp] = p ? [r2(p.x), r2(p.y), r2(p.z)] : null
    }
    return out
  }

  const cA = posOf(actorA.bones, tfA, "センター")
  const cB = posOf(actorB.bones, tfB, "センター")
  const hA = headCenterWorld(actorA, tfA)
  const hB = headCenterWorld(actorB, tfB)
  const wAL = posOf(actorA.bones, tfA, "左手首")
  const wAR = posOf(actorA.bones, tfA, "右手首")
  const wBL = posOf(actorB.bones, tfB, "左手首")
  const wBR = posOf(actorB.bones, tfB, "右手首")

  const dRL = dist3(wAR, wBL)
  const dLR = dist3(wAL, wBR)
  const dRR = dist3(wAR, wBR)
  const dLL = dist3(wAL, wBL)
  const pairs = [
    { pair: "A.hand_r <-> B.hand_l", d: dRL },
    { pair: "A.hand_l <-> B.hand_r", d: dLR },
    { pair: "A.hand_r <-> B.hand_r", d: dRR },
    { pair: "A.hand_l <-> B.hand_l", d: dLL },
  ].filter((x): x is { pair: string; d: number } => x.d != null)
  pairs.sort((a, b) => a.d - b.d)
  const bestPair = pairs[0]

  const issues: DuoIssue[] = []
  const dHeads = dist3(hA, hB)
  const minHeadDist = actorA.headRadius + actorB.headRadius - 0.25
  if (dHeads != null && dHeads < minHeadDist) {
    issues.push({
      code: "head_clipping",
      frame,
      timeSec,
      distUnits: r2(dHeads),
      message: `t=${timeSec}s: heads overlap (dist=${r2(dHeads)}u < ${r2(minHeadDist)}u)`,
    })
  }

  const loA = posOf(actorA.bones, tfA, "下半身") ?? cA
  const upA = posOf(actorA.bones, tfA, "上半身2") ?? posOf(actorA.bones, tfA, "上半身")
  const loB = posOf(actorB.bones, tfB, "下半身") ?? cB
  const upB = posOf(actorB.bones, tfB, "上半身2") ?? posOf(actorB.bones, tfB, "上半身")

  if (loA && upA && loB && upB) {
    const midA = { x: (loA.x + upA.x) / 2, y: (loA.y + upA.y) / 2, z: (loA.z + upA.z) / 2 }
    const midB = { x: (loB.x + upB.x) / 2, y: (loB.y + upB.y) / 2, z: (loB.z + upB.z) / 2 }
    const dTorso = Math.min(distPointToSeg(midA, loB, upB), distPointToSeg(midB, loA, upA))
    const minTorso = actorA.torsoRadius + actorB.torsoRadius - 0.35
    if (dTorso < minTorso) {
      issues.push({
        code: "torso_clipping",
        frame,
        timeSec,
        distUnits: r2(dTorso),
        message: `t=${timeSec}s: torsos clip into each other (dist=${r2(dTorso)}u < ${r2(minTorso)}u)`,
      })
    }
  }

  const checkHandInside = (
    handOwner: string,
    sideLabel: string,
    wrist: Vec3 | null,
    partnerLabel: string,
    partnerHead: Vec3 | null,
    partnerHeadR: number,
    partnerLo: Vec3 | null,
    partnerUp: Vec3 | null,
    partnerTorsoR: number
  ) => {
    if (!wrist) return
    if (partnerHead) {
      const dh = Math.hypot(wrist.x - partnerHead.x, wrist.y - partnerHead.y, wrist.z - partnerHead.z)
      if (dh < partnerHeadR * 0.50) {
        issues.push({
          code: "hand_inside_partner",
          frame,
          timeSec,
          distUnits: r2(dh),
          message: `t=${timeSec}s: ${handOwner}.${sideLabel} clips inside ${partnerLabel} head (dist=${r2(dh)}u)`,
        })
      }
    }
    if (partnerLo && partnerUp) {
      const dt = distPointToSeg(wrist, partnerLo, partnerUp)
      if (dt < partnerTorsoR * 0.55) {
        issues.push({
          code: "hand_inside_partner",
          frame,
          timeSec,
          distUnits: r2(dt),
          message: `t=${timeSec}s: ${handOwner}.${sideLabel} clips inside ${partnerLabel} torso (dist=${r2(dt)}u)`,
        })
      }
    }
  }

  checkHandInside("A", "hand_l", wAL, "B", hB, actorB.headRadius, loB, upB, actorB.torsoRadius)
  checkHandInside("A", "hand_r", wAR, "B", hB, actorB.headRadius, loB, upB, actorB.torsoRadius)
  checkHandInside("B", "hand_l", wBL, "A", hA, actorA.headRadius, loA, upA, actorA.torsoRadius)
  checkHandInside("B", "hand_r", wBR, "A", hA, actorA.headRadius, loA, upA, actorA.torsoRadius)

  // Fingertip penetration check against partner head/torso
  const TIP_NAMES = ["親指２", "人指３", "中指３", "薬指３", "小指３"] as const
  const checkFingertips = (
    owner: DuoActorPrepared,
    tfOwner: FrameTransforms,
    ownerLabel: string,
    partnerLabel: string,
    partnerHead: Vec3 | null,
    partnerHeadR: number,
    partnerLo: Vec3 | null,
    partnerUp: Vec3 | null,
    partnerTorsoR: number,
  ) => {
    for (const side of ["左", "右"] as const) {
      let worstDist = Infinity
      let worstWhere = ""
      for (const tip of TIP_NAMES) {
        const pt = posOf(owner.bones, tfOwner, `${side}${tip}`)
        if (!pt) continue
        if (partnerHead) {
          const dh = Math.hypot(pt.x - partnerHead.x, pt.y - partnerHead.y, pt.z - partnerHead.z)
          if (dh < partnerHeadR * 0.48 && dh < worstDist) {
            worstDist = dh
            worstWhere = "head"
          }
        }
        if (partnerLo && partnerUp) {
          const dt = distPointToSeg(pt, partnerLo, partnerUp)
          if (dt < partnerTorsoR * 0.52 && dt < worstDist) {
            worstDist = dt
            worstWhere = "torso"
          }
        }
      }
      if (worstWhere) {
        issues.push({
          code: "fingertip_inside_partner",
          frame,
          timeSec,
          distUnits: r2(worstDist),
          message: `t=${timeSec}s: ${ownerLabel}.${side === "左" ? "hand_l" : "hand_r"} fingertips clip inside ${partnerLabel} ${worstWhere} (dist=${r2(worstDist)}u)`,
        })
      }
    }
  }
  checkFingertips(actorA, tfA, "A", "B", hB, actorB.headRadius, loB, upB, actorB.torsoRadius)
  checkFingertips(actorB, tfB, "B", "A", hA, actorA.headRadius, loA, upA, actorA.torsoRadius)

  // Cross-actor arm-to-arm & leg-to-leg segment collision checks
  const segsOf = (actor: DuoActorPrepared, tf: FrameTransforms, pairs: Array<[string, string, string]>) => {
    const out: Array<{ label: string; a: Vec3; b: Vec3 }> = []
    for (const [label, j0, j1] of pairs) {
      const a = posOf(actor.bones, tf, j0)
      const b = posOf(actor.bones, tf, j1)
      if (a && b) out.push({ label, a, b })
    }
    return out
  }
  const armsA = segsOf(actorA, tfA, [
    ["upper_l", "左腕", "左ひじ"], ["fore_l", "左ひじ", "左手首"],
    ["upper_r", "右腕", "右ひじ"], ["fore_r", "右ひじ", "右手首"],
  ])
  const armsB = segsOf(actorB, tfB, [
    ["upper_l", "左腕", "左ひじ"], ["fore_l", "左ひじ", "左手首"],
    ["upper_r", "右腕", "右ひじ"], ["fore_r", "右ひじ", "右手首"],
  ])
  for (const sa of armsA) {
    for (const sb of armsB) {
      const d = distSegToSeg(sa.a, sa.b, sb.a, sb.b)
      if (d < 0.32) {
        issues.push({
          code: "arm_clipping",
          frame,
          timeSec,
          distUnits: r2(d),
          message: `t=${timeSec}s: A.${sa.label} clips with B.${sb.label} (dist=${r2(d)}u)`,
        })
      }
    }
  }

  const legsA = segsOf(actorA, tfA, [
    ["thigh_l", "左足", "左ひざ"], ["shin_l", "左ひざ", "左足首"],
    ["thigh_r", "右足", "右ひざ"], ["shin_r", "右ひざ", "右足首"],
  ])
  const legsB = segsOf(actorB, tfB, [
    ["thigh_l", "左足", "左ひざ"], ["shin_l", "左ひざ", "左足首"],
    ["thigh_r", "右足", "右ひざ"], ["shin_r", "右ひざ", "右足首"],
  ])
  for (const sa of legsA) {
    for (const sb of legsB) {
      const isBothThigh = sa.label.startsWith("thigh") && sb.label.startsWith("thigh")
      const minD = isBothThigh ? 1.02 : 0.68
      const d = distSegToSeg(sa.a, sa.b, sb.a, sb.b)
      if (d < minD) {
        issues.push({
          code: "leg_clipping",
          frame,
          timeSec,
          distUnits: r2(d),
          message: `t=${timeSec}s: A.${sa.label} clips with B.${sb.label} (dist=${r2(d)}u < ${minD}u)`,
        })
      }
    }
  }

  return {
    frame,
    timeSec,
    landmarksWorld: {
      A: dumpLandmarks(actorA, tfA),
      B: dumpLandmarks(actorB, tfB),
    },
    distancesUnits: {
      centerToCenter: dist3(cA, cB) != null ? r2(dist3(cA, cB)!) : null,
      headToHead: dHeads != null ? r2(dHeads) : null,
      aWristR_to_bWristL: dRL != null ? r2(dRL) : null,
      aWristL_to_bWristR: dLR != null ? r2(dLR) : null,
      aWristR_to_bWristR: dRR != null ? r2(dRR) : null,
      aWristL_to_bWristL: dLL != null ? r2(dLL) : null,
      minWristPair: bestPair
        ? { pair: bestPair.pair, distUnits: r2(bestPair.d), distCm: r2(bestPair.d * 8) }
        : null,
    },
    issues,
  }
}

export function analyzeDuoSequence(
  actorA: DuoActorPrepared,
  actorB: DuoActorPrepared,
  sampleTimes?: number[]
): {
  durationSec: number
  maxFrame: number
  frames: DuoFrameMetrics[]
  allIssues: DuoIssue[]
  passed: boolean
} {
  const maxFrame = Math.max(actorA.maxFrame, actorB.maxFrame)
  const durationSec = r2(maxFrame / 30)

  let frameList: number[]
  const explicitSamples = Array.isArray(sampleTimes) && sampleTimes.length > 0
  if (explicitSamples) {
    frameList = [...new Set(sampleTimes.map((t) => Math.max(0, Math.min(maxFrame, Math.round(t * 30)))))].sort((a, b) => a - b)
  } else {
    frameList = []
    for (let f = 0; f <= maxFrame; f++) frameList.push(f)
  }

  const allFrames: DuoFrameMetrics[] = []
  const allIssues: DuoIssue[] = []
  for (const f of frameList) {
    const m = analyzeDuoFrame(actorA, actorB, f)
    if (m) {
      allFrames.push(m)
      allIssues.push(...m.issues)
    }
  }

  // Keep report compact on dense scans: up to 12 evenly spaced frames + up to 4 worst-issue frames (issues per frame capped at 8)
  let frames = allFrames
  if (!explicitSamples && allFrames.length > 16) {
    const kept = new Set<number>()
    for (let i = 0; i < 12; i++) kept.add(Math.round((i * (allFrames.length - 1)) / 11))
    const issueIndices = allFrames
      .map((m, idx) => ({ idx, cnt: m.issues.length }))
      .filter((x) => x.cnt > 0)
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 4)
    for (const x of issueIndices) kept.add(x.idx)
    frames = [...kept]
      .sort((a, b) => a - b)
      .map((idx) => {
        const m = allFrames[idx]
        return m.issues.length > 8 ? { ...m, issues: m.issues.slice(0, 8) } : m
      })
  }

  return {
    durationSec,
    maxFrame,
    frames,
    allIssues,
    passed: allIssues.length === 0,
  }
}
