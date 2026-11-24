/**
 * long-motion.ts — Phase 1 分段拼装（纯函数，无 LLM / 无 IO，可独立测试）
 *
 * 职责（对应路线图 §1.2 Stage 3）：
 *  - 解析词库/LLM 生成的 MPL 片段
 *  - 逐段重命名姿势（避免跨段重名，编译器对重复姿势名直接报错）
 *  - 时间戳平移拼接成单个 @animation；接缝处留 GAP 给引擎插值
 *    （不用 `a & b` 复合接缝：同骨骼语句合并正是 main 组合碰撞的病灶，绕开它）
 *  - Plan 归一化：钳制段数/总时长，过滤未知动作
 */

export const STITCH_GAP = 0.25 // 接缝过渡时长（秒），引擎在该区间做姿势插值
export const MAX_SEGMENTS = 40
export const MAX_TOTAL_DURATION = 120

export interface ParsedFragment {
  poses: Array<{ name: string; headerLine: string; bodyLines: string[] }>
  animName: string
  frames: Array<{ time: number; refs: string[] }>
}

/** 解析一个 MPL 片段（若干 @pose + 一个 @animation；忽略 main） */
export function parseFragment(fragment: string): ParsedFragment {
  const poses: ParsedFragment["poses"] = []
  const frames: ParsedFragment["frames"] = []
  let animName = ""
  let blockType: "pose" | "animation" | "main" | null = null
  let brace = 0
  let currentPose: ParsedFragment["poses"][number] | null = null

  for (const line of fragment.split("\n")) {
    const t = line.trim()
    if (t.startsWith("@pose")) {
      const name = t.split(/\s+/)[1]?.replace("{", "").trim() ?? ""
      currentPose = { name, headerLine: line, bodyLines: [] }
      poses.push(currentPose)
      blockType = "pose"
      brace = 0
    } else if (t.startsWith("@animation")) {
      animName = t.split(/\s+/)[1]?.replace("{", "").trim() ?? ""
      blockType = "animation"
      brace = 0
    } else if (t.startsWith("main")) {
      blockType = "main"
      brace = 0
    }

    if (t === "" ) continue
    brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length

    if (blockType === "pose" && currentPose && !t.startsWith("@pose")) {
      if (t !== "{" && t !== "}") currentPose.bodyLines.push(line)
    } else if (blockType === "animation") {
      const m = t.match(/^([\d.]+)\s*:\s*(.+?);$/)
      if (m) frames.push({ time: parseFloat(m[1]), refs: m[2].split("&").map((s) => s.trim()) })
    }

    if (brace <= 0 && t.includes("}")) {
      if (blockType === "pose") currentPose = null
      blockType = null
    }
  }
  return { poses, animName, frames }
}

export interface StitchSegmentInput {
  fragment: string
  /** 段的规划时长；取 max(片段实际末帧, 规划时长) 作为下一段的起点 */
  duration?: number
}

export interface StitchOptions {
  /**
   * 剧情长动作无缝拼装模式：
   *  - 剥除后续段首帧的纯 reset 立正占位帧，实现末姿到下一段起手式的直接衔接
   *  - 对上一段改动而本段未提及的骨骼/通道自动补齐 reset（防止蹲姿/歪腕/扭转残留）
   *  - 对上一段活跃而本段未重申的 face 表情自动注入 weight=0 淡出（防止幽灵表情粘连）
   *  - 根据姿态跨度自动放宽过渡窗（手势 0.4s，下蹲/坐/走近等下肢切换 0.75s）
   *  - 规划时长大于末帧时显式拉长末尾保持帧（衔接 vmd-enhancer 呼吸微动）
   */
  seamless?: boolean
}

export interface StitchResult {
  script: string
  timeline: Array<{ index: number; start: number; end: number }>
  totalDuration: number
}

const FINGERS_L = ["thumb_l", "index_l", "middle_l", "ring_l", "pinky_l"]
const FINGERS_R = ["thumb_r", "index_r", "middle_r", "ring_r", "pinky_r"]
const LOWER_BODY_BONES = new Set(["base", "center", "leg_l", "leg_r", "knee_l", "knee_r", "ankle_l", "ankle_r"])

interface PoseStateInfo {
  coveredBones: Set<string>
  activeBones: Set<string>
  explicitResets: Set<string>
  morphs: Map<string, number>
  isPureReset: boolean
}

function inspectPoseBody(bodyLines: string[]): PoseStateInfo {
  const coveredBones = new Set<string>()
  const activeBones = new Set<string>()
  const explicitResets = new Set<string>()
  const morphs = new Map<string, number>()
  let hasNonResetAction = false

  for (const raw of bodyLines) {
    const t = raw.trim()
    if (!t || t.startsWith("//")) continue
    const fm = t.match(/^face\s+(\S+)\s+([\d.]+)\s*;$/i)
    if (fm) {
      const w = parseFloat(fm[2])
      if (w > 0) morphs.set(fm[1], w)
      hasNonResetAction = true
      continue
    }
    const rm = t.match(/^reach\s+hand_(l|r)\s+to\b/i)
    if (rm) {
      const side = rm[1].toLowerCase()
      const fingers = side === "l" ? FINGERS_L : FINGERS_R
      for (const b of [`arm_${side}`, `elbow_${side}`, `wrist_${side}`, `arm_twist_${side}`, ...fingers]) {
        coveredBones.add(b)
        activeBones.add(b)
      }
      hasNonResetAction = true
      continue
    }
    const hm = t.match(/^hand_(l|r)\s+([a-z0-9_]+)\s*;$/i)
    if (hm) {
      const side = hm[1].toLowerCase()
      for (const f of side === "l" ? FINGERS_L : FINGERS_R) {
        coveredBones.add(f)
        activeBones.add(f)
      }
      hasNonResetAction = true
      continue
    }
    const am = t.match(/^aim\s+(head|eyes)\s+at\b/i)
    if (am) {
      const b = am[1].toLowerCase()
      coveredBones.add(b)
      activeBones.add(b)
      hasNonResetAction = true
      continue
    }
    if (/^plant\s+(feet|foot_l|foot_r)\s*;$/i.test(t)) {
      coveredBones.add("center")
      continue
    }
    const bm = t.match(/^([a-z0-9_]+)\s+(.+?);$/i)
    if (bm) {
      const bone = bm[1].toLowerCase()
      const rest = bm[2].trim().toLowerCase()
      coveredBones.add(bone)
      if (rest === "reset") {
        explicitResets.add(bone)
      } else if (bone === "center") {
        // Horizontal stage locomotion (center move forward/left/right) is preserved across scenes;
        // only vertical crouch (up/down) or rotation needs cross-segment reset when returning to standing.
        if (/\bmove\s+(up|down)\b|\b(bend|turn|sway)\b/.test(rest)) {
          activeBones.add(bone)
          hasNonResetAction = true
        }
      } else {
        activeBones.add(bone)
        hasNonResetAction = true
      }
    }
  }

  return { coveredBones, activeBones, explicitResets, morphs, isPureReset: !hasNonResetAction }
}

function mergeFramePoseState(refs: string[], poseInfoMap: Map<string, PoseStateInfo>): {
  coveredBones: Set<string>
  activeBones: Set<string>
  explicitResets: Set<string>
  morphs: Map<string, number>
  isPureReset: boolean
} {
  const coveredBones = new Set<string>()
  const activeBones = new Set<string>()
  const explicitResets = new Set<string>()
  const morphs = new Map<string, number>()
  let isPureReset = refs.length > 0
  for (const r of refs) {
    const info = poseInfoMap.get(r)
    if (!info) {
      isPureReset = false
      continue
    }
    if (!info.isPureReset) isPureReset = false
    for (const b of info.coveredBones) coveredBones.add(b)
    for (const b of info.activeBones) activeBones.add(b)
    for (const b of info.explicitResets) explicitResets.add(b)
    for (const [m, w] of info.morphs) morphs.set(m, w)
  }
  return { coveredBones, activeBones, explicitResets, morphs, isPureReset }
}

function computeAdaptiveGap(prevActiveBones: Set<string>, currState: ReturnType<typeof mergeFramePoseState>): number {
  const prevLower = [...prevActiveBones].some((b) => LOWER_BODY_BONES.has(b))
  const currLower = [...currState.activeBones].some((b) => LOWER_BODY_BONES.has(b))
  // Count symmetric difference between active bone sets to gauge transition inertia
  let diffCount = 0
  for (const b of prevActiveBones) if (!currState.activeBones.has(b)) diffCount++
  for (const b of currState.activeBones) if (!prevActiveBones.has(b)) diffCount++

  if (prevLower && currLower && diffCount >= 4) return 0.85
  if (prevLower || currLower) return 0.75
  if (diffCount >= 6) return 0.5
  if (currState.activeBones.size >= 4 || prevActiveBones.size >= 4) return 0.4
  return STITCH_GAP
}

/**
 * 把若干片段缝合为一个完整 MPL 脚本。
 * 默认时间语义保持向后兼容：段 i 的首帧落在 cursor + STITCH_GAP。
 * 传入 `{ seamless: true }` 启用剧情长动作无缝拼装（消去回正卡顿、残余骨骼归零、表情淡出、自适应过渡窗）。
 */
export function stitchSegments(segments: StitchSegmentInput[], opts?: StitchOptions): StitchResult {
  const seamless = Boolean(opts?.seamless)
  const allPoses: string[] = []
  const frameLines: string[] = []
  const timeline: StitchResult["timeline"] = []
  let cursor = 0
  const runningActiveBones = new Set<string>()
  const runningActiveMorphs = new Set<string>()
  let emittedSegments = 0

  segments.forEach((seg, i) => {
    const parsed = parseFragment(seg.fragment)
    if (parsed.frames.length === 0) return
    const prefix = `s${i}_`
    const rename = new Map<string, string>()
    const poseInfoMap = new Map<string, PoseStateInfo>()
    for (const pose of parsed.poses) {
      rename.set(pose.name, prefix + pose.name)
      poseInfoMap.set(pose.name, inspectPoseBody(pose.bodyLines))
    }

    // 规范化段内帧序列；seamless 模式下从第 2 段起若首帧是纯 reset 占位帧，则直接跳入首表演帧
    let framesToEmit = parsed.frames
    let trimOffset = 0
    if (seamless && emittedSegments > 0 && parsed.frames.length > 1) {
      const f0State = mergeFramePoseState(parsed.frames[0].refs, poseInfoMap)
      if (f0State.isPureReset && parsed.frames[1].time > 0 && parsed.frames[1].time <= 1.2) {
        trimOffset = parsed.frames[1].time
        framesToEmit = parsed.frames.slice(1).map((f) => ({
          time: Number(Math.max(0, f.time - trimOffset).toFixed(2)),
          refs: f.refs,
        }))
      }
    }

    // 检查段内未引用的姿势仍可按需保留，仅在 seamless 下跳过已被剥离的纯 reset 占位姿势块
    const usedOrigNames = new Set(framesToEmit.flatMap((f) => f.refs))
    for (const pose of parsed.poses) {
      if (seamless && !usedOrigNames.has(pose.name) && poseInfoMap.get(pose.name)?.isPureReset) {
        continue
      }
      const newName = rename.get(pose.name) ?? pose.name
      const header = pose.headerLine.replace(/(@pose\s+)[^\s{]+/, `$1${newName}`)
      allPoses.push([header, ...pose.bodyLines, "}"].join("\n"))
    }

    const entryState = mergeFramePoseState(framesToEmit[0].refs, poseInfoMap)
    const gap =
      emittedSegments === 0
        ? 0
        : seamless
          ? computeAdaptiveGap(runningActiveBones, entryState)
          : STITCH_GAP
    const start = emittedSegments === 0 ? 0 : Number((cursor + gap).toFixed(2))

    // 状态感知：为上一段留下、但本段起点未触及的骨骼补 reset，并对残留表情写入 weight=0 淡出
    let syncPoseName: string | null = null
    if (seamless && emittedSegments > 0) {
      const syncLines: string[] = []
      for (const bone of [...runningActiveBones].sort()) {
        if (!entryState.coveredBones.has(bone)) {
          syncLines.push(`    ${bone} reset;`)
        }
      }
      for (const m of [...runningActiveMorphs].sort()) {
        if (m !== "まばたき" && !entryState.morphs.has(m)) {
          syncLines.push(`    face ${m} 0;`)
        }
      }
      if (syncLines.length > 0) {
        syncPoseName = `s${i}_entry_sync`
        allPoses.push([`@pose ${syncPoseName} {`, ...syncLines, "}"].join("\n"))
      }
      for (const b of [...runningActiveBones]) {
        if (!entryState.coveredBones.has(b)) runningActiveBones.delete(b)
      }
      for (const m of [...runningActiveMorphs]) {
        if (m !== "まばたき" && !entryState.morphs.has(m)) runningActiveMorphs.delete(m)
      }
    }

    let last = start
    let lastOrigRefs = framesToEmit[framesToEmit.length - 1].refs
    framesToEmit.forEach((f, idx) => {
      const t = Number((start + f.time).toFixed(2))
      const renamedRefs = f.refs.map((r) => rename.get(r) ?? r)
      const st = mergeFramePoseState(f.refs, poseInfoMap)
      const refs: string[] = []

      if (idx === 0 && syncPoseName) {
        refs.push(syncPoseName)
      } else if (seamless && idx > 0 && st.morphs.size > 0) {
        // 段内多拍表情互斥归零：当前帧显式设置了表情时，淡出此前活跃但本帧未提及的非眨眼 morph
        const staleMorphs = [...runningActiveMorphs]
          .filter((m) => m !== "まばたき" && !st.morphs.has(m))
          .sort()
        if (staleMorphs.length > 0) {
          const morphSyncName = `s${i}_f${idx}_morph_sync`
          allPoses.push([`@pose ${morphSyncName} {`, ...staleMorphs.map((m) => `    face ${m} 0;`), "}"].join("\n"))
          refs.push(morphSyncName)
          for (const m of staleMorphs) runningActiveMorphs.delete(m)
        }
      }

      refs.push(...renamedRefs)
      frameLines.push(`    ${t.toFixed(2)}: ${refs.join(" & ")};`)
      last = Math.max(last, t)
      lastOrigRefs = f.refs

      for (const b of st.explicitResets) runningActiveBones.delete(b)
      for (const b of st.activeBones) runningActiveBones.add(b)
      for (const [m, w] of st.morphs) {
        if (w > 0) runningActiveMorphs.add(m)
        else runningActiveMorphs.delete(m)
      }
    })

    // 若 Planner 分配时长 > 片段实际结尾，仅允许短暂呼吸缓冲（≤ 0.45s），严禁 1.5s 以上僵直定格
    const effectiveSegDuration = Math.max(0, (seg.duration ?? 0) - trimOffset)
    const plannedEnd = Number((start + effectiveSegDuration).toFixed(2))
    const cappedEnd = seamless ? Math.min(plannedEnd, Number((last + 0.45).toFixed(2))) : plannedEnd
    if (seamless && cappedEnd - last >= 0.4) {
      const holdRefs = lastOrigRefs.map((r) => rename.get(r) ?? r)
      frameLines.push(`    ${cappedEnd.toFixed(2)}: ${holdRefs.join(" & ")};`)
      last = cappedEnd
    }

    cursor = seamless ? last : Math.max(last, plannedEnd)
    timeline.push({ index: i, start: Number(start.toFixed(2)), end: Number(cursor.toFixed(2)) })
    emittedSegments++
  })

  if (frameLines.length === 0) {
    throw new Error("No frames to stitch: all segments were empty")
  }

  const script = [
    ...allPoses,
    "",
    "@animation long_sequence {",
    ...frameLines,
    "}",
    "",
    "main {",
    "    long_sequence;",
    "}",
    "",
  ].join("\n")

  return { script, timeline, totalDuration: Number(cursor.toFixed(2)) }
}

/**
 * 提取片段最后关键帧的简洁姿态摘要（用于长剧情相邻段上下文衔接 Prompt）。
 */
export function summarizeFragmentExit(fragment: string): string {
  const parsed = parseFragment(fragment)
  if (parsed.frames.length === 0) return ""
  const lastFrame = parsed.frames[parsed.frames.length - 1]
  const poseMap = new Map(parsed.poses.map((p) => [p.name, p.bodyLines]))
  const lines = lastFrame.refs.flatMap((r) => poseMap.get(r) ?? [])
  const info = inspectPoseBody(lines)

  const stance = info.activeBones.has("base")
    ? "lying"
    : info.activeBones.has("leg_l") || info.activeBones.has("leg_r") || info.activeBones.has("knee_l") || info.activeBones.has("knee_r")
      ? "kneeling/sitting/stepping"
      : "standing"
  const reaches = lines
    .map((l) => l.trim().match(/^reach\s+(hand_[lr])\s+to\s+([^;]+)/i))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => `${m[1]}->${m[2].trim()}`)
  const morphs = [...info.morphs.entries()].map(([n, w]) => `${n}(${w})`)
  const parts = [`stance=${stance}`]
  if (reaches.length > 0) parts.push(`hands=[${reaches.join(", ")}]`)
  if (morphs.length > 0) parts.push(`face=[${morphs.join(", ")}]`)
  return parts.join("; ")
}

// ---------------------------------------------------------------------------
// Plan 归一化
// ---------------------------------------------------------------------------

export interface RawSegment {
  action?: unknown
  params?: unknown
  mirror?: unknown
  duration?: unknown
}

export interface NormalizedSegment {
  action: string
  params: Record<string, number>
  mirror: boolean
  duration?: number
  /** true = 词库外动作：保留原始描述文本，Stage 2 由 LLM 现场生成（上限 MAX_CUSTOM_SEGMENTS） */
  custom: boolean
}

export interface NormalizeResult {
  segments: NormalizedSegment[]
  warnings: string[]
  totalDuration: number
}

/** 词库外（LLM 兜底生成）动作的段数上限——支持 30s 剧情多拍演出同时保留成本护栏 */
export const MAX_CUSTOM_SEGMENTS = 8

/**
 * 归一化 LLM 输出的剧本 JSON：
 *  - 已知 action：直接命中
 *  - 未知 action：先尝试词表内模糊匹配（如 "wave" → "wave_hand"）；
 *    仍失败则**保留为 custom 段**（不丢弃！），由 Stage 2 LLM 现场生成，
 *    超出 MAX_CUSTOM_SEGMENTS 的才丢弃并记 warning
 *  - 钳制段数 ≤ MAX_SEGMENTS、总时长 ≤ MAX_TOTAL_DURATION
 */
export function normalizePlan(raw: unknown, knownActions: string[]): NormalizeResult {
  const warnings: string[] = []
  const segments: NormalizedSegment[] = []
  const rawList: RawSegment[] = Array.isArray((raw as { segments?: unknown })?.segments)
    ? ((raw as { segments: RawSegment[] }).segments)
    : Array.isArray(raw)
      ? (raw as RawSegment[])
      : []

  let customCount = 0
  for (const s of rawList) {
    if (segments.length >= MAX_SEGMENTS) { warnings.push(`plan truncated at ${MAX_SEGMENTS} segments`); break }
    const action = typeof s.action === "string" ? s.action.trim().toLowerCase() : ""
    if (!action) continue
    let matched = knownActions.includes(action) ? action : null
    let custom = false
    if (!matched) {
      // 仅对短别名（≤2 词，如 "wave" → "wave_hand"）做词元模糊匹配，绝不劫持带 "cheerful"/"elbow" 等词的长描述句
      const words = action.split(/[\s_]+/).filter(Boolean)
      const compact = action.replace(/[_\s-]+/g, "")
      if (words.length <= 2) {
        matched =
          knownActions.find((k) => {
            const tokens = k.split("_")
            return tokens.includes(action) || (words.length === 1 && tokens.includes(words[0])) || k.replace(/[_\s-]+/g, "") === compact
          }) ?? null
      }
      if (matched) {
        warnings.push(`unknown action "${action}" matched to "${matched}"`)
      } else if (customCount < MAX_CUSTOM_SEGMENTS) {
        // 词库外动作：保留给 Stage 2 LLM 兜底生成（不做语法断言，LLM 生成后由编译器校验）
        matched = action
        custom = true
        customCount++
      } else {
        warnings.push(`dropped unknown action "${action}" (custom cap ${MAX_CUSTOM_SEGMENTS})`)
        continue
      }
    }
    const params: Record<string, number> = {}
    if (s.params && typeof s.params === "object") {
      for (const [k, v] of Object.entries(s.params as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) params[k] = v
      }
    }
    const duration = typeof s.duration === "number" && s.duration > 0 ? s.duration : undefined
    segments.push({ action: matched, params, mirror: s.mirror === true, duration, custom })
  }

  // 总时长钳制
  let total = 0
  const clipped: NormalizedSegment[] = []
  for (const seg of segments) {
    if (total >= MAX_TOTAL_DURATION) { warnings.push(`plan clipped at ${MAX_TOTAL_DURATION}s`); break }
    clipped.push(seg)
    total += seg.duration ?? 3 // 未标时长按 3s 估计
  }

  return { segments: clipped, warnings, totalDuration: Number(total.toFixed(2)) }
}

/** 从 LLM 文本中稳健提取第一个平衡的 JSON 对象 */
export function extractJSON(text: string): unknown | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === "\\") esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- 穿地段落定位（自愈回路用）

export interface PenetratingSegment {
  index: number
  /** 该段内穿地帧的时间（秒，30fps 换算） */
  times: number[]
  /** 这些帧上最低的腰部 y */
  lowestY: number
  /** 这些帧上最低的末端骨骼 y（手腕/足首/足先） */
  lowestTerminalY: number
}

/**
 * 把 FK 穿地帧映射回拼装时间轴上的责任段落。
 * frames（fk.ts 的逐帧报告）× timeline（stitchSegments 输出）→ 段索引列表。
 */
export function findOffendingSegments(
  frames: Array<{ frame: number; centerY: number | null; terminals?: Record<string, number> }>,
  timeline: Array<{ index: number; start: number; end: number }>,
  opts: { centerYThreshold?: number; terminalYThreshold?: number } = {}
): PenetratingSegment[] {
  const centerThreshold = opts.centerYThreshold ?? 0 // 腰低于地面即视为该段责任
  const terminalThreshold = opts.terminalYThreshold ?? -0.5 // 与 fk.ts DEFAULT 容差一致
  const byIndex = new Map<number, { times: number[]; lowestY: number; lowestTerminalY: number }>()
  for (const f of frames) {
    const termVals = f.terminals ? Object.values(f.terminals) : []
    const minTerm = termVals.length > 0 ? Math.min(...termVals) : Infinity
    const centerPen = f.centerY != null && f.centerY < centerThreshold
    const termPen = minTerm < terminalThreshold
    if (!centerPen && !termPen) continue
    const t = f.frame / 30
    const seg = timeline.find((s) => t >= s.start - 1e-6 && t <= s.end + 1e-6)
    if (!seg) continue
    let entry = byIndex.get(seg.index)
    if (!entry) {
      entry = { times: [], lowestY: Infinity, lowestTerminalY: Infinity }
      byIndex.set(seg.index, entry)
    }
    entry.times.push(t)
    if (f.centerY != null) entry.lowestY = Math.min(entry.lowestY, f.centerY)
    if (Number.isFinite(minTerm)) entry.lowestTerminalY = Math.min(entry.lowestTerminalY, minTerm)
  }
  return [...byIndex.entries()]
    .map(([index, v]) => ({ index, times: v.times, lowestY: v.lowestY, lowestTerminalY: v.lowestTerminalY }))
    .sort((a, b) => a.index - b.index)
}

// ---------------------------------------------------------------- SSE 流式进度协议（Phase L3）

export type LongMotionStreamEvent =
  | { type: "stage"; stage: "planning" | "generating" | "stitching" | "visual_critic"; message: string }
  | {
      type: "plan_done"
      segmentCount: number
      customCount: number
      totalDuration: number
      segments: Array<{ index: number; action: string; source: "lexicon" | "llm"; duration?: number }>
    }
  | {
      type: "segment_done"
      index: number
      total: number
      customCompleted: number
      customTotal: number
      action: string
      source: "lexicon" | "llm"
      duration: number
    }
  | { type: "fk_check"; attempt: number; passed: boolean; summary: string }
  | { type: "fk_repair"; attempt: number; offending: number[]; fixed: number[]; summary: string }
  | { type: "visual_critic_start"; mode: "single" | "storyboard"; tileCount: number }
  | {
      type: "visual_critic_done"
      status: "passed" | "needs_fix" | "skipped"
      mode?: "single" | "storyboard"
      tileCount?: number
      score?: number
      refined: boolean
      targetSegmentIndex?: number
      reason?: string
    }
  | { type: "complete"; payload: Record<string, unknown> }
  | { type: "error"; error: string; status?: number }

export function encodeSseEvent(event: LongMotionStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** 增量解析 SSE 文本块；返回本批完整解析出的事件与尚未闭合的剩余缓冲。 */
export function parseSseBuffer(buffer: string): {
  events: LongMotionStreamEvent[]
  rest: string
} {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  const rest = parts.pop() ?? ""
  const events: LongMotionStreamEvent[] = []
  for (const frame of parts) {
    const dataLines: string[] = []
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length === 0) continue
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as LongMotionStreamEvent
      if (parsed && typeof parsed.type === "string") events.push(parsed)
    } catch {
      // ignore malformed SSE chunk
    }
  }
  return { events, rest }
}
