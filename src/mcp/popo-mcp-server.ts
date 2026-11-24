/**
 * PoPo MCP Server (stdio JSON-RPC 2.0) — Blender-free MMD / PMX Motion Workbench.
 *
 * Exposes PoPo's deterministic 3D toolchain as MCP tools for external Agents (dsh,
 * Claude Code, Antigravity, Cursor, etc.):
 *   - list_models
 *   - inspect_pmx
 *   - compile_and_inspect_mpl2
 *   - render_pose_views
 *   - export_motion
 *
 * IMPORTANT: stdout is strictly reserved for JSON-RPC 2.0 frames. All diagnostic
 * logs are redirected to stderr.
 */

import fs from "node:fs"
import path from "node:path"
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
import { LEXICON } from "../lib/motion-lexicon.ts"
import { critiquePoseVmd } from "../lib/pose-critic.ts"
import { auditVmd } from "../lib/pose-audit.ts"
import { readVmdBoneKeys, solveFrameTransforms } from "../lib/fk.ts"
import { renderPoseMultiViewPng, renderStoryboardPng } from "../lib/pose-renderer.ts"
import { enhanceVmd } from "../lib/vmd-enhancer.ts"
import { getServerCompiler } from "../lib/server-compile.ts"
import { secondsToFrame } from "../lib/vmd-morph.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, "../..")
const PUBLIC_DIR = path.join(ROOT_DIR, "public")

const modelCache = new Map<string, PmxBones>()

function resolveModelEntry(modelId?: string) {
  const id = (modelId || "topaz").trim()
  return (
    AVAILABLE_MODELS.find((m) => m.id === id || m.label === id) ??
    AVAILABLE_MODELS[0]
  )
}

function loadModelSync(modelId?: string): { entry: (typeof AVAILABLE_MODELS)[number]; bones: PmxBones } {
  const entry = resolveModelEntry(modelId)
  const cached = modelCache.get(entry.id)
  if (cached) return { entry, bones: cached }

  const rel = entry.url.replace(/^\/+/, "")
  const fullPath = path.join(PUBLIC_DIR, rel)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Model file not found: ${fullPath}`)
  }
  const bytes = fs.readFileSync(fullPath)
  const bones = parsePmxBones(new Uint8Array(bytes))
  modelCache.set(entry.id, bones)
  return { entry, bones }
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

function extractKeyframeCoords(bones: PmxBones, vmd: Uint8Array, sampleTimes?: number[]) {
  const keys = readVmdBoneKeys(vmd)
  if (!keys || keys.length === 0) return []
  const sem = detectPosSemantics(bones)
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
    const state = new Map<string, (typeof keys)[number]>()
    for (const k of keys) {
      if (k.frame <= f) state.set(k.jp, k)
    }
    const tf = solveFrameTransforms(bones, state, sem)
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
      },
      additionalProperties: false,
    },
  },
  {
    name: "compile_and_inspect_mpl2",
    description:
      "Compile an MPL2 script to VMD and run deterministic FK kinematics, foot-lift/hip-hinge biomechanics, morph validation, and self-collision checks (checking both raw and enhanced VMD). Returns exact 3D coordinates, footLiftL/R, hipDrop, hipBackShift, squatDepthRatio, armExtensionRatio, and actionableWarnings.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "MPL2 script (@pose + @animation, optional main block)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
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
      "Compile an MPL2 script and render orthographic multi-view PNGs (single-frame Front/Side/Top or up to 6-tile Storyboard with Front + 3/4 view) plus per-tile foot-lift/hip telemetry so you can visually inspect the 3D pose and iterate.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "MPL2 script (@pose + @animation, optional main block)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
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
      "Validate, finalize, and export an MPL2 script: compiles, runs kinematic critic gate (blocks broken motions unless force=true), applies vmd-enhancer (skipped automatically when mode='blocking' for Blender handoff), optionally saves .mpl/.vmd files to disk, and optionally pushes live to the PoPo 3D web stage.",
    inputSchema: {
      type: "object",
      properties: {
        mpl: { type: "string", description: "Final MPL2 script" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
        mode: {
          type: "string",
          enum: ["final", "blocking"],
          description:
            "'blocking' exports clean un-enhanced sparse keyframes for Blender mmd_tools polish (defaults enhance=false, pushToStage=false) and returns blenderHandoff metadata. Default: 'final'.",
        },
        enhance: { type: "boolean", description: "Apply vmd-enhancer polish (default: true in final, false in blocking)" },
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
      "Inspect an external .vmd file (e.g. exported after Blender mmd_tools polish): runs PoPo's FK kinematic critic, self-collision audit, foot-lift/hip-hinge telemetry, and optionally renders orthographic PNG views for visual verification.",
    inputSchema: {
      type: "object",
      properties: {
        vmdPath: { type: "string", description: "Path to the .vmd file (relative to repo root or absolute)" },
        modelId: { type: "string", description: "Model id (default: topaz)" },
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
]

async function handleToolCall(name: string, args: Record<string, unknown>) {
  if (name === "list_models") {
    const models = AVAILABLE_MODELS.map((m) => {
      const fullPath = path.join(PUBLIC_DIR, m.url.replace(/^\/+/, ""))
      return { ...m, exists: fs.existsSync(fullPath) }
    })
    return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] }
  }

  if (name === "inspect_pmx") {
    const { entry, bones } = loadModelSync(typeof args.modelId === "string" ? args.modelId : undefined)
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
    const { bones } = loadModelSync(typeof args.modelId === "string" ? args.modelId : undefined)
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

    const keys = readVmdBoneKeys(res.vmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const criticRaw = critiquePoseVmd(bones, res.vmd, mpl, [{ index: 0, start: 0, end: durationSec }])
    const audit = auditVmd(res.vmd, bones)
    const enhancedVmd = enhanceVmd(audit.vmd, { autoBlink: true })
    const criticEnhanced = critiquePoseVmd(bones, enhancedVmd, mpl, [{ index: 0, start: 0, end: durationSec }])
    const sampleTimes = Array.isArray(args.sampleTimes) ? args.sampleTimes.map(Number) : undefined
    const keyframeCoords = extractKeyframeCoords(bones, res.vmd, sampleTimes)
    const actionableWarnings = buildBiomechanicalWarnings(mpl, res.warnings, keyframeCoords, bones)

    const criticPassed = (criticRaw?.passed ?? true) && (criticEnhanced?.passed ?? true)

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: res.directiveErrors.length === 0 && criticPassed,
              durationSec,
              vmdBytes: res.vmd.length,
              morphCount: res.morphCount,
              composed: res.composed,
              directiveErrors: res.directiveErrors,
              actionableWarnings,
              collisions: res.collisions,
              critic: criticRaw,
              criticAfterEnhance: criticEnhanced && !criticEnhanced.passed ? criticEnhanced : undefined,
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
    const { bones } = loadModelSync(typeof args.modelId === "string" ? args.modelId : undefined)
    const compiler = await getServerCompiler()
    if (!compiler) throw new Error("WASM MPL compiler unavailable")

    const res = compileMPL2(compiler, mpl, bones)
    if (res.vmd.length === 0) {
      throw new Error(`Cannot render: compiler produced 0 bytes. directiveErrors=${res.directiveErrors.join("; ")}`)
    }

    const keys = readVmdBoneKeys(res.vmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = maxFrame / 30
    const mode = typeof args.mode === "string" ? args.mode : "auto"
    const useStoryboard = mode === "storyboard" || (mode === "auto" && durationSec >= 1.5 && args.timeSec == null)

    if (useStoryboard) {
      const maxTiles = typeof args.maxTiles === "number" ? Math.max(2, Math.min(8, args.maxTiles)) : 6
      const sb = renderStoryboardPng(bones, res.vmd, [{ index: 0, start: 0, end: durationSec, action: "preview", source: "llm" }], { maxTiles })
      if (!sb) throw new Error("Failed to render storyboard PNG")
      const base64 = sb.dataUrl.replace(/^data:image\/png;base64,/, "")
      const tileCoords = extractKeyframeCoords(
        bones,
        res.vmd,
        sb.tiles.map((t) => t.timeSec)
      )
      const allCoords = extractKeyframeCoords(bones, res.vmd)
      const critic = critiquePoseVmd(bones, res.vmd, mpl, [{ index: 0, start: 0, end: durationSec }])
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
              `Rendered ${sb.tiles.length}-tile storyboard (${sb.width}x${sb.height}, duration=${durationSec.toFixed(2)}s).\n` +
              `Tile telemetry: ${tileSummary}\n` +
              `Kinematic critic: ${critic?.summary ?? "n/a"}` +
              (warnings.length > 0 ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
          },
        ],
      }
    }

    const targetFrame = typeof args.timeSec === "number" ? secondsToFrame(Math.max(0, args.timeSec)) : undefined
    const single = renderPoseMultiViewPng(bones, res.vmd, targetFrame)
    if (!single) throw new Error("Failed to render multi-view PNG")
    const base64 = single.dataUrl.replace(/^data:image\/png;base64,/, "")
    const [pt] = extractKeyframeCoords(bones, res.vmd, [single.timeSec])
    const warnings = buildBiomechanicalWarnings(mpl, res.warnings, pt ? [pt] : [], bones)
    return {
      content: [
        { type: "image", data: base64, mimeType: "image/png" },
        {
          type: "text",
          text:
            `Rendered 3-view PNG (Front/Side/Top, ${single.width}x${single.height}) at frame=${single.frame} (t=${single.timeSec.toFixed(2)}s). ` +
            (pt ? `footLiftL=${pt.footLiftL}u, footLiftR=${pt.footLiftR}u, hipDrop=${pt.hipDrop}u, hipBack=${pt.hipBackShift}u` : "") +
            (warnings.length > 0 ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
        },
      ],
    }
  }

  if (name === "export_motion") {
    const rawMpl = typeof args.mpl === "string" ? args.mpl : ""
    if (!rawMpl.trim()) throw new Error("mpl is required")
    const mpl = ensureCompilableMpl(rawMpl)
    const { entry, bones } = loadModelSync(typeof args.modelId === "string" ? args.modelId : undefined)
    const compiler = await getServerCompiler()
    if (!compiler) throw new Error("WASM MPL compiler unavailable")

    const res = compileMPL2(compiler, mpl, bones)
    if (res.vmd.length === 0) {
      throw new Error(`Export aborted: compiler produced 0 bytes. directiveErrors=${res.directiveErrors.join("; ")}`)
    }

    const exportMode = args.mode === "blocking" ? "blocking" : "final"
    const audit = auditVmd(res.vmd, bones)
    const shouldEnhance = args.enhance !== undefined ? Boolean(args.enhance) : exportMode !== "blocking"
    const shouldPush = args.pushToStage !== undefined ? Boolean(args.pushToStage) : exportMode !== "blocking"
    const finalVmd = shouldEnhance ? enhanceVmd(audit.vmd, { autoBlink: true }) : audit.vmd
    const keys = readVmdBoneKeys(finalVmd) ?? []
    const maxFrame = keys.reduce((m, k) => Math.max(m, k.frame), 0)
    const durationSec = Number((maxFrame / 30).toFixed(2))
    const critic = critiquePoseVmd(bones, finalVmd, mpl, [{ index: 0, start: 0, end: durationSec }])
    const coords = extractKeyframeCoords(bones, res.vmd)
    const actionableWarnings = buildBiomechanicalWarnings(mpl, res.warnings, coords, bones)

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
                actionableWarnings,
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
      const stageUrl = (typeof args.stageUrl === "string" && args.stageUrl.trim() ? args.stageUrl.trim() : "http://127.0.0.1:4000").replace(/\/+$/, "")
      try {
        const pushRes = await fetch(`${stageUrl}/api/stage-push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mpl,
            title: typeof args.title === "string" ? args.title : undefined,
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
              enhanced: shouldEnhance,
              directiveErrors: res.directiveErrors,
              actionableWarnings,
              criticSummary: critic?.summary,
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

  if (name === "inspect_vmd_file") {
    const rawPath = typeof args.vmdPath === "string" ? args.vmdPath.trim() : ""
    if (!rawPath) throw new Error("vmdPath is required")
    const absPath = path.resolve(ROOT_DIR, rawPath)
    if (!fs.existsSync(absPath)) throw new Error(`VMD file not found: ${absPath}`)
    const vmdBytes = new Uint8Array(fs.readFileSync(absPath))
    const { bones } = loadModelSync(typeof args.modelId === "string" ? args.modelId : undefined)
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
    const { bones } = loadModelSync(typeof args.modelId === "string" ? args.modelId : undefined)
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
              stagePush: stagePushResult,
            },
            null,
            2
          ),
        },
      ],
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
