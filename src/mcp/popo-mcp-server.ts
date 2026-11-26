/**
 * PoPo MCP Server (stdio JSON-RPC 2.0) — Blender-free MMD / PMX Motion Workbench.
 *
 * Exposes PoPo's deterministic 3D toolchain as MCP tools for external Agents
 * (Antigravity, Claude Code, Cursor, DSH, etc.):
 *   - make_motion            (one call: compile → finalize → gate → storyboard → report)
 *   - list_models
 *   - inspect_pmx
 *   - compile_and_inspect_mpl2
 *   - render_pose_views
 *   - export_motion
 *   - inspect_vmd_file
 *   - push_vmd_to_stage
 *   - inspect_duo            (two-actor world transform, collision/distance check & duo render)
 *   - get_blender_scene_info (inspect running Blender scene via blender_mcp.py socket bridge)
 *   - execute_blender_code   (run bpy / mmd_tools Python inside connected local Blender GUI)
 *   - get_blender_viewport   (capture offscreen 3D viewport PNG from connected Blender)
 *
 * IMPORTANT: stdout is strictly reserved for JSON-RPC 2.0 frames. All diagnostic
 * logs are redirected to stderr.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

// Guard stdout before importing anything that might call console.log
console.log = (...args: unknown[]) => console.error(...args)
console.info = (...args: unknown[]) => console.error(...args)
console.warn = (...args: unknown[]) => console.error(...args)

import { AVAILABLE_MODELS } from "../lib/model.ts"
import { parsePmxBones } from "../lib/pmx-bones.ts"
import type { PmxBones } from "../lib/pmx-bones.ts"
import { buildModelConditioning } from "../lib/model-conditioning.ts"
import { detectPosSemantics, measureModelGeometry, restWorldPositions } from "../lib/model-geometry.ts"
import { compileMPL2 } from "../lib/mpl2.ts"
import { VALID_AIM_TARGETS, VALID_REACH_ANCHORS } from "../lib/ik-solver.ts"
import { LEXICON, expandLexiconSegment } from "../lib/motion-lexicon.ts"
import { critiquePoseVmd, parsePoseTextsAndTimeline } from "../lib/pose-critic.ts"
import { auditVmd } from "../lib/pose-audit.ts"
import { buildBoneTracks, readVmdBoneKeys, samplePoseTransforms } from "../lib/fk.ts"
import { buildRigProfile, RIG_PROFILE_VERSION } from "../lib/rig-profile.ts"
import { solveMotionIntent, type MotionIntent } from "../lib/rig-solver.ts"
import { renderPoseMultiViewPng, renderStoryboardPng, renderDuoMultiViewPng, renderDuoStoryboardPng } from "../lib/pose-renderer.ts"
import { getServerCompiler } from "../lib/server-compile.ts"
import { measureGroundErrorVmd, summarizeGroundMeasure, type GroundMeasure } from "../lib/ground-bake.ts"
import { finalizeMotion, type FinalizeResult } from "../lib/motion-finalize.ts"
import { secondsToFrame } from "../lib/vmd-morph.ts"
import {
  analyzeDuoSequence,
  prepareDuoActor,
  toBlenderRootPlacement,
  worldToActorLocal,
  type DuoPlacement,
} from "../lib/duo.ts"
import { resolveBlenderEndpoint, sendBlenderCommand } from "../lib/blender-bridge.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = process.env.POPO_ROOT?.trim()
  ? path.resolve(process.env.POPO_ROOT.trim())
  : path.resolve(__dirname, "../..")
const PUBLIC_DIR = path.join(ROOT_DIR, "public")

type ResolvedModelEntry = {
  id: string
  label: string
  url: string
  pmxPath?: string
}

const modelCache = new Map<string, PmxBones>()

function scanPublicModels(): ResolvedModelEntry[] {
  const modelsDir = path.join(PUBLIC_DIR, "models")
  const knownByPath = new Map<string, ResolvedModelEntry>()
  const seenIds = new Set<string>()
  const result: ResolvedModelEntry[] = []

  for (const m of AVAILABLE_MODELS) {
    const abs = path.resolve(PUBLIC_DIR, m.url.replace(/^\/+/, ""))
    knownByPath.set(abs.toLowerCase(), { ...m, pmxPath: abs })
    seenIds.add(m.id)
    result.push({ ...m, pmxPath: abs })
  }

  if (!fs.existsSync(modelsDir)) return result

  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".pmx")) {
        const key = full.toLowerCase()
        if (knownByPath.has(key)) continue
        const relFromPublic = "/" + path.relative(PUBLIC_DIR, full).replace(/\\/g, "/")
        const parentDir = path.basename(path.dirname(full))
        const baseName = path.basename(full, path.extname(full))
        const id = parentDir && parentDir !== "models" ? parentDir : baseName
        if (seenIds.has(id)) continue
        seenIds.add(id)
        result.push({
          id,
          label: baseName,
          url: relFromPublic,
          pmxPath: full,
        })
      }
    }
  }
  walk(modelsDir)
  return result
}

function resolveModelEntry(modelId?: string, pmxPath?: string): ResolvedModelEntry {
  if (pmxPath && pmxPath.trim()) {
    const absPath = path.resolve(ROOT_DIR, pmxPath.trim())
    const baseName = path.basename(absPath, path.extname(absPath))
    return {
      id: modelId?.trim() || baseName || "custom",
      label: baseName || "Custom PMX",
      url: absPath,
      pmxPath: absPath,
    }
  }
  const all = scanPublicModels()
  const id = (modelId || "topaz").trim()
  return (
    all.find((m) => m.id === id || m.label === id) ??
    all[0]
  )
}

function loadModelSync(modelId?: string, pmxPath?: string): { entry: ResolvedModelEntry; bones: PmxBones } {
  const entry = resolveModelEntry(modelId, pmxPath)
  const fullPath = entry.pmxPath ?? path.join(PUBLIC_DIR, entry.url.replace(/^\/+/, ""))
  const cacheKey = `pmx:${path.resolve(fullPath).toLowerCase()}`
  const cached = modelCache.get(cacheKey)
  if (cached) return { entry, bones: cached }

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Model file not found: ${fullPath}`)
  }
  const bytes = fs.readFileSync(fullPath)
  const bones = parsePmxBones(new Uint8Array(bytes))
  modelCache.set(cacheKey, bones)
  return { entry, bones }
}

function loadModelFromArgs(args: Record<string, unknown>) {
  return loadModelSync(
    typeof args.modelId === "string" ? args.modelId : undefined,
    typeof args.pmxPath === "string" ? args.pmxPath : undefined
  )
}

/** Ensure standalone @pose/@animation fragments also compile by wrapping an implicit main block if missing. */
function ensureCompilableMpl(mpl: string): string {
  if (/\bmain\s*\{/.test(mpl)) return mpl
  const animMatch = mpl.match(/@animation\s+([A-Za-z0-9_]+)\s*\{/)
  if (animMatch) {
    return `${mpl.trim()}\n\nmain {\n    ${animMatch[1]};\n}`
  }
  return mpl
}

function getRestAnchors(bones: PmxBones) {
  const rw = restWorldPositions(bones)
  const rPos = (jp: string) => {
    const idx = bones.indexByJp.get(jp)
    return idx != null ? rw.get(idx) ?? null : null
  }
  const al = rPos("左足首")
  const ar = rPos("右足首")
  const center = rPos("センター")
  return {
    restAnkleY: al && ar ? Math.min(al.y, ar.y) : 1.5,
    restCenterY: center?.y ?? 8.0,
    restCenterZ: center?.z ?? 0.0,
  }
}

/**
 * 按舞台引擎的插值规则在指定时刻采样骨骼世界坐标（与 kinematic critic、贴地测量同源）。
 * 曾用 step-hold（取 ≤f 的最近键），会漏掉关键帧之间的下沉/漂浮，与连续检查器结论对不上。
 */
function extractKeyframeCoords(bones: PmxBones, vmd: Uint8Array, sampleTimes?: number[]) {
  const keys = readVmdBoneKeys(vmd)
  if (!keys || keys.length === 0) return []
  const sem = detectPosSemantics(bones)
  const tracks = buildBoneTracks(keys)
  const geom = measureModelGeometry(bones)
  const { restAnkleY, restCenterY, restCenterZ } = getRestAnchors(bones)

  let frames: number[]
  if (Array.isArray(sampleTimes) && sampleTimes.length > 0) {
    frames = [...new Set(sampleTimes.map((t) => secondsToFrame(Math.max(0, Number(t) || 0))))].sort((a, b) => a - b)
  } else {
    const distinct = [...new Set(keys.map((k) => k.frame))].sort((a, b) => a - b)
    if (distinct.length <= 10) {
      frames = distinct
    } else {
      frames = []
      for (let i = 0; i < 10; i++) {
        frames.push(distinct[Math.round((i * (distinct.length - 1)) / 9)])
      }
      frames = [...new Set(frames)]
    }
  }

  const r2 = (n: number) => Number(n.toFixed(2))
  const dist = (a: { x: number; y: number; z: number } | null, b: { x: number; y: number; z: number } | null) =>
    a && b ? r2(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)) : null

  return frames.map((f) => {
    const tf = samplePoseTransforms(bones, tracks, f, sem)
    const at = (jp: string) => {
      const idx = bones.indexByJp.get(jp)
      const p = idx != null && tf ? tf.pos[idx] : undefined
      return p ? { x: r2(p.x), y: r2(p.y), z: r2(p.z) } : null
    }
    const shoulderR = at("右腕")
    const wristR = at("右手首")
    const shoulderL = at("左腕")
    const wristL = at("左手首")
    const ankleL = at("左足首")
    const ankleR = at("右足首")
    const center = at("センター")
    const dR = dist(shoulderR, wristR)
    const dL = dist(shoulderL, wristL)
    const footLiftL = ankleL ? r2(ankleL.y - restAnkleY) : null
    const footLiftR = ankleR ? r2(ankleR.y - restAnkleY) : null
    const hipDrop = center ? r2(restCenterY - center.y) : null
    const hipBackShift = center ? r2(center.z - restCenterZ) : null
    const squatDepthRatio = hipDrop != null && geom.legLenUnits > 0 ? r2(hipDrop / geom.legLenUnits) : null

    return {
      frame: f,
      timeSec: r2(f / 30),
      head: at("頭"),
      center,
      wristR,
      elbowR: at("右ひじ"),
      wristL,
      elbowL: at("左ひじ"),
      ankleL,
      ankleR,
      footLiftL,
      footLiftR,
      hipDrop,
      hipBackShift,
      squatDepthRatio,
      armExtensionRatioR: dR != null && geom.armLenUnits > 0 ? r2(dR / geom.armLenUnits) : null,
      armExtensionRatioL: dL != null && geom.armLenUnits > 0 ? r2(dL / geom.armLenUnits) : null,
    }
  })
}

/**
 * 成品的逐帧贴地报告：每只脚相对静止脚踝/脚尖高度的偏移（负 = 沉入地面）、
 * 烘焙统计，以及给 Agent 的结论句。blocking 模式没有烘焙（bake=null）。
 */
function groundReport(fin: FinalizeResult) {
  const g = fin.ground
  const bs = fin.bakeStats
  const notes: string[] = []
  if (g && g.offendingFrames > 0) {
    const side = g.feet.l.offending >= g.feet.r.offending ? "left" : "right"
    const s = side === "left" ? g.feet.l : g.feet.r
    notes.push(
      `${g.offendingFrames} rendered frame(s) still off the floor by >${g.tolerance}u ` +
        `(worst foot ${side}: min ${s.min.toFixed(3)}u @f${s.minFrame}, max ${s.max.toFixed(3)}u @f${s.maxFrame})`
    )
  }
  if (bs && bs.residualAtEntries > 0) {
    notes.push(
      `${bs.residualAtEntries} of those are authored key poses (ground bake never rewrites key poses) — ` +
        `add "plant feet;" to the pose(s) at those frames, or accept the offset`
    )
  } else if (g && g.offendingFrames > 0 && bs && bs.skippedReason === "no grounded transition (nothing between contact keys)") {
    // 没有可修的过渡段：超差帧全在保持中的作者姿势上（烘焙只修关键帧之间的中间帧）
    notes.push(
      "the ground bake only corrects frames between contact keys and this motion has no such transition — " +
        `the offset is in the authored pose(s) themselves: bend the knees / add "plant feet;" / raise the center, or accept the offset`
    )
  }
  return {
    ground: g,
    bake: bs
      ? {
          applied: bs.applied,
          skippedReason: bs.skippedReason,
          entriesFrom: bs.entriesFrom,
          passes: bs.passes,
          insertedKeys: bs.insertedKeys,
          centerKeys: bs.centerKeys,
          ankleKeys: bs.ankleKeys,
          anchorKeys: bs.anchorKeys,
          residualFrames: bs.residualFrames,
          residualAtEntries: bs.residualAtEntries,
          windows: bs.windows,
          before: bs.before,
        }
      : null,
    notes,
  }
}

/** blocking 导出的贴地说明：导出的是未烘焙的稀疏键，帧间偏差属预期；标准烘焙预览的结果才是闸门依据。 */
function blockingGroundNotes(fin: FinalizeResult, gate: FinalizeResult): string[] {
  const g = fin.ground
  const p = gate.ground
  if (!g || !p) return []
  const sink = Math.min(0, g.feet.l.min, g.feet.r.min)
  const head =
    g.offendingFrames === 0
      ? "blocking keys are exported un-baked and already keep both feet on the floor on every rendered frame"
      : `blocking keys are exported un-baked: ${g.offendingFrames} foot-frame(s) deviate between keys (deepest sink ${sink.toFixed(3)}u)`
  const tail =
    p.offendingFrames === 0
      ? "; the standard ground bake fixes all of them (quality gate passed on that preview)"
      : `; ${p.offendingFrames} foot-frame(s) remain after the standard ground bake (see qualityGate.groundContact)`
  return [head + tail]
}

/** render_pose_views 文本输出用的一行英文贴地结论（舞台端中文版见 motion-finalize.describeGroundContact）。 */
function describeGroundEn(fin: FinalizeResult): string {
  const g = fin.ground
  if (!g) return "n/a"
  const bs = fin.bakeStats
  const head =
    g.offendingFrames === 0
      ? `all ${g.frames} rendered frames within ±${g.tolerance}u of rest foot height`
      : `${g.offendingFrames} frame(s) beyond ±${g.tolerance}u`
  const feet = `L min ${g.feet.l.min.toFixed(3)}u / max ${g.feet.l.max.toFixed(3)}u, R min ${g.feet.r.min.toFixed(3)}u / max ${g.feet.r.max.toFixed(3)}u`
  const bake = bs
    ? bs.applied
      ? `; ground bake inserted ${bs.insertedKeys} key(s)`
      : `; ground bake not applied (${bs.skippedReason ?? "n/a"})`
    : ""
  return `${head} (${feet})${bake}`
}

/** 外部 VMD（无 MPL 源）的逐帧贴地摘要。 */
function groundSummaryOf(bones: PmxBones, vmd: Uint8Array) {
  const m = measureGroundErrorVmd(vmd, bones)
  return m ? summarizeGroundMeasure(m) : null
}

/**
 * make_motion 的逐帧曲线（按舞台引擎插值规则，与 critic / 贴地测量同源）：
 *   footL / footR  —— 每只脚最低观测点相对静止脚踝/脚尖高度的偏移（u，负 = 沉入地面）
 *   footLiftL / R  —— 脚踝相对静止脚踝高（u，> 0 = 抬脚）
 *   hipDrop        —— 重心相对静止高度下降多少（u）
 * 帧数多时按 stride 降采样到 ≤ maxPoints 个点（末帧一定包含）。
 */
function motionCurves(bones: PmxBones, vmd: Uint8Array, measure: GroundMeasure | null, maxPoints = 240) {
  const keys = readVmdBoneKeys(vmd)
  if (!keys || keys.length === 0 || !measure) return null
  const tracks = buildBoneTracks(keys)
  const sem = detectPosSemantics(bones)
  const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
  const stride = Math.max(1, Math.ceil((maxFrame + 1) / maxPoints))
  const { restAnkleY, restCenterY } = getRestAnchors(bones)
  const cIdx = bones.indexByJp.get("センター")
  const alIdx = bones.indexByJp.get("左足首")
  const arIdx = bones.indexByJp.get("右足首")
  const r3 = (n: number) => Number(n.toFixed(3))
  const c = { t: [] as number[], footL: [] as number[], footR: [] as number[], footLiftL: [] as number[], footLiftR: [] as number[], hipDrop: [] as number[] }
  for (let f = 0; f <= maxFrame; f += stride) {
    if (f + stride > maxFrame && f !== maxFrame) f = maxFrame // 末帧一定采样
    const tf = samplePoseTransforms(bones, tracks, f, sem)
    if (!tf) continue
    c.t.push(r3(f / 30))
    c.footL.push(r3(measure.error.l[f]))
    c.footR.push(r3(measure.error.r[f]))
    c.footLiftL.push(alIdx != null ? r3(tf.pos[alIdx].y - restAnkleY) : 0)
    c.footLiftR.push(arIdx != null ? r3(tf.pos[arIdx].y - restAnkleY) : 0)
    c.hipDrop.push(cIdx != null ? r3(restCenterY - tf.pos[cIdx].y) : 0)
  }
  const extreme = (arr: number[], pick: "max" | "min") => {
    let best = 0
    let at = 0
    arr.forEach((v, i) => {
      if ((pick === "max" ? v > best : v < best) || i === 0) {
        best = v
        at = i
      }
    })
    return { value: best, t: c.t[at] }
  }
  return {
    frames: maxFrame + 1,
    fps: 30,
    stride,
    unit: "u (1u ≈ 8cm)",
    tolerance: measure.tolerance,
    peaks: {
      hipDropMax: extreme(c.hipDrop, "max"),
      footLiftMaxL: extreme(c.footLiftL, "max"),
      footLiftMaxR: extreme(c.footLiftR, "max"),
      footDeepestL: extreme(c.footL, "min"),
      footDeepestR: extreme(c.footR, "min"),
      footHighestL: extreme(c.footL, "max"),
      footHighestR: extreme(c.footR, "max"),
    },
    ...c,
  }
}

/**
 * 面向 Agent 的 JSON 排版：对象缩进（好读）；数字/字符串数组单行，纯标量对象的数组每项一行
 * （遥测曲线、判定帧表不炸 token）。
 */
function isFlatObject(v: unknown): boolean {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((x) => x === null || typeof x !== "object")
}
function stringifyReport(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent)
  const padIn = "  ".repeat(indent + 1)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    if (value.every((v) => v === null || typeof v !== "object")) return JSON.stringify(value)
    if (value.every(isFlatObject)) return "[\n" + value.map((v) => padIn + JSON.stringify(v)).join(",\n") + "\n" + pad + "]"
    return "[\n" + value.map((v) => padIn + stringifyReport(v, indent + 1)).join(",\n") + "\n" + pad + "]"
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return "{}"
    if (isFlatObject(value)) return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}"
    return "{\n" + entries.map(([k, v]) => `${padIn}${JSON.stringify(k)}: ${stringifyReport(v, indent + 1)}`).join(",\n") + "\n" + pad + "}"
  }
  return JSON.stringify(value)
}

/**
 * 把成品 VMD 推到舞台（export_motion / make_motion 共用）。带字节：舞台拿到 vmdBase64 就按字节播放，
 * 烘焙键不会在客户端重新编译/增强时丢失；mpl 只作编辑器标签。
 */
async function pushMotionToStage(args: Record<string, unknown>, body: Record<string, unknown>): Promise<unknown> {
  const stageUrl = (typeof args.stageUrl === "string" && args.stageUrl.trim() ? args.stageUrl.trim() : "http://127.0.0.1:4000").replace(/\/+$/, "")
  try {
    const pushRes = await fetch(`${stageUrl}/api/stage-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return pushRes.ok ? await pushRes.json() : { ok: false, status: pushRes.status, error: await pushRes.text().catch(() => "") }
  } catch (e) {
    return { ok: false, error: `Stage server unreachable at ${stageUrl} (${e instanceof Error ? e.message : String(e)})` }
  }
}

function buildBiomechanicalWarnings(
  mpl: string,
  mplWarnings: string[],
  coords: ReturnType<typeof extractKeyframeCoords>,
  bones: PmxBones
): string[] {
  const out = [...mplWarnings]
  const isAerialOrSit = /\b(jump|jumping_jack|sit|sitting|base\s+bend|base\s+sway)\b/i.test(mpl)
  const bendsLegs = /\b(leg|knee)_[lr]\s+(bend|sway|turn)\b/i.test(mpl)
  const usesPlant = /\bplant\s+(feet|foot_l|foot_r)\s*;/i.test(mpl)

  if (bendsLegs && !usesPlant && !isAerialOrSit) {
    out.push(
      'Script rotates leg/knee bones without "plant feet;" — add "plant feet;" in every bent-knee @pose so the solver keeps feet grounded on the floor plane.'
    )
  }

  // Check if center moved down/backward without an explicit center reset later
  const movesCenter = /\bcenter\s+move\b/i.test(mpl)
  const resetsCenter = /\bcenter\s+reset\s*;/i.test(mpl)
  if (movesCenter && !resetsCenter) {
    out.push(
      'Script uses "center move ..." without ever calling "center reset;" — mmd-mpl carries over prior center offset to later poses (causing feet to float when standing back up!).'
    )
  }

  for (const pt of coords) {
    if (!isAerialOrSit && ((pt.footLiftL != null && pt.footLiftL > 0.6) || (pt.footLiftR != null && pt.footLiftR > 0.6))) {
      out.push(
        `t=${pt.timeSec}s (frame ${pt.frame}): feet lifted off ground (footLiftL=${pt.footLiftL}u, footLiftR=${pt.footLiftR}u) — emit "plant feet;" on bent-knee poses AND "center reset; leg_l reset; leg_r reset; knee_l reset; knee_r reset;" on stand poses.`
      )
      break
    }
  }

  const maxDropPt = coords.reduce(
    (best, pt) => ((pt.hipDrop ?? 0) > (best?.hipDrop ?? 0) ? pt : best),
    null as (typeof coords)[number] | null
  )
  if (maxDropPt && (maxDropPt.hipDrop ?? 0) >= 1.5 && !isAerialOrSit) {
    if ((maxDropPt.hipBackShift ?? 0) < 0.8) {
      out.push(
        `At deepest squat/crouch t=${maxDropPt.timeSec}s (hipDrop=${maxDropPt.hipDrop}u), hipBackShift is only ${maxDropPt.hipBackShift}u (+Z is backward). Push hips back with "center move backward 1.8;" (or 2.0~2.5) so the butt sits back naturally instead of knees jutting forward.`
      )
    }
    if ((maxDropPt.squatDepthRatio ?? 0) < 0.45 && /\bsquat|深蹲|蹲/i.test(mpl)) {
      out.push(
        `Squat depth at t=${maxDropPt.timeSec}s is shallow (hipDrop=${maxDropPt.hipDrop}u, ratio=${maxDropPt.squatDepthRatio}). For a standard deep squat, use leg_l/r bend forward 85-100, knee_l/r bend backward 110-125, center move backward 2.0, and "plant feet;".`
      )
    }
  }

  // Suggest valid morph alternatives if unknown morphs exist
  if (bones.faceMorphs.length > 0 && mplWarnings.some((w) => w.startsWith("unknown face morph"))) {
    out.push(`Hint: use exact kanji/kana morph names from inspect_pmx (e.g. "真面目" instead of "まじめ").`)
  }

  return out
}

const MPL2_AUTHORING_GUIDE = {
  coordinateSystem: "+X = character LEFT, -X = character RIGHT, +Y = UP, -Z = FORWARD (toward camera), +Z = BACKWARD (behind character)",
  statefulCarryOverRule:
    "CRITICAL: mmd-mpl holds previous bone transforms if omitted in a later @pose! When returning from squat/crouch/sit to stand, ALWAYS emit: center reset; leg_l reset; leg_r reset; knee_l reset; knee_r reset;",
  groundingRule:
    'ALWAYS emit "plant feet;" inside every @pose that bends leg_l/r or knee_l/r (except sitting/jumping). plant feet automatically adjusts center Y so the lowest foot stays on the floor.',
  squatBiomechanics: {
    principle: "A realistic standard squat is a hip-hinge: hips go BACK (+Z) and DOWN, knees stay aligned, torso leans forward to counterbalance.",
    recommendedDeepPose: [
      "center move backward 2.0;",
      "waist bend forward 28;",
      "upper_body bend forward 12;",
      "upper_body2 bend forward 10;",
      "leg_l bend forward 90, sway left 8;",
      "leg_r bend forward 90, sway right 8;",
      "knee_l bend backward 120;",
      "knee_r bend backward 120;",
      "ankle_l bend backward 30;",
      "ankle_r bend backward 30;",
      "plant feet;",
      "reach hand_l to front_l;",
      "reach hand_r to front_r;",
    ],
    recommendedStandPose: [
      "center reset;",
      "waist reset;",
      "upper_body reset;",
      "upper_body2 reset;",
      "leg_l reset;",
      "leg_r reset;",
      "knee_l reset;",
      "knee_r reset;",
      "ankle_l reset;",
      "ankle_r reset;",
      "arm_l reset;",
      "arm_r reset;",
      "elbow_l reset;",
      "elbow_r reset;",
      "plant feet;",
    ],
  },
  conflictRule:
    'Do NOT mix "reach hand_<l|r> to <anchor>;" with raw arm_<l|r>, elbow_<l|r>, or arm_twist_<l|r> rotations in the same @pose.',
  morphRule:
    "Copy face morph names verbatim from safeMorphs or allFaceMorphs (e.g. 真面目, NOT まじめ). Max 2 morphs per @pose.",
}

const TOOLS = [
  {
    name: "make_motion",
    description:
      "One-call motion maker — start here. Input is either an MPL2 script (mpl) or a lexicon primitive with params (e.g. primitive='squat', params={depth:1, cycles:3, tempo:1}; primitive names and params are listed by inspect_pmx). The call compiles, finalizes (vmd-enhancer + ground-contact bake = exactly what the stage plays and what export_motion final writes), runs the per-frame kinematic + ground-contact quality gate, renders a storyboard PNG, and returns ONE report: verdict (ok, critic, groundContact, groundNotes, actionableWarnings), vmd (bytes, sha256, key count, file path when saved), per-frame foot/hip height curves (footL/footR sole offset vs rest foot height, footLift, hipDrop), a telemetry row per authored timeline entry (keyframes), exact 3D bone coordinates at sampleTimes (coords), and the storyboard tiles. Options: outBasePath writes <base>.mpl/.vmd/.png/.json; pushToStage sends the final bytes to the PoPo stage; force returns a failed report instead of an MCP error. The step-by-step tools (compile_and_inspect_mpl2, render_pose_views, export_motion, ...) stay available.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "MPL2 script (@pose + @animation + main). Mutually exclusive with primitive." },
        primitive: { type: "string", description: "Lexicon primitive name, e.g. squat, bow, wave_hand (see the inspect_pmx lexicon list)" },
        params: {
          type: "object",
          additionalProperties: { type: "number" },
          description: 'Primitive params, e.g. {"depth": 1, "cycles": 3}. Out-of-range values are clamped, unknown names ignored.',
        },
        mirror: { type: "boolean", description: "Mirror the primitive left/right (default false)" },
        targetDuration: { type: "number", description: "Primitive only: stretch to about this many seconds by adding cycles (or hold)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
        sampleTimes: {
          type: "array",
          items: { type: "number" },
          description: "Optional timestamps (seconds) to also return exact 3D bone coordinates (coords) on the final motion",
        },
        title: { type: "string", description: "Optional motion title (stage notice / storyboard label)" },
        outBasePath: {
          type: "string",
          description: "Optional file path prefix (relative to repo root): writes <base>.mpl, .vmd, .png (storyboard) and .json (this report)",
        },
        pushToStage: { type: "boolean", description: "Push the final VMD bytes to the running PoPo stage (default false; only when the gate passes or force=true)" },
        stageUrl: { type: "string", description: "PoPo web server URL (default: http://127.0.0.1:4000)" },
        includeVmdBase64: { type: "boolean", description: "Embed the final VMD bytes as base64 in the report (default false)" },
        storyboard: { type: "boolean", description: "Render the storyboard PNG (default true; a 3-view PNG when the motion is shorter than 1.5s)" },
        maxTiles: { type: "number", description: "Max storyboard tiles (default 6)" },
        force: { type: "boolean", description: "Return the report (ok=false) instead of an MCP error when the quality gate fails (default false)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_models",
    description: "List available .pmx character models in the PoPo workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "inspect_pmx",
    description:
      "Inspect a .pmx character skeleton and return the MPL2 Authoring Guide: geometry measurements, available/missing bones, Leg IK & skirt rigids, safe & full face morph lists, valid reach/aim anchors, squat/grounding biomechanics, and lexicon entries.",
    inputSchema: {
      type: "object",
      properties: {
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "compile_and_inspect_mpl2",
    description:
      "Compile an MPL2 script to VMD and run deterministic FK kinematics on EVERY rendered frame (engine-accurate bezier/slerp interpolation), foot-lift/hip-hinge biomechanics, morph validation, and self-collision checks. The verdict (ok / critic) is on the FINAL motion (vmd-enhancer + ground-contact bake — exactly what the stage plays and export_motion final writes); criticRaw is attached only when the raw compile itself fails, to tell frame-between sinking (fixed by the bake) from authored-pose problems. Returns groundContact (per-frame foot height vs rest ankle/toe height; negative = below floor), groundBake stats, exact 3D coordinates at sampleTimes, footLiftL/R, hipDrop, hipBackShift, squatDepthRatio, armExtensionRatio, and actionableWarnings.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "MPL2 script (@pose + @animation, optional main block)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
        sampleTimes: {
          type: "array",
          items: { type: "number" },
          description: "Optional timestamps (in seconds) to inspect exact 3D bone coordinates",
        },
      },
      required: ["mpl"],
      additionalProperties: false,
    },
  },
  {
    name: "render_pose_views",
    description:
      "Compile an MPL2 script and render orthographic multi-view PNGs (single-frame Front/Side/Top or up to 6-tile Storyboard with Front + 3/4 view) of the FINAL motion (vmd-enhancer + ground-contact bake) plus per-tile foot-lift/hip telemetry and a ground-contact summary so you can visually inspect the 3D pose and iterate.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "MPL2 script (@pose + @animation, optional main block)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
        mode: {
          type: "string",
          enum: ["auto", "single", "storyboard"],
          description: "Render mode (default: auto — storyboard if duration >= 1.5s, else single 3-view)",
        },
        timeSec: { type: "number", description: "Target timestamp in seconds for single-frame mode" },
        maxTiles: { type: "number", description: "Max storyboard tiles (default: 6)" },
      },
      required: ["mpl"],
      additionalProperties: false,
    },
  },
  {
    name: "export_motion",
    description:
      "Validate, finalize, and export an MPL2 script: compiles, finalizes (mode='final': vmd-enhancer + ground-contact bake so feet stay on the floor on every rendered frame; mode='blocking': clean un-enhanced, un-baked sparse keyframes for Blender mmd_tools polish), runs the kinematic critic gate (blocks broken motions unless force=true; in blocking mode the gate is judged on a ground-baked preview of the keys because Blender handles last-mile grounding — so blocking and final agree), optionally saves .mpl/.vmd files to disk, and optionally pushes the exact final VMD bytes live to the PoPo 3D web stage. Returns groundContact / groundBake / groundNotes.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "Final MPL2 script" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
        mode: {
          type: "string",
          enum: ["final", "blocking"],
          description:
            "'blocking' exports clean un-enhanced, un-baked sparse keyframes for Blender mmd_tools polish (defaults enhance=false, pushToStage=false) and returns blenderHandoff metadata. Default: 'final'.",
        },
        enhance: { type: "boolean", description: "Apply vmd-enhancer polish (default: true in final, false in blocking; ignored in blocking)" },
        pushToStage: { type: "boolean", description: "Push live to running PoPo stage (default: true in final, false in blocking)" },
        stageUrl: { type: "string", description: "PoPo web server URL (default: http://127.0.0.1:4000)" },
        title: { type: "string", description: "Optional motion title shown in stage notice" },
        outBasePath: {
          type: "string",
          description: "Optional file path prefix (without extension) to write <outBasePath>.mpl and <outBasePath>.vmd",
        },
        force: {
          type: "boolean",
          description: "Export even if kinematic critic reports errors (default: false)",
        },
      },
      required: ["mpl"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_vmd_file",
    description:
      "Inspect an external .vmd file (e.g. exported after Blender mmd_tools polish): runs PoPo's FK kinematic critic on every rendered frame (engine-accurate interpolation), self-collision audit, foot-lift/hip-hinge telemetry, per-frame ground-contact offsets vs rest foot height — plus a ground-bake preview when the file is still un-baked (blocking exports) — and optionally renders orthographic PNG views for visual verification. ok=false means the file as-is would fail the stage quality gate.",
    inputSchema: {
      type: "object",
      properties: {
        vmdPath: { type: "string", description: "Path to the .vmd file (relative to repo root or absolute)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
        sampleTimes: {
          type: "array",
          items: { type: "number" },
          description: "Optional timestamps (in seconds) to inspect exact 3D bone coordinates",
        },
        renderViews: {
          type: "boolean",
          description: "Also render multi-view / storyboard PNG for visual verification (default: false)",
        },
      },
      required: ["vmdPath"],
      additionalProperties: false,
    },
  },
  {
    name: "push_vmd_to_stage",
    description:
      "Run kinematic critic gate on an exported .vmd file (e.g. Blender-polished final VMD) and push its raw bytes directly to the running PoPo 3D web stage (http://127.0.0.1:4000) without re-running vmd-enhancer.",
    inputSchema: {
      type: "object",
      properties: {
        vmdPath: { type: "string", description: "Path to the .vmd file (relative to repo root or absolute)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path (relative to repo root or absolute), overriding modelId" },
        title: { type: "string", description: "Optional motion title shown in stage notice" },
        stageUrl: { type: "string", description: "PoPo web server URL (default: http://127.0.0.1:4000)" },
        force: {
          type: "boolean",
          description: "Push even if kinematic critic reports errors (default: false)",
        },
      },
      required: ["vmdPath"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_duo",
    description:
      "Inspect and render a two-person (duo) interactive scene by placing Actor A (default: topaz) and Actor B (default: caelus) in a shared duo world space using [offset, yawDeg]. Each actor takes either a .vmd file (vmdPath) or an MPL2 script (mpl, compiled & ground-baked on the fly). Returns world-space landmarks, cross-actor hand/head/chest distances (distancesUnits & minWristPair), cross-actor clipping issues (torso_clipping, head_clipping, hand_inside_partner), Blender root placements (location in meters, rotation_euler_z_deg), optional worldToActorLocal conversion for exact 'reach hand_<l|r> to [x,y,z];' targeting, and side-by-side duo orthographic multi-view / storyboard PNGs.",
    inputSchema: {
      type: "object",
      properties: {
        actorA: {
          type: "object",
          description: "First character (rendered in pink/magenta palette with badge A)",
          properties: {
            modelId: { type: "string", description: "Model id (default: topaz)" },
            pmxPath: { type: "string", description: "Optional local .pmx path, overriding modelId" },
            label: { type: "string", description: "Display label (default: A)" },
            vmdPath: { type: "string", description: "Path to .vmd file (mutually exclusive with mpl)" },
            mpl: { type: "string", description: "MPL2 script to compile & ground-bake on the fly (mutually exclusive with vmdPath)" },
            offset: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
              description: "Shared world offset [x, y, z] in MMD units (1u = 8cm). Default: [0, 0, 0]",
            },
            yawDeg: {
              type: "number",
              description: "Heading in degrees (0 = -Z forward, +90 = +X left/toward partner, -90 = -X right, 180 = +Z). Matches Blender root.rotation_euler.z.",
            },
          },
          additionalProperties: false,
        },
        actorB: {
          type: "object",
          description: "Second character (rendered in sky/teal palette with badge B)",
          properties: {
            modelId: { type: "string", description: "Model id (default: caelus)" },
            pmxPath: { type: "string", description: "Optional local .pmx path, overriding modelId" },
            label: { type: "string", description: "Display label (default: B)" },
            vmdPath: { type: "string", description: "Path to .vmd file (mutually exclusive with mpl)" },
            mpl: { type: "string", description: "MPL2 script to compile & ground-bake on the fly (mutually exclusive with vmdPath)" },
            offset: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
              description: "Shared world offset [x, y, z] in MMD units (1u = 8cm). Default: [0, 0, 0]",
            },
            yawDeg: {
              type: "number",
              description: "Heading in degrees (0 = -Z forward, +90 = +X, -90 = -X, 180 = +Z).",
            },
          },
          additionalProperties: false,
        },
        sampleTimes: {
          type: "array",
          items: { type: "number" },
          description: "Optional timestamps (in seconds) to evaluate cross-actor distances and world landmarks",
        },
        renderViews: {
          type: "boolean",
          description: "Render duo orthographic multi-view / storyboard PNG (default: true)",
        },
        mode: {
          type: "string",
          enum: ["auto", "single", "storyboard"],
          description: "Render mode (default: auto — storyboard if duration >= 1.5s, else single 3-view)",
        },
        timeSec: {
          type: "number",
          description: "Target timestamp in seconds when mode='single'",
        },
        maxTiles: {
          type: "number",
          description: "Max storyboard tiles (default: 6)",
        },
        convertWorldPointFor: {
          type: "object",
          description: "Optional helper: convert a shared world [x, y, z] coordinate (e.g. partner's landmarksWorld.handR) into actor-local [x, y, z] for 'reach hand_<l|r> to [x,y,z];'",
          properties: {
            actor: { type: "string", enum: ["A", "B"] },
            worldPoint: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
            },
          },
          required: ["actor", "worldPoint"],
          additionalProperties: false,
        },
      },
      required: ["actorA", "actorB"],
      additionalProperties: false,
    },
  },
  {
    name: "get_blender_scene_info",
    description:
      "Read-only check of the connected local Blender GUI via the blender_mcp.py addon socket (default 127.0.0.1:9876): returns scene name, object count, first objects, materials count, and optional addon/version handshake.",
    inputSchema: {
      type: "object",
      properties: {
        includeAddonInfo: { type: "boolean", description: "Also query get_addon_info (Blender version & capabilities, default true)" },
        host: { type: "string", description: "Blender MCP socket host (default: BLENDER_HOST or 127.0.0.1)" },
        port: { type: "number", description: "Blender MCP socket port (default: BLENDER_PORT or 9876)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "execute_blender_code",
    description:
      "Execute arbitrary Blender Python (bpy / mmd_tools) inside the user's running local Blender GUI via the blender_mcp.py addon socket (default 127.0.0.1:9876). Use this for Stage 2 mmd_tools import, F-Curve smoothing, sole-to-floor cleanup, dual-rig placement, and VMD export; only call when the user wants Blender updated.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute in Blender's bpy context (stdout is captured and returned)" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 120000)" },
        host: { type: "string", description: "Blender MCP socket host (default: BLENDER_HOST or 127.0.0.1)" },
        port: { type: "number", description: "Blender MCP socket port (default: BLENDER_PORT or 9876)" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "compile_motion_intent",
    description:
      "Compile a high-level beat-based MotionIntent JSON directly into a smooth, grounded .vmd using PoPo's Semantic-Kinematic Rig Profile (multi-slice elliptical hulls, mesh-snapped surface anchors, 6-DOF palm basis, hybrid spring-damper dynamics, 2-bone Leg IK grounding, soft-tissue coupling for 腕捩/グルーブ/胸, and Verlet secondary physics chains for hair/ribbons/skirts).",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "object",
          description: "MotionIntent JSON: { title?, fps?, breathing?, autoBlink?, secondaryPhysics?, beats: [{ at, effort?, passThrough?, stance?, spine?, hand_l?, hand_r?, gaze?, face? }] }",
        },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        pmxPath: { type: "string", description: "Optional local .pmx path overriding modelId" },
        outVmdPath: { type: "string", description: "Optional output .vmd path (default: .tmp/intent-motion.vmd)" },
        rebuildProfile: { type: "boolean", description: "Force rebuild of <model>.rig-profile.json (default: false)" },
      },
      required: ["intent"],
      additionalProperties: false,
    },
  },
  {
    name: "get_blender_viewport",
    description:
      "Capture an offscreen screenshot of the active 3D Viewport from the connected local Blender GUI (via blender_mcp.py) and return it as an inline PNG image for visual mesh/skirt/hand inspection.",
    inputSchema: {
      type: "object",
      properties: {
        maxSize: { type: "number", description: "Maximum dimension in pixels (default: 800)" },
        filepath: { type: "string", description: "Optional path to keep the captured PNG; if omitted a temp file is used and removed after reading" },
        host: { type: "string", description: "Blender MCP socket host (default: BLENDER_HOST or 127.0.0.1)" },
        port: { type: "number", description: "Blender MCP socket port (default: BLENDER_PORT or 9876)" },
      },
      additionalProperties: false,
    },
  },
]

async function handleToolCall(name: string, args: Record<string, unknown>) {
  if (name === "list_models") {
    const models = scanPublicModels().map((m) => {
      const fullPath = m.pmxPath ?? path.join(PUBLIC_DIR, m.url.replace(/^\/+/, ""))
      return { id: m.id, label: m.label, url: m.url, exists: fs.existsSync(fullPath) }
    })
    return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] }
  }

  if (name === "inspect_pmx") {
    const { entry, bones } = loadModelFromArgs(args)
    const cond = buildModelConditioning(bones)
    const payload = {
      model: entry,
      mpl2AuthoringGuide: MPL2_AUTHORING_GUIDE,
      conditioningText: cond.text,
      measurements: cond.measurements,
      availableCoreBones: cond.available,
      missingCoreBones: cond.missing,
      extendedBones: cond.extendedAvailable,
      legIk: cond.legIk,
      skirtRigids: cond.skirtRigids,
      allFaceMorphs: bones.faceMorphs,
      validReachAnchors: [...VALID_REACH_ANCHORS],
      validAimTargets: [...VALID_AIM_TARGETS],
      lexicon: LEXICON.map((l) => ({ name: l.name, description: l.description, params: l.params })),
    }
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
  }

  if (name === "compile_and_inspect_mpl2") {
    const rawMpl = typeof args.mpl === "string" ? args.mpl : ""
    if (!rawMpl.trim()) throw new Error("mpl is required")
    const mpl = ensureCompilableMpl(rawMpl)
    const { bones } = loadModelFromArgs(args)
    const compiler = await getServerCompiler()
    if (!compiler) throw new Error("WASM MPL compiler unavailable")

    const res = compileMPL2(compiler, mpl, bones)
    if (res.vmd.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                vmdBytes: 0,
                directiveErrors: res.directiveErrors,
                warnings: res.warnings,
                error: "Compiler produced 0 bytes (syntax error, unknown bone/action/direction, or missing @pose/@animation)",
              },
              null,
              2
            ),
          },
        ],
      }
    }

    // 成品 = 增强 + 贴地烘焙 —— 与舞台 chat 播放、export_motion final 是同一条管线。
    // 闸门看成品；raw 编译产物的 critic 只在它失败时附上（criticRaw），
    // 用来区分“过渡段帧间下沉（烘焙已修）”和“作者姿势本身的问题”。
    const audit = auditVmd(res.vmd, bones)
    const fin = finalizeMotion(audit.vmd, bones, { mplSource: mpl, enhanceOptions: { autoBlink: true } })
    const finalVmd = fin.vmd
    const keys = readVmdBoneKeys(finalVmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const timeline = [{ index: 0, start: 0, end: durationSec }]
    const criticRaw = critiquePoseVmd(bones, res.vmd, mpl, timeline)
    const critic = critiquePoseVmd(bones, finalVmd, mpl, timeline)
    const sampleTimes = Array.isArray(args.sampleTimes) ? args.sampleTimes.map(Number) : undefined
    const keyframeCoords = extractKeyframeCoords(bones, finalVmd, sampleTimes)
    const actionableWarnings = buildBiomechanicalWarnings(mpl, res.warnings, keyframeCoords, bones)
    const ground = groundReport(fin)

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: res.directiveErrors.length === 0 && (critic?.passed ?? true),
              durationSec,
              vmdBytes: res.vmd.length,
              finalVmdBytes: finalVmd.length,
              rawKeyCount: (readVmdBoneKeys(res.vmd) ?? []).length,
              finalKeyCount: keys.length,
              morphCount: res.morphCount,
              composed: res.composed,
              directiveErrors: res.directiveErrors,
              actionableWarnings,
              collisions: res.collisions,
              critic,
              criticRaw: criticRaw && !criticRaw.passed ? criticRaw : undefined,
              groundContact: ground.ground,
              groundBake: ground.bake,
              groundNotes: ground.notes,
              audit: { violations: audit.violations, fixed: audit.fixed },
              keyframeCoords,
            },
            null,
            2
          ),
        },
      ],
    }
  }

  if (name === "render_pose_views") {
    const rawMpl = typeof args.mpl === "string" ? args.mpl : ""
    if (!rawMpl.trim()) throw new Error("mpl is required")
    const mpl = ensureCompilableMpl(rawMpl)
    const { bones } = loadModelFromArgs(args)
    const compiler = await getServerCompiler()
    if (!compiler) throw new Error("WASM MPL compiler unavailable")

    const res = compileMPL2(compiler, mpl, bones)
    if (res.vmd.length === 0) {
      throw new Error(`Cannot render: compiler produced 0 bytes. directiveErrors=${res.directiveErrors.join("; ")}`)
    }

    // 画的是成品（增强 + 贴地烘焙后）：与舞台播放、kinematic critic 同源
    const fin = finalizeMotion(auditVmd(res.vmd, bones).vmd, bones, {
      mplSource: mpl,
      enhanceOptions: { autoBlink: true },
    })
    const finalVmd = fin.vmd
    const keys = readVmdBoneKeys(finalVmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = maxFrame / 30
    const mode = typeof args.mode === "string" ? args.mode : "auto"
    const useStoryboard = mode === "storyboard" || (mode === "auto" && durationSec >= 1.5 && args.timeSec == null)

    if (useStoryboard) {
      const maxTiles = typeof args.maxTiles === "number" ? Math.max(2, Math.min(8, args.maxTiles)) : 6
      const sb = renderStoryboardPng(bones, finalVmd, [{ index: 0, start: 0, end: durationSec, action: "preview", source: "llm" }], { maxTiles })
      if (!sb) throw new Error("Failed to render storyboard PNG")
      const base64 = sb.dataUrl.replace(/^data:image\/png;base64,/, "")
      const tileCoords = extractKeyframeCoords(
        bones,
        finalVmd,
        sb.tiles.map((t) => t.timeSec)
      )
      const allCoords = extractKeyframeCoords(bones, finalVmd)
      const critic = critiquePoseVmd(bones, finalVmd, mpl, [{ index: 0, start: 0, end: durationSec }])
      const warnings = buildBiomechanicalWarnings(mpl, res.warnings, allCoords, bones)
      const tileSummary = tileCoords
        .map((c) => `t=${c.timeSec}s(footLiftL=${c.footLiftL}u,R=${c.footLiftR}u,hipDrop=${c.hipDrop}u,hipBack=${c.hipBackShift}u)`)
        .join("; ")
      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" },
          {
            type: "text",
            text:
              `Rendered ${sb.tiles.length}-tile storyboard (${sb.width}x${sb.height}, duration=${durationSec.toFixed(2)}s) of the FINAL motion (enhanced + ground-baked).\n` +
              `Tile telemetry: ${tileSummary}\n` +
              `Kinematic critic: ${critic?.summary ?? "n/a"}\n` +
              `Ground contact: ${describeGroundEn(fin)}` +
              (warnings.length > 0 ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
          },
        ],
      }
    }

    const targetFrame = typeof args.timeSec === "number" ? secondsToFrame(Math.max(0, args.timeSec)) : undefined
    const single = renderPoseMultiViewPng(bones, finalVmd, targetFrame)
    if (!single) throw new Error("Failed to render multi-view PNG")
    const base64 = single.dataUrl.replace(/^data:image\/png;base64,/, "")
    const [pt] = extractKeyframeCoords(bones, finalVmd, [single.timeSec])
    const warnings = buildBiomechanicalWarnings(mpl, res.warnings, pt ? [pt] : [], bones)
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        {
          type: "text",
          text:
            `Rendered 3-view PNG (Front/Side/Top, ${single.width}x${single.height}) of the FINAL motion at frame=${single.frame} (t=${single.timeSec.toFixed(2)}s). ` +
            (pt ? `footLiftL=${pt.footLiftL}u, footLiftR=${pt.footLiftR}u, hipDrop=${pt.hipDrop}u, hipBack=${pt.hipBackShift}u` : "") +
            `\nGround contact: ${describeGroundEn(fin)}` +
            (warnings.length > 0 ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
        },
      ],
    }
  }

  if (name === "export_motion") {
    const rawMpl = typeof args.mpl === "string" ? args.mpl : ""
    if (!rawMpl.trim()) throw new Error("mpl is required")
    const mpl = ensureCompilableMpl(rawMpl)
    const { entry, bones } = loadModelFromArgs(args)
    const compiler = await getServerCompiler()
    if (!compiler) throw new Error("WASM MPL compiler unavailable")

    const res = compileMPL2(compiler, mpl, bones)
    if (res.vmd.length === 0) {
      throw new Error(`Export aborted: compiler produced 0 bytes. directiveErrors=${res.directiveErrors.join("; ")}`)
    }

    const exportMode = args.mode === "blocking" ? "blocking" : "final"
    const audit = auditVmd(res.vmd, bones)
    // final：增强 + 贴地烘焙（与舞台 playMplOnStage、compile_and_inspect_mpl2 同一条管线）。
    // blocking：稀疏键原样导出给 Blender 精修 —— 永不增强、永不烘焙。
    const fin = finalizeMotion(audit.vmd, bones, {
      enhance: args.enhance !== undefined ? Boolean(args.enhance) : exportMode !== "blocking",
      bake: exportMode !== "blocking",
      mplSource: mpl,
      enhanceOptions: { autoBlink: true },
    })
    const finalVmd = fin.vmd
    // 闸门对象：final 看成品；blocking 看“这组稀疏键经标准贴地烘焙后”的预览。
    // 过渡段帧间下沉是 Blender 那一步本来就要处理的事，不该拦下；作者姿势本身的错误照样拦。
    // 这样 blocking 与 final / compile_and_inspect_mpl2 的结论一致。
    const gate = exportMode === "blocking" ? finalizeMotion(audit.vmd, bones, { enhance: false, bake: true, mplSource: mpl }) : fin
    const shouldEnhance = fin.enhanced
    const shouldPush = args.pushToStage !== undefined ? Boolean(args.pushToStage) : exportMode !== "blocking"
    const keys = readVmdBoneKeys(finalVmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const timeline = [{ index: 0, start: 0, end: durationSec }]
    const critic = critiquePoseVmd(bones, gate.vmd, mpl, timeline)
    const coords = extractKeyframeCoords(bones, finalVmd)
    const actionableWarnings = buildBiomechanicalWarnings(mpl, res.warnings, coords, bones)
    const ground = groundReport(fin)
    const gateReport = exportMode === "blocking" ? groundReport(gate) : null
    const groundNotes = gateReport ? blockingGroundNotes(fin, gate) : ground.notes
    const qualityGate = gateReport
      ? {
          checked: "ground-baked preview of the blocking keys (exported bytes stay un-baked)",
          passed: critic?.passed ?? true,
          groundContact: gateReport.ground,
          groundBake: gateReport.bake,
        }
      : undefined

    if ((res.directiveErrors.length > 0 || (critic && !critic.passed)) && args.force !== true) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                blockedByQualityGate: true,
                directiveErrors: res.directiveErrors,
                critic,
                criticRaw: critiquePoseVmd(bones, res.vmd, mpl, timeline),
                actionableWarnings,
                groundContact: ground.ground,
                groundBake: ground.bake,
                groundNotes,
                qualityGate,
                message: "Export blocked by kinematic/directive quality gate. Fix the issues above and re-test, or pass force=true to override.",
              },
              null,
              2
            ),
          },
        ],
      }
    }

    const writtenFiles: string[] = []
    let writtenVmdPath: string | null = null
    if (typeof args.outBasePath === "string" && args.outBasePath.trim()) {
      const base = path.resolve(ROOT_DIR, args.outBasePath.trim())
      fs.mkdirSync(path.dirname(base), { recursive: true })
      fs.writeFileSync(`${base}.mpl`, mpl, "utf8")
      fs.writeFileSync(`${base}.vmd`, finalVmd)
      writtenVmdPath = `${base}.vmd`
      writtenFiles.push(`${base}.mpl`, writtenVmdPath)
    }

    let stagePushResult: unknown = { skipped: true }
    if (shouldPush) {
      // baseRotated / legsKeyed 取自 compileMPL2（与舞台 MPL 路径判定同源）。
      stagePushResult = await pushMotionToStage(args, {
        mpl,
        vmdBase64: Buffer.from(finalVmd).toString("base64"),
        baseRotated: Boolean(res.baseRotated),
        legsKeyed: Boolean(res.legsKeyed),
        title: typeof args.title === "string" ? args.title : undefined,
      })
    }

    const pmxAbsPath = path.join(PUBLIC_DIR, entry.url.replace(/^\/+/, ""))
    const blenderHandoff =
      exportMode === "blocking"
        ? {
            pmxPath: pmxAbsPath,
            vmdPath: writtenVmdPath,
            frameStart: 0,
            frameEnd: maxFrame,
            fps: 30,
            importArgs: { scale: 0.08, margin: 0, bone_mapper: "PMX", update_scene_settings: true },
            disableIkBones: ["左足ＩＫ", "右足ＩＫ"],
            exportArgs: { scale: 12.5, use_frame_range: true },
          }
        : undefined

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              mode: exportMode,
              vmdBytes: finalVmd.length,
              vmdSha256: crypto.createHash("sha256").update(finalVmd).digest("hex"),
              enhanced: shouldEnhance,
              baked: fin.baked,
              directiveErrors: res.directiveErrors,
              actionableWarnings,
              criticSummary: critic?.summary,
              groundContact: ground.ground,
              groundBake: ground.bake,
              groundNotes,
              qualityGate,
              writtenFiles,
              blenderHandoff,
              stagePush: stagePushResult,
            },
            null,
            2
          ),
        },
      ],
    }
  }

  if (name === "make_motion") {
    const rawMpl = typeof args.mpl === "string" ? args.mpl : ""
    const primitiveName = typeof args.primitive === "string" ? args.primitive.trim() : ""
    if (!rawMpl.trim() && !primitiveName) throw new Error("provide either mpl (MPL2 script) or primitive (lexicon name)")
    const { entry, bones } = loadModelFromArgs(args)
    const compiler = await getServerCompiler()
    if (!compiler) throw new Error("WASM MPL compiler unavailable")

    // 1) 来源：词库原语 + 参数（clamp / 目标时长自适应 / 镜像都在 expandLexiconSegment 里），或直接给 MPL 脚本
    let mpl: string
    let source: Record<string, unknown>
    if (primitiveName) {
      const requested = args.params && typeof args.params === "object" ? (args.params as Record<string, unknown>) : {}
      const params: Record<string, number> = {}
      for (const [k, v] of Object.entries(requested)) {
        const n = Number(v)
        if (Number.isFinite(n)) params[k] = n
      }
      const targetDuration = typeof args.targetDuration === "number" && args.targetDuration > 0 ? args.targetDuration : undefined
      const seg = expandLexiconSegment(primitiveName, params, args.mirror === true, targetDuration)
      if (!seg) throw new Error(`unknown lexicon primitive "${primitiveName}" — call inspect_pmx for the lexicon list`)
      mpl = ensureCompilableMpl(seg.fragment)
      source = { kind: "lexicon", primitive: seg.name, durationSec: seg.duration, requestedParams: params, effectiveParams: seg.params, mirror: args.mirror === true, targetDuration }
    } else {
      mpl = ensureCompilableMpl(rawMpl)
      source = { kind: "mpl", chars: rawMpl.length }
    }

    const res = compileMPL2(compiler, mpl, bones)
    if (res.vmd.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: stringifyReport({
              ok: false,
              source,
              directiveErrors: res.directiveErrors,
              warnings: res.warnings,
              error: "Compiler produced 0 bytes (syntax error, unknown bone/action/direction, or missing @pose/@animation)",
            }),
          },
        ],
      }
    }

    // 2) 成品管线（增强 + 贴地烘焙）—— 与舞台播放、export_motion final、compile_and_inspect_mpl2 同源
    const audit = auditVmd(res.vmd, bones)
    const fin = finalizeMotion(audit.vmd, bones, { mplSource: mpl, enhanceOptions: { autoBlink: true } })
    const finalVmd = fin.vmd
    const keys = readVmdBoneKeys(finalVmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const timeline = [{ index: 0, start: 0, end: durationSec }]
    const critic = critiquePoseVmd(bones, finalVmd, mpl, timeline)
    const criticRaw = critiquePoseVmd(bones, res.vmd, mpl, timeline)
    const ground = groundReport(fin)

    // 3) 逐帧曲线 + 作者时间轴判定帧的 3D 坐标（带姿势名）
    const curves = motionCurves(bones, finalVmd, measureGroundErrorVmd(finalVmd, bones))
    const timelineRefs = parsePoseTextsAndTimeline(mpl).frames
    const entryRefs = timelineRefs.slice(0, 40)
    // 作者时间轴的时长（最后一个条目）；成片时长 durationSec 可能因增强器的收尾键略长
    const authoredSec = Number(((timelineRefs.at(-1)?.frame ?? maxFrame) / 30).toFixed(2))
    // 判定帧表：每个时间轴条目一行的标量遥测（姿势名 + 髋/脚指标）；完整 3D 坐标按 sampleTimes 另取
    const entryCoords = extractKeyframeCoords(bones, finalVmd, entryRefs.map((e) => e.frame / 30))
    const coordsByFrame = new Map(entryCoords.map((c) => [c.frame, c]))
    const keyframes = entryRefs.flatMap((e) => {
      const c = coordsByFrame.get(e.frame)
      return c
        ? [
            {
              frame: c.frame,
              t: c.timeSec,
              pose: e.refs.join(","),
              hipDrop: c.hipDrop,
              hipBackShift: c.hipBackShift,
              footLiftL: c.footLiftL,
              footLiftR: c.footLiftR,
              squatDepthRatio: c.squatDepthRatio,
              armExtL: c.armExtensionRatioL,
              armExtR: c.armExtensionRatioR,
            },
          ]
        : []
    })
    const sampleTimes = Array.isArray(args.sampleTimes) ? (args.sampleTimes as unknown[]).map(Number).filter((t) => Number.isFinite(t)) : []
    const coords = sampleTimes.length > 0 ? extractKeyframeCoords(bones, finalVmd, sampleTimes) : undefined
    const warnings = buildBiomechanicalWarnings(mpl, res.warnings, extractKeyframeCoords(bones, finalVmd), bones)

    // 4) 分镜（≥1.5s 用 storyboard，否则三视图）
    let image: { base64: string; width: number; height: number } | null = null
    let storyboard: Record<string, unknown> | undefined
    if (args.storyboard !== false) {
      if (durationSec >= 1.5) {
        const maxTiles = typeof args.maxTiles === "number" ? Math.max(2, Math.min(8, args.maxTiles)) : 6
        const sb = renderStoryboardPng(
          bones,
          finalVmd,
          [{ index: 0, start: 0, end: durationSec, action: String(source.primitive ?? source.kind), source: "llm" }],
          { maxTiles }
        )
        if (sb) {
          image = { base64: sb.dataUrl.replace(/^data:image\/png;base64,/, ""), width: sb.width, height: sb.height }
          storyboard = { kind: "storyboard", tilesSec: sb.tiles.map((t) => Number(t.timeSec.toFixed(2))), width: sb.width, height: sb.height }
        }
      } else {
        const single = renderPoseMultiViewPng(bones, finalVmd)
        if (single) {
          image = { base64: single.dataUrl.replace(/^data:image\/png;base64,/, ""), width: single.width, height: single.height }
          storyboard = { kind: "views", views: ["front", "side", "top"], frame: single.frame, t: Number(single.timeSec.toFixed(2)), width: single.width, height: single.height }
        }
      }
    }

    // 5) 落盘：<base>.mpl / .vmd / .png（.json 在报告生成后写）
    const writtenFiles: string[] = []
    let vmdPath: string | null = null
    let pngPath: string | null = null
    let jsonPath: string | null = null
    if (typeof args.outBasePath === "string" && args.outBasePath.trim()) {
      const base = path.resolve(ROOT_DIR, args.outBasePath.trim())
      fs.mkdirSync(path.dirname(base), { recursive: true })
      fs.writeFileSync(`${base}.mpl`, mpl, "utf8")
      fs.writeFileSync(`${base}.vmd`, finalVmd)
      vmdPath = `${base}.vmd`
      writtenFiles.push(`${base}.mpl`, vmdPath)
      if (image) {
        pngPath = `${base}.png`
        fs.writeFileSync(pngPath, Buffer.from(image.base64, "base64"))
        writtenFiles.push(pngPath)
      }
      jsonPath = `${base}.json`
      writtenFiles.push(jsonPath)
    }

    // 6) 闸门：指令错误或成品 critic 未过 → ok=false（force=true 时仍返回报告；否则作为 MCP 错误返回，附分镜便于定位）
    const gatePassed = res.directiveErrors.length === 0 && (critic?.passed ?? true)
    const forced = !gatePassed && args.force === true
    const allIssues = critic?.issues ?? []
    const issues = allIssues.slice(0, 12).map(({ code, frame, frameEnd, frameCount, severity, message, fixHint }) => ({
      code,
      frame,
      frameEnd,
      frameCount,
      severity,
      message,
      fixHint,
    }))

    let stagePush: unknown
    if (args.pushToStage === true) {
      if (gatePassed || forced) {
        stagePush = await pushMotionToStage(args, {
          mpl,
          vmdBase64: Buffer.from(finalVmd).toString("base64"),
          baseRotated: Boolean(res.baseRotated),
          legsKeyed: Boolean(res.legsKeyed),
          title: typeof args.title === "string" ? args.title : String(source.primitive ?? "make_motion"),
        })
      } else {
        stagePush = { ok: false, skipped: true, reason: "quality gate failed — pass force=true to push anyway" }
      }
    }

    const report = {
      ok: gatePassed,
      forced: forced || undefined,
      source,
      modelId: entry.id,
      durationSec,
      authoredSec,
      frames: maxFrame + 1,
      fps: 30,
      vmd: {
        bytes: finalVmd.length,
        sha256: crypto.createHash("sha256").update(finalVmd).digest("hex"),
        boneKeys: keys.length,
        rawBoneKeys: (readVmdBoneKeys(res.vmd) ?? []).length,
        path: vmdPath,
        base64: args.includeVmdBase64 === true ? Buffer.from(finalVmd).toString("base64") : undefined,
      },
      pipeline: { enhanced: fin.enhanced, baked: fin.baked, groundBake: ground.bake },
      verdict: {
        passed: gatePassed,
        critic: { passed: critic?.passed ?? true, summary: critic?.summary ?? "n/a", issueCount: allIssues.length, issues },
        // raw 编译产物的 critic 只在它失败时附上，并说明成品是否已把它修掉：
        // 深蹲等动作的原始键在关键帧之间必然沉地（ground_penetration）→ fixedByFinalize=true；
        // 成品也没修掉的才是作者姿势本身的问题。
        criticRaw:
          criticRaw && !criticRaw.passed
            ? { passed: false, summary: criticRaw.summary, issueCount: criticRaw.issues.length, fixedByFinalize: gatePassed }
            : undefined,
        groundContact: ground.ground,
        groundNotes: ground.notes,
        actionableWarnings: warnings,
        directiveErrors: res.directiveErrors,
        compilerWarnings: res.warnings.slice(0, 12),
        collisions: { count: res.collisions.length, first: res.collisions.slice(0, 6) },
        audit: { checkedFrames: audit.checkedFrames, violations: audit.violations.length, fixed: audit.fixed.length, unresolved: audit.unresolved.length },
      },
      curves,
      keyframes,
      coords,
      storyboard: storyboard ? { ...storyboard, path: pngPath } : undefined,
      writtenFiles,
      stagePush,
    }
    const text = stringifyReport(report)
    if (jsonPath) fs.writeFileSync(jsonPath, text, "utf8")
    const content: { type: "image" | "text"; data?: string; mimeType?: string; text?: string }[] = []
    if (image) content.push({ type: "image", data: image.base64, mimeType: "image/png" })
    content.push({ type: "text", text })
    return gatePassed || forced ? { content } : { isError: true, content }
  }

  if (name === "inspect_vmd_file") {
    const rawPath = typeof args.vmdPath === "string" ? args.vmdPath.trim() : ""
    if (!rawPath) throw new Error("vmdPath is required")
    const absPath = path.resolve(ROOT_DIR, rawPath)
    if (!fs.existsSync(absPath)) throw new Error(`VMD file not found: ${absPath}`)
    const vmdBytes = new Uint8Array(fs.readFileSync(absPath))
    const { bones } = loadModelFromArgs(args)
    const keys = readVmdBoneKeys(vmdBytes) ?? []
    if (keys.length === 0) {
      throw new Error(`VMD contains 0 bone keyframes: ${absPath}`)
    }
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const critic = critiquePoseVmd(bones, vmdBytes, "", [{ index: 0, start: 0, end: durationSec }])
    const audit = auditVmd(vmdBytes, bones)
    const sampleTimes = Array.isArray(args.sampleTimes) ? args.sampleTimes.map(Number) : undefined
    const keyframeCoords = extractKeyframeCoords(bones, vmdBytes, sampleTimes)
    const telemetryWarnings: string[] = []
    for (const pt of keyframeCoords) {
      if ((pt.footLiftL != null && pt.footLiftL > 0.6) || (pt.footLiftR != null && pt.footLiftR > 0.6)) {
        telemetryWarnings.push(`t=${pt.timeSec}s: footLiftL=${pt.footLiftL}u, footLiftR=${pt.footLiftR}u`)
      }
    }

    const content: Array<Record<string, unknown>> = []
    // 外部文件按字节原样评判（舞台上也是原样播放）。若它尚未烘焙（blocking 导出属预期），
    // 附一份“标准贴地烘焙后会怎样”的预览：区分“帧间偏差，烘焙可修”与“作者关键帧本身的问题”。
    const groundContact = groundSummaryOf(bones, vmdBytes)
    const groundNotes: string[] = []
    let groundBakePreview: Record<string, unknown> | null = null
    if (groundContact && groundContact.offendingFrames > 0) {
      const sink = Math.min(0, groundContact.feet.l.min, groundContact.feet.r.min)
      groundNotes.push(
        `${groundContact.offendingFrames} foot-frame(s) deviate from the floor when this file is played as-is (deepest sink ${sink.toFixed(3)}u)`
      )
      const preview = finalizeMotion(vmdBytes, bones, { enhance: false, bake: true })
      const bs = preview.bakeStats
      const after = preview.ground
      groundBakePreview = {
        applied: preview.baked,
        insertedKeys: bs?.insertedKeys ?? 0,
        residualFrames: bs?.residualFrames ?? 0,
        residualAtEntries: bs?.residualAtEntries ?? 0,
        windows: bs?.windows ?? [],
        after,
      }
      groundNotes.push(
        after && after.offendingFrames === 0
          ? `the standard ground bake fixes all of them (+${bs?.insertedKeys ?? 0} keys) — expected for an un-baked mode="blocking" export; re-inspect after Blender / ground polish before pushing`
          : `${after?.offendingFrames ?? "?"} foot-frame(s) would remain after the standard ground bake (${bs?.residualAtEntries ?? "?"} on authored key poses) — fix those key poses`
      )
    }
    if (args.renderViews === true) {
      if (durationSec >= 1.5) {
        const sb = renderStoryboardPng(bones, vmdBytes, [{ index: 0, start: 0, end: durationSec, action: "vmd", source: "llm" }], { maxTiles: 6 })
        if (sb) {
          content.push({ type: "image", data: sb.dataUrl.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" })
        }
      } else {
        const single = renderPoseMultiViewPng(bones, vmdBytes)
        if (single) {
          content.push({ type: "image", data: single.dataUrl.replace(/^data:image\/png;base64,/, ""), mimeType: "image/png" })
        }
      }
    }
    content.push({
      type: "text",
      text: JSON.stringify(
        {
          ok: critic?.passed ?? true,
          vmdPath: absPath,
          vmdBytes: vmdBytes.length,
          boneKeyCount: keys.length,
          maxFrame,
          durationSec,
          critic,
          audit: { violations: audit.violations },
          groundContact,
          groundBakePreview,
          groundNotes,
          telemetryWarnings,
          keyframeCoords,
        },
        null,
        2
      ),
    })
    return { content }
  }

  if (name === "push_vmd_to_stage") {
    const rawPath = typeof args.vmdPath === "string" ? args.vmdPath.trim() : ""
    if (!rawPath) throw new Error("vmdPath is required")
    const absPath = path.resolve(ROOT_DIR, rawPath)
    if (!fs.existsSync(absPath)) throw new Error(`VMD file not found: ${absPath}`)
    const vmdBytes = new Uint8Array(fs.readFileSync(absPath))
    const { bones } = loadModelFromArgs(args)
    const keys = readVmdBoneKeys(vmdBytes) ?? []
    if (keys.length === 0) throw new Error(`VMD contains 0 bone keyframes: ${absPath}`)

    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const critic = critiquePoseVmd(bones, vmdBytes, "", [{ index: 0, start: 0, end: durationSec }])
    if (critic && !critic.passed && args.force !== true) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                blockedByQualityGate: true,
                critic,
                groundContact: groundSummaryOf(bones, vmdBytes),
                message: "Push blocked by kinematic quality gate. Fix in Blender or pass force=true to override.",
              },
              null,
              2
            ),
          },
        ],
      }
    }

    const baseRotated = keys.some(
      (k) => k.jp === "全ての親" && (Math.abs(k.quat[0]) > 1e-3 || Math.abs(k.quat[1]) > 1e-3 || Math.abs(k.quat[2]) > 1e-3)
    )
    const legSet = new Set(["左足", "右足", "左ひざ", "右ひざ", "左足首", "右足首"])
    const legsKeyed = keys.some((k) => legSet.has(k.jp))
    const stageUrl = (typeof args.stageUrl === "string" && args.stageUrl.trim() ? args.stageUrl.trim() : "http://127.0.0.1:4000").replace(/\/+$/, "")

    let stagePushResult: unknown
    try {
      const pushRes = await fetch(`${stageUrl}/api/stage-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vmdBase64: Buffer.from(vmdBytes).toString("base64"),
          baseRotated,
          legsKeyed,
          title: typeof args.title === "string" ? args.title : path.basename(absPath),
        }),
      })
      stagePushResult = pushRes.ok
        ? await pushRes.json()
        : { ok: false, status: pushRes.status, error: await pushRes.text().catch(() => "") }
    } catch (e) {
      stagePushResult = {
        ok: false,
        error: `Stage server unreachable at ${stageUrl} (${e instanceof Error ? e.message : String(e)})`,
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              vmdPath: absPath,
              vmdBytes: vmdBytes.length,
              durationSec,
              baseRotated,
              legsKeyed,
              criticSummary: critic?.summary,
              groundContact: groundSummaryOf(bones, vmdBytes),
              stagePush: stagePushResult,
            },
            null,
            2
          ),
        },
      ],
    }
  }

  if (name === "inspect_duo") {
    const rawA = (args.actorA && typeof args.actorA === "object" ? args.actorA : {}) as Record<string, unknown>
    const rawB = (args.actorB && typeof args.actorB === "object" ? args.actorB : {}) as Record<string, unknown>

    const normalizeOffset = (val: unknown): [number, number, number] => {
      if (Array.isArray(val) && val.length >= 3) {
        return [Number(val[0]) || 0, Number(val[1]) || 0, Number(val[2]) || 0]
      }
      return [0, 0, 0]
    }

    const resolveActor = async (
      raw: Record<string, unknown>,
      defaultModelId: string,
      fallbackLabel: string
    ) => {
      const modelId = typeof raw.modelId === "string" && raw.modelId.trim() ? raw.modelId.trim() : defaultModelId
      const pmxPath = typeof raw.pmxPath === "string" && raw.pmxPath.trim() ? raw.pmxPath.trim() : undefined
      const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : fallbackLabel
      const { entry, bones } = loadModelSync(modelId, pmxPath)
      const placement: DuoPlacement = {
        offset: normalizeOffset(raw.offset),
        yawDeg: Number.isFinite(Number(raw.yawDeg)) ? Number(raw.yawDeg) : 0,
      }

      const vmdPathArg = typeof raw.vmdPath === "string" ? raw.vmdPath.trim() : ""
      const mplArg = typeof raw.mpl === "string" ? raw.mpl : ""
      let vmd: Uint8Array
      let sourceDesc: Record<string, unknown>
      if (vmdPathArg) {
        const abs = path.resolve(ROOT_DIR, vmdPathArg)
        if (!fs.existsSync(abs)) throw new Error(`${fallbackLabel}: VMD file not found: ${abs}`)
        vmd = new Uint8Array(fs.readFileSync(abs))
        sourceDesc = { type: "vmd", vmdPath: abs, vmdBytes: vmd.length }
      } else if (mplArg.trim()) {
        const compiler = await getServerCompiler()
        if (!compiler) throw new Error("WASM MPL compiler unavailable")
        const compiled = compileMPL2(compiler, ensureCompilableMpl(mplArg), bones)
        if (compiled.vmd.length === 0) {
          throw new Error(`${fallbackLabel} MPL compile failed: ${compiled.directiveErrors.join("; ") || "0 bytes"}`)
        }
        const fin = finalizeMotion(compiled.vmd, bones, { enhance: true, bake: true })
        vmd = fin.vmd
        sourceDesc = {
          type: "mpl",
          vmdBytes: vmd.length,
          compilerWarnings: compiled.warnings.slice(0, 8),
        }
      } else {
        throw new Error(`${fallbackLabel} requires either vmdPath or mpl`)
      }

      const prep = prepareDuoActor({ label, bones, vmd, placement }, fallbackLabel)
      if (!prep) throw new Error(`${fallbackLabel} VMD contains 0 bone keyframes`)
      return { entry, bones, vmd, placement, prep, label, sourceDesc }
    }

    const actA = await resolveActor(rawA, "topaz", "A")
    const actB = await resolveActor(rawB, "caelus", "B")

    const sampleTimes = Array.isArray(args.sampleTimes)
      ? args.sampleTimes.map(Number).filter(Number.isFinite)
      : undefined
    const analysis = analyzeDuoSequence(actA.prep, actB.prep, sampleTimes)

    let convertedLocalPoint: Record<string, unknown> | undefined
    if (args.convertWorldPointFor && typeof args.convertWorldPointFor === "object") {
      const conv = args.convertWorldPointFor as Record<string, unknown>
      const which = conv.actor === "B" ? "B" : "A"
      const wp = normalizeOffset(conv.worldPoint)
      const targetPlacement = which === "B" ? actB.placement : actA.placement
      const localPt = worldToActorLocal({ x: wp[0], y: wp[1], z: wp[2] }, targetPlacement)
      convertedLocalPoint = {
        actor: which,
        worldPoint: wp,
        localPoint: localPt,
        reachExample: `reach hand_r to [${localPt[0]}, ${localPt[1]}, ${localPt[2]}];`,
      }
    }

    const content: Array<Record<string, unknown>> = []
    let renderInfo: Record<string, unknown> | undefined
    if (args.renderViews !== false) {
      const modeArg = typeof args.mode === "string" ? args.mode : "auto"
      const useSingle = modeArg === "single" || (modeArg === "auto" && analysis.durationSec < 1.5)
      const renderA = { bones: actA.bones, vmd: actA.vmd, placement: actA.placement, tag: actA.label }
      const renderB = { bones: actB.bones, vmd: actB.vmd, placement: actB.placement, tag: actB.label }

      if (useSingle) {
        const targetFrame = typeof args.timeSec === "number" && Number.isFinite(args.timeSec)
          ? secondsToFrame(args.timeSec)
          : undefined
        const png = renderDuoMultiViewPng(renderA, renderB, targetFrame)
        if (png) {
          content.push({
            type: "image",
            data: png.dataUrl.replace(/^data:image\/png;base64,/, ""),
            mimeType: "image/png",
          })
          renderInfo = { mode: "single", frame: png.frame, timeSec: png.timeSec, width: png.width, height: png.height }
        }
      } else {
        const maxTiles = typeof args.maxTiles === "number" && Number.isFinite(args.maxTiles) ? args.maxTiles : 6
        const sampleFrames = sampleTimes?.map((t) => secondsToFrame(t))
        const sb = renderDuoStoryboardPng(renderA, renderB, { maxTiles, sampleFrames })
        if (sb) {
          content.push({
            type: "image",
            data: sb.dataUrl.replace(/^data:image\/png;base64,/, ""),
            mimeType: "image/png",
          })
          renderInfo = { mode: "storyboard", tiles: sb.tiles, width: sb.width, height: sb.height }
        }
      }
    }

    const report = {
      ok: analysis.passed,
      durationSec: analysis.durationSec,
      maxFrame: analysis.maxFrame,
      actorA: {
        label: actA.label,
        model: { id: actA.entry.id, label: actA.entry.label },
        placement: actA.placement,
        blenderRoot: toBlenderRootPlacement(actA.placement),
        source: actA.sourceDesc,
      },
      actorB: {
        label: actB.label,
        model: { id: actB.entry.id, label: actB.entry.label },
        placement: actB.placement,
        blenderRoot: toBlenderRootPlacement(actB.placement),
        source: actB.sourceDesc,
      },
      convertedLocalPoint,
      issues: analysis.allIssues,
      frames: analysis.frames,
      render: renderInfo,
    }

    content.push({ type: "text", text: stringifyReport(report) })
    return { content }
  }

  if (name === "get_blender_scene_info") {
    const cfg = {
      host: typeof args.host === "string" ? args.host : undefined,
      port: typeof args.port === "number" ? args.port : undefined,
      timeoutMs: 15_000,
    }
    const endpoint = resolveBlenderEndpoint(cfg)
    const sceneInfo = await sendBlenderCommand("get_scene_info", {}, cfg)
    const addonInfo = args.includeAddonInfo === false
      ? undefined
      : await sendBlenderCommand("get_addon_info", {}, cfg).catch(() => undefined)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, endpoint, addonInfo, sceneInfo }, null, 2),
        },
      ],
    }
  }

  if (name === "execute_blender_code") {
    const code = typeof args.code === "string" ? args.code : ""
    if (!code.trim()) throw new Error("code is required")
    const cfg = {
      host: typeof args.host === "string" ? args.host : undefined,
      port: typeof args.port === "number" ? args.port : undefined,
      timeoutMs: typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 120_000,
    }
    const endpoint = resolveBlenderEndpoint(cfg)
    const res = await sendBlenderCommand("execute_code", { code }, cfg)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, endpoint, ...(typeof res === "object" && res ? res : { result: res }) }, null, 2),
        },
      ],
    }
  }

  if (name === "compile_motion_intent") {
    const { entry, bones } = loadModelFromArgs(args)
    const intent = args.intent as MotionIntent
    if (!intent || !Array.isArray(intent.beats) || intent.beats.length === 0) {
      throw new Error("intent.beats must be a non-empty array")
    }
    const pmxAbs = entry.pmxPath ?? path.join(PUBLIC_DIR, entry.url.replace(/^\/+/, ""))
    const profilePath = path.join(path.dirname(pmxAbs), `${entry.id}.rig-profile.json`)
    const rebuild = args.rebuildProfile === true
    let cachedProfile: ReturnType<typeof buildRigProfile> | null = null
    if (!rebuild && fs.existsSync(profilePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8"))
        if (parsed?.version === RIG_PROFILE_VERSION) cachedProfile = parsed
      } catch { /* rebuild */ }
    }
    const profile = cachedProfile ?? (() => {
      const built = buildRigProfile(bones, entry.id)
      try { fs.writeFileSync(profilePath, JSON.stringify(built, null, 2)) } catch { /* ignore read-only */ }
      return built
    })()

    const solved = solveMotionIntent(intent, profile, bones)
    const outRel = typeof args.outVmdPath === "string" && args.outVmdPath.trim()
      ? args.outVmdPath.trim()
      : ".tmp/intent-motion.vmd"
    const outAbs = path.resolve(ROOT_DIR, outRel)
    fs.mkdirSync(path.dirname(outAbs), { recursive: true })
    fs.writeFileSync(outAbs, solved.vmd)

    const critic = critiquePoseVmd(bones, solved.vmd, "", [{ index: 0, start: 0, end: solved.durationSec }])
    const audit = auditVmd(solved.vmd, bones)
    const ground = groundSummaryOf(bones, solved.vmd)
    const ok = Boolean(critic?.passed && (!ground || ground.offendingFrames === 0))

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok,
              modelId: entry.id,
              profilePath,
              vmdPath: outAbs,
              vmdBytes: solved.vmd.byteLength,
              durationSec: solved.durationSec,
              frameCount: solved.frameCount,
              decimatedKeyCount: solved.decimatedKeyCount,
              morphKeyCount: solved.morphKeyCount,
              solveTimeMs: solved.solveTimeMs,
              critic,
              audit: audit ? { violations: audit.violations } : null,
              groundContact: ground,
            },
            null,
            2,
          ),
        },
      ],
    }
  }

  if (name === "get_blender_viewport") {
    const cfg = {
      host: typeof args.host === "string" ? args.host : undefined,
      port: typeof args.port === "number" ? args.port : undefined,
      timeoutMs: 30_000,
    }
    const maxSize = typeof args.maxSize === "number" && args.maxSize > 0 ? args.maxSize : 800
    const userPath = typeof args.filepath === "string" && args.filepath.trim() ? args.filepath.trim() : ""
    const absPath = userPath
      ? path.resolve(ROOT_DIR, userPath)
      : path.join(os.tmpdir(), `popo-blender-vp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })

    try {
      const vpRes = await sendBlenderCommand<Record<string, unknown>>(
        "get_viewport_screenshot",
        { max_size: maxSize, filepath: absPath, format: "png" },
        cfg
      )
      if (!fs.existsSync(absPath)) {
        throw new Error(`Blender viewport screenshot did not create file: ${absPath} (${JSON.stringify(vpRes)})`)
      }
      const pngBytes = fs.readFileSync(absPath)
      const content: Array<Record<string, unknown>> = [
        { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              endpoint: resolveBlenderEndpoint(cfg),
              filepath: userPath ? absPath : "(ephemeral)",
              bytes: pngBytes.length,
              viewport: vpRes,
            },
            null,
            2
          ),
        },
      ]
      return { content }
    } finally {
      if (!userPath && fs.existsSync(absPath)) {
        fs.unlinkSync(absPath)
      }
    }
  }

  throw new Error(`Unknown tool: ${name}`)
}

function sendJsonRpc(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on("line", async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    req = JSON.parse(trimmed)
  } catch {
    return
  }

  const { id, method, params } = req
  // Notifications have no id and expect no response
  if (id === undefined || id === null) return

  try {
    if (method === "initialize") {
      sendJsonRpc({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "popo-mmd", version: "0.1.0" },
        },
      })
      return
    }
    if (method === "ping") {
      sendJsonRpc({ jsonrpc: "2.0", id, result: {} })
      return
    }
    if (method === "tools/list") {
      sendJsonRpc({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
      return
    }
    if (method === "tools/call") {
      const toolName = String(params?.name ?? "")
      const toolArgs = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>
      const result = await handleToolCall(toolName, toolArgs)
      sendJsonRpc({ jsonrpc: "2.0", id, result })
      return
    }
    sendJsonRpc({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    })
  } catch (err) {
    sendJsonRpc({
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      },
    })
  }
})
