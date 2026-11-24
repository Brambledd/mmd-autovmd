/**
 * VMD enhancer — Phase 1 motion polish.
 *
 * A deterministic post-processor over the VMD bytes produced by the mmd-mpl
 * WASM compiler. It never touches the LLM, the MPL grammar, or the engine.
 *
 * What it fixes (each maps to a root cause in docs/how-llm-understands-pmx.md §7):
 *  1. A1 — the compiler hard-codes an extreme S-curve (64,0,63,127) on every
 *     frame ("hold → snap → dead stop"). Replaced by a small curve library:
 *     soft (default, MMD-like), snap (fast attack for big moves), settle (slow
 *     gentle landing).
 *  2. A2 — every gesture has exactly two keys per bone and every joint arrives
 *     simultaneously. Inserts classic embellishment keys where they are safe:
 *       anticipation  (2 frames before a held pose starts moving, -15% counter)
 *       overshoot     (2 frames past the target, +10%, then a settle key)
 *     and staggers arrival along the kinematic chain (shoulder → arm → elbow →
 *     wrist → fingers) by shifting each bone's whole track 0-4 frames.
 *  3. A4 — the compiler globally disables leg IK. When a motion never keys a
 *     leg bone (upper-body gestures), re-enables it so feet stay planted.
 *
 * Robustness contract: this is a polish layer, so on ANY parse anomaly it
 * returns the input unchanged instead of throwing.
 */

import { injectMorphFrames, parseMorphFrames } from "./vmd-morph.ts"
import type { MorphKey } from "./vmd-morph.ts"

export interface VmdCurve {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface VmdEnhanceOptions {
  /** Curve applied to ordinary transitions. Default: MMD-like gentle S. */
  curve?: VmdCurve
  /** Multiplier for the per-bone kinematic-chain delay, in frames. Default 1 (≤4 frames). */
  staggerFrames?: number
  /** Insert anticipation keys for transitions of at least this many degrees. Default 30. */
  embellishAngleDeg?: number
  /** Counter-move magnitude relative to the gesture, 0-1. Default 0.15. */
  anticipationRatio?: number
  /** Frames before the gesture start for the anticipation key. Default 2. */
  anticipationFrames?: number
  /** How far past the target to overshoot, relative to the gesture, 0-1. Default 0.10. */
  overshootRatio?: number
  /** Frames after the target for the overshoot key; the settle key follows this later. Default 2. */
  overshootFrames?: number
  /** Frames after the overshoot key for the settle key. Default 2. */
  settleFrames?: number
  /** Re-enable leg IK when no leg-chain bone is keyed. Default true. */
  enableLegIkWhenFeetUntouched?: boolean
  /** Breathing micro-motion amplitude (deg) injected inside long hold poses (>=0.8s). Default 1.0 (0 disables). */
  holdBreathAmp?: number
  /** Inject natural eye blinks (まばたき) when eyes are not already closed by morphs. Default false (opt-in). */
  autoBlink?: boolean
}

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export interface BoneKey {
  frame: number
  pos: [number, number, number]
  quat: Quat
  /** Raw 15-byte Shift-JIS name field, preserved byte-for-byte on output. */
  name: Uint8Array
  jp: string
  /** Rotation-bezier control points for the interval starting at this key. */
  curve: VmdCurve
}

export interface PropertyFrame {
  frame: number
  visible: boolean
  ikEntries: { jp: string; raw: Uint8Array; enabled: boolean }[]
}

const CURVE_SOFT: VmdCurve = { x1: 20, y1: 20, x2: 107, y2: 107 }
const CURVE_SNAP: VmdCurve = { x1: 25, y1: 95, x2: 64, y2: 127 }
const CURVE_SETTLE: VmdCurve = { x1: 38, y1: 13, x2: 102, y2: 114 }

/** Kinematic-chain depth of standard MMD bones (deeper = later in the wave). */
const CHAIN_DEPTH: Record<string, number> = {
  全ての親: 0,
  センター: 0,
  グルーブ: 1,
  腰: 1,
  上半身: 1,
  下半身: 1,
  上半身2: 2,
  首: 2,
  左肩: 2,
  右肩: 2,
  左足: 2,
  右足: 2,
  頭: 3,
  両目: 3,
  左腕: 3,
  右腕: 3,
  左ひざ: 3,
  右ひざ: 3,
  左ひじ: 4,
  右ひじ: 4,
  左足首: 4,
  右足首: 4,
  左手首: 5,
  右手首: 5,
  左足先EX: 5,
  右足先EX: 5,
}

// Finger bones 左/右 × 親指/人指/中指/薬指/小指 × １/２/３
for (const side of ["左", "右"]) {
  for (const finger of ["親指", "人指", "中指", "薬指", "小指"]) {
    for (const seg of ["１", "２", "３"]) {
      CHAIN_DEPTH[side + finger + seg] = 6
    }
  }
}

const LEG_CHAIN = new Set(["左足", "右足", "左ひざ", "右ひざ", "左足首", "右足首", "左足先EX", "右足先EX"])
const LEG_IK_BONES = new Set(["右足IK親", "左足IK親", "右足ＩＫ", "左足ＩＫ", "右つま先ＩＫ", "左つま先ＩＫ"])
/** Pelvis/root + leg chain stay temporally synchronized so knee bend matches center drop (no mid-squat ground clipping). */
const GROUND_SYNC_BONES = new Set(["全ての親", "センター", "グルーブ", "腰", "下半身", ...LEG_CHAIN])
/** Floor-anchored root bones and ground-coupled leg chain must not independently overshoot/anticipate without center Y tracking (prevents mid-air foot popping). */
const NO_EMBELLISH_BONES = new Set(["全ての親", "センター", ...LEG_CHAIN])

// ---------------------------------------------------------------- quaternion

function quatDot(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
}

function quatNeg(a: Quat): Quat {
  return { x: -a.x, y: -a.y, z: -a.z, w: -a.w }
}

export function quatAngleDeg(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(quatDot(a, b)))
  return (2 * Math.acos(d) * 180) / Math.PI
}

function quatAxisAngle(ax: [number, number, number], degrees: number): Quat {
  const rad = (degrees * Math.PI) / 180
  const s = Math.sin(rad / 2)
  const len = Math.hypot(ax[0], ax[1], ax[2]) || 1
  return { x: (ax[0] / len) * s, y: (ax[1] / len) * s, z: (ax[2] / len) * s, w: Math.cos(rad / 2) }
}

function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

const HOLD_BREATH_SPEC: Record<string, { bendDeg: number; swayDeg: number; phase: number }> = {
  上半身: { bendDeg: -0.9, swayDeg: 0.4, phase: 0 },
  上半身2: { bendDeg: -1.1, swayDeg: 0.5, phase: 0.3 },
  首: { bendDeg: 0.5, swayDeg: 0, phase: Math.PI },
  頭: { bendDeg: 0.4, swayDeg: 0.7, phase: Math.PI / 2 },
}

const EYE_CLOSING_MORPHS = new Set([
  "まばたき",
  "笑い",
  "ウィンク",
  "ウィンク２",
  "ウィンク右",
  "ｳｨﾝｸ",
  "ｳｨﾝｸ２右",
  "はぅ",
  "じと目",
])

/** Slerp; t may be negative or >1 (extrapolation past the endpoints). */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x
  let by = b.y
  let bz = b.z
  let bw = b.w
  let dot = quatDot(a, b)
  if (dot < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    dot = -dot
  }
  if (dot > 0.9995) {
    const q = { x: a.x + t * (bx - a.x), y: a.y + t * (by - a.y), z: a.z + t * (bz - a.z), w: a.w + t * (bw - a.w) }
    const len = Math.hypot(q.x, q.y, q.z, q.w) || 1
    return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
  }
  const theta0 = Math.acos(Math.min(1, dot))
  const sin0 = Math.sin(theta0)
  const s0 = Math.sin((1 - t) * theta0) / sin0
  const s1 = Math.sin(t * theta0) / sin0
  return { x: s0 * a.x + s1 * bx, y: s0 * a.y + s1 * by, z: s0 * a.z + s1 * bz, w: s0 * a.w + s1 * bw }
}

// -------------------------------------------------------------------- parse

function decodeSjis(raw: Uint8Array): string {
  let end = raw.length
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) {
      end = i
      break
    }
  }
  if (end === 0) return ""
  return new TextDecoder("shift_jis").decode(raw.subarray(0, end))
}

export interface ParsedVmd {
  header: Uint8Array
  modelName: Uint8Array
  boneKeys: BoneKey[]
  morphBytes: Uint8Array
  cameraBytes: Uint8Array
  lightBytes: Uint8Array
  shadowBytes: Uint8Array
  propertyFrames: PropertyFrame[]
  trailing: Uint8Array
}

/** Parse a VMD into structured tracks; null when it is not a VMD 2 file. */
export function parseVmd(data: Uint8Array): ParsedVmd | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.byteLength < 54) return null
  if (decodeSjis(data.subarray(0, 26)) !== "Vocaloid Motion Data 0002") return null

  let o = 30
  const header = data.slice(0, 30)
  const modelName = data.slice(30, 50)
  o = 50

  const boneCount = dv.getUint32(o, true)
  o += 4
  if (boneCount > (data.byteLength - o) / 111) return null
  const boneKeys: BoneKey[] = []
  for (let i = 0; i < boneCount; i++) {
    const name = data.slice(o, o + 15)
    const jp = decodeSjis(name)
    const frame = dv.getUint32(o + 15, true)
    const pos: [number, number, number] = [
      dv.getFloat32(o + 19, true),
      dv.getFloat32(o + 23, true),
      dv.getFloat32(o + 27, true),
    ]
    const quat: Quat = {
      x: dv.getFloat32(o + 31, true),
      y: dv.getFloat32(o + 35, true),
      z: dv.getFloat32(o + 39, true),
      w: dv.getFloat32(o + 43, true),
    }
    boneKeys.push({ frame, pos, quat, name, jp, curve: CURVE_SOFT })
    o += 111
  }

  const readCountedChunk = (frameSize: number): Uint8Array | null => {
    if (o + 4 > data.byteLength) return null
    const count = dv.getUint32(o, true)
    const bytes = count * frameSize
    if (o + 4 + bytes > data.byteLength) return null
    const chunk = data.slice(o + 4, o + 4 + bytes)
    o += 4 + bytes
    return chunk
  }

  const morphBytes = readCountedChunk(23)
  const cameraBytes = readCountedChunk(61)
  const lightBytes = readCountedChunk(32)
  const shadowBytes = readCountedChunk(9)
  if (morphBytes === null || cameraBytes === null || lightBytes === null || shadowBytes === null) return null

  const propertyFrames: PropertyFrame[] = []
  if (o + 4 <= data.byteLength) {
    const propCount = dv.getUint32(o, true)
    o += 4
    for (let i = 0; i < propCount; i++) {
      if (o + 9 > data.byteLength) return null
      const frame = dv.getUint32(o, true)
      const visible = dv.getUint8(o + 4) !== 0
      const ikCount = dv.getUint32(o + 5, true)
      o += 9
      const ikEntries: PropertyFrame["ikEntries"] = []
      for (let k = 0; k < ikCount; k++) {
        if (o + 21 > data.byteLength) return null
        const raw = data.slice(o, o + 20)
        ikEntries.push({ jp: decodeSjis(raw), raw, enabled: dv.getUint8(o + 20) !== 0 })
        o += 21
      }
      propertyFrames.push({ frame, visible, ikEntries })
    }
  }

  return {
    header,
    modelName,
    boneKeys,
    morphBytes,
    cameraBytes,
    lightBytes,
    shadowBytes,
    propertyFrames,
    trailing: data.slice(o),
  }
}

// ---------------------------------------------------------------- serialize

function interpBytes(c: VmdCurve): Uint8Array {
  const b = new Uint8Array(64)
  for (let ch = 0; ch < 4; ch++) {
    b[ch * 16 + 0] = c.x1
    b[ch * 16 + 4] = c.y1
    b[ch * 16 + 8] = c.x2
    b[ch * 16 + 12] = c.y2
  }
  return b
}

/** Serialize parsed VMD data (with modified keys) back to bytes. */
export function serializeVmd(parsed: ParsedVmd, boneKeys: BoneKey[]): Uint8Array {
  const out = new Uint8Array(
    30 + 20 + 4 + boneKeys.length * 111 + 4 + parsed.morphBytes.length + 4 + parsed.cameraBytes.length +
      4 + parsed.lightBytes.length + 4 + parsed.shadowBytes.length + 4 +
      parsed.propertyFrames.reduce((n, p) => n + 9 + p.ikEntries.length * 21, 0) + parsed.trailing.length
  )
  const dv = new DataView(out.buffer)
  out.set(parsed.header, 0)
  out.set(parsed.modelName, 30)
  let o = 50
  dv.setUint32(o, boneKeys.length, true)
  o += 4
  for (const k of boneKeys) {
    out.set(k.name, o)
    dv.setUint32(o + 15, k.frame, true)
    dv.setFloat32(o + 19, k.pos[0], true)
    dv.setFloat32(o + 23, k.pos[1], true)
    dv.setFloat32(o + 27, k.pos[2], true)
    dv.setFloat32(o + 31, k.quat.x, true)
    dv.setFloat32(o + 35, k.quat.y, true)
    dv.setFloat32(o + 39, k.quat.z, true)
    dv.setFloat32(o + 43, k.quat.w, true)
    out.set(interpBytes(k.curve), o + 47)
    o += 111
  }
  const sections: [Uint8Array, number][] = [
    [parsed.morphBytes, 23],
    [parsed.cameraBytes, 61],
    [parsed.lightBytes, 32],
    [parsed.shadowBytes, 9],
  ]
  for (const [chunk, frameSize] of sections) {
    dv.setUint32(o, frameSize > 0 ? chunk.length / frameSize : 0, true)
    o += 4
    out.set(chunk, o)
    o += chunk.length
  }
  dv.setUint32(o, parsed.propertyFrames.length, true)
  o += 4
  for (const p of parsed.propertyFrames) {
    dv.setUint32(o, p.frame, true)
    out[o + 4] = p.visible ? 1 : 0
    dv.setUint32(o + 5, p.ikEntries.length, true)
    o += 9
    for (const e of p.ikEntries) {
      out.set(e.raw, o)
      out[o + 20] = e.enabled ? 1 : 0
      o += 21
    }
  }
  out.set(parsed.trailing, o)
  return out
}

// ----------------------------------------------------------------- enhance

export interface EnhanceStats {
  insertedAnticipation: number
  insertedOvershoot: number
  insertedSettle: number
  insertedBreathKeys: number
  insertedBlinks: number
  staggeredBones: number
  legIkReenabled: boolean
  framesBefore: number
  framesAfter: number
}

export interface IkWindow {
  startFrame: number
  endFrame: number
  startSec: number
  endSec: number
  disableIK: boolean
  disablePhysics: boolean
}

const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 }

/**
 * Compute per-interval IK / Physics enablement schedule over bone keys (step-hold semantics).
 * During intervals where neither `全ての親` (`base`) nor `LEG_CHAIN` has non-trivial rotation (>2 deg),
 * Leg IK stays ON so standing gestures remain planted even inside mixed 30s stories.
 */
export function computeIkScheduleFromKeys(keys: BoneKey[]): IkWindow[] {
  if (keys.length === 0) return []
  const sorted = [...keys].sort((a, b) => a.frame - b.frame)
  const distinctFrames = [...new Set(sorted.map((k) => k.frame))].sort((a, b) => a - b)
  const state = new Map<string, Quat>()
  let ki = 0

  const raw: IkWindow[] = []
  for (let i = 0; i < distinctFrames.length; i++) {
    const f = distinctFrames[i]
    while (ki < sorted.length && sorted[ki].frame <= f) {
      state.set(sorted[ki].jp, sorted[ki].quat)
      ki++
    }
    const baseQ = state.get("全ての親")
    const baseRotated = baseQ != null && quatAngleDeg(IDENTITY_Q, baseQ) > 2
    let legsRotated = false
    for (const jp of LEG_CHAIN) {
      const lq = state.get(jp)
      if (lq != null && quatAngleDeg(IDENTITY_Q, lq) > 2) {
        legsRotated = true
        break
      }
    }
    const disableIK = baseRotated || legsRotated
    const disablePhysics = baseRotated
    const nextF = i + 1 < distinctFrames.length ? distinctFrames[i + 1] : Infinity
    const prev = raw[raw.length - 1]
    if (prev && prev.disableIK === disableIK && prev.disablePhysics === disablePhysics) {
      prev.endFrame = nextF
      prev.endSec = Number.isFinite(nextF) ? Number((nextF / 30).toFixed(3)) : Infinity
    } else {
      raw.push({
        startFrame: f,
        endFrame: nextF,
        startSec: Number((f / 30).toFixed(3)),
        endSec: Number.isFinite(nextF) ? Number((nextF / 30).toFixed(3)) : Infinity,
        disableIK,
        disablePhysics,
      })
    }
  }
  // Debounce brief (<6 frame / 0.2s) overshoot-induced IK flicker windows that immediately revert
  const MIN_GLITCH_FRAMES = 6
  const smoothed: IkWindow[] = []
  for (let i = 0; i < raw.length; i++) {
    const cur = { ...raw[i] }
    const prev = smoothed[smoothed.length - 1]
    const next = raw[i + 1]
    const dur = Number.isFinite(cur.endFrame) ? cur.endFrame - cur.startFrame : Infinity
    if (
      prev &&
      next &&
      dur < MIN_GLITCH_FRAMES &&
      prev.disableIK === next.disableIK &&
      prev.disablePhysics === next.disablePhysics
    ) {
      prev.endFrame = cur.endFrame
      prev.endSec = cur.endSec
      continue
    }
    if (prev && prev.disableIK === cur.disableIK && prev.disablePhysics === cur.disablePhysics) {
      prev.endFrame = cur.endFrame
      prev.endSec = cur.endSec
    } else {
      smoothed.push(cur)
    }
  }
  return smoothed
}

/** Extract time-varying IK/physics windows from any compiled or enhanced VMD byte stream. */
export function computeIkSchedule(vmd: Uint8Array): IkWindow[] {
  const parsed = parseVmd(vmd)
  if (!parsed) return []
  return computeIkScheduleFromKeys(parsed.boneKeys)
}

/** Sync engine IK/Physics toggles on the current playback timestamp (mutates only when state flips). */
export function applyIkScheduleAtTime(
  engine: { disableIK: boolean; disablePhysics: boolean },
  schedule: IkWindow[] | undefined,
  currentSec: number
): void {
  if (!schedule || schedule.length === 0) return
  let hit = schedule[schedule.length - 1]
  for (let i = 0; i < schedule.length; i++) {
    if (currentSec < schedule[i].endSec) {
      hit = schedule[i]
      break
    }
  }
  if (engine.disableIK !== hit.disableIK) engine.disableIK = hit.disableIK
  if (engine.disablePhysics !== hit.disablePhysics) engine.disablePhysics = hit.disablePhysics
}

function enhance(parsed: ParsedVmd, opts: Required<VmdEnhanceOptions>): { boneKeys: BoneKey[]; stats: EnhanceStats } {
  const stats: EnhanceStats = {
    insertedAnticipation: 0,
    insertedOvershoot: 0,
    insertedSettle: 0,
    insertedBreathKeys: 0,
    insertedBlinks: 0,
    staggeredBones: 0,
    legIkReenabled: false,
    framesBefore: parsed.boneKeys.length,
    framesAfter: 0,
  }

  // Group per bone (all frames of a bone share the same name field).
  const tracks = new Map<string, BoneKey[]>()
  for (const k of parsed.boneKeys) {
    const list = tracks.get(k.jp)
    if (list) list.push(k)
    else tracks.set(k.jp, [k])
  }
  const hasBaseRotation = (tracks.get("全ての親") ?? []).some((k) => quatAngleDeg(IDENTITY_Q, k.quat) > 5)

  const out: BoneKey[] = []
  for (const [jp, keys] of tracks) {
    keys.sort((a, b) => a.frame - b.frame)

    // Shortest-path alignment: flip quaternion signs so consecutive keys take
    // the short arc (guards against double-spin flicker in interpolation).
    for (let i = 1; i < keys.length; i++) {
      if (quatDot(keys[i - 1].quat, keys[i].quat) < 0) keys[i].quat = quatNeg(keys[i].quat)
    }

    // Kinematic-chain stagger: shift the whole track so deeper bones start and
    // land later (follow-through). Ground-contact chain (and full-body base rotations
    // such as lying flat) stays synchronized at 0 so limbs don't lag into the floor.
    const depth = CHAIN_DEPTH[jp] ?? 2
    const delay = hasBaseRotation || GROUND_SYNC_BONES.has(jp) ? 0 : Math.min(depth, 4) * opts.staggerFrames
    if (delay > 0) {
      stats.staggeredBones++
      for (const k of keys) k.frame += delay
    }

    // Pre-roll: MPL clips open directly on their first authored pose, so the
    // character *pops* from rest into pose N when playback starts (and pops
    // later after the stagger shift). Anchor frame 0 to the rest orientation
    // (identity local rotation) so the opening pose is eased into.
    if (keys.length > 0 && keys[0].frame > 0) {
      keys.unshift({
        frame: 0,
        pos: [0, 0, 0],
        quat: { x: 0, y: 0, z: 0, w: 1 },
        name: keys[0].name,
        jp,
        curve: CURVE_SOFT,
      })
    }

    // Embellishment: anticipation before held poses start moving, overshoot +
    // settle on arrival. Only for substantial rotations, and only when the
    // neighbouring segments are holds (continuous sequences stay continuous).
    const extra: BoneKey[] = []
    if (!NO_EMBELLISH_BONES.has(jp)) {
      for (let i = 0; i < keys.length - 1; i++) {
        const cur = keys[i]
        const next = keys[i + 1]
        const deg = quatAngleDeg(cur.quat, next.quat)
        if (deg < opts.embellishAngleDeg) continue

      cur.curve = CURVE_SNAP
      const prev = i > 0 ? keys[i - 1] : null
      const heldBefore = prev !== null && quatAngleDeg(prev.quat, cur.quat) < 1
      const nextNext = i + 2 < keys.length ? keys[i + 2] : null
      const heldAfter = nextNext === null || quatAngleDeg(next.quat, nextNext.quat) < 1

      if (heldBefore && prev) {
        const at = cur.frame - opts.anticipationFrames
        if (at > prev.frame && at >= 0) {
          extra.push({
            frame: at,
            pos: cur.pos,
            quat: quatSlerp(cur.quat, next.quat, -opts.anticipationRatio),
            name: cur.name,
            jp,
            curve: CURVE_SNAP,
          })
          stats.insertedAnticipation++
        }
      }
      if (heldAfter) {
        // Tight elbow flex (>55 deg, e.g. mouth/cheek/chest) should barely overshoot so hand doesn't punch into face/torso
        const effOvershoot =
          (jp === "左ひじ" || jp === "右ひじ") && deg > 55
            ? Math.min(opts.overshootRatio, 0.02)
            : opts.overshootRatio
        const atO = next.frame + opts.overshootFrames
        const atS = atO + opts.settleFrames
        const roomForBoth = nextNext === null || atS < nextNext.frame
        if (process.env.VMD_ENH_DEBUG === "1") {
          console.log(`[dbg] ${jp} i=${i} deg=${deg.toFixed(1)} cur=f${cur.frame} next=f${next.frame} heldBefore=${heldBefore} heldAfter=${heldAfter} atO=${atO} atS=${atS} roomBoth=${roomForBoth}`)
        }
        const roomForOvershoot = nextNext === null || atO < nextNext.frame
        if (roomForBoth) {
          extra.push({
            frame: atO,
            pos: next.pos,
            quat: quatSlerp(next.quat, cur.quat, -effOvershoot),
            name: next.name,
            jp,
            curve: CURVE_SETTLE,
          })
          extra.push({
            frame: atS,
            pos: next.pos,
            quat: next.quat,
            name: next.name,
            jp,
            curve: CURVE_SOFT,
          })
          stats.insertedOvershoot++
          stats.insertedSettle++
          next.curve = CURVE_SOFT
        } else if (roomForOvershoot) {
          extra.push({
            frame: atO,
            pos: next.pos,
            quat: quatSlerp(next.quat, cur.quat, -effOvershoot),
            name: next.name,
            jp,
            curve: CURVE_SOFT,
          })
          stats.insertedOvershoot++
        }
      }
      }
    }

    const breathSpec = opts.holdBreathAmp > 0 ? HOLD_BREATH_SPEC[jp] : undefined
    if (breathSpec) {
      for (let i = 0; i < keys.length - 1; i++) {
        const cur = keys[i]
        const next = keys[i + 1]
        if (quatAngleDeg(cur.quat, next.quat) >= 1) continue
        const startF = cur.frame + 8
        const endF = next.frame - 6
        if (next.frame - cur.frame < 24 || endF - startF < 10) continue
        const occupied = new Set([...keys.map((k) => k.frame), ...extra.map((k) => k.frame)])
        const count = Math.max(1, Math.min(4, Math.floor((endF - startF) / 16) + 1))
        for (let m = 0; m < count; m++) {
          const frac = (m + 1) / (count + 1)
          const f = Math.round(startF + frac * (endF - startF))
          if (occupied.has(f)) continue
          occupied.add(f)
          const tSec = (f - cur.frame) / 30
          const bend = breathSpec.bendDeg * opts.holdBreathAmp * Math.sin((2 * Math.PI * tSec) / 2.8 + breathSpec.phase)
          const sway = breathSpec.swayDeg * opts.holdBreathAmp * Math.cos((2 * Math.PI * tSec) / 3.4 + breathSpec.phase)
          let delta: Quat = { x: 0, y: 0, z: 0, w: 1 }
          if (Math.abs(bend) > 1e-3) delta = quatMul(delta, quatAxisAngle([-1, 0, 0], bend))
          if (Math.abs(sway) > 1e-3) delta = quatMul(delta, quatAxisAngle([0, 0, -1], sway))
          extra.push({
            frame: f,
            pos: cur.pos,
            quat: quatMul(cur.quat, delta),
            name: cur.name,
            jp,
            curve: CURVE_SOFT,
          })
          stats.insertedBreathKeys++
        }
      }
    }

    const merged = [...keys, ...extra].sort((a, b) => a.frame - b.frame)
    for (let i = 1; i < merged.length; i++) {
      if (quatDot(merged[i - 1].quat, merged[i].quat) < 0) merged[i].quat = quatNeg(merged[i].quat)
    }
    for (let i = merged.length - 1; i > 0; i--) {
      if (merged[i].frame === merged[i - 1].frame) merged.splice(i, 1)
    }
    out.push(...merged)
  }

  out.sort((a, b) => a.frame - b.frame)
  stats.framesAfter = out.length

  // Leg IK: re-enable when the motion never keys a leg-chain bone, or emit per-window
  // PropertyFrame transitions on mixed clips (e.g. stand -> walk/sit -> stand)
  if (opts.enableLegIkWhenFeetUntouched) {
    const keyed = new Set(out.map((k) => k.jp))
    const legsKeyed = [...keyed].some((n) => LEG_CHAIN.has(n))
    if (!legsKeyed) {
      for (const p of parsed.propertyFrames) {
        for (const e of p.ikEntries) {
          if (LEG_IK_BONES.has(e.jp)) e.enabled = true
        }
      }
      stats.legIkReenabled = true
    } else if (parsed.propertyFrames.length > 0) {
      const windows = computeIkScheduleFromKeys(out)
      const returnsToStanding = windows.some((w) => !w.disableIK && w.startFrame > 0)
      const hasNonStanding = windows.some((w) => w.disableIK)
      if (returnsToStanding && hasNonStanding) {
        const template = parsed.propertyFrames[0].ikEntries
        parsed.propertyFrames = windows.map((w) => ({
          frame: w.startFrame,
          visible: true,
          ikEntries: template.map((e) => ({
            jp: e.jp,
            raw: e.raw.slice(),
            enabled: LEG_IK_BONES.has(e.jp) ? !w.disableIK : e.enabled,
          })),
        }))
        stats.legIkReenabled = true
      }
    }
  }

  return { boneKeys: out, stats }
}

// ----------------------------------------------------------------- public API

function buildSafeAutoBlinks(existing: MorphKey[], maxFrame: number): MorphKey[] {
  if (maxFrame < 45) return []
  if (existing.some((m) => m.name === "まばたき")) return []

  const isEyesClosedAt = (centerFrame: number): boolean => {
    for (const morphName of EYE_CLOSING_MORPHS) {
      const track = existing
        .filter((k) => k.name === morphName && k.frame <= centerFrame + 8)
        .sort((a, b) => a.frame - b.frame)
      if (track.length === 0) continue
      const latest = track[track.length - 1]
      if (latest.weight > 0.2) return true
    }
    return false
  }

  const out: MorphKey[] = []
  for (let f = 42; f + 6 <= maxFrame; f += 78) {
    if (isEyesClosedAt(f)) continue
    out.push({ name: "まばたき", frame: Math.max(0, f - 2), weight: 0 })
    out.push({ name: "まばたき", frame: f, weight: 1 })
    out.push({ name: "まばたき", frame: f + 4, weight: 0 })
  }
  return out
}

function withDefaults(opts?: VmdEnhanceOptions): Required<VmdEnhanceOptions> {
  return {
    curve: opts?.curve ?? CURVE_SOFT,
    staggerFrames: opts?.staggerFrames ?? 1,
    embellishAngleDeg: opts?.embellishAngleDeg ?? 30,
    anticipationRatio: opts?.anticipationRatio ?? 0.15,
    anticipationFrames: opts?.anticipationFrames ?? 2,
    overshootRatio: opts?.overshootRatio ?? 0.1,
    overshootFrames: opts?.overshootFrames ?? 2,
    settleFrames: opts?.settleFrames ?? 2,
    enableLegIkWhenFeetUntouched: opts?.enableLegIkWhenFeetUntouched ?? true,
    holdBreathAmp: opts?.holdBreathAmp ?? 1.0,
    autoBlink: opts?.autoBlink ?? false,
  }
}

export interface VmdEnhanceResult {
  vmd: Uint8Array
  stats: EnhanceStats
}

const emptyStats = (): EnhanceStats => ({
  insertedAnticipation: 0,
  insertedOvershoot: 0,
  insertedSettle: 0,
  insertedBreathKeys: 0,
  insertedBlinks: 0,
  staggeredBones: 0,
  legIkReenabled: false,
  framesBefore: 0,
  framesAfter: 0,
})

/** Enhanced VMD with per-frame stats; throws nothing, falls back to input on anomaly. */
export function enhanceVmdDetailed(vmd: Uint8Array, opts?: VmdEnhanceOptions): VmdEnhanceResult {
  try {
    const parsed = parseVmd(vmd)
    if (!parsed) return { vmd, stats: emptyStats() }
    const resolved = withDefaults(opts)
    const { boneKeys, stats } = enhance(parsed, resolved)
    let outVmd = serializeVmd(parsed, boneKeys)
    if (resolved.autoBlink) {
      const existingMorphs = parseMorphFrames(outVmd) ?? []
      const maxFrame = boneKeys.reduce((mx, k) => Math.max(mx, k.frame), 0)
      const blinkKeys = buildSafeAutoBlinks(existingMorphs, maxFrame)
      if (blinkKeys.length > 0) {
        outVmd = injectMorphFrames(outVmd, [...existingMorphs, ...blinkKeys])
        stats.insertedBlinks = Math.round(blinkKeys.length / 3)
      }
    }
    return { vmd: outVmd, stats }
  } catch {
    return { vmd, stats: emptyStats() }
  }
}

/** Polish a compiled VMD in place (bytes in, bytes out). Never throws. */
export function enhanceVmd(vmd: Uint8Array, opts?: VmdEnhanceOptions): Uint8Array {
  return enhanceVmdDetailed(vmd, opts).vmd
}
