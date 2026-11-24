/**
 * Pose auditor — Phase 2 collision pre-check with automatic relaxation.
 *
 * Runs AFTER the MPL compiler and BEFORE the Phase 1 enhancer:
 *   compile → auditVmd (this file) → enhanceVmd → engine
 *
 * How it works:
 *  1. Parses the compiled VMD (track per bone) and the PMX skeleton (rest
 *     positions + hierarchy, from parsePmxBones).
 *  2. For every distinct keyframe, evaluates MMD forward kinematics
 *     (step evaluation: each bone holds its latest key ≤ t; identity outside).
 *  3. Builds capsule proxies from the posed skeleton — torso, head, thighs,
 *     shins (radii derived from REST bone lengths, so they scale with the
 *     model automatically) — and tests the movers (hands, elbows) against
 *     the classic clipping pairs: hand-vs-torso/head/opposite-leg,
 *     elbow-vs-torso. Hand-vs-own-thigh is deliberately excluded: resting a
 *     hand on your own lap is a pose, not a bug.
 *  4. When a mover penetrates a capsule, the relaxer binary-searches the
 *     largest scale s ∈ [minScale, 1] that clears the violation when the
 *     mover's whole kinematic chain (wrist→elbow→arm→shoulder) is pulled
 *     toward rest by s. This keeps poses plausible instead of rejecting them.
 *     Same-side physics (skirts) is not simulated: cloth clipping needs the
 *     engine, this layer only guards the FK skeleton.
 *
 * Robustness contract: like the enhancer, this is a safety layer — any
 * anomaly returns the input unchanged.
 */

import { parseVmd, serializeVmd, quatSlerp } from "./vmd-enhancer.ts"
import type { BoneKey, ParsedVmd, Quat } from "./vmd-enhancer.ts"
import type { PmxBones } from "./pmx-bones.ts"
import { detectPosSemantics } from "./model-geometry.ts"

export interface AuditOptions {
  /** Global multiplier on every capsule/point radius. Default 1. */
  radiiScale?: number
  /** Smallest chain-relaxation scale the fixer will apply. Default 0.35. */
  minScale?: number
  /** Binary-search iterations for the fixer. Default 9. */
  relaxIterations?: number
}

export interface Violation {
  frame: number
  mover: string
  target: string
  /** How deep the point sits inside the capsule, in model units. */
  depth: number
}

export interface ChainFix {
  frame: number
  chain: string[]
  scale: number
}

export interface AuditResult {
  vmd: Uint8Array
  checkedFrames: number
  /** All violations detected before any fix. */
  violations: Violation[]
  /** Relaxations applied, largest scale first per frame. */
  fixed: ChainFix[]
  /** Violations the relaxer could not clear (chain would be destroyed). */
  unresolved: Violation[]
}

type V3 = [number, number, number]

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }
const ZERO: V3 = [0, 0, 0]

// ------------------------------------------------------------- vector math

function vAdd(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function vSub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function vLen(a: V3): number {
  return Math.hypot(a[0], a[1], a[2])
}

/** Rotate vector v by quaternion q. */
function vRotate(v: V3, q: Quat): V3 {
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (q.y * v[2] - q.z * v[1])
  const ty = 2 * (q.z * v[0] - q.x * v[2])
  const tz = 2 * (q.x * v[1] - q.y * v[0])
  return [
    v[0] + q.w * tx + (q.y * tz - q.z * ty),
    v[1] + q.w * ty + (q.z * tx - q.x * tz),
    v[2] + q.w * tz + (q.x * ty - q.y * tx),
  ]
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** Squared distance from point p to segment ab. */
function distPointSegmentSq(p: V3, a: V3, b: V3): number {
  const ab = vSub(b, a)
  const ab2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
  const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ab2))
  const dx = p[0] - (a[0] + ab[0] * t)
  const dy = p[1] - (a[1] + ab[1] * t)
  const dz = p[2] - (a[2] + ab[2] * t)
  return dx * dx + dy * dy + dz * dz
}

// -------------------------------------------------------------- capsule set

interface Capsule {
  key: string
  a: V3
  b: V3
  r: number
}

interface Skeleton {
  /** jp -> world position for every PMX bone at the current frame. */
  world: Map<number, V3>
  /** jp -> accumulated world rotation (children need the parent's, not this bone's). */
  rot: Map<number, Quat>
}

interface CapsuleKit {
  capsules: Capsule[]
  points: { key: string; jp: string; r: number }[]
}

const TORSO = "torso"
const CHEST = "chest"
const HEAD = "head"

const PAIRS: { mover: string; rKind: "hand" | "elbow"; targets: string[] }[] = [
  { mover: "左手首", rKind: "hand", targets: [TORSO, CHEST, HEAD, "thighR", "shinR"] },
  { mover: "右手首", rKind: "hand", targets: [TORSO, CHEST, HEAD, "thighL", "shinL"] },
  { mover: "左ひじ", rKind: "elbow", targets: [TORSO, CHEST] },
  { mover: "右ひじ", rKind: "elbow", targets: [TORSO, CHEST] },
]

const CHAINS: Record<string, string[]> = {
  左手首: ["左手首", "左ひじ", "左腕", "左肩"],
  右手首: ["右手首", "右ひじ", "右腕", "右肩"],
  左ひじ: ["左ひじ", "左腕", "左肩"],
  右ひじ: ["右ひじ", "右腕", "右肩"],
}

/** Rest-length based radii — anatomically proportional to slender MMD figures. */
const RADIUS_FACTORS = {
  torso: 0.24, // × rest |下半身→首|
  head: 0.45, // × rest |首→頭|
  thigh: 0.18, // × rest |足→ひざ| (~0.95u on Topaz, prevents false thigh traps when reaching shoes)
  shin: 0.13, // × rest |ひざ→足首| (~0.70u on Topaz, allows both hands near shoe without wrecking reach)
  hand: 0.16, // × rest |ひじ→手首|
  elbow: 0.18, // × rest |腕→ひじ|
}

const SEG_BONES = {
  torso: ["下半身", "首"] as const,
  head: ["首", "頭"] as const,
  thighL: ["左足", "左ひざ"] as const,
  shinL: ["左ひざ", "左足首"] as const,
  thighR: ["右足", "右ひざ"] as const,
  shinR: ["右ひざ", "右足首"] as const,
}

// ------------------------------------------------------------------- FK

interface TrackSet {
  keys: BoneKey[] // sorted by frame
}

function stepEval(track: TrackSet | undefined, frame: number): BoneKey | null {
  if (!track || track.keys.length === 0) return null
  let hit: BoneKey | null = null
  for (const k of track.keys) {
    if (k.frame <= frame) hit = k
    else break
  }
  return hit
}

function quatConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w }
}

function buildSkeleton(bones: PmxBones, tracks: Map<string, TrackSet>, frame: number, overrides: Map<string, Quat> | null): Skeleton {
  const world = new Map<number, V3>()
  const rot = new Map<number, Quat>()
  const localCache = new Map<number, Quat>()
  const visiting = new Set<number>()
  const resolvingGrant = new Set<number>()
  const semantics = detectPosSemantics(bones)

  const localRotOf = (i: number): Quat => {
    const cached = localCache.get(i)
    if (cached) return cached
    if (resolvingGrant.has(i)) return IDENTITY
    resolvingGrant.add(i)
    const b = bones.bones[i]
    const key = stepEval(tracks.get(b.jp), frame)
    let own = overrides?.get(b.jp) ?? key?.quat ?? IDENTITY
    const g = b.grant
    if (g && g.rotate && (g.ratio === 1 || g.ratio === -1) && g.parent >= 0 && g.parent < bones.bones.length) {
      const src = localRotOf(g.parent)
      own = g.ratio === 1 ? quatMul(own, src) : quatMul(own, quatConj(src))
    }
    resolvingGrant.delete(i)
    localCache.set(i, own)
    return own
  }

  const evalBone = (i: number): void => {
    if (world.has(i)) return
    if (visiting.has(i)) {
      // cyclic hierarchy (malformed PMX): emit identity placement
      world.set(i, ZERO)
      rot.set(i, IDENTITY)
      return
    }
    visiting.add(i)
    const b = bones.bones[i]
    let parentPos: V3 = ZERO
    let parentRot = IDENTITY
    if (b.parent >= 0 && b.parent < bones.bones.length) {
      evalBone(b.parent)
      parentPos = world.get(b.parent) ?? ZERO
      parentRot = rot.get(b.parent) ?? IDENTITY
    }
    visiting.delete(i)

    const key = stepEval(tracks.get(b.jp), frame)
    const localQ = localRotOf(i)
    const localP: V3 = key?.pos ?? ZERO
    const off: V3 =
      semantics === "absolute" && b.parent >= 0
        ? vSub(b.pos, bones.bones[b.parent].pos)
        : b.pos
    const worldPos = vAdd(parentPos, vRotate(vAdd(off, localP), parentRot))
    const worldRot = quatMul(parentRot, localQ)
    world.set(i, worldPos)
    rot.set(i, worldRot)
  }

  for (let i = 0; i < bones.bones.length; i++) evalBone(i)
  return { world, rot }
}

function bonePos(skel: Skeleton, bones: PmxBones, jp: string): V3 | null {
  const i = bones.indexByJp.get(jp)
  if (i === undefined) return null
  return skel.world.get(i) ?? null
}

/**
 * Test/introspection hook: world position of every PMX bone at `frame` under
 * the VMD keys in `boneKeys` (step evaluation). With identity/empty keys this
 * must reproduce the PMX rest positions exactly.
 */
export function skeletonAt(bones: PmxBones, boneKeys: BoneKey[], frame: number, overrides?: Map<string, Quat>): Map<string, V3> {
  const tracks = new Map<string, TrackSet>()
  for (const k of boneKeys) {
    let t = tracks.get(k.jp)
    if (!t) {
      t = { keys: [] }
      tracks.set(k.jp, t)
    }
    t.keys.push(k)
  }
  for (const t of tracks.values()) t.keys.sort((a, b) => a.frame - b.frame)
  const skel = buildSkeleton(bones, tracks, frame, overrides ?? null)
  const out = new Map<string, V3>()
  for (const [i, p] of skel.world) out.set(bones.bones[i].jp, p)
  return out
}

function restLen(bones: PmxBones, a: string, b: string): number {
  const ia = bones.indexByJp.get(a)
  const ib = bones.indexByJp.get(b)
  if (ia === undefined || ib === undefined) return 0
  return vLen(vSub(bones.bones[ia].pos, bones.bones[ib].pos))
}

function buildCapsuleKit(skel: Skeleton, bones: PmxBones, radiiScale: number): CapsuleKit {
  const capsules: Capsule[] = []
  const seg = (key: string, names: readonly [string, string], factor: number) => {
    const a = bonePos(skel, bones, names[0])
    const b = bonePos(skel, bones, names[1])
    const rest = restLen(bones, names[0], names[1])
    if (a && b && rest > 0) capsules.push({ key, a, b, r: factor * rest * radiiScale })
  }
  seg(TORSO, SEG_BONES.torso, RADIUS_FACTORS.torso)
  // Real chest hull from PMX vertex envelope (captures forward chest protrusion on Topaz)
  const upper2Idx = bones.indexByJp.get("上半身2")
  const upper2Env = bones.envelopes?.["上半身2"]
  if (upper2Idx != null && upper2Env) {
    const uPos = skel.world.get(upper2Idx)
    const uRot = skel.rot.get(upper2Idx)
    if (uPos && uRot) {
      const rest = bones.bones[upper2Idx].pos
      const frontZ = Math.min(-0.4, (upper2Env.min[2] - rest[2]) * 0.55)
      const halfW = Math.max(0.45, Math.min(0.85, (upper2Env.max[0] - upper2Env.min[0]) * 0.25))
      const aLocal: V3 = [-halfW, 0.85, frontZ]
      const bLocal: V3 = [halfW, 0.85, frontZ]
      const rChest = Math.max(0.35, Math.abs(upper2Env.min[2] - rest[2]) * 0.34) * radiiScale
      capsules.push({
        key: CHEST,
        a: vAdd(uPos, vRotate(aLocal, uRot)),
        b: vAdd(uPos, vRotate(bLocal, uRot)),
        r: rChest,
      })
    }
  }
  seg(HEAD, SEG_BONES.head, RADIUS_FACTORS.head)
  seg("thighL", SEG_BONES.thighL, RADIUS_FACTORS.thigh)
  seg("shinL", SEG_BONES.shinL, RADIUS_FACTORS.shin)
  seg("thighR", SEG_BONES.thighR, RADIUS_FACTORS.thigh)
  seg("shinR", SEG_BONES.shinR, RADIUS_FACTORS.shin)

  const points: CapsuleKit["points"] = []
  const point = (key: string, jp: string, lenPair: readonly [string, string], factor: number) => {
    const rest = restLen(bones, lenPair[0], lenPair[1])
    if (rest > 0) points.push({ key, jp, r: factor * rest * radiiScale })
  }
  point("handL", "左手首", ["左ひじ", "左手首"], RADIUS_FACTORS.hand)
  point("handR", "右手首", ["右ひじ", "右手首"], RADIUS_FACTORS.hand)
  point("elbowL", "左ひじ", ["左腕", "左ひじ"], RADIUS_FACTORS.elbow)
  point("elbowR", "右ひじ", ["右腕", "右ひじ"], RADIUS_FACTORS.elbow)

  return { capsules, points }
}

// ------------------------------------------------------------------ audit

function checkFrame(
  frame: number,
  bones: PmxBones,
  tracks: Map<string, TrackSet>,
  radiiScale: number,
  overrides: Map<string, Quat> | null
): Violation[] {
  // Skeleton AND capsules are rebuilt per call: with chain overrides applied,
  // torso/head/leg capsules move too, so targets must re-pose each iteration.
  const skel = buildSkeleton(bones, tracks, frame, overrides)
  const cap = buildCapsuleKit(skel, bones, radiiScale)
  const out: Violation[] = []
  for (const pair of PAIRS) {
    const p = cap.points.find((x) => x.jp === pair.mover)
    if (!p) continue
    const pos = bonePos(skel, bones, pair.mover)
    if (!pos) continue
    for (const t of pair.targets) {
      const c = cap.capsules.find((x) => x.key === t)
      if (!c) continue
      const rSum = p.r + c.r
      const d2 = distPointSegmentSq(pos, c.a, c.b)
      const slack = rSum * 0.96 // 4% tolerance before calling it a hit
      if (d2 < slack * slack) {
        out.push({ frame, mover: pair.mover, target: t, depth: rSum - Math.sqrt(d2) })
      }
    }
  }
  return out
}

function withDefaultsAudit(opts?: AuditOptions): Required<AuditOptions> {
  return {
    radiiScale: opts?.radiiScale ?? 1,
    minScale: opts?.minScale ?? 0.35,
    relaxIterations: opts?.relaxIterations ?? 9,
  }
}

export function auditVmd(vmd: Uint8Array, bones: PmxBones, opts?: AuditOptions): AuditResult {
  const empty: AuditResult = { vmd, checkedFrames: 0, violations: [], fixed: [], unresolved: [] }
  try {
    const parsed: ParsedVmd | null = parseVmd(vmd)
    if (!parsed) return empty
    const cfg = withDefaultsAudit(opts)

    // Group keys per bone (sorted); keep object identity so fixes mutate in place.
    const tracks = new Map<string, TrackSet>()
    for (const k of parsed.boneKeys) {
      let t = tracks.get(k.jp)
      if (!t) {
        t = { keys: [] }
        tracks.set(k.jp, t)
      }
      t.keys.push(k)
    }
    for (const t of tracks.values()) t.keys.sort((a, b) => a.frame - b.frame)

    const frames = [...new Set(parsed.boneKeys.map((k) => k.frame))].sort((a, b) => a - b)

    const allViolations: Violation[] = []
    const fixed: ChainFix[] = []
    const unresolved: Violation[] = []

    for (const f of frames) {
      const hits = checkFrame(f, bones, tracks, cfg.radiiScale, null)
      if (hits.length === 0) continue
      allViolations.push(...hits)

      // Fix per mover, deepest first.
      const byMover = new Map<string, Violation>()
      for (const h of hits) {
        const prev = byMover.get(h.mover)
        if (!prev || h.depth > prev.depth) byMover.set(h.mover, h)
      }
      for (const [mover] of byMover) {
        const chainJps = CHAINS[mover] ?? []
        const chainKeys: BoneKey[] = []
        for (const jp of chainJps) {
          const k = tracks.get(jp)?.keys.find((x) => x.frame === f)
          if (k) chainKeys.push(k)
        }
        if (chainKeys.length === 0) {
          unresolved.push(byMover.get(mover)!)
          continue
        }
        const originals = chainKeys.map((k) => k.quat)

        // Binary search the LARGEST pull-back scale that clears this mover's
        // violations: clear(s) → try larger; blocked → go smaller.
        let lo = cfg.minScale
        let hi = 1
        let best: number | null = null
        for (let it = 0; it < cfg.relaxIterations; it++) {
          const mid = (lo + hi) / 2
          const ov = new Map<string, Quat>()
          chainKeys.forEach((k, i) => ov.set(k.jp, quatSlerp(IDENTITY, originals[i], mid)))
          const cleared = !checkFrame(f, bones, tracks, cfg.radiiScale, ov).some((x) => x.mover === mover)
          if (cleared) {
            best = mid
            lo = mid
          } else {
            hi = mid
          }
        }
        if (best !== null) {
          chainKeys.forEach((k, i) => {
            k.quat = quatSlerp(IDENTITY, originals[i], best)
          })
          fixed.push({ frame: f, chain: chainKeys.map((k) => k.jp), scale: Math.round(best * 100) / 100 })
        } else {
          unresolved.push(byMover.get(mover)!)
        }
      }
    }

    return { vmd: serializeVmd(parsed, parsed.boneKeys), checkedFrames: frames.length, violations: allViolations, fixed, unresolved }
  } catch {
    return empty
  }
}

/**
 * Human-readable fix report for logs / LLM self-healing feedback.
 * The text is exactly what you would feed back to the model to regenerate a
 * softer pose: which bone, which frame, how much it was pulled back.
 */
export function formatAuditReport(result: AuditResult): string {
  const lines: string[] = []
  for (const v of result.violations) {
    lines.push(`clip @f${v.frame}: ${v.mover} into ${v.target} (depth ${v.depth.toFixed(2)})`)
  }
  for (const fx of result.fixed) {
    lines.push(`relaxed @f${fx.frame}: ${fx.chain.join("→")} ×${fx.scale}`)
  }
  for (const u of result.unresolved) {
    lines.push(`could not clear @f${u.frame}: ${u.mover} into ${u.target}`)
  }
  return lines.join("\n")
}
