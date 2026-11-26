/**
 * Per-model conditioning — Phase 2 part B.
 *
 * The Phase 1 analysis showed the LLM is "model-blind": one static prompt
 * serves every skeleton (topaz 243 bones, 梵天 656, 梵天2 without leg IK).
 * This module closes part of that gap by turning a parsed PMX skeleton into
 * a small, strict prompt block that the pose generator must respect:
 *   - which MPL bones the model actually has (never hallucinate a bone the
 *     compiler cannot resolve — it would silently drop from the motion)
 *   - whether leg IK exists (feet planting possible or not)
 *   - whether a physics skirt / heavy cloth rig exists (tighten leg motion
 *     to avoid cloth clipping that no FK check can see)
 *   - which face morphs exist (usable via the mpl2 "face <name> <weight>;" channel)
 *
 * The client appends this text to the request body; /api/pose-generate-long injects it into the planner and segment prompts.
 */

import { measureModelGeometry } from "./model-geometry.ts"
import type { PmxBones } from "./pmx-bones.ts"

/** MPL core vocabulary mapped to the standard PMX Japanese bone names. */
const MPL_CORE: { en: string; jp: string }[] = [
  { en: "base", jp: "全ての親" },
  { en: "center", jp: "センター" },
  { en: "upper_body", jp: "上半身" },
  { en: "lower_body", jp: "下半身" },
  { en: "waist", jp: "腰" },
  { en: "neck", jp: "首" },
  { en: "head", jp: "頭" },
  { en: "shoulder_l", jp: "左肩" },
  { en: "shoulder_r", jp: "右肩" },
  { en: "arm_l", jp: "左腕" },
  { en: "arm_r", jp: "右腕" },
  { en: "elbow_l", jp: "左ひじ" },
  { en: "elbow_r", jp: "右ひじ" },
  { en: "wrist_l", jp: "左手首" },
  { en: "wrist_r", jp: "右手首" },
  { en: "leg_l", jp: "左足" },
  { en: "leg_r", jp: "右足" },
  { en: "knee_l", jp: "左ひざ" },
  { en: "knee_r", jp: "右ひざ" },
  { en: "ankle_l", jp: "左足首" },
  { en: "ankle_r", jp: "右足首" },
  { en: "toe_l", jp: "左足先EX" },
  { en: "toe_r", jp: "右足先EX" },
]

const MPL_EXTENDED: { en: string; jp: string }[] = [
  { en: "upper_body2", jp: "上半身2" },
  { en: "groove", jp: "グルーブ" },
  { en: "arm_twist_l", jp: "左腕捩" },
  { en: "arm_twist_r", jp: "右腕捩" },
  { en: "wrist_twist_l", jp: "左手捩" },
  { en: "wrist_twist_r", jp: "右手捩" },
  { en: "eyes", jp: "両目" },
]

const MORPH_GLOSS: Record<string, string> = {
  にこり: "gentle smile",
  なごみ: "warm soft smile",
  笑い: "big closed-eye smile",
  ｷﾘｯ: "confident sharp eyes",
  真面目: "focused/serious",
  困る: "troubled",
  照れ: "shy/blush",
  にやり２: "playful smirk",
  びっくり: "surprised",
  怒り: "angry",
  ウィンク: "left wink",
  ウィンク右: "right wink",
  あ: "open mouth",
  ワ: "cheerful open grin",
  口角上げ: "lift mouth corners",
}

/** Group PMX face morphs with clear English semantics and hide confusing utility morphs (e.g. 上/下/口下/瞳小). */
function summarizeMorphs(morphs: string[]): string[] {
  const present = new Set(morphs)
  const recommended: string[] = []
  for (const [name, gloss] of Object.entries(MORPH_GLOSS)) {
    if (present.has(name)) recommended.push(`${name}(${gloss})`)
  }
  const parts: string[] = []
  if (recommended.length > 0) {
    parts.push(`    * Recommended safe morphs (prefer these, max 1-2 per @pose): ${recommended.join(", ")}`)
  }
  parts.push(
    `    * Rules: NEVER stack >2 morphs or mix opposing emotions; NEVER use brow/mouth utility morphs like 上, 下, 口上, 口下, う, 瞳小 (上/下 are eyebrow shifts, NOT gaze — use "head bend" / "eyes bend" to look up/down; 瞳小 is anime horror shock).`
  )
  return parts
}

export interface ModelConditioning {
  /** Ready-to-append prompt block (English, matching the system prompt). */
  text: string
  available: string[]
  missing: string[]
  extendedAvailable: string[]
  legIk: boolean
  skirtRigids: number
  /** Layer 1 geometric measurements (height/limb lengths/anchor heights). */
  measurements: ReturnType<typeof measureModelGeometry>
}

export function buildModelConditioning(bones: PmxBones): ModelConditioning {
  const available = MPL_CORE.filter((b) => bones.indexByJp.has(b.jp)).map((b) => b.en)
  const missing = MPL_CORE.filter((b) => !bones.indexByJp.has(b.jp)).map((b) => b.en)
  const extendedAvailable = MPL_EXTENDED.filter((b) => bones.indexByJp.has(b.jp)).map((b) => b.en)
  const legIk = bones.indexByJp.has("右足ＩＫ") && bones.indexByJp.has("左足ＩＫ")

  const skirtRigids = bones.rigids.filter((r) => {
    const b = bones.bones[r.bone]
    if (!b) return false
    const text = `${r.jp} ${b.jp} ${b.en}`
    return /skirt|スカート|裙|外套|衣摆|coat|cape|披风/i.test(text)
  }).length

  const lines: string[] = []
  lines.push(`## ACTIVE MODEL NOTES (${bones.modelName || "loaded .pmx"} — auto-detected from .pmx, follow strictly)`)

  // ---- Layer 1: geometric measurements + real silhouette envelope
  const m = measureModelGeometry(bones)
  lines.push(
    `- Geometry: height ≈${m.heightCm}cm (${m.heightUnits}u); hip joint at y≈${m.hipY}; ` +
      `arm chain ≈${m.armLenCm}cm (${m.armLenUnits}u); leg chain ≈${m.legLenCm}cm (${m.legLenUnits}u); ` +
      `head y≈${m.headY}; ankle y≈${m.footY}. The ground is y=0; 1 unit ≈ 8cm.`
  )
  const envDetails: string[] = []
  if (m.shoulderHalfWidth != null) envDetails.push(`shoulder half-width ±${m.shoulderHalfWidth}u`)
  if (m.hipHalfWidth != null) envDetails.push(`hip half-width ±${m.hipHalfWidth}u`)
  if (m.chestFrontZ != null) envDetails.push(`chest front surface z≈${m.chestFrontZ}u (-Z is forward)`)
  if (m.headRadius != null) envDetails.push(`head radius ≈${m.headRadius}u`)
  if (m.armRestAngleDeg != null) envDetails.push(`rest A-pose arms slope ${m.armRestAngleDeg}° below horizontal`)
  if (envDetails.length > 0) {
    lines.push(`- Body envelope & rest pose: ${envDetails.join("; ")}.`)
  }
  lines.push(
    `- Ground-contact reasoning: to sit down use center move down ≈${m.hipY != null ? Math.round(m.hipY) : "?"}u ` +
      "(hips reach the floor); when lying flat with \"base bend backward 90;\", base already pivots at y=0 so use center move up 1u instead of move down. " +
      "While lying flat, hands/feet only reach the ground if the arm/leg chains rotate toward it — total limb lengths are listed above, do not assume the limbs stretch."
  )

  if (missing.length === 0) {
    lines.push("- Skeleton: all 23 core MPL bones exist; every core bone in your vocabulary is safe to use.")
  } else {
    lines.push(`- Bones MISSING from this model (never reference them, the motion would silently drop them): ${missing.join(", ")}`)
  }

  if (extendedAvailable.length > 0) {
    lines.push(
      `- Extended MPL2 bones supported on this model: ${extendedAvailable.join(", ")}. ` +
        `Use upper_body2 for upper chest/spine articulation, arm_twist_l/r & wrist_twist_l/r for forearm twist/palm orientation, ` +
        `and eyes for gaze shifts.`
    )
  }

  if (legIk) {
    lines.push("- Leg IK bones present: planted feet are supported; keep leg motions natural and grounded (or emit \"plant feet;\" when bending knees/lowering center).")
  } else {
    lines.push("- Leg IK bones ABSENT: feet cannot be planted — keep leg motions small and symmetric, prefer upper-body expression.")
  }

  if (skirtRigids >= 8) {
    lines.push(
      `- Heavy physics skirt detected (${skirtRigids} cloth bodies): keep leg bend forward ≤ 60°, avoid wide leg sway, ` +
        "and prefer seated poses with knees together to prevent cloth clipping."
    )
  }

  if (bones.faceMorphs.length > 0) {
    lines.push(
      `- Face morphs available (${bones.faceMorphs.length}): ` +
        `You MAY add expression lines inside @pose blocks with the exact syntax "face <morph_name> <weight 0-1>;". ` +
        `Use ONLY names copied verbatim from the list below (unknown names are silently ignored). Weight 0.3 = subtle, 0.8 = strong.`
    )
    lines.push(...summarizeMorphs(bones.faceMorphs))
  } else {
    lines.push("- Face morphs: NONE in this model — do not emit face commands.")
  }

  return { text: lines.join("\n"), available, missing, extendedAvailable, legIk, skirtRigids, measurements: m }
}
