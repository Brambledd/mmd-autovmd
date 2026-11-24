/**
 * pose-intent.ts — Structured High-Level Pose Intent Compiler (Zero-GPU Weak-Model Adapter).
 *
 * Instead of forcing smaller/faster LLMs (e.g. flash models) to simultaneously
 * juggle 3D Euler signs, A-pose quirks, MPL2 syntax, and multi-beat timing,
 * this module provides a compact JSON intent schema that compiles deterministically
 * into valid, grounded MPL2 fragments using verified S-curve torso presets,
 * analytical IK anchors (`reach` / `aim` / `plant`), and safe face morph rules.
 */

import { extractJSON } from "./long-motion.ts"

export type PoseTorsoIntent =
  | "upright"
  | "lean_forward"
  | "lean_back"
  | "bow"
  | "turn_left"
  | "turn_right"
  | "tilt_left"
  | "tilt_right"

export type PoseLowerIntent =
  | "stand"
  | "relaxed"
  | "step_left"
  | "step_right"
  | "crouch"
  | "kneel"
  | "sit"

export type PoseHandTarget =
  | "rest"
  | "hip"
  | "waist"
  | "chest"
  | "heart"
  | "mouth"
  | "cheek"
  | "peace"
  | "salute"
  | "wave"
  | "front"
  | "point"
  | "up"
  | "out"
  | "knee"
  | "shoe"

export type PoseHeadIntent =
  | "camera"
  | "up"
  | "down"
  | "left"
  | "right"
  | "tilt_left"
  | "tilt_right"

export interface PoseIntentFace {
  morph: string
  weight: number
}

export interface PoseIntentBeat {
  time: number
  torso?: PoseTorsoIntent
  lower?: PoseLowerIntent
  hand_l?: PoseHandTarget
  hand_r?: PoseHandTarget
  head?: PoseHeadIntent
  face?: PoseIntentFace[]
}

export interface PoseIntentSegment {
  beats: PoseIntentBeat[]
}

const UNSAFE_UTILITY_MORPHS = new Set(["上", "下", "口上", "口下", "う", "瞳小"])

const HAND_TARGET_MAP: Record<
  Exclude<PoseHandTarget, "rest">,
  { anchor: (side: "l" | "r") => string; preset: string; twist?: (side: "l" | "r") => string }
> = {
  hip: { anchor: (s) => `hip_${s}`, preset: "akimbo" },
  waist: { anchor: (s) => `waist_${s}`, preset: "akimbo" },
  chest: { anchor: () => "chest", preset: "cup" },
  heart: { anchor: () => "heart", preset: "cup" },
  mouth: {
    anchor: () => "mouth",
    preset: "cup",
    twist: (s) => (s === "r" ? "wrist_twist_r turn left 30;" : "wrist_twist_l turn right 30;"),
  },
  cheek: { anchor: (s) => `cheek_${s}`, preset: "cup" },
  peace: {
    anchor: (s) => `peace_${s}`,
    preset: "peace",
    twist: (s) => (s === "r" ? "wrist_twist_r turn left 20;" : "wrist_twist_l turn right 20;"),
  },
  salute: { anchor: (s) => `salute_${s}`, preset: "open" },
  wave: { anchor: (s) => `wave_${s}`, preset: "open" },
  front: { anchor: (s) => `front_${s}`, preset: "open" },
  point: { anchor: (s) => `front_${s}`, preset: "point" },
  up: { anchor: (s) => `up_${s}`, preset: "open" },
  out: { anchor: (s) => `out_${s}`, preset: "open" },
  knee: { anchor: (s) => `knee_${s}`, preset: "cup" },
  shoe: { anchor: (s) => `shoe_${s}`, preset: "cup" },
}

const VALID_TORSO = new Set<string>([
  "upright", "lean_forward", "lean_back", "bow", "turn_left", "turn_right", "tilt_left", "tilt_right",
])
const VALID_LOWER = new Set<string>([
  "stand", "relaxed", "step_left", "step_right", "crouch", "kneel", "sit",
])
const VALID_HAND = new Set<string>([
  "rest", "hip", "waist", "chest", "heart", "mouth", "cheek", "peace",
  "salute", "wave", "front", "point", "up", "out", "knee", "shoe",
])
const VALID_HEAD = new Set<string>([
  "camera", "up", "down", "left", "right", "tilt_left", "tilt_right",
])

/**
 * Parse and sanitize a PoseIntentSegment from raw LLM JSON output.
 */
export function parsePoseIntentJSON(raw: string): PoseIntentSegment | null {
  const json = extractJSON(raw)
  if (!json || typeof json !== "object") return null
  const rawBeats = (json as { beats?: unknown }).beats
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) return null

  const beats: PoseIntentBeat[] = []
  for (const item of rawBeats) {
    if (!item || typeof item !== "object") continue
    const b = item as Record<string, unknown>
    const rawTime = Number(b.time)
    if (!Number.isFinite(rawTime) || rawTime < 0) continue

    const face: PoseIntentFace[] = []
    if (Array.isArray(b.face)) {
      for (const f of b.face) {
        if (!f || typeof f !== "object") continue
        const morph = String((f as Record<string, unknown>).morph ?? "").trim()
        const weight = Number((f as Record<string, unknown>).weight)
        if (!morph || UNSAFE_UTILITY_MORPHS.has(morph)) continue
        if (!Number.isFinite(weight)) continue
        face.push({ morph, weight: Number(Math.max(0, Math.min(1, weight)).toFixed(2)) })
        if (face.length >= 2) break
      }
    }

    beats.push({
      time: Number(Math.min(20, Math.max(0, rawTime)).toFixed(2)),
      torso: typeof b.torso === "string" && VALID_TORSO.has(b.torso) ? (b.torso as PoseTorsoIntent) : "upright",
      lower: typeof b.lower === "string" && VALID_LOWER.has(b.lower) ? (b.lower as PoseLowerIntent) : "relaxed",
      hand_l: typeof b.hand_l === "string" && VALID_HAND.has(b.hand_l) ? (b.hand_l as PoseHandTarget) : "rest",
      hand_r: typeof b.hand_r === "string" && VALID_HAND.has(b.hand_r) ? (b.hand_r as PoseHandTarget) : "rest",
      head: typeof b.head === "string" && VALID_HEAD.has(b.head) ? (b.head as PoseHeadIntent) : "camera",
      face,
    })
  }

  if (beats.length === 0) return null
  beats.sort((a, b) => a.time - b.time)
  // Deduplicate identical timestamps (keep latest)
  const dedup: PoseIntentBeat[] = []
  for (const beat of beats) {
    if (dedup.length > 0 && Math.abs(dedup[dedup.length - 1].time - beat.time) < 0.05) {
      dedup[dedup.length - 1] = beat
    } else {
      dedup.push(beat)
    }
  }
  return { beats: dedup }
}

function emitTorsoLines(torso: PoseTorsoIntent, reachingFloor: boolean): string[] {
  if (reachingFloor) {
    return [
      "    waist bend forward 45;",
      "    upper_body bend forward 40;",
      "    upper_body2 bend forward 20;",
    ]
  }
  switch (torso) {
    case "lean_forward":
      return [
        "    waist bend forward 12;",
        "    upper_body2 bend forward 15;",
      ]
    case "lean_back":
      return [
        "    waist bend backward 8;",
        "    upper_body2 bend backward 10;",
      ]
    case "bow":
      return [
        "    waist bend forward 30;",
        "    upper_body bend forward 20;",
        "    upper_body2 bend forward 15;",
      ]
    case "turn_left":
      return [
        "    waist turn left 15;",
        "    upper_body2 turn left 15;",
      ]
    case "turn_right":
      return [
        "    waist turn right 15;",
        "    upper_body2 turn right 15;",
      ]
    case "tilt_left":
      return [
        "    waist sway left 8;",
        "    upper_body2 sway left 10;",
      ]
    case "tilt_right":
      return [
        "    waist sway right 8;",
        "    upper_body2 sway right 10;",
      ]
    case "upright":
    default:
      return [
        "    waist reset;",
        "    upper_body reset;",
        "    upper_body2 reset;",
      ]
  }
}

function emitLowerLines(lower: PoseLowerIntent): string[] {
  switch (lower) {
    case "crouch":
      return [
        "    leg_l bend forward 95;",
        "    knee_l bend backward 105;",
        "    leg_r bend forward 35;",
        "    knee_r bend backward 120;",
        "    plant feet;",
      ]
    case "kneel":
      return [
        "    leg_l bend forward 85;",
        "    knee_l bend backward 95;",
        "    leg_r bend forward 30;",
        "    knee_r bend backward 115;",
        "    plant feet;",
      ]
    case "sit":
      return [
        "    center move down 4.2;",
        "    leg_l bend forward 80, sway left 5;",
        "    leg_r bend forward 80, sway right 5;",
        "    knee_l bend backward 90;",
        "    knee_r bend backward 90;",
      ]
    case "step_left":
      return [
        "    leg_l bend forward 15, sway left 5;",
        "    knee_l bend backward 15;",
        "    leg_r bend backward 10;",
        "    knee_r bend backward 10;",
        "    plant feet;",
      ]
    case "step_right":
      return [
        "    leg_r bend forward 15, sway right 5;",
        "    knee_r bend backward 15;",
        "    leg_l bend backward 10;",
        "    knee_l bend backward 10;",
        "    plant feet;",
      ]
    case "relaxed":
      return [
        "    center reset;",
        "    leg_l reset;",
        "    leg_r reset;",
        "    knee_l bend backward 10;",
        "    knee_r bend backward 10;",
        "    plant feet;",
      ]
    case "stand":
    default:
      return [
        "    center reset;",
        "    leg_l reset;",
        "    leg_r reset;",
        "    knee_l reset;",
        "    knee_r reset;",
      ]
  }
}

function emitHandLines(side: "l" | "r", target: PoseHandTarget): string[] {
  if (target === "rest") {
    return [
      `    arm_${side} reset;`,
      `    elbow_${side} reset;`,
      `    hand_${side} relax;`,
    ]
  }
  const spec = HAND_TARGET_MAP[target]
  const lines = [
    `    reach hand_${side} to ${spec.anchor(side)};`,
    `    hand_${side} ${spec.preset};`,
  ]
  if (spec.twist) lines.push(`    ${spec.twist(side)}`)
  return lines
}

function emitHeadLines(head: PoseHeadIntent): string[] {
  switch (head) {
    case "tilt_left":
      return ["    head sway left 12;", "    aim head at camera;"]
    case "tilt_right":
      return ["    head sway right 12;", "    aim head at camera;"]
    case "up":
    case "down":
    case "left":
    case "right":
      return [`    aim head at ${head};`]
    case "camera":
    default:
      return ["    head reset;", "    aim head at camera;"]
  }
}

/**
 * Compile a structured PoseIntentSegment into a strictly valid MPL2 fragment
 * (one or more `@pose` blocks + one `@animation` block, without `main`).
 */
export function compilePoseIntentToMPL2(intent: PoseIntentSegment, targetDuration = 3): string {
  const poses: string[] = []
  const animFrames: string[] = []

  const firstBeat = intent.beats[0]
  if (firstBeat.time > 0) {
    poses.push([
      "@pose ready {",
      "    waist reset;",
      "    upper_body2 reset;",
      "    head reset;",
      "}",
    ].join("\n"))
    animFrames.push("    0: ready;")
  }

  intent.beats.forEach((beat, idx) => {
    const poseName = `intent_b${idx}`
    const handL = beat.hand_l ?? "rest"
    const handR = beat.hand_r ?? "rest"
    const lower = beat.lower ?? "relaxed"
    const torso = beat.torso ?? "upright"
    const head = beat.head ?? "camera"
    const reachingFloor = (lower === "crouch" || lower === "kneel") && (handL === "shoe" || handR === "shoe")

    const bodyLines: string[] = [
      ...emitTorsoLines(torso, reachingFloor),
      ...emitLowerLines(lower),
      ...emitHandLines("l", handL),
      ...emitHandLines("r", handR),
      ...emitHeadLines(head),
    ]
    for (const f of beat.face ?? []) {
      bodyLines.push(`    face ${f.morph} ${f.weight};`)
    }

    poses.push([`@pose ${poseName} {`, ...bodyLines, "}"].join("\n"))
    animFrames.push(`    ${beat.time.toFixed(2)}: ${poseName};`)
  })

  const lastBeat = intent.beats[intent.beats.length - 1]
  if (targetDuration > lastBeat.time + 0.4) {
    const lastPose = `intent_b${intent.beats.length - 1}`
    animFrames.push(`    ${targetDuration.toFixed(2)}: ${lastPose};`)
  }

  return [...poses, "", "@animation seg {", ...animFrames, "}"].join("\n")
}

export const POSE_INTENT_PROMPT = `You are a choreography intent planner for an MMD character.
Output ONLY a JSON object (no markdown fences) describing key beats across the target duration:
{
  "beats": [
    {
      "time": 0.6,
      "torso": "upright|lean_forward|lean_back|bow|turn_left|turn_right|tilt_left|tilt_right",
      "lower": "stand|relaxed|step_left|step_right|crouch|kneel|sit",
      "hand_l": "rest|hip|waist|chest|heart|mouth|cheek|peace|salute|wave|front|point|up|out|knee|shoe",
      "hand_r": "rest|hip|waist|chest|heart|mouth|cheek|peace|salute|wave|front|point|up|out|knee|shoe",
      "head": "camera|up|down|left|right|tilt_left|tilt_right",
      "face": [{"morph": "<exact safe morph name>", "weight": 0.7}]
    }
  ]
}
Rules:
- For durations >= 4.5s, emit 3 to 5 evolving beats so the character moves expressively rather than freezing.
- Use ONLY safe face morph names from ACTIVE MODEL NOTES (max 2 morphs per beat).
- To tie shoelaces or touch shoes, set lower="crouch" and hand_l/hand_r="shoe".
- Output strictly valid JSON only.`
