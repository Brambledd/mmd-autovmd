/**
 * visual-critic.ts — Phase 3 VLM 多视角视觉闭环评审器
 *
 * 将 pose-renderer 生成的三视图包络 PNG（正面 / 右侧面 / 3/4 视图）+ 当前活跃表情列表 +
 * 用户原始意图送给多模态大模型做审美与落位评审，产出结构化评分与定向 MPL2 修改建议。
 *
 * 稳健性契约：若当前模型不支持图像输入、请求超时或返回非 JSON，一律静默降级为
 * `status: "skipped"`，绝不阻断主生成链路。
 */

import type OpenAI from "openai"
import { extractJSON } from "./long-motion.ts"
import { parseMorphFrames } from "./vmd-morph.ts"
import type { RenderedPosePng, RenderedStoryboardPng } from "./pose-renderer.ts"

export interface VisualCriticVerdict {
  status: "passed" | "needs_fix" | "skipped"
  pass: boolean
  score?: number
  issues: string[]
  fixInstructions: string
  targetSegmentIndex?: number
  mode?: "single" | "storyboard"
  tileCount?: number
  reason?: string
  frame: number
  timeSec: number
  model?: string
}

export interface VisualCriticInput {
  client: Pick<OpenAI, "chat">
  model: string
  userDescription: string
  mplScript: string
  vmd: Uint8Array
  rendered?: RenderedPosePng
  storyboard?: RenderedStoryboardPng
  /** Minimum score (1-10) required to pass without refinement. Default 7. */
  passThreshold?: number
}

const VISUAL_CRITIC_SYSTEM = `You are a strict 3D anime character pose director reviewing an MMD character pose rendered in 3 orthographic views:
- Left panel: FRONT (-Z, camera facing character; viewer-left = character's RIGHT side, viewer-right = character's LEFT side)
- Middle panel: SIDE (R) (character's right profile; front faces LEFT)
- Right panel: 3/4 VIEW (yaw -35°)

Visual Legend:
- RED arm + ORANGE fingers = character's RIGHT arm & hand
- BLUE arm + CYAN fingers = character's LEFT arm & hand
- DARK RED leg = character's RIGHT leg; DARK BLUE leg = character's LEFT leg
- Translucent peach sphere = head; dark dots = eyes; PINK dot = mouth; GREEN arrow = face gaze direction
- Translucent grey capsules = torso/pelvis volume; GREEN bottom line = floor (y=0)

Evaluate the pose against the user's request on 5 criteria:
1. Pose Fidelity: Does overall posture (lean, twist, kneel/crouch, look-back, etc.) match every part of the request?
2. Hand Placement: Are RED (right) and BLUE (left) hands accurately near requested targets (mouth, hip, cheek, knee, front, etc.) without blocking eyes or floating awkwardly far?
3. Gaze Direction: Does the GREEN gaze arrow point naturally where requested (e.g. straight forward toward camera in FRONT/SIDE views)?
4. Anatomical Naturalness & Grounding: Natural elbow/knee bends, feet/knees contacting or near the green floor line?
5. Expression & Hand Shape: Do the listed active face morphs and finger shapes match the mood?

Output ONLY a single JSON object (no markdown fences, no commentary):
{
  "pass": true,
  "score": 8,
  "issues": [],
  "fixInstructions": ""
}
Rules:
- score is an integer 1..10 (7+ = good enough to ship; <=6 = clear defect that needs a 1-round fix).
- Set pass=true ONLY when score >= 7 and there is no major mismatch.
- When pass=false, keep issues concise (<=3 items) and write actionable MPL2 fixInstructions referencing strictly valid MPL2 directives (use "head sway left/right <deg>" NOT "head tilt"; use "reach hand_l/r to peace_l/r;" for cheek V-sign; "reach hand_l/r to <anchor>;"; "hand_l/r <relax|cup|akimbo|fist|open|peace|point>;"; "waist/upper_body2 bend/turn/sway"; "plant feet;"; "aim head at camera;"; "face ウィンク 1.0;" / "face 笑い 0.8;").`

const STORYBOARD_CRITIC_SYSTEM = `You are a strict 3D anime character motion director reviewing a multi-frame STORYBOARD grid of a long MMD animation.
Layout:
- Up to 6 tiles arranged in a grid (top-left to bottom-right in chronological story order).
- Inside EACH tile: LEFT sub-panel = FRONT (-Z, viewer-left = character RIGHT); RIGHT sub-panel = 3/4 VIEW.
- Top badge on each tile shows "#<segmentIndex> <ACTION>" and timestamp "T=<sec>S".

Visual Legend:
- RED arm + ORANGE fingers = character's RIGHT arm & hand
- BLUE arm + CYAN fingers = character's LEFT arm & hand
- DARK RED leg = character's RIGHT leg; DARK BLUE leg = character's LEFT leg
- Translucent peach sphere = head; dark dots = eyes; PINK dot = mouth; GREEN arrow = face gaze direction
- Translucent grey capsules = torso/pelvis volume; GREEN bottom line = floor (y=0)

Evaluate the full storyboard against the user's request on 5 criteria:
1. Narrative & Pose Fidelity: Do the sampled story beats clearly match the requested sequence and transitions?
2. Clipping & Hand Placement: In any tile, do arms/wrists/fingers penetrate the head sphere, torso, or block eyes awkwardly?
3. Gaze & Head Attitude: Does the GREEN gaze arrow read naturally per beat (forward at camera when talking/greeting, lowered on shy/bow beats)?
4. Grounding & Balance: Do feet/knees stay on/above the green y=0 floor line cleanly, with believable leg bends on kneel/crouch/step beats?
5. Expression Continuity: Do the listed active facial morphs per tile match each beat's mood?

Output ONLY a single JSON object (no markdown fences, no commentary):
{
  "pass": true,
  "score": 8,
  "targetSegmentIndex": null,
  "issues": [],
  "fixInstructions": ""
}
Rules:
- score is an integer 1..10 (7+ = good enough to ship; <=6 = clear defect needing 1-round fix on one segment).
- Set pass=true ONLY when score >= 7 and no tile shows major pose mismatch or severe clipping.
- When pass=false, set "targetSegmentIndex" to the single segment integer index (#<segmentIndex>) most in need of refinement, keep issues concise (<=3 items), and write actionable MPL2 fixInstructions referencing strictly valid MPL2 syntax ("head sway", "reach hand_l/r to peace_l/r;", "hand_l/r <relax|cup|akimbo|fist|open|peace|point>;", "waist/upper_body2 bend/turn/sway", "plant feet;", "aim head at camera;", "face <morph> <0..1>;").`

/** Summarize active morph weights at `frame` (step-hold semantics) for VLM context. */
export function summarizeActiveMorphsAtFrame(vmd: Uint8Array, frame: number): string {
  const keys = parseMorphFrames(vmd)
  if (!keys || keys.length === 0) return "none"
  const latest = new Map<string, number>()
  for (const k of [...keys].sort((a, b) => a.frame - b.frame)) {
    if (k.frame <= frame) latest.set(k.name, k.weight)
  }
  const active = [...latest.entries()]
    .filter(([, w]) => w > 0.05)
    .map(([name, w]) => `${name}=${w.toFixed(2)}`)
  return active.length > 0 ? active.join(", ") : "none"
}

export function parseVisualCriticJson(
  raw: string,
  passThreshold = 7
): { pass: boolean; score: number; issues: string[]; fixInstructions: string; targetSegmentIndex?: number } | null {
  const parsed = extractJSON(raw)
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const scoreRaw = typeof obj.score === "number" && Number.isFinite(obj.score) ? obj.score : null
  if (scoreRaw == null) return null
  const score = Math.max(1, Math.min(10, Math.round(scoreRaw)))
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 5)
    : []
  const fixInstructions = typeof obj.fixInstructions === "string" ? obj.fixInstructions.trim() : ""
  const targetSegmentIndex =
    typeof obj.targetSegmentIndex === "number" && Number.isInteger(obj.targetSegmentIndex) && obj.targetSegmentIndex >= 0
      ? obj.targetSegmentIndex
      : undefined
  const passFlag = typeof obj.pass === "boolean" ? obj.pass : score >= passThreshold
  const pass = passFlag && score >= passThreshold
  return { pass, score, issues, fixInstructions, targetSegmentIndex }
}

/**
 * Run 1-shot multimodal VLM critique on either a multi-frame Storyboard grid or a single 3-view PNG.
 */
export async function runVisualCritic(input: VisualCriticInput): Promise<VisualCriticVerdict> {
  const threshold = input.passThreshold ?? 7
  const useStoryboard = Boolean(input.storyboard && input.storyboard.tiles.length >= 2)
  const storyboard = useStoryboard ? input.storyboard! : undefined
  const rendered = input.rendered

  if (!storyboard && !rendered) {
    return {
      status: "skipped",
      pass: true,
      issues: [],
      fixInstructions: "",
      reason: "No rendered frame or storyboard provided",
      frame: 0,
      timeSec: 0,
      model: input.model,
    }
  }

  const refTile = storyboard ? storyboard.tiles[storyboard.tiles.length - 1] : undefined
  const repFrame = rendered?.frame ?? refTile?.frame ?? 0
  const repTimeSec = rendered?.timeSec ?? refTile?.timeSec ?? 0
  const imageDataUrl = storyboard ? storyboard.dataUrl : rendered!.dataUrl
  const mode: "single" | "storyboard" = storyboard ? "storyboard" : "single"
  const tileCount = storyboard ? storyboard.tiles.length : 1

  const systemPrompt = storyboard ? STORYBOARD_CRITIC_SYSTEM : VISUAL_CRITIC_SYSTEM
  const userText = storyboard
    ? [
        `User request: ${input.userDescription}`,
        `Storyboard tiles (${storyboard.tiles.length} sampled keyframes across timeline):`,
        ...storyboard.tiles.map((t, idx) => {
          const morphs = summarizeActiveMorphsAtFrame(input.vmd, t.frame)
          const segLabel = t.segmentIndex != null ? `#${t.segmentIndex}` : `tile${idx}`
          return `- Tile ${idx + 1}: segment=${segLabel} action="${t.action ?? "unknown"}" f=${t.frame} (t=${t.timeSec.toFixed(2)}s) morphs=[${morphs}]`
        }),
        `Current MPL2 script excerpt:\n${input.mplScript.slice(0, 2600)}`,
        `Review all storyboard tiles and return ONLY the JSON verdict.`,
      ].join("\n")
    : [
        `User request: ${input.userDescription}`,
        `Rendered peak frame: f=${rendered!.frame} (t=${rendered!.timeSec.toFixed(2)}s)`,
        `Active facial morphs at this frame: ${summarizeActiveMorphsAtFrame(input.vmd, rendered!.frame)}`,
        `Current MPL2 script:\n${input.mplScript.slice(0, 2200)}`,
        `Review the attached 3-view pose silhouette and return ONLY the JSON verdict.`,
      ].join("\n\n")

  try {
    const res = await input.client.chat.completions.create({
      model: input.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl,
                detail: "auto",
              },
            },
          ],
        },
      ],
    })
    const content = res.choices[0]?.message?.content ?? ""
    const verdict = parseVisualCriticJson(content, threshold)
    if (!verdict) {
      return {
        status: "skipped",
        pass: true,
        mode,
        tileCount,
        issues: [],
        fixInstructions: "",
        reason: "VLM response did not contain valid verdict JSON",
        frame: repFrame,
        timeSec: repTimeSec,
        model: input.model,
      }
    }
    return {
      status: verdict.pass ? "passed" : "needs_fix",
      pass: verdict.pass,
      mode,
      tileCount,
      score: verdict.score,
      targetSegmentIndex: verdict.targetSegmentIndex,
      issues: verdict.issues,
      fixInstructions: verdict.fixInstructions,
      frame: repFrame,
      timeSec: repTimeSec,
      model: input.model,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      status: "skipped",
      pass: true,
      mode,
      tileCount,
      issues: [],
      fixInstructions: "",
      reason: `VLM call skipped: ${msg.slice(0, 160)}`,
      frame: repFrame,
      timeSec: repTimeSec,
      model: input.model,
    }
  }
}
