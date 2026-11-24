/**
 * pose-critic.ts — Phase 1 Harness 运动学质量门禁（零 LLM 成本）
 *
 * 在编译产物上用付与感知 FK 做纯数学解剖学检查，拦截“语法合法、也不穿地，
 * 但 3D 姿态明显反解剖或不到位”的生成结果（如：捂嘴时手肘翻到头顶、手挡住眼睛、
 * 站姿严重失衡），并返回可归因到段落的精准修复建议。
 */

import { detectPosSemantics, restWorldPositions } from "./model-geometry.ts"
import {
  analyzeGroundContactKeys,
  buildBoneTracks,
  integerFrames,
  qRotate,
  readVmdBoneKeys,
  sampleBoneTracks,
  samplePoseTransforms,
  solveFrameTransforms,
} from "./fk.ts"
import type { Vec3, VmdBoneKey } from "./fk.ts"
import type { PmxBones } from "./pmx-bones.ts"
import { secondsToFrame } from "./vmd-morph.ts"

export type CriticIssueCode =
  | "ground_penetration"
  | "floating_foot"
  | "elbow_above_shoulder"
  | "hand_blocking_eyes"
  | "body_clipping"
  | "spine_imbalance"

function distPointToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const abz = b.z - a.z
  const ab2 = abx * abx + aby * aby + abz * abz
  const t =
    ab2 > 1e-6
      ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / ab2))
      : 0
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t))
}

export interface PoseCritiqueIssue {
  code: CriticIssueCode
  segmentIndex?: number
  frame: number
  time: number
  severity: "error" | "warn"
  message: string
  fixHint: string
  /** 连续多帧命中同一问题时：末帧号与命中帧数（相邻帧已合并成一条） */
  frameEnd?: number
  frameCount?: number
}

/** 检查器的取帧方式：interpolated = 舞台实际渲染的每一帧（关键帧之间按引擎规则插值）；keyframes = 只看关键帧。 */
export type CriticSampling = "interpolated" | "keyframes"

export interface CriticOptions {
  /** 缺省 "interpolated"（与舞台一致）；"keyframes" 为旧行为（step-hold，只看关键帧） */
  sampling?: CriticSampling
}

export interface CriticOffendingSegment {
  index: number
  times: number[]
  issues: PoseCritiqueIssue[]
  lowestY: number
  lowestTerminalY: number
}

export interface PoseCritiqueReport {
  passed: boolean
  issues: PoseCritiqueIssue[]
  offendingSegments: CriticOffendingSegment[]
  summary: string
  /** 本次检查的取帧方式（见 CriticSampling） */
  sampling?: CriticSampling
}

interface ParsedAnimRef {
  frame: number
  refs: string[]
}

export function parsePoseTextsAndTimeline(mplSource: string): {
  poseBodyByName: Map<string, string>
  frames: ParsedAnimRef[]
} {
  const poseBodyByName = new Map<string, string>()
  const frames: ParsedAnimRef[] = []
  const lines = mplSource.split("\n")
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t.startsWith("@pose")) {
      const start = i
      const name = t.split(/\s+/)[1]?.replace("{", "").trim() ?? ""
      const body: string[] = []
      let depth = 0
      for (let j = start; j < lines.length; j++) {
        depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
        if (j > start && !lines[j].trim().startsWith("}")) body.push(lines[j])
        i = j + 1
        if (depth <= 0 && (j > start || lines[j].includes("{"))) break
      }
      if (name) poseBodyByName.set(name, body.join("\n"))
      continue
    }
    if (t.startsWith("@animation")) {
      const start = i
      let depth = 0
      for (let j = start; j < lines.length; j++) {
        depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
        if (j > start) {
          const m = lines[j].trim().match(/^([\d.]+)\s*:\s*(.+?);$/)
          if (m) {
            frames.push({
              frame: secondsToFrame(parseFloat(m[1])),
              refs: m[2].split("&").map((s) => s.trim()),
            })
          }
        }
        i = j + 1
        if (depth <= 0 && (j > start || lines[j].includes("{"))) break
      }
      continue
    }
    i++
  }
  return { poseBodyByName, frames }
}

function segmentIndexForTime(
  t: number,
  timeline?: Array<{ index: number; start: number; end: number }>
): number | undefined {
  if (!timeline || timeline.length === 0) return undefined
  const hit = timeline.find((s) => t >= s.start - 1e-6 && t <= s.end + 1e-6)
  return hit?.index
}

function isOverheadIntent(poseText: string, poseRefs: string, side: "l" | "r"): boolean {
  const s = side
  if (new RegExp(`reach\\s+hand_${s}\\s+to\\s+(up|wave|salute|forehead|head_top)`, "i").test(poseText)) return true
  if (/(?:^|[\s_;])(up|wave|cheer|arms_up|arms_raised|jumping_jack|jack_out|salute|raise)/i.test(`${poseRefs} ${poseText}`)) {
    return true
  }
  const hasHighBackwardArm = new RegExp(`(?:arm|shoulder)_${s}[^;]*bend\\s+backward\\s+(?:[4-9]\\d|\\d{3,})`, "i").test(
    poseText
  )
  const hasSharpFoldedElbow = new RegExp(`elbow_${s}[^;]*bend\\s+forward\\s+(?:9\\d|1\\d{2})`, "i").test(poseText)
  if (hasHighBackwardArm && !hasSharpFoldedElbow) return true
  return false
}

/**
 * 逐帧求值时同一问题会连续命中多帧：按 code + 段落把相邻帧（间隔 ≤1 帧）合并成一条，
 * 保留首帧的帧号/时间，并附 frameEnd / frameCount。返回按帧号排序的列表。
 */
function mergeConsecutiveIssues(issues: PoseCritiqueIssue[]): PoseCritiqueIssue[] {
  if (issues.length <= 1) return issues
  const order: CriticIssueCode[] = []
  const byCode = new Map<CriticIssueCode, PoseCritiqueIssue[]>()
  for (const i of issues) {
    let list = byCode.get(i.code)
    if (!list) {
      list = []
      byCode.set(i.code, list)
      order.push(i.code)
    }
    list.push(i)
  }

  const out: PoseCritiqueIssue[] = []
  for (const code of order) {
    const runs: PoseCritiqueIssue[][] = []
    let current: PoseCritiqueIssue[] | null = null
    let lastSeg: number | undefined
    let lastFrame = Number.NEGATIVE_INFINITY
    for (const i of byCode.get(code) ?? []) {
      if (!current || i.segmentIndex !== lastSeg || i.frame - lastFrame > 1) {
        current = []
        runs.push(current)
        lastSeg = i.segmentIndex
      }
      current.push(i)
      lastFrame = i.frame
    }
    for (const run of runs) {
      const head = run[0]
      if (run.length === 1) {
        out.push(head)
        continue
      }
      out.push({
        ...head,
        frameEnd: run[run.length - 1].frame,
        frameCount: run.length,
        message: `${head.message} — persists for ${run.length} frames (to t=${run[run.length - 1].time}s)`,
      })
    }
  }
  out.sort((a, b) => a.frame - b.frame)
  return out
}

/**
 * Deterministic kinematic critique over a compiled VMD + MPL source.
 * Checks ground contact, elbow flip above shoulder, hand blocking eyes on mouth/chin reach,
 * and extreme standing spine overhang.
 *
 * 取帧：缺省在舞台实际渲染的每一帧（0..maxFrame，关键帧之间按 reze-engine 规则插值）上求值，
 * 所以关键帧之间的下沉/漂移也会被抓到；同一问题连续命中多帧会合并成一条（frameEnd/frameCount）。
 */
export function critiquePoseVmd(
  bones: PmxBones,
  vmd: Uint8Array,
  mplSource: string,
  timeline?: Array<{ index: number; start: number; end: number }>,
  opts: CriticOptions = {}
): PoseCritiqueReport | null {
  try {
    const keys = readVmdBoneKeys(vmd)
    if (!keys || keys.length === 0) return null

    const interpolated = opts.sampling !== "keyframes"
    const semantics = detectPosSemantics(bones)
    const sortedKeys = [...keys].sort((a, b) => a.frame - b.frame)
    const distinctFrames = [...new Set(sortedKeys.map((k) => k.frame))].sort((a, b) => a - b)
    const evalFrames = interpolated ? integerFrames(keys) : distinctFrames
    const tracks = interpolated ? buildBoneTracks(keys) : null
    const ground = analyzeGroundContactKeys(bones, keys, interpolated ? { interpolated: true, frames: evalFrames } : {})
    const { poseBodyByName, frames: animRefs } = parsePoseTextsAndTimeline(mplSource)

    // Group step-hold pose text and ref names by frame sorted chronologically
    const animTimeline: Array<{ frame: number; text: string; refs: string }> = []
    for (const af of [...animRefs].sort((a, b) => a.frame - b.frame)) {
      const combined = af.refs.map((r) => poseBodyByName.get(r) ?? "").join("\n")
      animTimeline.push({ frame: af.frame, text: combined, refs: af.refs.join(" ") })
    }

    const issues: PoseCritiqueIssue[] = []
    const bySeg = new Map<number, CriticOffendingSegment>()

    const recordIssue = (issue: PoseCritiqueIssue, centerY?: number | null, minTermY?: number) => {
      issues.push(issue)
      if (issue.segmentIndex == null) return
      let entry = bySeg.get(issue.segmentIndex)
      if (!entry) {
        entry = {
          index: issue.segmentIndex,
          times: [],
          issues: [],
          lowestY: Infinity,
          lowestTerminalY: Infinity,
        }
        bySeg.set(issue.segmentIndex, entry)
      }
      if (!entry.times.includes(issue.time)) entry.times.push(issue.time)
      entry.issues.push(issue)
      if (centerY != null) entry.lowestY = Math.min(entry.lowestY, centerY)
      if (minTermY != null && Number.isFinite(minTermY)) {
        entry.lowestTerminalY = Math.min(entry.lowestTerminalY, minTermY)
      }
    }

    // 每帧骨骼状态：interpolated = 按引擎规则在关键帧之间插值；keyframes = 旧的 step-hold
    const state = new Map<string, VmdBoneKey>()
    let ki = 0
    let ai = 0
    let activeText = ""
    let activeRefs = ""
    const activeHistory: Array<{ frame: number; endFrame: number; text: string; refs: string }> = []
    const groundByFrame = new Map((ground?.frames ?? []).map((g) => [g.frame, g]))
    const restWorld = restWorldPositions(bones)
    const restAnkleLIdx = bones.indexByJp.get("左足首")
    const restAnkleRIdx = bones.indexByJp.get("右足首")
    const restAnkleY =
      restAnkleLIdx != null && restAnkleRIdx != null
        ? Math.min(restWorld.get(restAnkleLIdx)?.y ?? 1.5, restWorld.get(restAnkleRIdx)?.y ?? 1.5)
        : 1.5

    for (const f of evalFrames) {
      while (ki < sortedKeys.length && sortedKeys[ki].frame <= f) {
        state.set(sortedKeys[ki].jp, sortedKeys[ki])
        ki++
      }
      while (ai < animTimeline.length && animTimeline[ai].frame <= f) {
        activeText = animTimeline[ai].text
        activeRefs = animTimeline[ai].refs
        const endFrame = ai + 1 < animTimeline.length ? animTimeline[ai + 1].frame : Infinity
        activeHistory.push({ ...animTimeline[ai], endFrame })
        ai++
      }
      // 过渡段（f 落在两个时间轴条目之间）同时受“来姿”和“去姿”的意图约束：
      // 起跳段/踢腿抬腿段的腾空是设计意图，不能因为下一姿还没到就判悬空。到达帧只看当前姿。
      const nextEntry = ai < animTimeline.length ? animTimeline[ai] : null
      const atTimelineKey = ai > 0 && animTimeline[ai - 1].frame === f
      const ctxText = nextEntry && !atTimelineKey ? `${activeText}\n${nextEntry.text}` : activeText
      const ctxRefs = nextEntry && !atTimelineKey ? `${activeRefs} ${nextEntry.refs}` : activeRefs
      const isOverheadRecent = (side: "l" | "r") =>
        isOverheadIntent(ctxText, ctxRefs, side) ||
        activeHistory.some((h) => h.frame <= f && f <= h.endFrame + 8 && isOverheadIntent(h.text, h.refs, side))
      // Skip frame 0 reset/rest check unless it's the only frame
      if (f === 0 && evalFrames.length > 1) continue

      const tf = tracks
        ? solveFrameTransforms(bones, sampleBoneTracks(tracks, f), semantics)
        : solveFrameTransforms(bones, state, semantics)
      if (!tf) continue
      const at = (jp: string) => {
        const idx = bones.indexByJp.get(jp)
        return idx != null ? tf.pos[idx] : undefined
      }
      const quatAt = (jp: string) => {
        const idx = bones.indexByJp.get(jp)
        return idx != null ? tf.quat[idx] : undefined
      }

      const t = Number((f / 30).toFixed(2))
      const segIdx = segmentIndexForTime(t, timeline)

      // 1) Ground penetration (center < 0 or terminals < -0.5)
      const gf = groundByFrame.get(f)
      if (gf) {
        const termVals = Object.values(gf.terminals)
        const minTerm = termVals.length > 0 ? Math.min(...termVals) : Infinity
        if ((gf.centerY != null && gf.centerY < 0) || minTerm < -0.5) {
          recordIssue(
            {
              code: "ground_penetration",
              segmentIndex: segIdx,
              frame: f,
              time: t,
              severity: "error",
              message: `ground penetration at t=${t}s (waist y=${gf.centerY ?? "?"}u, lowest terminal y=${Number.isFinite(minTerm) ? minTerm.toFixed(2) : "?"}u)`,
              fixHint:
                'emit "plant feet;" when bending knees/lowering center, or raise center / reduce center move down values (if lying via base bend backward 90, use center move up 1 instead of move down).',
            },
            gf.centerY,
            minTerm
          )
        }
      }

      // 2) Elbow above shoulder when NOT overhead intent
      for (const side of ["l", "r"] as const) {
        const shoulder = at(side === "l" ? "左腕" : "右腕")
        const elbow = at(side === "l" ? "左ひじ" : "右ひじ")
        if (shoulder && elbow && !isOverheadRecent(side)) {
          if (elbow.y > shoulder.y + 0.65) {
            recordIssue({
              code: "elbow_above_shoulder",
              segmentIndex: segIdx,
              frame: f,
              time: t,
              severity: "error",
              message: `${side === "l" ? "left" : "right"} elbow (y=${elbow.y.toFixed(2)}) flipped above shoulder (y=${shoulder.y.toFixed(2)}) at t=${t}s`,
              fixHint: `use "reach hand_${side} to <anchor>;" cleanly and do NOT combine arm_twist_${side} or upward arm bend with reach.`,
            })
          }
        }
      }

      // 3) Hand blocking eyes when targeting mouth/chin
      const head = at("頭")
      const qHead = quatAt("頭")
      if (head) {
        for (const side of ["l", "r"] as const) {
          if (new RegExp(`reach\\s+hand_${side}\\s+to\\s+(?:mouth|chin)\\b`, "i").test(activeText)) {
            const wrist = at(side === "l" ? "左手首" : "右手首")
            if (wrist && wrist.y > head.y + 0.15) {
              recordIssue({
                code: "hand_blocking_eyes",
                segmentIndex: segIdx,
                frame: f,
                time: t,
                severity: "error",
                message: `hand_${side} wrist (y=${wrist.y.toFixed(2)}) sits too high above head pivot (y=${head.y.toFixed(2)}) at t=${t}s, fingers will cover eyes`,
                fixHint: `lower hand_${side} slightly using "reach hand_${side} to mouth + [0, -0.35, 0];"`,
              })
            }
          }
        }
      }

      // 3b) Wrist / fingertip clipping into head core, neck, or torso centerline
      const neck = at("首")
      const upper2 = at("上半身2") ?? at("上半身")
      const lowerBody = at("下半身") ?? at("腰")
      if (head && qHead && neck) {
        const headOff = qRotate(qHead, { x: 0, y: 0.95, z: 0 })
        const headCenter: Vec3 = { x: head.x + headOff.x, y: head.y + headOff.y, z: head.z + headOff.z }
        for (const side of ["l", "r"] as const) {
          const prefix = side === "l" ? "左" : "右"
          const pts = ["手首", "人指３", "中指３", "小指３"]
            .map((suf) => ({ label: prefix + suf, p: at(prefix + suf) }))
            .filter((x): x is { label: string; p: Vec3 } => Boolean(x.p))
          if (pts.length === 0) continue

          const hasPeaceSign =
            new RegExp(`hand_${side}\\s+peace\\b`, "i").test(activeText) ||
            (new RegExp(`index_${side}\\s+bend\\s+forward\\s+0\\b`, "i").test(activeText) &&
              new RegExp(`ring_${side}\\s+bend\\s+forward\\s+(?:7|8|9)\\d`, "i").test(activeText))
          const headMinLimit = hasPeaceSign ? 1.2 : 0.72

          let worstMsg = ""
          let worstHint = ""
          for (const { label, p } of pts) {
            const dNeck = distPointToSegment(p, neck, head)
            if (dNeck < 0.55) {
              worstMsg = `${label} pokes into neck core (dist=${dNeck.toFixed(2)}u) at t=${t}s`
              worstHint = hasPeaceSign
                ? `for cheek V-sign, use "reach hand_${side} to peace_${side};" instead of cheek_${side} + positive [dx,dy,dz] offsets.`
                : `keep hand_${side} outside neck/face contour (avoid adding +X/+Z offsets onto reach anchors).`
              break
            }
            const dHead = Math.hypot(p.x - headCenter.x, p.y - headCenter.y, p.z - headCenter.z)
            if (dHead < headMinLimit) {
              worstMsg = `${label} penetrates head envelope (dist=${dHead.toFixed(2)}u < ${headMinLimit.toFixed(2)}u) at t=${t}s`
              worstHint = hasPeaceSign
                ? `for peace sign near face, use "reach hand_${side} to peace_${side};" cleanly without inward offsets.`
                : `move reach hand_${side} target outward/forward cleanly using cheek_${side} or peace_${side}.`
              break
            }
            if (upper2 && lowerBody) {
              const dTorso = Math.min(
                distPointToSegment(p, lowerBody, upper2),
                distPointToSegment(p, upper2, neck)
              )
              if (dTorso < 0.72) {
                worstMsg = `${label} clips into torso core (dist=${dTorso.toFixed(2)}u) at t=${t}s`
                worstHint = `use semantic anchors (hip_${side}, heart, front_${side}) cleanly without inward offsets.`
                break
              }
            }
          }
          if (worstMsg) {
            recordIssue({
              code: "body_clipping",
              segmentIndex: segIdx,
              frame: f,
              time: t,
              severity: "error",
              message: worstMsg,
              fixHint: worstHint,
            })
          }
        }
      }

      // 4) Standing balance overhang check & mid-air curled foot check
      const center = at("センター")
      const ankleL = at("左足首D") ?? at("左足首")
      const ankleR = at("右足首D") ?? at("右足首")
      const kneeL = at("左ひざD") ?? at("左ひざ")
      const kneeR = at("右ひざD") ?? at("右ひざ")
      if (
        ankleL &&
        ankleR &&
        kneeL &&
        kneeR &&
        !/\b(kick|jump|jumping_jack|base\s+bend|base\s+sway|center\s+move\s+up)\b/i.test(ctxText) &&
        !/\b(jumping_jack|jack_idle|jack_out)\b/i.test(ctxRefs)
      ) {
        const lowY = Math.min(ankleL.y, ankleR.y)
        const highY = Math.max(ankleL.y, ankleR.y)
        const highKneeY = ankleL.y >= ankleR.y ? kneeL.y : kneeR.y
        const highSide = ankleL.y >= ankleR.y ? "left" : "right"
        const isSeatedPose =
          /\b(sit|sitting|sitting_start|risen)\b/i.test(ctxRefs) || /\bsit\b/i.test(ctxText)
        // 过渡段里“一脚高抬、膝盖还高”是抬脚落位的过程，不是定格姿势的毛病：
        // 连续模式下只在该帧双脚几乎不动（±2 帧位移 < 0.2u）时才按“悬空”报错。
        const quasiStatic = (() => {
          if (!tracks) return true
          const pick = (t: number) => {
            const s = samplePoseTransforms(bones, tracks, t, semantics)?.pos
            if (!s) return null
            const atIdx = (jp: string) => {
              const i = bones.indexByJp.get(jp)
              return i != null ? s[i] : undefined
            }
            const l = atIdx("左足首D") ?? atIdx("左足首")
            const r = atIdx("右足首D") ?? atIdx("右足首")
            return l && r ? [l, r] : null
          }
          const before = pick(Math.max(0, f - 2))
          const after = pick(f + 2)
          if (!before || !after) return true
          const move = Math.max(
            Math.hypot(before[0].x - after[0].x, before[0].y - after[0].y, before[0].z - after[0].z),
            Math.hypot(before[1].x - after[1].x, before[1].y - after[1].y, before[1].z - after[1].z)
          )
          return move < 0.2
        })()
        if (quasiStatic && lowY <= 2.3 && highY > 3.8 && highKneeY > 3.2) {
          recordIssue({
            code: "floating_foot",
            segmentIndex: segIdx,
            frame: f,
            time: t,
            severity: "error",
            message: `${highSide} foot (ankle y=${highY.toFixed(2)}u, knee y=${highKneeY.toFixed(2)}u) floats high in mid-air while squatting/standing at t=${t}s`,
            fixHint:
              'keep crouch legs balanced so both feet/knees stay near ground (e.g. front leg leg_l bend forward 95 + knee_l bend backward 105, back leg leg_r bend forward 35 + knee_r bend backward 120, plus "plant feet;").',
          })
        } else if (!isSeatedPose && lowY > restAnkleY + 0.9) {
          recordIssue({
            code: "floating_foot",
            segmentIndex: segIdx,
            frame: f,
            time: t,
            severity: "error",
            message: `both feet lifted off the floor (lowest ankle y=${lowY.toFixed(2)}u vs rest ${restAnkleY.toFixed(2)}u) at t=${t}s`,
            fixHint:
              'emit "plant feet;" on bent-knee/squat poses, AND explicitly emit "center reset; leg_l reset; leg_r reset; knee_l reset; knee_r reset;" when returning to stand.',
          })
        }
      }
      if (center && head && ankleL && ankleR && center.y > 5.5 && !/\bbase\s+(bend|sway)/i.test(ctxText)) {
        const footMidX = (ankleL.x + ankleR.x) / 2
        const footMidZ = (ankleL.z + ankleR.z) / 2
        const overhang = Math.hypot(head.x - footMidX, head.z - footMidZ)
        if (overhang > 5.0) {
          recordIssue({
            code: "spine_imbalance",
            segmentIndex: segIdx,
            frame: f,
            time: t,
            severity: "warn",
            message: `heavy forward/side lean overhang (${overhang.toFixed(2)}u) at t=${t}s without foot compensation`,
            fixHint: "reduce extreme waist/upper_body forward bend or bend knees slightly with plant feet; to balance.",
          })
        }
      }
    }

    const merged = mergeConsecutiveIssues(issues)
    const segments = [...bySeg.values()].sort((a, b) => a.index - b.index)
    for (const seg of segments) {
      const own = merged.filter((m) => m.segmentIndex === seg.index)
      const seen = new Set<PoseCritiqueIssue>()
      seg.issues = own.filter((m) => !seen.has(m) && seen.add(m))
      seg.times = [...new Set(own.map((m) => m.time))].sort((a, b) => a - b)
    }

    const errors = merged.filter((x) => x.severity === "error")
    const summary =
      errors.length === 0
        ? `kinematic critic passed (${evalFrames.length} ${interpolated ? "rendered" : "key"} frames checked${merged.length > 0 ? `, ${merged.length} warning(s)` : ""})`
        : `${errors.length} kinematic issue(s): ${errors.map((e) => e.code).filter((v, idx, a) => a.indexOf(v) === idx).join(", ")}`

    return {
      passed: errors.length === 0,
      issues: merged,
      offendingSegments: segments,
      summary,
      sampling: interpolated ? "interpolated" : "keyframes",
    }
  } catch {
    return null
  }
}
