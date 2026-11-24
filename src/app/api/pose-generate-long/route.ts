import OpenAI from "openai"
import { ChatCompletionMessageParam } from "openai/resources/chat/completions"

import { LEXICON, expandLexiconSegment, fragmentDuration } from "@/lib/motion-lexicon"
import {
  encodeSseEvent,
  extractJSON,
  normalizePlan,
  stitchSegments,
  summarizeFragmentExit,
  LongMotionStreamEvent,
  StitchSegmentInput,
  MAX_TOTAL_DURATION,
  MAX_SEGMENTS,
  MAX_CUSTOM_SEGMENTS,
} from "@/lib/long-motion"
import { desugarMPL } from "@/lib/mpl-macros"
import { compileMPL2 } from "@/lib/mpl2"
import { auditVmd } from "@/lib/pose-audit"
import { critiquePoseVmd } from "@/lib/pose-critic"
import { finalizeMotion } from "@/lib/motion-finalize"
import { formatExemplarsForPrompt, retrievePoseExemplars } from "@/lib/pose-exemplars"
import { renderPoseMultiViewPng, renderStoryboardPng } from "@/lib/pose-renderer"
import type { StoryboardTimelineEntry } from "@/lib/pose-renderer"
import { runVisualCritic } from "@/lib/visual-critic"
import type { VisualCriticVerdict } from "@/lib/visual-critic"
import { getServerCompiler } from "@/lib/server-compile"
import { deserializePmxBones } from "@/lib/pmx-bones"
import { POSE_INTENT_PROMPT, parsePoseIntentJSON, compilePoseIntentToMPL2 } from "@/lib/pose-intent"

/**
 * Phase 1 编排 API：Plan → Generate → Stitch（路线图 §1.2）
 *
 * 成本模型（对应路线图风险④缓解）：
 *  - Stage 1 一次 LLM 调用产出 JSON 剧本
 *  - Stage 2 词库命中的段 = 0 次 LLM 调用；只有词库外的段才走 LLM（上限 MAX_CUSTOM_SEGMENTS）
 *  - Stage 3 纯 TS 拼接 + 宏展开，零调用
 *
 * Layer 2.5 编译期自愈：每个 LLM custom 段在收下前用服务端 wasm 编译器验证，
 * 编译失败把错误原文喂回 LLM 重试一次（原先失败要到客户端编译才炸，整次生成作废）。
 */

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:mpl|MPL)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim()
}

const PLANNER_PROMPT = `You are a choreography planner for an MMD character (Topaz). Select segments from the motion library or emit custom motion segments to fulfill the user's request.

## Motion Library (JSON)
{library}

## Rules
- Output ONLY a JSON object, no markdown fences:
  {"segments":[{"action":"<library name or custom description>","params":{},"mirror":false,"duration":<seconds>}]}
- params must only use keys defined for that library entry.
- Set duration to the time that segment should occupy (repeat segments via extra entries to fill longer durations).
- Keep narrative sense: e.g. "sit" then "stand_up"; greetings at start/end; use "step_closer", "talk_explain", "weight_shift", "goodbye_wave" for long conversational/storytelling scenes.
- NEVER prepend unrequested "idle_stand" or insert unrequested filler segments — start immediately with the first action the user asked for, and keep every segment faithful to the user's requested sequence.
- If the user asks for a LONG acting story (~15-35 seconds): organize it into a coherent multi-act narrative arc (4 to 7 segments) so the sum of durations matches the target length (±10%). Keep brief greetings concise ("bow": 1.8-2.2s, "wave_hand": 2.4-3.5s) and static pose presets ("akimbo", "salute", "shy_cheek", "heart_chest") to 2.5-4.5s max so the character never freezes motionless.
- CRITICAL COHESION RULE: NEVER split a continuous grounded posture/action into multiple back-to-back custom segments (for example, NEVER emit separate segments for "squat down", "tie shoelaces", and "stand back up" — that causes sudden leg teleporting and multiplies latency). Combine descend → action → stand-up smoothly inside ONE cohesive multi-beat custom segment (e.g. "crouch forward on one knee to tie left shoelace cleanly with both hands then stand back up smoothly", duration 6-9s)!
- Prefer exact library entries ONLY when the request is a simple standalone match for that preset (e.g. "hands on hips / 双手叉腰" -> akimbo, "salute / 敬礼" -> salute, "wave / 挥手" -> wave_hand, "bow / 鞠躬" -> bow).
- Whenever the user combines a preset with ANY extra posture, body turn/look-back, single-hand asymmetry, hand gesture, gaze, or emotion (e.g. "回头看我+单手叉腰 / look back over shoulder with one hand on hip", "前倾+捂嘴+叉腰", "剪刀手+歪头+wink", "单膝蹲+扶膝盖", "指向镜头"), NEVER pick "cheer" or "akimbo" — ALWAYS emit a custom segment (at most {maxCustom}):
  set "action" to a clear, vivid English description including emotion/gaze/hand placement (e.g. "lean forward excitedly with right hand over mouth giggling", "crouch down gently touching knee and looking up at camera", "turn back over shoulder with confident smirk and one hand on hip").
- IMPORTANT: For a single pose or simultaneous full-body action (e.g. "kneel down touching knee and smiling", "lean forward with one hand over mouth and one on hip"), emit ONLY ONE segment covering the whole pose — NEVER split lower-body and upper-body of the same pose into two separate segments! Only emit multiple segments when the user explicitly requests a temporal sequence of distinct actions or a multi-beat long performance.
- If the user gives a total duration, sum of durations should match it (±10%). If not specified: use 2-5 seconds for a single pose/gesture request, or 8-18 seconds for short multi-step choreography, or 25-35 seconds when asked for a ~30s storytelling clip.
- Hard caps: no more than {maxSegments} segments, {maxTotal} seconds total.`

const SEGMENT_PROMPT = `Generate ONE expressive MMD Pose Language (MPL2) segment tailored for the active PMX character.

## MPL2 SYNTAX
@pose name {
    bone action direction amount;   // compound: bone act1 dir1 amt1, act2 dir2 amt2;
    face <morph> <weight 0-1>;      // expression from ACTIVE MODEL NOTES (multiple face lines allowed)
    reach <hand_l|hand_r> to <anchor>;        // Analytical 2-bone arm IK! Solves exact arm+elbow for this model
    hand_<l|r> <relax|cup|akimbo|fist|open|peace|point>; // Optional finger preset (auto-inferred on reach if omitted)
    aim <head|eyes> at <target>;              // Exact head/gaze aim relative to parent spine
    plant <feet|foot_l|foot_r>;               // Keep feet grounded when bending knees/lowering waist
}
@animation name {
    0: pose_name;
    0.6: other_pose;
}

## ACTIONS & DIRECTIONS (only these are valid)
bend: forward, backward | turn: left, right | sway: left, right | move: base/center/groove only (all 6 directions)
reset: "bone reset;" restores the bind pose

## BONES & LIMITS (degrees, round to nearest 5)
- Core: base, center, waist, lower_body, upper_body (90), neck/head (60fwd/90bwd, turn 90, sway 60), shoulder_l/r (90), arm_l/r (90), elbow_l/r (ONLY bend forward 180), wrist_l/r (60fwd/90bwd, turn/sway 90), leg_l/r (180fwd/90bwd, turn 90, sway 180out/30in), knee_l/r (ONLY bend backward 180), ankle_l/r (60/60/90), toe_l/r (60/60), fingers thumb/index/middle/ring/pinky_l/r (bend/sway only).
- Extended MPL2 bones: upper_body2 (upper chest, 60 all), groove (subtle hip bounce, move/rotate), arm_twist_l/r & wrist_twist_l/r (turn left/right up to 120; do NOT combine arm_twist with reach on the same arm, use wrist_twist_l/r for palm orientation), eyes (bend 25, turn 35).

## CRITICAL SPATIAL RULES (IMPORTANT!)
1. MMD world coordinate axes: +X = character's LEFT, -X = character's RIGHT, +Y = UP, -Z = FORWARD (toward camera), +Z = BACKWARD (behind character).
2. For hand placement near body/face/feet/space, ALWAYS prefer "reach hand_l/r to <anchor>;" instead of guessing raw arm_l/r angles!
   Valid anchors: hip_l, hip_r, waist_l, waist_r, chest, heart, cheek_l, cheek_r, peace_l, peace_r, chin, mouth, forehead, forehead_l, forehead_r, salute_l, salute_r, head_top, back_of_head, nape, ear_l, ear_r, shoulder_l, shoulder_r, knee_l, knee_r, foot_l, foot_r, shoe_l, shoe_r, ankle_l, ankle_r, front, front_l, front_r, up, up_l, up_r, out, out_l, out_r, wave_l, wave_r, hand_l, hand_r, or "[x,y,z]", or "anchor + [dx,dy,dz]".
   - NEVER add guessed large +[dx,dy,dz] offsets onto mouth/cheek/knee/shoe (+Z pushes hands BEHIND the face/leg into the body; swapping +/-X crosses the arms!). Use "reach hand_l/r to peace_l/r;" for peace/V-sign near face, "reach hand_l/r to shoe_l;" (or shoe_r/foot_l/foot_r) for tying shoelaces/touching shoes, and pure "cheek_l/r", "mouth", "knee_l/r", "front_l/r" cleanly.
   - "aim head at camera;" automatically preserves any prior "head sway left/right <deg>;" tilt!
3. Use "upper_body2" together with "waist"/"upper_body" for lifelike spine S-curves instead of stiff single-joint bending.
4. FACIAL EXPRESSIONS: Emit ONLY 1-2 clean "face <morph> <weight>;" lines per @pose from the Recommended safe morphs in ACTIVE MODEL NOTES! Never stack >2 morphs, never mix opposing emotions, and NEVER use 上, 下, 口上, 口下, う, 瞳小 unless explicitly asked (use "head bend" / "eyes bend" for looking up/down!).
5. Keep movements natural and end in a clean posed frame (don't abruptly snap back to reset unless requested).{dynamicRules}

## OUTPUT
Only the MPL2 fragment: the @pose block(s) plus ONE @animation block. No main block, no fences, no explanations.

## EXAMPLES (dynamically retrieved verified references matching this segment)

{exemplars}

{storyContext}
Segment description: {description}
Target duration: about {duration} seconds.`

function fill(t: string, vars: Record<string, string>) {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), t)
}

/**
 * Dynamic prompt pruning: only inject specialized geometric rules when the
 * segment description/duration actually needs them, avoiding cognitive overload
 * on smaller/faster models.
 */
function buildDynamicSegmentRules(actionDesc: string, durationSec: number): string {
  const rules: string[] = []
  if (/crouch|squat|kneel|shoe|lace|tie|蹲|跪|鞋/i.test(actionDesc)) {
    rules.push(
      '6. CROUCH / SHOE-TYING GEOMETRY: Arms are only ~5.4u long! To reach the floor/shoes cleanly with "plant feet;", keep the front shin near-vertical in front (leg_l bend forward 95-100, knee_l bend backward 105-110), lower the back knee near ground (leg_r bend forward 35, knee_r bend backward 120), AND fold torso deeply forward (waist bend forward 45-50, upper_body bend forward 40-45, upper_body2 bend forward 20). NEVER use extreme asymmetric leg bends like knee_r=140 while knee_l=75.'
    )
  }
  if (/raw|arm_l|arm_r|wing|stretch|t-pose|举|伸展/i.test(actionDesc)) {
    rules.push(
      '7. If using raw arm_l/r rotations (A-pose): "arm_l bend backward" raises arm UP, "arm_l bend forward" drops arm DOWN; "arm_l sway right" swings left arm FORWARD (-Z).'
    )
  }
  if (durationSec >= 4.5) {
    rules.push(
      "8. MULTI-BEAT TIMING: Target duration >= 4.5s — choreograph 3 to 5 evolving pose keyframes across the segment (e.g. 0: entry; 0.8: beat_1; 2.2: beat_2; 3.8: beat_3; 5.5: hold_beat) with subtle gesture/head/expression progression."
    )
  }
  return rules.length > 0 ? `\n${rules.join("\n")}` : ""
}

function lexiconMenu() {
  return JSON.stringify(
    LEXICON.map((m) => ({
      name: m.name,
      duration: fragmentDuration(m.build(Object.fromEntries(Object.entries(m.params).map(([k, s]) => [k, s.default])))),
      params: m.params,
      tags: m.tags,
      description: m.description,
    })),
    null,
    0
  )
}

async function chat(client: OpenAI, model: string, messages: ChatCompletionMessageParam[]): Promise<string> {
  const res = await client.chat.completions.create({ model, messages, temperature: 0.4 })
  return res.choices[0]?.message?.content ?? ""
}

type CompileLike = { compile: (s: string) => Uint8Array }

/**
 * 编译验证一个 custom 片段。返回 null = 合法；否则返回错误描述（喂回 LLM 修正）。
 * wasm 编译器的失败形态有两种：抛错 / 静默 0 字节（缺 main 或姿势引用悬空），
 * 两者都按失败处理。serverCompiler 为 null 时跳过验证（与旧行为一致）。
 */
function validateFragment(
  serverCompiler: CompileLike | null,
  fragment: string,
  bones?: ReturnType<typeof deserializePmxBones>
): string | null {
  if (!serverCompiler) return null
  try {
    const res = compileMPL2(serverCompiler, fragment, bones)
    if (res.vmd.length === 0)
      return "compiler produced 0 bytes — invalid MPL (bad syntax, unknown bone/action/direction, or an @animation frame referencing a missing @pose)"
    if (res.directiveErrors.length > 0)
      return `invalid MPL2 directive(s): ${res.directiveErrors.join("; ")}`
    return null
  } catch (e) {
    return `compiler rejected the MPL: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * 成品管线：审核 → vmd-enhancer → 贴地烘焙。与舞台 playMplOnStage、MCP export_motion(final) 同源。
 * 自愈回路的 critic 与分镜都看成品 —— 过渡段的帧间下沉由烘焙修掉，
 * 不再因为“关键帧之间”的问题触发无谓的定向重生成；作者姿势本身的错误照样会被拦。
 */
function finalizeForStage(
  vmd: Uint8Array,
  bones: ReturnType<typeof deserializePmxBones> | null,
  mplSource: string
): Uint8Array {
  if (vmd.length === 0 || !bones) return vmd
  return finalizeMotion(auditVmd(vmd, bones).vmd, bones, {
    mplSource,
    enhanceOptions: { autoBlink: true },
  }).vmd
}

type PipelineRequest = {
  description: string
  conditioning?: string
  modelBones?: unknown
  visualCritic?: boolean
  includePreview?: boolean
  intentMode?: boolean
}

type PipelineResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number; error: string; plannerError?: string }

async function executeLongPosePipeline(
  input: PipelineRequest,
  emit: (event: LongMotionStreamEvent) => void = () => {}
): Promise<PipelineResult> {
  const { description, conditioning, modelBones, visualCritic, includePreview } = input
  // Phase 2 per-model conditioning: client parses the active .pmx skeleton
  // (bones coverage / leg IK / physics skirt) and appends it to every prompt.
  const conditioningBlock =
    typeof conditioning === "string" && conditioning.trim().length > 0
      ? `\n\n${conditioning.trim()}`
      : ""
  // Layer 2 FK 自愈回路：客户端同时传骨架（序列化 PmxBones），服务端做编译 + 地面接触检查
  const fkBones = deserializePmxBones(modelBones)

  const client = new OpenAI({ apiKey: process.env.AI_API_KEY, baseURL: process.env.AI_API_BASE_URL })
  const model = process.env.AI_MODEL!
  const plannerModel = process.env.AI_PLANNER_MODEL || model
  const segmentModel = process.env.AI_SEGMENT_MODEL || model
  const repairModel = process.env.AI_REPAIR_MODEL || plannerModel
  // 编译期自愈依赖服务端编译器；环境不支持时 validateFragment 自动跳过（不重试、不报错）
  const serverCompiler = await getServerCompiler()

  const pipelineT0 = Date.now()
  // ---- Stage 1: PLAN（一次调用 → JSON 剧本；解析失败重试一次）
  emit({ type: "stage", stage: "planning", message: "正在编排长动作剧本..." })
  const planT0 = Date.now()
  let plan: ReturnType<typeof normalizePlan> | null = null
  let plannerError = ""
  const plannerSys = fill(PLANNER_PROMPT, {
    library: lexiconMenu(),
    maxSegments: String(MAX_SEGMENTS),
    maxTotal: String(MAX_TOTAL_DURATION),
    maxCustom: String(MAX_CUSTOM_SEGMENTS),
  }) + conditioningBlock
  for (let attempt = 0; attempt < 2 && !plan; attempt++) {
    try {
      const raw = await chat(client, plannerModel, [
        { role: "system", content: plannerSys },
        { role: "user", content: `User request: ${description}` },
      ])
      const json = extractJSON(raw)
      if (json) plan = normalizePlan(json, LEXICON.map((m) => m.name))
    } catch (e) {
      // 供应商错误（429 余额不足 / 401 鉴权 / 超时）透传给调用方，便于排障
      plannerError = e instanceof Error ? e.message : String(e)
    }
  }
  if (!plan || plan.segments.length === 0) {
    return {
      ok: false,
      status: 502,
      error: plannerError
        ? `Planner LLM call failed: ${plannerError}`
        : "Planner failed to produce a valid plan",
      plannerError: plannerError || undefined,
    }
  }
  const planMs = Date.now() - planT0

  // ---- Stage 2: GENERATE（词库命中 = 0 调用；未命中走 LLM 并行生成，上限 MAX_CUSTOM_SEGMENTS 段）
  type MetaEntry = {
    action: string
    source: "lexicon" | "llm"
    duration: number
    mirror: boolean
    exemplars?: string[]
    storyContext?: string
  }
  const plannedSlots: Array<
    | { kind: "lexicon"; input: StitchSegmentInput; meta: MetaEntry; exitSummary: string }
    | { kind: "llm"; action: string; duration?: number; mirror: boolean }
  > = []
  const warnings = [...plan.warnings]
  let llmCustomCount = 0

  for (const seg of plan.segments) {
    const hit = expandLexiconSegment(seg.action, seg.params, seg.mirror, seg.duration)
    if (hit) {
      const dur = Math.max(hit.duration, seg.duration ?? hit.duration)
      plannedSlots.push({
        kind: "lexicon",
        input: { fragment: hit.fragment, duration: dur },
        meta: { action: hit.name, source: "lexicon", duration: dur, mirror: seg.mirror },
        exitSummary: summarizeFragmentExit(hit.fragment),
      })
      continue
    }
    if (llmCustomCount >= MAX_CUSTOM_SEGMENTS) {
      warnings.push(`custom segment "${seg.action}" dropped (custom cap ${MAX_CUSTOM_SEGMENTS})`)
      continue
    }
    llmCustomCount++
    plannedSlots.push({ kind: "llm", action: seg.action, duration: seg.duration, mirror: seg.mirror })
  }

  emit({
    type: "plan_done",
    segmentCount: plannedSlots.length,
    customCount: llmCustomCount,
    totalDuration: plan.totalDuration,
    segments: plannedSlots.map((slot, index) =>
      slot.kind === "lexicon"
        ? { index, action: slot.meta.action, source: "lexicon", duration: slot.meta.duration }
        : { index, action: slot.action, source: "llm", duration: slot.duration }
    ),
  })
  emit({
    type: "stage",
    stage: "generating",
    message:
      llmCustomCount > 0
        ? `共 ${plannedSlots.length} 段（${llmCustomCount} 段需定制生成）...`
        : `共 ${plannedSlots.length} 段（全部命中动作库）...`,
  })

  const buildStoryContext = (idx: number, prevActualFragment?: string): string => {
    const prev = idx > 0 ? plannedSlots[idx - 1] : undefined
    const next = idx + 1 < plannedSlots.length ? plannedSlots[idx + 1] : undefined
    const lines: string[] = []
    if (prev) {
      const exitInfo = prevActualFragment
        ? summarizeFragmentExit(prevActualFragment)
        : prev.kind === "lexicon"
          ? prev.exitSummary
          : ""
      const prevDesc = prev.kind === "lexicon" ? prev.meta.action : prev.action
      lines.push(`Story continuity — previous beat: ${prevDesc}${exitInfo ? ` (${exitInfo})` : ""}`)
    }
    if (next) {
      const nextDesc = next.kind === "lexicon" ? next.meta.action : next.action
      lines.push(`Story continuity — upcoming next beat: ${nextDesc} (leave a natural exit pose for smooth transition).`)
    }
    return lines.join("\n")
  }

  const preferIntent = Boolean(input.intentMode) || process.env.AI_INTENT_MODE === "1"

  const generateViaIntent = async (
    actionDesc: string,
    targetDur: number,
    storyContext: string
  ): Promise<string | null> => {
    try {
      const raw = await chat(client, segmentModel, [
        {
          role: "system",
          content:
            POSE_INTENT_PROMPT +
            conditioningBlock +
            (storyContext ? `\n\n${storyContext}` : ""),
        },
        { role: "user", content: `Segment: ${actionDesc}\nTarget duration: about ${targetDur} seconds.` },
      ])
      const intent = parsePoseIntentJSON(raw)
      if (!intent) return null
      const compiled = compilePoseIntentToMPL2(intent, targetDur)
      const problem = validateFragment(serverCompiler, compiled, fkBones)
      return problem ? null : compiled
    } catch {
      return null
    }
  }

  const generateT0 = Date.now()
  let customCompleted = 0
  const exemplarTopK = llmCustomCount >= 2 ? 2 : 3
  type ResolvedSlot = { input: StitchSegmentInput; meta: MetaEntry; warning?: string } | null
  const slotPromises: Array<Promise<ResolvedSlot>> = []

  for (let idx = 0; idx < plannedSlots.length; idx++) {
    const slot = plannedSlots[idx]
    if (slot.kind === "lexicon") {
      emit({
        type: "segment_done",
        index: idx,
        total: plannedSlots.length,
        customCompleted,
        customTotal: llmCustomCount,
        action: slot.meta.action,
        source: "lexicon",
        duration: slot.meta.duration,
      })
      slotPromises.push(Promise.resolve({ input: slot.input, meta: slot.meta }))
      continue
    }

    const prevSlotPromise = idx > 0 && plannedSlots[idx - 1].kind === "llm" ? slotPromises[idx - 1] : null
    slotPromises.push(
      (async (): Promise<ResolvedSlot> => {
        // 串行接力：若前一段也是 custom，等待其完成后提取真实 exitSummary，消除盲接
        const prevResolved = prevSlotPromise ? await prevSlotPromise : null
        const matched = retrievePoseExemplars(`${description}\n${slot.action}`, exemplarTopK)
        const exemplarsText = formatExemplarsForPrompt(matched)
        const exemplarIds = matched.map((e) => e.id)
        const storyContext = buildStoryContext(idx, prevResolved?.input.fragment)
        const targetDur = slot.duration ?? 3
        const dynamicRules = buildDynamicSegmentRules(slot.action, targetDur)

        let fragment = ""
        let accepted = false
        let lastError = ""
        let usedIntent = false

        if (preferIntent) {
          const intentFrag = await generateViaIntent(slot.action, targetDur, storyContext)
          if (intentFrag) {
            fragment = intentFrag
            accepted = true
            usedIntent = true
          }
        }

        // 编译期自愈：生成 → 编译验证 → 失败把错误喂回重试一次（最多 2 次 LLM 调用/段）
        for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
          try {
            const corrective =
              attempt === 0
                ? ""
                : `\n\nPREVIOUS ATTEMPT WAS REJECTED (must fix): ${lastError}. ` +
                  `Regenerate as strictly valid MPL: use only the listed actions/directions, only real bone names, ` +
                  `and make sure every @animation frame references a @pose defined in this segment.`
            const raw = await chat(client, segmentModel, [
              {
                role: "system",
                content:
                  fill(SEGMENT_PROMPT, {
                    description: slot.action,
                    duration: String(targetDur),
                    exemplars: exemplarsText,
                    storyContext,
                    dynamicRules,
                  }) +
                  conditioningBlock +
                  corrective,
              },
              { role: "user", content: `Segment: ${slot.action}` },
            ])
            fragment = stripCodeFences(raw)
            const duration = fragmentDuration(fragment)
            if (!fragment.includes("@animation") || duration <= 0) throw new Error("no animation frames")
            const problem = validateFragment(serverCompiler, fragment, fkBones)
            if (problem) throw new Error(problem)
            accepted = true
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e)
          }
        }

        // 弱模型兜底：自由 MPL2 两次均失败时，自动降级到结构化 Intent JSON，避免直接变成呆立 idle_stand
        if (!accepted && !preferIntent) {
          const intentFrag = await generateViaIntent(slot.action, targetDur, storyContext)
          if (intentFrag) {
            fragment = intentFrag
            accepted = true
            usedIntent = true
          }
        }

        customCompleted++
        if (accepted) {
          const duration = fragmentDuration(fragment)
          const finalDur = Math.max(duration, targetDur)
          emit({
            type: "segment_done",
            index: idx,
            total: plannedSlots.length,
            customCompleted,
            customTotal: llmCustomCount,
            action: slot.action,
            source: "llm",
            duration: finalDur,
          })
          return {
            input: { fragment, duration: finalDur },
            meta: { action: slot.action, source: "llm", duration: finalDur, mirror: slot.mirror, exemplars: exemplarIds, storyContext },
            warning: usedIntent && !preferIntent ? `custom segment "${slot.action}" recovered via intent compiler` : undefined,
          }
        }
        const idle = expandLexiconSegment("idle_stand", { hold: 1 })
        if (!idle) return null
        emit({
          type: "segment_done",
          index: idx,
          total: plannedSlots.length,
          customCompleted,
          customTotal: llmCustomCount,
          action: slot.action,
          source: "lexicon",
          duration: idle.duration,
        })
        return {
          input: { fragment: idle.fragment, duration: idle.duration },
          meta: { action: "idle_stand", source: "lexicon", duration: idle.duration, mirror: false },
          warning: `custom segment "${slot.action}" failed: ${lastError}; using idle_stand`,
        }
      })()
    )
  }

  const resolvedSlots = await Promise.all(slotPromises)

  const generateMs = Date.now() - generateT0
  const stitchInputs: StitchSegmentInput[] = []
  const segmentMeta: MetaEntry[] = []
  for (const r of resolvedSlots) {
    if (!r) continue
    stitchInputs.push(r.input)
    segmentMeta.push(r.meta)
    if (r.warning) warnings.push(r.warning)
  }

  if (stitchInputs.length === 0) {
    return { ok: false, status: 502, error: "No segments could be generated" }
  }

  // ---- Stage 3: STITCH + 运动学 Critic 自愈回路（穿地/浮空腿/肘部翻折/捂嘴遮眼检测 → 定向重生成 → 复核，最多 2 轮）
  emit({ type: "stage", stage: "stitching", message: "正在缝合长动作并执行运动学检查..." })
  const criticT0 = Date.now()
  const currentInputs = stitchInputs
  let stitched = stitchSegments(currentInputs, { seamless: true })
  const fkRepairs: Array<{ attempt: number; offending: number[]; fixed: number[]; summary: string }> = []
  let fkSummary: string | undefined
  let criticIssues: Array<{ code: string; message: string }> = []
  let lastCompiledVmd: Uint8Array | null = null

  if (serverCompiler && fkBones) {
    let prevSignature = ""
    for (let attempt = 1; attempt <= 2; attempt++) {
      let mpl2res: ReturnType<typeof compileMPL2>
      try {
        mpl2res = compileMPL2(serverCompiler, stitched.script, fkBones)
      } catch (e) {
        warnings.push(
          `server-side compile failed after stitch: ${e instanceof Error ? e.message : String(e)} — ` +
            "returning script anyway (client compile will surface the same error)"
        )
        break
      }
      if (mpl2res.vmd.length === 0) {
        warnings.push("server-side compile returned 0 bytes — stitched script may fail client compile")
        break
      }
      // 成品（增强 + 贴地烘焙）才是舞台实际播放的东西 → critic 看成品
      lastCompiledVmd = finalizeForStage(mpl2res.vmd, fkBones, stitched.script)
      const report = critiquePoseVmd(fkBones, lastCompiledVmd, stitched.script, stitched.timeline)
      if (!report) break
      fkSummary = report.summary
      criticIssues = report.issues.map((x) => ({ code: x.code, message: x.message }))
      emit({ type: "fk_check", attempt, passed: report.passed, summary: report.summary })
      if (report.passed) break

      const offending = report.offendingSegments.filter((s) => s.issues.some((i) => i.severity === "error"))
      if (offending.length === 0) break
      const sig = offending
        .map((o) => `${o.index}:${[...new Set(o.issues.filter((i) => i.severity === "error").map((i) => i.code))].sort().join(",")}`)
        .join("|")
      if (attempt > 1 && sig === prevSignature) {
        warnings.push(`Critic repair skipped duplicate attempt ${attempt} (${report.summary})`)
        break
      }
      prevSignature = sig
      // 只定向重生成 LLM/custom 源段；词库段是手工验证模板，有错误记 warning 提示人工修模板
      const fixable = offending.filter((o) => segmentMeta[o.index]?.source === "llm")
      const lexiconBad = offending.filter((o) => segmentMeta[o.index]?.source !== "llm")
      if (lexiconBad.length > 0) {
        warnings.push(
          `Critic: lexicon segment(s) [${lexiconBad.map((o) => o.index).join(",")}] flagged (${report.summary})`
        )
      }
      if (fixable.length === 0) break
      const fixed: number[] = []
      await Promise.all(
        fixable.map(async (o) => {
          const meta = segmentMeta[o.index]
          try {
            const errorLines = o.issues
              .filter((i) => i.severity === "error")
              .map((i) => `- ${i.message}. Fix: ${i.fixHint}`)
              .join("\n")
            const corrective =
              `\n\nPREVIOUS ATTEMPT FAILED KINEMATIC CHECKS (must fix all):\n${errorLines}`
            const prevExit = o.index > 0 ? summarizeFragmentExit(currentInputs[o.index - 1].fragment) : ""
            const storyCtx = prevExit
              ? `Story continuity — previous segment exit state: ${prevExit}`
              : (meta.storyContext ?? "")
            const matched = retrievePoseExemplars(`${description}\n${meta.action}`, 3)
            const fragment = await chat(client, repairModel, [
              {
                role: "system",
                content:
                  fill(SEGMENT_PROMPT, {
                    description: meta.action,
                    duration: String(meta.duration),
                    exemplars: formatExemplarsForPrompt(matched),
                    storyContext: storyCtx,
                    dynamicRules: buildDynamicSegmentRules(meta.action, meta.duration),
                  }) +
                  conditioningBlock +
                  corrective,
              },
              { role: "user", content: `Segment: ${meta.action}` },
            ])
            const cleaned = stripCodeFences(fragment)
            const dur = fragmentDuration(cleaned)
            if (!cleaned.includes("@animation") || dur <= 0) throw new Error("no animation frames")
            const problem = validateFragment(serverCompiler, cleaned, fkBones)
            if (problem) throw new Error(problem)
            currentInputs[o.index] = { fragment: cleaned, duration: Math.max(dur, meta.duration) }
            fixed.push(o.index)
          } catch { /* 保留原段，下一轮再试 */ }
        })
      )
      if (fixed.length === 0) break
      fkRepairs.push({ attempt, offending: offending.map((o) => o.index), fixed, summary: report.summary })
      emit({ type: "fk_repair", attempt, offending: offending.map((o) => o.index), fixed, summary: report.summary })
      warnings.push(`Critic repair attempt ${attempt}: segment(s) [${fixed.join(",")}] regenerated (${report.summary})`)
      stitched = stitchSegments(currentInputs, { seamless: true })
      try {
        const recompiled = compileMPL2(serverCompiler, stitched.script, fkBones)
        if (recompiled.vmd.length > 0) lastCompiledVmd = finalizeForStage(recompiled.vmd, fkBones, stitched.script)
      } catch { /* ignore */ }
    }
  }

  const criticMs = Date.now() - criticT0
  // ---- Stage 4: 可选 VLM 视觉 Critic 闭环（长动作自动启用多帧分镜 Storyboard，短动作沿用单帧三视图 → VLM 评审 → 至多 1 轮定向修补）
  const visualT0 = Date.now()
  let visualResult: VisualCriticVerdict | null = null
  let visualRefined = false
  let previewDataUrl: string | undefined
  const wantVisualCritic = Boolean(visualCritic) || process.env.ENABLE_VISUAL_CRITIC === "1"

  if (wantVisualCritic && serverCompiler && fkBones && lastCompiledVmd && lastCompiledVmd.length > 0) {
    const timelineMeta: StoryboardTimelineEntry[] = stitched.timeline.map((s) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      action: segmentMeta[s.index]?.action,
      source: segmentMeta[s.index]?.source,
    }))
    const useStoryboard = stitched.timeline.length >= 2 || stitched.totalDuration >= 5.0
    const storyboard = useStoryboard ? renderStoryboardPng(fkBones, lastCompiledVmd, timelineMeta, { maxTiles: 6 }) : null
    const rendered = !storyboard ? renderPoseMultiViewPng(fkBones, lastCompiledVmd) : null

    if (storyboard || rendered) {
      if (includePreview) previewDataUrl = storyboard ? storyboard.dataUrl : rendered!.dataUrl
      const criticMode: "single" | "storyboard" = storyboard ? "storyboard" : "single"
      const tileCount = storyboard ? storyboard.tiles.length : 1
      emit({
        type: "stage",
        stage: "visual_critic",
        message:
          criticMode === "storyboard"
            ? `正在进行 ${tileCount} 帧分镜视觉质检...`
            : "正在进行三视图视觉质检...",
      })
      emit({ type: "visual_critic_start", mode: criticMode, tileCount })

      const vlmModel = process.env.VLM_MODEL || model
      const vlmClient =
        process.env.VLM_API_KEY && process.env.VLM_API_BASE_URL
          ? new OpenAI({ apiKey: process.env.VLM_API_KEY, baseURL: process.env.VLM_API_BASE_URL })
          : client

      visualResult = await runVisualCritic({
        client: vlmClient,
        model: vlmModel,
        userDescription: description,
        mplScript: stitched.script,
        vmd: lastCompiledVmd,
        storyboard: storyboard ?? undefined,
        rendered: rendered ?? undefined,
      })

      if (visualResult.status === "needs_fix" && (visualResult.fixInstructions || visualResult.issues.length > 0)) {
        // 优先用多帧分镜 VLM 指定的目标段落，其次按时间戳落段，最后兜底最后一个 custom 段
        const hitSeg = stitched.timeline.find(
          (s) => visualResult!.timeSec >= s.start - 1e-6 && visualResult!.timeSec <= s.end + 1e-6
        )
        const lastLlmIdx = segmentMeta.reduce((acc, m, idx) => (m.source === "llm" ? idx : acc), -1)
        const explicitIdx =
          visualResult.targetSegmentIndex != null &&
          visualResult.targetSegmentIndex >= 0 &&
          visualResult.targetSegmentIndex < currentInputs.length
            ? visualResult.targetSegmentIndex
            : undefined
        const targetIdx = explicitIdx ?? hitSeg?.index ?? (lastLlmIdx >= 0 ? lastLlmIdx : 0)
        const safeIdx = targetIdx >= 0 && targetIdx < currentInputs.length ? targetIdx : 0
        const meta = segmentMeta[safeIdx]
        if (meta) {
          try {
            const targetAction = meta.source === "llm" ? meta.action : description
            const matched = retrievePoseExemplars(`${description}\n${targetAction}`, 3)
            const visualFeedback = [
              `\n\nVISUAL CRITIC REVIEW (score ${visualResult.score ?? "?"}/10 on segment #${safeIdx} — MUST REFINE):`,
              ...visualResult.issues.map((x) => `- Issue: ${x}`),
              visualResult.fixInstructions ? `- Fix instructions: ${visualResult.fixInstructions}` : "",
              `Generate a COMPLETE, strictly valid MPL2 fragment matching the user request ("${description}"). Use only valid MPL2 syntax ("head sway" instead of "head tilt", "reach hand_r to peace_r;" for cheek V-sign), and keep feet grounded and arms natural without clipping.`,
            ]
              .filter(Boolean)
              .join("\n")

            const refinedRaw = await chat(client, repairModel, [
              {
                role: "system",
                content:
                  fill(SEGMENT_PROMPT, {
                    description: targetAction,
                    duration: String(meta.duration),
                    exemplars: formatExemplarsForPrompt(matched),
                    storyContext:
                      safeIdx > 0
                        ? `Story continuity — previous segment exit state: ${summarizeFragmentExit(currentInputs[safeIdx - 1].fragment)}`
                        : (meta.storyContext ?? ""),
                    dynamicRules: buildDynamicSegmentRules(targetAction, meta.duration),
                  }) +
                  conditioningBlock +
                  visualFeedback,
              },
              { role: "user", content: `Refine segment #${safeIdx} for user request: ${description}` },
            ])
            const cleaned = stripCodeFences(refinedRaw)
            const dur = fragmentDuration(cleaned)
            if (!cleaned.includes("@animation") || dur <= 0) {
              warnings.push("Visual Critic refine produced no animation frames; kept initial version")
            } else {
              const problem = validateFragment(serverCompiler, cleaned, fkBones)
              if (problem) {
                warnings.push(`Visual Critic refine rejected (${problem}); kept initial version`)
              } else {
                const candidateInputs = [...currentInputs]
                candidateInputs[safeIdx] = { fragment: cleaned, duration: Math.max(dur, meta.duration) }
                const candStitched = stitchSegments(candidateInputs, { seamless: true })
                const candCompiled = compileMPL2(serverCompiler, candStitched.script, fkBones)
                const candFinal = finalizeForStage(candCompiled.vmd, fkBones, candStitched.script)
                const candCritic = critiquePoseVmd(fkBones, candFinal, candStitched.script, candStitched.timeline)
                if (candCompiled.vmd.length > 0 && candCritic?.passed) {
                  currentInputs[safeIdx] = candidateInputs[safeIdx]
                  stitched = candStitched
                  lastCompiledVmd = candFinal
                  fkSummary = candCritic.summary
                  criticIssues = candCritic.issues.map((x) => ({ code: x.code, message: x.message }))
                  segmentMeta[safeIdx] = {
                    ...meta,
                    source: "llm",
                    exemplars: matched.map((e) => e.id),
                  }
                  visualRefined = true
                  warnings.push(
                    `Visual Critic refined segment [${safeIdx}] (initial score ${visualResult.score ?? "?"}/10)`
                  )
                  if (includePreview) {
                    const nextMeta: StoryboardTimelineEntry[] = candStitched.timeline.map((s) => ({
                      index: s.index,
                      start: s.start,
                      end: s.end,
                      action: segmentMeta[s.index]?.action,
                      source: segmentMeta[s.index]?.source,
                    }))
                    const rerendered =
                      criticMode === "storyboard"
                        ? renderStoryboardPng(fkBones, candFinal, nextMeta, { maxTiles: 6 })
                        : renderPoseMultiViewPng(fkBones, candFinal)
                    if (rerendered) previewDataUrl = rerendered.dataUrl
                  }
                } else if (candCritic && !candCritic.passed) {
                  warnings.push(`Visual Critic refine failed kinematic check (${candCritic.summary}); kept initial version`)
                }
              }
            }
          } catch {
            // 视觉修补异常时安全保留原通过运动学门禁的版本
          }
        }
      }

      emit({
        type: "visual_critic_done",
        status: visualResult.status,
        mode: visualResult.mode,
        tileCount: visualResult.tileCount,
        score: visualResult.score,
        refined: visualRefined,
        targetSegmentIndex: visualResult.targetSegmentIndex,
        reason: visualResult.reason,
      })
    }
  }

  const visualMs = wantVisualCritic ? Date.now() - visualT0 : 0
  const totalMs = Date.now() - pipelineT0
  const { output, ...macroReport } = desugarMPL(stitched.script)

  return {
    ok: true,
    payload: {
      mpl: output,
      plan: { segments: segmentMeta, warnings },
      timeline: stitched.timeline,
      totalDuration: stitched.totalDuration,
      timing: { planMs, generateMs, criticMs, visualMs, totalMs },
      macroReport,
      fk: fkSummary ? { summary: fkSummary, repairs: fkRepairs } : undefined,
      critic: fkSummary ? { summary: fkSummary, issues: criticIssues } : undefined,
      visualCritic: visualResult
        ? {
            status: visualResult.status,
            pass: visualResult.pass,
            mode: visualResult.mode,
            tileCount: visualResult.tileCount,
            score: visualResult.score,
            targetSegmentIndex: visualResult.targetSegmentIndex,
            issues: visualResult.issues,
            fixInstructions: visualResult.fixInstructions,
            reason: visualResult.reason,
            refined: visualRefined,
            frame: visualResult.frame,
            timeSec: visualResult.timeSec,
            model: visualResult.model,
            previewDataUrl,
          }
        : undefined,
    },
  }
}

export async function POST(request: Request) {
  if (!process.env.AI_MODEL || !process.env.AI_API_KEY || !process.env.AI_API_BASE_URL) {
    return Response.json({ error: "Missing required environment variables" }, { status: 500 })
  }

  try {
    const body = await request.json()
    const { description, conditioning, modelBones, visualCritic, includePreview, intentMode, stream } = body
    if (typeof description !== "string" || description.trim().length === 0) {
      return Response.json({ error: "description is required" }, { status: 400 })
    }

    const wantStream = Boolean(stream) || Boolean(request.headers.get("accept")?.includes("text/event-stream"))
    const pipelineInput: PipelineRequest = {
      description,
      conditioning,
      modelBones,
      visualCritic,
      includePreview,
      intentMode,
    }

    if (wantStream) {
      const encoder = new TextEncoder()
      const sseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const emit = (event: LongMotionStreamEvent) => {
            try {
              controller.enqueue(encoder.encode(encodeSseEvent(event)))
            } catch {
              // ignore if client disconnected
            }
          }
          try {
            const res = await executeLongPosePipeline(pipelineInput, emit)
            if (res.ok) {
              emit({ type: "complete", payload: res.payload })
            } else {
              emit({ type: "error", error: res.error, status: res.status })
            }
          } catch (error) {
            console.log("Error generating long animation (SSE):", error)
            emit({ type: "error", error: "Failed to generate long animation", status: 500 })
          } finally {
            try {
              controller.close()
            } catch {
              // already closed
            }
          }
        },
      })
      return new Response(sseStream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      })
    }

    const res = await executeLongPosePipeline(pipelineInput)
    if (!res.ok) {
      return Response.json(
        { error: res.error, plannerError: res.plannerError },
        { status: res.status }
      )
    }
    return Response.json(res.payload)
  } catch (error) {
    console.log("Error generating long animation:", error)
    return Response.json({ error: "Failed to generate long animation", mpl: "" }, { status: 500 })
  }
}
