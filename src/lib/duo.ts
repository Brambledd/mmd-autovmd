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
  code: "torso_clipping" | "head_clipping" | "hand_inside_partner"
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
      if (dh < partnerHeadR * 0.65) {
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
  if (Array.isArray(sampleTimes) && sampleTimes.length > 0) {
    frameList = [...new Set(sampleTimes.map((t) => Math.max(0, Math.min(maxFrame, Math.round(t * 30)))))].sort((a, b) => a - b)
  } else {
    const count = Math.min(8, Math.max(2, Math.ceil(maxFrame / 15) + 1))
    frameList = []
    for (let i = 0; i < count; i++) {
      frameList.push(Math.round((i * maxFrame) / Math.max(1, count - 1)))
    }
    frameList = [...new Set(frameList)]
  }

  const frames: DuoFrameMetrics[] = []
  const allIssues: DuoIssue[] = []
  for (const f of frameList) {
    const m = analyzeDuoFrame(actorA, actorB, f)
    if (m) {
      frames.push(m)
      allIssues.push(...m.issues)
    }
  }

  return {
    durationSec,
    maxFrame,
    frames,
    allIssues,
    passed: allIssues.length === 0,
  }
}
