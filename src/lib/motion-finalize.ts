/**
 * motion-finalize.ts — 编译产物 → 可上舞台的成片（增强 + 贴地烘焙）的统一入口。
 *
 * 所有“按将要播放的成品判定/播放”的路径（MCP export_motion final、
 * compile_and_inspect_mpl2、pose-generate-long 修复回路、舞台 playMplOnStage）
 * 都走这里，保证检查的就是播的。
 *
 * blocking 导出（交给 Blender 精修的稀疏键）**不要**在这里打开 bake：
 * 调用方负责按导出模式决定 bake 开关。
 */

import { readVmdBoneKeys } from "./fk.ts"
import {
  bakeGroundContact,
  measureGroundError,
  summarizeGroundMeasure,
  type GroundBakeStats,
  type GroundSummary,
} from "./ground-bake.ts"
import type { PmxBones } from "./pmx-bones.ts"
import { enhanceVmdDetailed, type EnhanceStats, type VmdEnhanceOptions } from "./vmd-enhancer.ts"

export interface FinalizeOptions {
  /** vmd-enhancer 润色（stagger / 预备 / 过冲 / 呼吸 / 眨眼）。默认 true。 */
  enhance?: boolean
  /**
   * 贴地烘焙。默认 true。调用方负责保证这不是 blocking 导出
   * （稀疏 blocking 键会被烘成逐帧死数据，Blender Graph Editor 无法精修）。
   */
  bake?: boolean
  /** MPL 源码：有则贴地窗口按时间轴条目帧判定（更准），没有则退回腿部/重心关键帧。 */
  mplSource?: string
  enhanceOptions?: VmdEnhanceOptions
  /** 贴地容差（u），默认 0.05（≈4mm） */
  groundTolerance?: number
}

export interface FinalizeResult {
  vmd: Uint8Array
  enhanced: boolean
  baked: boolean
  enhanceStats: EnhanceStats
  bakeStats: GroundBakeStats | null
  /** 成品的逐帧贴地摘要（无论是否烘焙都测） */
  ground: GroundSummary | null
}

const EMPTY_ENHANCE_STATS: EnhanceStats = {
  insertedAnticipation: 0,
  insertedOvershoot: 0,
  insertedSettle: 0,
  insertedBreathKeys: 0,
  insertedBlinks: 0,
  staggeredBones: 0,
  legIkReenabled: false,
  framesBefore: 0,
  framesAfter: 0,
}

/**
 * 编译产物 → 成片。任何异常都原样返回输入 VMD（不抛）。
 * bones 为 null（无骨架信息）时只做增强，不烘焙、不测量。
 */
export function finalizeMotion(vmd: Uint8Array, bones: PmxBones | null, opts: FinalizeOptions = {}): FinalizeResult {
  const tolerance = opts.groundTolerance
  let out = vmd
  let enhanceStats: EnhanceStats = EMPTY_ENHANCE_STATS
  let bakeStats: GroundBakeStats | null = null
  let enhanced = false
  let baked = false
  try {
    if (opts.enhance ?? true) {
      const r = enhanceVmdDetailed(out, opts.enhanceOptions)
      out = r.vmd
      enhanceStats = r.stats
      enhanced = true
    }
  } catch {
    enhanced = false
  }
  try {
    if (bones && (opts.bake ?? true)) {
      const r = bakeGroundContact(out, bones, { mplSource: opts.mplSource, tolerance })
      out = r.vmd
      bakeStats = r.stats
      baked = r.stats.applied
    }
  } catch {
    baked = false
  }
  let ground: GroundSummary | null = null
  try {
    if (bones) {
      const keys = readVmdBoneKeys(out)
      if (keys) {
        const m = measureGroundError(bones, keys, tolerance)
        if (m) ground = summarizeGroundMeasure(m)
      }
    }
  } catch {
    ground = null
  }
  return { vmd: out, enhanced, baked, enhanceStats, bakeStats, ground }
}

const r2 = (n: number) => Number(n.toFixed(2))

/**
 * 一行贴地结论（舞台提示、MCP 文本输出共用）。
 * 偏移以静止脚踝/脚尖高度为基准：负 = 沉入地面，正 = 浮起。
 */
export function describeGroundContact(fin: FinalizeResult): string {
  const g = fin.ground
  if (!g) return "贴地：无骨架信息，未测量"
  const bs = fin.bakeStats
  const head =
    g.offendingFrames === 0
      ? `全部 ${g.frames} 帧脚底在静止高度 ±${g.tolerance}u 内`
      : `${g.offendingFrames} 帧脚底偏离超过 ±${g.tolerance}u`
  const feet = `左 ${r2(g.feet.l.min)}~${r2(g.feet.l.max)}u，右 ${r2(g.feet.r.min)}~${r2(g.feet.r.max)}u`
  let bake = ""
  if (bs) {
    if (bs.applied) {
      const sunkBefore = r2(Math.min(0, bs.before.l.min, bs.before.r.min))
      const sunkAfter = r2(Math.min(0, g.feet.l.min, g.feet.r.min))
      bake = `；贴地烘焙插入 ${bs.insertedKeys} 个键（最深下沉 ${sunkBefore}u → ${sunkAfter}u）`
      if (bs.residualAtEntries > 0) bake += `，${bs.residualAtEntries} 个判定帧的作者姿势自带偏差未动`
    } else {
      bake = `；无需烘焙（${bs.skippedReason ?? "n/a"}）`
    }
  }
  return `${head}（${feet}）${bake}`
}
