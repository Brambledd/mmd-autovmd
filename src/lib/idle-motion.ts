/**
 * idle-motion.ts — Phase 3 ⑧-B: procedural idle loop.
 *
 * Generates a seamless, loopable "breathing" VMD entirely client-side — no
 * motion assets, no engine upgrade:
 *   上半身  bend 2±2° @ breath frequency (the inhale/exhale swell) + sway ±1°
 *   首      bend ∓1.2° counter-phase (head stays level-ish)
 *   頭      sway ±0.8° half frequency
 *   左腕/右腕 bend ±1.5° gentle phase offset (mirrored axes)
 *   左手首/右手首 sway ±2° slow
 *   センター vertical bob ±0.15 units with the breath
 *   まばたき  blink morph ~every 4s (skipped gracefully when a model lacks it)
 *
 * All sinusoids run an INTEGER number of cycles over the loop duration and the
 * final key lands exactly at the loop end with frame-0 values, so the loop is
 * sample-continuous. Keys at 10 Hz carry soft bezier curves (Phase 1 curve
 * values) and the engine evaluates them per-axis. Blink morph frames land at
 * frame 0 + integer beats so they repeat seamlessly across loop restarts.
 *
 * Usage:
 *   - initial pose after model load (play before any gesture)
 *   - fallback when a generation produces an empty motion
 *   - poll `getAnimationProgress()` and re-play idle when a clip ends
 */

import { serializeVmd } from "./vmd-enhancer.ts"
import type { BoneKey, ParsedVmd, Quat } from "./vmd-enhancer.ts"
import { injectMorphFrames, secondsToFrame } from "./vmd-morph.ts"
import type { MorphKey } from "./vmd-morph.ts"
import Encoding from "encoding-japanese"

export interface IdleOptions {
  /** Loop length in seconds. Default 8. */
  seconds?: number
  /** Breaths over the loop. Default: round(seconds / 4) — ~4s per breath. */
  breaths?: number
  /** Key interval in frames at 30fps. Default 3 (10 Hz). */
  keyInterval?: number
  /** Global amplitude multiplier. Default 1. */
  amplitude?: number
  /** Emit まばたき (both-eye blink) keys. Default true — unknown morph names are ignored by the engine. */
  blink?: boolean
  /** Blinks over the loop. Default: round(seconds / 4) — one blink every ~4s. */
  blinks?: number
}

/** 标准 MMD 双眼眨眼 morph 名（VMD 习惯名；引擎对未知名静默忽略，无副作用） */
const BLINK_MORPH = "まばたき"
/** 眨眼闭合→睁开的关键帧间隔（30fps 下 ~0.13s，自然眨眼速度） */
const BLINK_REOPEN_FRAMES = 4

/** 生成一个循环内的眨眼 morph 关键帧序列：0(初始) + 每次眨眼 闭合→睁开 两帧 */
function buildBlinkKeys(seconds: number, blinks: number): MorphKey[] {
  const keys: MorphKey[] = [{ name: BLINK_MORPH, frame: 0, weight: 0 }]
  for (let k = 0; k < blinks; k++) {
    // 相位偏移 0.6：第一次眨眼不落在循环起点（开场即眨眼显得机械）
    const f = secondsToFrame(((k + 0.6) / blinks) * seconds)
    keys.push({ name: BLINK_MORPH, frame: f, weight: 1 })
    keys.push({ name: BLINK_MORPH, frame: f + BLINK_REOPEN_FRAMES, weight: 0 })
  }
  return keys
}

const FPS = 30

interface IdleTrack {
  jp: string
  /** Local-space rotation axes, matching the MPL rules table. */
  bendAxis?: [number, number, number]
  swayAxis?: [number, number, number]
  bendAmp: number
  swayAmp: number
  phase: number
  freqScale: number
  /** Vertical bob amplitude (position channel), model units. */
  bobY?: number
}

const TRACKS: IdleTrack[] = [
  { jp: "上半身", bendAxis: [-1, 0, 0], swayAxis: [0, 0, -1], bendAmp: 2.0, swayAmp: 1.0, phase: 0, freqScale: 1 },
  { jp: "首", bendAxis: [-1, 0, 0], bendAmp: 1.2, swayAmp: 0, phase: Math.PI, freqScale: 1 },
  { jp: "頭", swayAxis: [0, 0, -1], bendAmp: 0, swayAmp: 0.8, phase: Math.PI / 2, freqScale: 0.5 },
  { jp: "左腕", bendAxis: [0, 0, -1], bendAmp: 1.5, swayAmp: 0, phase: Math.PI / 3, freqScale: 1 },
  { jp: "右腕", bendAxis: [0, 0, 1], bendAmp: 1.5, swayAmp: 0, phase: Math.PI / 3 + 0.4, freqScale: 1 },
  { jp: "左手首", swayAxis: [0, 0, -1], bendAmp: 0, swayAmp: 2.0, phase: Math.PI / 2, freqScale: 0.5 },
  { jp: "右手首", swayAxis: [0, 0, 1], bendAmp: 0, swayAmp: 2.0, phase: Math.PI, freqScale: 0.5 },
  { jp: "センター", bendAmp: 0, swayAmp: 0, phase: Math.PI / 6, freqScale: 1, bobY: 0.15 },
]

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

/** Shift-JIS bytes of a bone name, NUL-padded to the 15-byte VMD name field. */
function boneNameField(jp: string): Uint8Array {
  const field = new Uint8Array(15)
  const codes = Encoding.stringToCode(jp)
  const sjis = Encoding.convert(codes, { to: "SJIS", from: "UNICODE" })
  for (let i = 0; i < Math.min(15, sjis.length); i++) field[i] = sjis[i] & 0xff
  return field
}

export interface IdleBuildResult {
  vmd: Uint8Array
  frames: number
  keys: number
  /** 注入的眨眼 morph 关键帧数 */
  morphs: number
  seconds: number
}

export function buildIdleVmd(opts?: IdleOptions): IdleBuildResult {
  const seconds = opts?.seconds ?? 8
  const breaths = opts?.breaths ?? Math.max(1, Math.round(seconds / 4))
  const interval = Math.max(1, Math.round(opts?.keyInterval ?? 3))
  const amp = opts?.amplitude ?? 1
  const totalFrames = Math.round(seconds * FPS)

  const keys: BoneKey[] = []
  for (const tr of TRACKS) {
    const nameField = boneNameField(tr.jp)
    let prevFrame = -1
    for (let f = 0; f <= totalFrames; f += interval) {
      const frame = f > totalFrames ? totalFrames : f
      if (frame === prevFrame) continue
      const t = frame / FPS
      const osc1 = Math.sin((2 * Math.PI * breaths * tr.freqScale * t) / seconds + tr.phase)
      const osc2 = Math.cos((2 * Math.PI * breaths * tr.freqScale * t) / seconds + tr.phase)
      const bend = tr.bendAmp * amp * osc1
      const sway = tr.swayAmp * amp * osc2
      const pos: [number, number, number] = tr.bobY ? [0, tr.bobY * amp * osc1, 0] : [0, 0, 0]

      let quat: Quat = { x: 0, y: 0, z: 0, w: 1 }
      if (tr.bendAxis && tr.bendAmp !== 0) quat = quatMul(quat, quatAxisAngle(tr.bendAxis, bend))
      if (tr.swayAxis && tr.swayAmp !== 0) quat = quatMul(quat, quatAxisAngle(tr.swayAxis, sway))

      keys.push({ frame, pos, quat, name: nameField, jp: tr.jp, curve: { x1: 20, y1: 20, x2: 107, y2: 107 } })
      prevFrame = frame
    }
  }

  const header = new Uint8Array(30)
  const sig = new TextEncoder().encode("Vocaloid Motion Data 0002")
  header.set(sig.subarray(0, Math.min(26, sig.length)), 0)

  const parsed: ParsedVmd = {
    header,
    modelName: new Uint8Array(20),
    boneKeys: keys,
    morphBytes: new Uint8Array(0),
    cameraBytes: new Uint8Array(0),
    lightBytes: new Uint8Array(0),
    shadowBytes: new Uint8Array(0),
    propertyFrames: [],
    trailing: new Uint8Array(0),
  }

  const base = serializeVmd(parsed, keys)
  // 眨眼通道：morph 名模型缺失时引擎静默忽略（与 face 语句同一稳健性契约）
  const blinkOn = opts?.blink !== false
  const blinkCount = opts?.blinks ?? Math.max(1, Math.round(seconds / 4))
  const morphKeys = blinkOn ? buildBlinkKeys(seconds, blinkCount) : []
  const vmd = injectMorphFrames(base, morphKeys)

  return { vmd, frames: totalFrames, keys: keys.length, morphs: morphKeys.length, seconds }
}

// ---------------------------------------------------------------- browser hook

let idleUrl: string | null = null

/**
 * Lazily built object URL of the idle loop (browser only — builds once and
 * caches, so every fallback/replay shares one blob).
 */
export function getIdleObjectUrl(): string {
  if (!idleUrl) {
    const { vmd } = buildIdleVmd()
    idleUrl = URL.createObjectURL(new Blob([new Uint8Array(vmd)], { type: "application/octet-stream" }))
  }
  return idleUrl
}
