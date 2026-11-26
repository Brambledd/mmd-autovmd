/**
 * duo-solver.ts — Joint Two-Person (Duo) MotionIntent Solver.
 *
 * Coordinates two characters in shared world space without duplicating single-actor
 * kinematics:
 *   1. Unified timeline (shared 30fps beat grid & contact-beat phase synchronization)
 *   2. Multi-pass collaborative solve (leadActor -> follower -> optional lead refinement)
 *   3. Dynamic per-frame `"partner:*"` hand targets & mutual contact constraints
 *      (`hold_hands`, `high_five`, `pat_shoulder`, `hand_on_waist`)
 *   4. Strictly opt-in dynamic gaze (`"partner:head"`, `"partner:hand_l/r"`, or `[x,y,z]`)
 *      with physiological neck clamp — never forces actors to stare at each other
 *   5. Cross-actor body hull injection into arm collision & cloth/hair Verlet physics
 *   6. Optional per-beat dynamic root movement (`placementA` / `placementB` via 全ての親)
 */

import { duoYawQuat, type DuoPlacement } from "./duo.ts"
import type { PmxBones } from "./pmx-bones.ts"
import type { RigProfile, V3 } from "./rig-profile.ts"
import {
  solveMotionIntent,
  type EffortStyle,
  type FkState,
  type MotionBeat,
  type MotionIntent,
  type RigSolveResult,
  type SceneObstacle,
  type WorldHull,
} from "./rig-solver.ts"

export type DuoPartnerPart =
  | "head"
  | "hand_l"
  | "hand_r"
  | "shoulder_l"
  | "shoulder_r"
  | "cheek_l"
  | "cheek_r"
  | "waist_l"
  | "waist_r"

export interface DuoContact {
  type: "hold_hands" | "high_five" | "pat_shoulder" | "hand_on_waist"
  from: { actor: "A" | "B"; hand: "l" | "r" }
  to: { actor: "A" | "B"; part: DuoPartnerPart }
  /** Blend weight 0..1 (default 1.0) */
  strength?: number
}

export interface DuoBeat {
  at: number
  effort?: EffortStyle
  passThrough?: boolean
  A?: Partial<MotionBeat>
  B?: Partial<MotionBeat>
  /** Optional dynamic root placement for Actor A at this beat (interpolated onto 全ての親) */
  placementA?: DuoPlacement
  /** Optional dynamic root placement for Actor B at this beat (interpolated onto 全ての親) */
  placementB?: DuoPlacement
  /** Declarative physical contact constraints active at this beat */
  contacts?: DuoContact[]
}

export interface DuoMotionIntent {
  title?: string
  fps?: number
  breathing?: boolean
  autoBlink?: boolean
  secondaryPhysics?: boolean
  /** Optional static scene collision capsules in shared duo world space */
  obstacles?: SceneObstacle[]
  actors: {
    A: { modelId?: string; pmxPath?: string; placement: DuoPlacement }
    B: { modelId?: string; pmxPath?: string; placement: DuoPlacement }
  }
  /** Actor solved first in Pass 1 (default "A") */
  leadActor?: "A" | "B"
  beats: DuoBeat[]
}

export interface DuoSolveActorInput {
  bones: PmxBones
  profile: RigProfile
  placement: DuoPlacement
}

export interface DuoSolveResult {
  actorA: RigSolveResult
  actorB: RigSolveResult
  durationSec: number
  frameCount: number
  syncContactTimes: number[]
  solveTimeMs: number
}

// ------------------------------------------------------------------ Math & Transform Helpers

const DEG = Math.PI / 180

function vAdd(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function vSub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function vScale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s] }
function vLen(a: V3): number { return Math.hypot(a[0], a[1], a[2]) }
function vNorm(a: V3): V3 {
  const l = vLen(a)
  return l > 1e-6 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1]
}

function rotateYaw(v: V3, yawDeg: number): V3 {
  const q = duoYawQuat(yawDeg)
  const ux = q.x, uy = q.y, uz = q.z, uw = q.w
  const ix = uw * v[0] + uy * v[2] - uz * v[1]
  const iy = uw * v[1] + uz * v[0] - ux * v[2]
  const iz = uw * v[2] + ux * v[1] - uy * v[0]
  const iw = -ux * v[0] - uy * v[1] - uz * v[2]
  return [
    ix * uw + iw * -ux + iy * -uz - iz * -uy,
    iy * uw + iw * -uy + iz * -ux - ix * -uz,
    iz * uw + iw * -uz + ix * -uy - iy * -ux,
  ]
}

function qMul(a: { x: number; y: number; z: number; w: number }, b: { x: number; y: number; z: number; w: number }) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

function localToWorld(pt: V3, p: DuoPlacement): V3 {
  return vAdd(rotateYaw(pt, p.yawDeg), p.offset)
}

function worldToLocal(pt: V3, p: DuoPlacement): V3 {
  return rotateYaw(vSub(pt, p.offset), -p.yawDeg)
}

function dirLocalToWorld(dir: V3, yawDeg: number): V3 {
  return vNorm(rotateYaw(dir, yawDeg))
}

function dirWorldToLocal(dir: V3, yawDeg: number): V3 {
  return vNorm(rotateYaw(dir, -yawDeg))
}

function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

function lerpPlacement(a: DuoPlacement, b: DuoPlacement, t: number): DuoPlacement {
  const s = smoothstep01(t)
  // Shortest angular path for yawDeg
  const dy = ((b.yawDeg - a.yawDeg + 540) % 360) - 180
  return {
    offset: [
      a.offset[0] + (b.offset[0] - a.offset[0]) * s,
      a.offset[1] + (b.offset[1] - a.offset[1]) * s,
      a.offset[2] + (b.offset[2] - a.offset[2]) * s,
    ],
    yawDeg: a.yawDeg + dy * s,
  }
}

// ------------------------------------------------------------------ Partner Part Resolution

const PARTNER_BONE_MAP: Record<DuoPartnerPart, { boneJp: string; localOffset: V3; localNormal: V3 }> = {
  head:       { boneJp: "頭",     localOffset: [0, 1.75, 0],       localNormal: [0, 1, 0] },
  hand_l:     { boneJp: "左手首", localOffset: [0, 0, 0],          localNormal: [1, 0, 0] },
  hand_r:     { boneJp: "右手首", localOffset: [0, 0, 0],          localNormal: [-1, 0, 0] },
  shoulder_l: { boneJp: "左腕",   localOffset: [0.25, 0.45, -0.10],localNormal: [0.45, 0.85, -0.25] },
  shoulder_r: { boneJp: "右腕",   localOffset: [-0.25, 0.45, -0.10],localNormal: [-0.45, 0.85, -0.25] },
  cheek_l:    { boneJp: "頭",     localOffset: [0.6, 0.3, -0.7],   localNormal: [0.6, 0, -0.8] },
  cheek_r:    { boneJp: "頭",     localOffset: [-0.6, 0.3, -0.7],  localNormal: [-0.6, 0, -0.8] },
  waist_l:    { boneJp: "上半身", localOffset: [1.3, 0.2, 0],      localNormal: [1, 0, 0] },
  waist_r:    { boneJp: "上半身", localOffset: [-1.3, 0.2, 0],     localNormal: [-1, 0, 0] },
}

function getPartnerPartWorld(
  part: DuoPartnerPart,
  partnerBones: PmxBones,
  partnerFk: FkState,
  partnerPlacement: DuoPlacement,
): { worldPos: V3; worldNormal: V3 } | null {
  const spec = PARTNER_BONE_MAP[part]
  if (!spec) return null
  const idx = partnerBones.indexByJp.get(spec.boneJp)
  if (idx == null) return null
  const bp = partnerFk.pos.get(idx)
  const br = partnerFk.rot.get(idx)
  if (!bp || !br) return null

  const rotOff = rotatePointByQuat(br, spec.localOffset)
  const rotNorm = rotatePointByQuat(br, spec.localNormal)
  const localPos = vAdd(bp, rotOff)
  return {
    worldPos: localToWorld(localPos, partnerPlacement),
    worldNormal: dirLocalToWorld(rotNorm, partnerPlacement.yawDeg),
  }
}

function rotatePointByQuat(q: { x: number; y: number; z: number; w: number }, v: V3): V3 {
  const ux = q.x, uy = q.y, uz = q.z, uw = q.w
  const ix = uw * v[0] + uy * v[2] - uz * v[1]
  const iy = uw * v[1] + uz * v[0] - ux * v[2]
  const iz = uw * v[2] + ux * v[1] - uy * v[0]
  const iw = -ux * v[0] - uy * v[1] - uz * v[2]
  return [
    ix * uw + iw * -ux + iy * -uz - iz * -uy,
    iy * uw + iw * -uy + iz * -ux - ix * -uz,
    iz * uw + iw * -uz + ix * -uy - iy * -ux,
  ]
}

// ------------------------------------------------------------------ Main Duo Solver

export function solveDuoMotionIntent(
  duoIntent: DuoMotionIntent,
  actorAInput: DuoSolveActorInput,
  actorBInput: DuoSolveActorInput,
): DuoSolveResult {
  const tStart = performance.now()
  if (duoIntent.fps != null && duoIntent.fps !== 30) {
    throw new Error(`VMD output requires fps=30 (got ${duoIntent.fps})`)
  }
  const fps = 30
  const beats = [...duoIntent.beats].sort((a, b) => a.at - b.at)
  if (beats.length === 0) throw new Error("DuoMotionIntent must contain at least one beat")

  const VALID_GAZE_PARTS = new Set(["head", "hand_l", "hand_r"])
  const VALID_CONTACT_TYPES = new Set(["hold_hands", "high_five", "pat_shoulder", "hand_on_waist"])
  for (const b of beats) {
    for (const sideKey of ["A", "B"] as const) {
      const sb = b[sideKey]
      if (!sb) continue
      for (const hKey of ["hand_l", "hand_r"] as const) {
        const tgt = sb[hKey]?.target
        if (typeof tgt === "string" && tgt.startsWith("partner:")) {
          const part = tgt.slice(8)
          if (!(part in PARTNER_BONE_MAP)) {
            throw new Error(`Unknown partner target "${tgt}" on ${sideKey}.${hKey}. Valid parts: ${Object.keys(PARTNER_BONE_MAP).join(", ")}`)
          }
        }
      }
      const gt = sb.gaze?.target
      if (typeof gt === "string" && gt.startsWith("partner:")) {
        const part = gt.slice(8)
        if (!VALID_GAZE_PARTS.has(part)) {
          throw new Error(`Unknown partner gaze target "${gt}" on ${sideKey}. Valid gaze parts: head, hand_l, hand_r`)
        }
      }
    }
    if (b.contacts) {
      for (const c of b.contacts) {
        if (!VALID_CONTACT_TYPES.has(c.type)) {
          throw new Error(`Unknown contact type "${c.type}". Valid types: ${[...VALID_CONTACT_TYPES].join(", ")}`)
        }
        if ((c.from?.actor !== "A" && c.from?.actor !== "B") || (c.to?.actor !== "A" && c.to?.actor !== "B")) {
          throw new Error(`Invalid contact actor in ${JSON.stringify(c)} (must be "A" or "B")`)
        }
        if (c.from?.hand !== "l" && c.from?.hand !== "r") {
          throw new Error(`Invalid contact hand "${c.from?.hand}" (must be "l" or "r")`)
        }
        if (!(c.to?.part in PARTNER_BONE_MAP)) {
          throw new Error(`Unknown contact target part "${c.to?.part}". Valid parts: ${Object.keys(PARTNER_BONE_MAP).join(", ")}`)
        }
      }
    }
  }

  const durationSec = Math.max(0.5, beats[beats.length - 1].at)
  const totalFrames = Math.max(1, Math.round(durationSec * fps))

  // Build synchronized single-actor MotionIntents sharing exact beat timestamps
  const toSingleIntent = (which: "A" | "B"): MotionIntent => {
    const pBase = which === "A" ? actorAInput.placement : actorBInput.placement
    const localObstacles = duoIntent.obstacles?.map((ob) => ({
      id: ob.id,
      a: worldToLocal(ob.a, pBase),
      b: worldToLocal(ob.b, pBase),
      radius: ob.radius,
    }))
    return {
      title: `${duoIntent.title ?? "Duo"} (${which})`,
      fps,
      breathing: duoIntent.breathing,
      autoBlink: duoIntent.autoBlink,
      secondaryPhysics: duoIntent.secondaryPhysics,
      ...(localObstacles ? { obstacles: localObstacles } : {}),
      beats: beats.map((b) => {
        const sideBeat = b[which] ?? {}
        return {
          at: b.at,
          effort: sideBeat.effort ?? b.effort ?? "soft",
          passThrough: sideBeat.passThrough ?? b.passThrough,
          stance: sideBeat.stance,
          spine: sideBeat.spine,
          hand_l: sideBeat.hand_l,
          hand_r: sideBeat.hand_r,
          gaze: sideBeat.gaze,
          face: sideBeat.face,
        }
      }),
    }
  }

  const intentA = toSingleIntent("A")
  const intentB = toSingleIntent("B")

  // Collect timestamps where mutual contacts are active to lock Lead & Follow sync
  const syncContactTimes = beats
    .filter((b) => Array.isArray(b.contacts) && b.contacts.length > 0)
    .map((b) => b.at)

  // Per-frame placement evaluator (supports static or beat-interpolated dynamic walking)
  const hasDynamicPlacementA = beats.some((b) => b.placementA != null)
  const hasDynamicPlacementB = beats.some((b) => b.placementB != null)

  const evalPlacement = (which: "A" | "B", timeSec: number): DuoPlacement => {
    const base = which === "A" ? actorAInput.placement : actorBInput.placement
    const hasDyn = which === "A" ? hasDynamicPlacementA : hasDynamicPlacementB
    if (!hasDyn) return base
    const key = which === "A" ? "placementA" : "placementB"
    let prevT = 0, prevP = beats[0][key] ?? base
    for (let i = 0; i < beats.length; i++) {
      const bp = beats[i][key]
      if (!bp) continue
      if (beats[i].at >= timeSec) {
        if (beats[i].at <= prevT + 1e-4) return bp
        return lerpPlacement(prevP, bp, (timeSec - prevT) / (beats[i].at - prevT))
      }
      prevT = beats[i].at
      prevP = bp
    }
    return prevP
  }

  const rootLocalTransformFor = (which: "A" | "B") => {
    const hasDyn = which === "A" ? hasDynamicPlacementA : hasDynamicPlacementB
    if (!hasDyn) return undefined
    const base = which === "A" ? actorAInput.placement : actorBInput.placement
    return (_frame: number, timeSec: number) => {
      const cur = evalPlacement(which, timeSec)
      const deltaWorld = vSub(cur.offset, base.offset)
      const localPos = rotateYaw(deltaWorld, -base.yawDeg)
      return { pos: localPos, yawDeg: cur.yawDeg - base.yawDeg }
    }
  }

  // Recorded FK & Hulls from previous pass
  type FrameCache = { fk: FkState; hulls: WorldHull[] }
  const cacheA = new Map<number, FrameCache>()
  const cacheB = new Map<number, FrameCache>()

  // Note: fk & worldHulls from rig-solver already include dynamic 全ての親 relative to static base placement!
  const buildPartnerHullsInSelfLocal = (
    partnerCache: Map<number, FrameCache>,
    partnerWhich: "A" | "B",
    selfWhich: "A" | "B",
    frame: number,
  ): WorldHull[] => {
    const rec = partnerCache.get(frame)
    if (!rec) return []
    const partnerBones = partnerWhich === "A" ? actorAInput.bones : actorBInput.bones
    const pPartner = partnerWhich === "A" ? actorAInput.placement : actorBInput.placement
    const pSelf = selfWhich === "A" ? actorAInput.placement : actorBInput.placement
    const qRel = duoYawQuat(pPartner.yawDeg - pSelf.yawDeg)
    const out: WorldHull[] = rec.hulls.map((h) => ({
      id: `partner_${h.id}`,
      bonePos: worldToLocal(localToWorld(h.bonePos, pPartner), pSelf),
      boneRot: qMul(qRel, h.boneRot),
      a: worldToLocal(localToWorld(h.a, pPartner), pSelf),
      b: worldToLocal(localToWorld(h.b, pPartner), pSelf),
      radiusA: h.radiusA,
      radiusB: h.radiusB,
      slices: h.slices,
    }))
    // Also inject partner upper-arm capsules using real sleeve-aware radii from RigProfile
    const partnerProfile = partnerWhich === "A" ? actorAInput.profile : actorBInput.profile
    const idZero = { x: 0, y: 0, z: 0, w: 1 }
    for (const side of ["左", "右"] as const) {
      const sKey = side === "左" ? "l" : "r"
      const upperR = partnerProfile.arms[sKey]?.upperArmRadius ?? 0.56
      const foreR = partnerProfile.arms[sKey]?.forearmRadius ?? 0.46
      const armIdx = partnerBones.indexByJp.get(`${side}腕`)
      const elbIdx = partnerBones.indexByJp.get(`${side}ひじ`)
      if (armIdx != null && elbIdx != null) {
        const aPos = rec.fk.pos.get(armIdx)
        const ePos = rec.fk.pos.get(elbIdx)
        if (aPos && ePos) {
          const aLoc = worldToLocal(localToWorld(aPos, pPartner), pSelf)
          const bLoc = worldToLocal(localToWorld(ePos, pPartner), pSelf)
          out.push({
            id: `partner_upper_${sKey}`,
            bonePos: aLoc,
            boneRot: idZero,
            a: aLoc,
            b: bLoc,
            radiusA: upperR,
            radiusB: foreR,
          })
        }
      }
    }
    return out
  }

  // Sample active duo beat pair at timeSec (handles timeSec < beats[0].at cleanly)
  const sampleDuoBeat = (timeSec: number) => {
    const tClamped = Math.max(0, Math.min(durationSec, timeSec))
    if (tClamped <= beats[0].at) {
      return { a: beats[0], b: beats[0], t: 0 }
    }
    for (let i = 0; i < beats.length - 1; i++) {
      if (tClamped >= beats[i].at && tClamped <= beats[i + 1].at) {
        const span = Math.max(1e-4, beats[i + 1].at - beats[i].at)
        return { a: beats[i], b: beats[i + 1], t: smoothstep01((tClamped - beats[i].at) / span) }
      }
    }
    const last = beats[beats.length - 1]
    return { a: last, b: last, t: 1 }
  }

  // Build hooks for a given actor reading the partner's cached FK (using static base placements since FK already includes 全ての親)
  const makePartnerHooks = (selfWhich: "A" | "B") => {
    const partnerWhich: "A" | "B" = selfWhich === "A" ? "B" : "A"
    const partnerCache = partnerWhich === "A" ? cacheA : cacheB
    const partnerBones = partnerWhich === "A" ? actorAInput.bones : actorBInput.bones
    const selfInput = selfWhich === "A" ? actorAInput : actorBInput
    const pSelf = selfWhich === "A" ? actorAInput.placement : actorBInput.placement
    const pPartner = partnerWhich === "A" ? actorAInput.placement : actorBInput.placement

    const resolveDynamicHand = (frame: number, side: "l" | "r", timeSec: number, beatAtSec?: number) => {
      const pRec = partnerCache.get(frame)
      if (!pRec) return null
      const { a, b, t } = sampleDuoBeat(timeSec)
      // When called for a specific beat endpoint (resPrev/resA/resB/resNext), evaluate ONLY that beat
      // so rest->partner transitions interpolate smoothly along the outward-upward detour arc!
      const refBeat = beatAtSec != null
        ? (beats.find((bt) => Math.abs(bt.at - beatAtSec) < 1e-4) ?? b)
        : null

      // 1) Check declarative contacts
      const findContact = (bt: DuoBeat) =>
        bt.contacts?.find((c) => c.from.actor === selfWhich && c.from.hand === side) ??
        bt.contacts?.find((c) => (c.type === "hold_hands" || c.type === "high_five") && c.to.actor === selfWhich && c.to.part === `hand_${side}`)
      const activeC = refBeat ? findContact(refBeat) : (findContact(b) ?? findContact(a))
      if (activeC) {
        const wContact = refBeat
          ? (activeC.strength ?? 1.0)
          : ((findContact(a) && findContact(b) ? 1.0 : findContact(b) ? t : 1 - t) * (activeC.strength ?? 1.0))
        if (wContact > 0.25) {
          const isMutualHand = activeC.type === "hold_hands" || activeC.type === "high_five"
          const targetPart: DuoPartnerPart = activeC.from.actor === selfWhich
            ? activeC.to.part
            : (`hand_${activeC.from.hand}` as DuoPartnerPart)
          const pInfo = getPartnerPartWorld(targetPart, partnerBones, pRec.fk, pPartner)
          if (pInfo) {
            let worldTarget = pInfo.worldPos
            let worldNormal = pInfo.worldNormal
            if (isMutualHand) {
              // Meet at midpoint between self shoulder/front-ready & partner hand, with opposing palm normals
              const selfWristJp = side === "l" ? "左手首" : "右手首"
              const selfArmJp = side === "l" ? "左腕" : "右腕"
              const swIdx = selfInput.bones.indexByJp.get(selfWristJp)
              const saIdx = selfInput.bones.indexByJp.get(selfArmJp)
              const selfCache = (selfWhich === "A" ? cacheA : cacheB).get(frame)
              const selfWristLocal = selfCache && swIdx != null ? selfCache.fk.pos.get(swIdx) : undefined
              const selfArmLocal = selfCache && saIdx != null ? selfCache.fk.pos.get(saIdx) : undefined
              const selfRefWorld = selfWristLocal
                ? localToWorld(selfWristLocal, pSelf)
                : selfArmLocal
                  ? localToWorld(vAdd(selfArmLocal, [0, -1.5, -2.5]), pSelf)
                  : pInfo.worldPos
              worldTarget = vAdd(vScale(pInfo.worldPos, 0.72), vScale(selfRefWorld, 0.28))
              const toSelf = vSub(pSelf.offset, pPartner.offset)
              worldNormal = vNorm(toSelf[0] === 0 && toSelf[2] === 0 ? [0, 0, -1] : [toSelf[0], 0, toSelf[2]])
            }
            return {
              localTarget: worldToLocal(worldTarget, pSelf),
              localNormal: dirWorldToLocal(worldNormal, pSelf.yawDeg),
              palmMode: "surface",
              endEffector: "palm" as const,
            }
          }
        }
      }

      // 2) Check explicit "partner:*" hand target on beat
      const hA = a[selfWhich]?.[side === "l" ? "hand_l" : "hand_r"]
      const hB = b[selfWhich]?.[side === "l" ? "hand_l" : "hand_r"]
      const pickTarget = (h: MotionBeat["hand_l"] | undefined) =>
        typeof h?.target === "string" && h.target.startsWith("partner:") ? h.target.slice(8) as DuoPartnerPart : null
      if (refBeat) {
        const pRef = pickTarget(refBeat[selfWhich]?.[side === "l" ? "hand_l" : "hand_r"])
        if (!pRef) return null
        const infoRef = getPartnerPartWorld(pRef, partnerBones, pRec.fk, pPartner)
        if (!infoRef) return null
        return {
          localTarget: worldToLocal(infoRef.worldPos, pSelf),
          localNormal: dirWorldToLocal(infoRef.worldNormal, pSelf.yawDeg),
          palmMode: "surface",
          endEffector: (pRef === "cheek_l" || pRef === "cheek_r") ? "fingertip" as const : "palm" as const,
        }
      }
      const pA = pickTarget(hA)
      const pB = pickTarget(hB)
      if (!pA && !pB) return null

      const infoA = pA ? getPartnerPartWorld(pA, partnerBones, pRec.fk, pPartner) : null
      const infoB = pB ? getPartnerPartWorld(pB, partnerBones, pRec.fk, pPartner) : null
      let wPos: V3 | null = null
      let wNorm: V3 | null = null
      if (infoA && infoB) {
        wPos = vAdd(vScale(infoA.worldPos, 1 - t), vScale(infoB.worldPos, t))
        wNorm = vNorm(vAdd(vScale(infoA.worldNormal, 1 - t), vScale(infoB.worldNormal, t)))
      } else if (infoB) {
        wPos = infoB.worldPos; wNorm = infoB.worldNormal
      } else if (infoA) {
        wPos = infoA.worldPos; wNorm = infoA.worldNormal
      }
      if (!wPos) return null
      return {
        localTarget: worldToLocal(wPos, pSelf),
        localNormal: wNorm ? dirWorldToLocal(wNorm, pSelf.yawDeg) : undefined,
        palmMode: "surface",
        endEffector: (pA === "cheek_l" || pA === "cheek_r" || pB === "cheek_l" || pB === "cheek_r") ? "fingertip" as const : "palm" as const,
      }
    }

    const resolveDynamicGaze = (frame: number, headLocalPos: V3, timeSec: number) => {
      const { a, b, t } = sampleDuoBeat(timeSec)
      const gA = a[selfWhich]?.gaze?.target
      const gB = b[selfWhich]?.gaze?.target
      const isDynGaze = (g: unknown): g is string | V3 =>
        Array.isArray(g) || (typeof g === "string" && g.startsWith("partner:"))
      if (!isDynGaze(gA) && !isDynGaze(gB)) return null

      const pRec = partnerCache.get(frame)

      const resolveGazeWorld = (g: string | V3 | undefined): V3 | null => {
        if (Array.isArray(g)) return g
        if (typeof g === "string" && g.startsWith("partner:") && pRec) {
          const part = g.slice(8) as DuoPartnerPart
          if (part === "head") {
            const hIdx = partnerBones.indexByJp.get("頭")
            const hp = hIdx != null ? pRec.fk.pos.get(hIdx) : undefined
            const hq = hIdx != null ? pRec.fk.rot.get(hIdx) : undefined
            if (hp && hq) return localToWorld(vAdd(hp, rotatePointByQuat(hq, [0, 0.9, 0])), pPartner)
          }
          return getPartnerPartWorld(part, partnerBones, pRec.fk, pPartner)?.worldPos ?? null
        }
        return null
      }

      const wA = isDynGaze(gA) ? resolveGazeWorld(gA) : null
      const wB = isDynGaze(gB) ? resolveGazeWorld(gB) : null
      const wTarget = wA && wB
        ? vAdd(vScale(wA, 1 - t), vScale(wB, t))
        : (wB ?? wA)
      if (!wTarget) return null

      // Convert target world pos into head's current local space (accounting for 全ての親 rootDyn!)
      const pSelfDyn = evalPlacement(selfWhich, timeSec)
      const localTgt = worldToLocal(wTarget, pSelfDyn)
      const headInBaseWorld = localToWorld(headLocalPos, pSelf)
      const headInDynLocal = worldToLocal(headInBaseWorld, pSelfDyn)
      const dx = localTgt[0] - headInDynLocal[0]
      const dy = localTgt[1] - headInDynLocal[1]
      const dz = localTgt[2] - headInDynLocal[2]
      const horiz = Math.hypot(dx, dz)
      if (horiz < 1e-4) return null
      // MMD fk qRotate(+deg Y, [0,0,-1]) turns toward -X, and +deg X turns toward +Y
      const yawDeg = Math.atan2(-dx, -dz) / DEG
      const pitchDeg = Math.atan2(dy, horiz) / DEG
      return { headYawDeg: yawDeg, headPitchDeg: pitchDeg }
    }

    return {
      externalWorldHulls: (frame: number) =>
        buildPartnerHullsInSelfLocal(partnerCache, partnerWhich, selfWhich, frame),
      overrideHandTarget: resolveDynamicHand,
      overrideGaze: resolveDynamicGaze,
      rootLocalTransform: rootLocalTransformFor(selfWhich),
      syncContactTimes,
    }
  }

  const lead = duoIntent.leadActor ?? "A"
  const follower: "A" | "B" = lead === "A" ? "B" : "A"

  const needsPartnerRef = (which: "A" | "B") =>
    beats.some((b) => {
      const sb = b[which]
      const hasHandPartner =
        (typeof sb?.hand_l?.target === "string" && sb.hand_l.target.startsWith("partner:")) ||
        (typeof sb?.hand_r?.target === "string" && sb.hand_r.target.startsWith("partner:"))
      const hasGazePartner =
        Array.isArray(sb?.gaze?.target) ||
        (typeof sb?.gaze?.target === "string" && sb.gaze.target.startsWith("partner:"))
      const hasContact = b.contacts?.some((c) => c.from.actor === which || c.to.actor === which)
      return Boolean(hasHandPartner || hasGazePartner || hasContact)
    })

  // Pass 1: Solve leadActor
  const leadInput = lead === "A" ? actorAInput : actorBInput
  const leadIntent = lead === "A" ? intentA : intentB
  const leadCache = lead === "A" ? cacheA : cacheB
  let resLead = solveMotionIntent(leadIntent, leadInput.profile, leadInput.bones, {
    rootLocalTransform: rootLocalTransformFor(lead),
    syncContactTimes,
    onFrameSolved: (frame, fk, hulls) => leadCache.set(frame, { fk, hulls }),
  })

  // Pass 2: Solve follower with leadActor's FK & hulls
  const folInput = follower === "A" ? actorAInput : actorBInput
  const folIntent = follower === "A" ? intentA : intentB
  const folCache = follower === "A" ? cacheA : cacheB
  const folHooks = makePartnerHooks(follower)
  const resFol = solveMotionIntent(folIntent, folInput.profile, folInput.bones, {
    ...folHooks,
    onFrameSolved: (frame, fk, hulls) => folCache.set(frame, { fk, hulls }),
  })

  // Pass 3: Re-solve leadActor if it also references partner or participates in mutual contacts
  if (needsPartnerRef(lead)) {
    const leadHooks = makePartnerHooks(lead)
    resLead = solveMotionIntent(leadIntent, leadInput.profile, leadInput.bones, {
      ...leadHooks,
      onFrameSolved: (frame, fk, hulls) => leadCache.set(frame, { fk, hulls }),
    })
  }

  return {
    actorA: lead === "A" ? resLead : resFol,
    actorB: lead === "B" ? resLead : resFol,
    durationSec,
    frameCount: totalFrames + 1,
    syncContactTimes,
    solveTimeMs: Number((performance.now() - tStart).toFixed(1)),
  }
}
