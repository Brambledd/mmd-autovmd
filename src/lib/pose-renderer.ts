/**
 * pose-renderer.ts — Phase 3 多视角带包络轮廓渲染器（纯 TS + Node zlib，零原生依赖）
 *
 * 把编译后的 VMD 在目标模型骨架（含真实包络半径）上做付与感知 FK 求解，
 * 输出 840×360 三视图合成 PNG（正面 FRONT / 右侧面 SIDE / 3/4 透视），
 * 附带透明人体躯干与头部包络、眼/嘴特征点、绿色视线箭头、左右红蓝着色四肢与手指扇形，
 * 专供 VLM 视觉 Critic 评审姿态还原度、手-脸/腰/膝落位、遮眼与穿模问题。
 */

import { deflateSync } from "node:zlib"
import { qRotate, readVmdBoneKeys, solveFrameTransforms } from "./fk.ts"
import type { Quat, Vec3, VmdBoneKey } from "./fk.ts"
import { detectPosSemantics, measureModelGeometry } from "./model-geometry.ts"
import type { PmxBones } from "./pmx-bones.ts"

export interface RenderedPosePng {
  png: Uint8Array
  base64: string
  dataUrl: string
  frame: number
  timeSec: number
  width: number
  height: number
}

export interface StoryboardTimelineEntry {
  index: number
  start: number
  end: number
  action?: string
  source?: string
}

export interface StoryboardTile {
  segmentIndex?: number
  action?: string
  frame: number
  timeSec: number
}

export interface RenderedStoryboardPng {
  png: Uint8Array
  base64: string
  dataUrl: string
  tiles: StoryboardTile[]
  width: number
  height: number
}

// ---------------------------------------------------------------- PNG 最小编码器

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "latin1")
  const td = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}

function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const dst = y * (1 + w * 4)
    raw[dst] = 0
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), dst + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 5x7 像素字体（标签与图例）

const FONT_5X7: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10011", "10101", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "11110", "10001", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "#": ["01010", "11111", "01010", "01010", "11111", "01010", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
}

// ---------------------------------------------------------------- Alpha 混合画布

type RGBA = [number, number, number, number]

class RasterCanvas {
  readonly w: number
  readonly h: number
  readonly px: Uint8Array

  constructor(w: number, h: number, bg: [number, number, number] = [248, 250, 252]) {
    this.w = w
    this.h = h
    this.px = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      this.px[o] = bg[0]
      this.px[o + 1] = bg[1]
      this.px[o + 2] = bg[2]
      this.px[o + 3] = 255
    }
  }

  blend(x: number, y: number, [r, g, b, a]: RGBA) {
    const ix = Math.round(x)
    const iy = Math.round(y)
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h || a <= 0) return
    const o = (iy * this.w + ix) * 4
    if (a >= 255) {
      this.px[o] = r
      this.px[o + 1] = g
      this.px[o + 2] = b
      this.px[o + 3] = 255
      return
    }
    const alpha = a / 255
    const inv = 1 - alpha
    this.px[o] = Math.round(r * alpha + this.px[o] * inv)
    this.px[o + 1] = Math.round(g * alpha + this.px[o + 1] * inv)
    this.px[o + 2] = Math.round(b * alpha + this.px[o + 2] * inv)
  }

  fillRect(x: number, y: number, w: number, h: number, col: RGBA) {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.w - 1, Math.ceil(x + w))
    const y1 = Math.min(this.h - 1, Math.ceil(y + h))
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) this.blend(px, py, col)
    }
  }

  fillCircle(cx: number, cy: number, r: number, col: RGBA, clip?: [number, number, number, number]) {
    const r2 = r * r
    const minX = Math.max(clip ? clip[0] : 0, Math.floor(cx - r))
    const maxX = Math.min(clip ? clip[2] : this.w - 1, Math.ceil(cx + r))
    const minY = Math.max(clip ? clip[1] : 0, Math.floor(cy - r))
    const maxY = Math.min(clip ? clip[3] : this.h - 1, Math.ceil(cy + r))
    for (let y = minY; y <= maxY; y++) {
      const dy = y - cy
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx
        if (dx * dx + dy * dy <= r2) this.blend(x, y, col)
      }
    }
  }

  strokeCircle(cx: number, cy: number, r: number, col: RGBA, clip?: [number, number, number, number]) {
    const outer = (r + 0.8) * (r + 0.8)
    const inner = Math.max(0, r - 0.9) * Math.max(0, r - 0.9)
    const minX = Math.max(clip ? clip[0] : 0, Math.floor(cx - r - 1))
    const maxX = Math.min(clip ? clip[2] : this.w - 1, Math.ceil(cx + r + 1))
    const minY = Math.max(clip ? clip[1] : 0, Math.floor(cy - r - 1))
    const maxY = Math.min(clip ? clip[3] : this.h - 1, Math.ceil(cy + r + 1))
    for (let y = minY; y <= maxY; y++) {
      const dy = y - cy
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx
        const d2 = dx * dx + dy * dy
        if (d2 <= outer && d2 >= inner) this.blend(x, y, col)
      }
    }
  }

  fillCapsule(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    col: RGBA,
    clip?: [number, number, number, number]
  ) {
    const minX = Math.max(clip ? clip[0] : 0, Math.floor(Math.min(x0, x1) - r - 1))
    const maxX = Math.min(clip ? clip[2] : this.w - 1, Math.ceil(Math.max(x0, x1) + r + 1))
    const minY = Math.max(clip ? clip[1] : 0, Math.floor(Math.min(y0, y1) - r - 1))
    const maxY = Math.min(clip ? clip[3] : this.h - 1, Math.ceil(Math.max(y0, y1) + r + 1))
    const vx = x1 - x0
    const vy = y1 - y0
    const v2 = vx * vx + vy * vy
    const r2 = r * r
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = v2 > 1e-6 ? Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / v2)) : 0
        const px = x0 + t * vx
        const py = y0 + t * vy
        const dx = x - px
        const dy = y - py
        if (dx * dx + dy * dy <= r2) this.blend(x, y, col)
      }
    }
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    col: RGBA,
    width = 2,
    clip?: [number, number, number, number]
  ) {
    this.fillCapsule(x0, y0, x1, y1, Math.max(0.6, width * 0.5), col, clip)
  }

  drawText(x: number, y: number, text: string, col: RGBA, scale = 1) {
    let cx = x
    for (const rawCh of text.toUpperCase()) {
      const glyph = FONT_5X7[rawCh] ?? FONT_5X7[" "]
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] === "1") {
            this.fillRect(cx + gx * scale, y + gy * scale, scale - 1, scale - 1, col)
          }
        }
      }
      cx += 6 * scale
    }
  }
}

// ---------------------------------------------------------------- 峰值帧选取

function quatAngleFromIdentity(q: [number, number, number, number]): number {
  const w = Math.min(1, Math.abs(q[3]))
  return 2 * Math.acos(w)
}

const WEIGHTED_ENERGY_BONES = new Set([
  "全ての親",
  "センター",
  "腰",
  "上半身",
  "上半身2",
  "頭",
  "左腕",
  "右腕",
  "左ひじ",
  "右ひじ",
  "左足",
  "右足",
  "左ひざ",
  "右ひざ",
])

function computeFrameEnergies(keys: VmdBoneKey[], bones?: PmxBones): Array<{ frame: number; energy: number }> {
  const frames = [...new Set(keys.map((k) => k.frame))].sort((a, b) => a - b)
  const sorted = [...keys].sort((a, b) => a.frame - b.frame)
  const state = new Map<string, VmdBoneKey>()
  let ki = 0
  const result: Array<{ frame: number; energy: number }> = []

  for (const f of frames) {
    while (ki < sorted.length && sorted[ki].frame <= f) {
      state.set(sorted[ki].jp, sorted[ki])
      ki++
    }
    let energy = 0
    for (const [jp, k] of state) {
      if (bones && !bones.indexByJp.has(jp)) continue
      const w = WEIGHTED_ENERGY_BONES.has(jp) ? 2.0 : 0.4
      energy += w * (quatAngleFromIdentity(k.quat) + 0.25 * Math.hypot(k.pos[0], k.pos[1], k.pos[2]))
    }
    result.push({ frame: f, energy })
  }
  return result
}

/**
 * 自动挑选整段动画中最具代表性的姿态峰值帧（跳过第 0 帧初始位，按关键关节偏离幅度选峰值）。
 */
export function pickPeakPoseFrame(vmd: Uint8Array, bones?: PmxBones): number {
  const keys = readVmdBoneKeys(vmd)
  if (!keys || keys.length === 0) return 0
  const energies = computeFrameEnergies(keys, bones)
  if (energies.length === 1) return energies[0].frame

  let bestFrame = energies[energies.length - 1].frame
  let bestEnergy = -1
  for (const { frame, energy } of energies) {
    if (frame === 0) continue
    if (energy > bestEnergy + 1e-4) {
      bestEnergy = energy
      bestFrame = frame
    }
  }
  return bestFrame
}

/**
 * 为长动作挑选多帧分镜代表帧（覆盖起承转合及 LLM 定制段，最多 maxTiles 帧）。
 */
export function pickStoryboardSamples(
  vmd: Uint8Array,
  bones?: PmxBones,
  timeline?: StoryboardTimelineEntry[],
  maxTiles = 6
): StoryboardTile[] {
  const keys = readVmdBoneKeys(vmd)
  if (!keys || keys.length === 0) return []
  const energies = computeFrameEnergies(keys, bones)
  if (energies.length === 0) return []
  const cap = Math.max(1, Math.min(12, Math.floor(maxTiles)))
  const nonZero = energies.filter((e) => e.frame > 0)
  const pool = nonZero.length > 0 ? nonZero : energies

  if (timeline && timeline.length >= 2) {
    const n = timeline.length
    const chosenIndices = new Set<number>()
    if (n <= cap) {
      for (let i = 0; i < n; i++) chosenIndices.add(i)
    } else {
      chosenIndices.add(0)
      chosenIndices.add(n - 1)
      // Prioritize custom LLM segments (most likely to benefit from visual review)
      for (let i = 1; i < n - 1 && chosenIndices.size < cap; i++) {
        if (timeline[i].source === "llm") chosenIndices.add(i)
      }
      // Fill remaining budget evenly across the narrative arc
      if (chosenIndices.size < cap) {
        const steps = cap - 1
        for (let k = 1; k < steps && chosenIndices.size < cap; k++) {
          const idx = Math.round((k * (n - 1)) / steps)
          chosenIndices.add(idx)
        }
      }
      // Backfill any still-open slots linearly
      for (let i = 1; i < n - 1 && chosenIndices.size < cap; i++) {
        chosenIndices.add(i)
      }
    }

    const sortedIdx = [...chosenIndices].sort((a, b) => a - b)
    const tiles: StoryboardTile[] = []
    const usedFrames = new Set<number>()
    for (const idx of sortedIdx) {
      const seg = timeline[idx]
      const fStart = Math.round(seg.start * 30)
      const fEnd = Math.max(fStart + 1, Math.round(seg.end * 30))
      const candidates = pool.filter((e) => e.frame >= fStart && e.frame <= fEnd)
      let chosenFrame: number
      if (candidates.length > 0) {
        let best = candidates[0]
        for (const c of candidates) {
          if (c.energy > best.energy + 1e-4) best = c
        }
        chosenFrame = best.frame
      } else {
        chosenFrame = Math.max(1, Math.round((fStart + fEnd) / 2))
      }
      if (usedFrames.has(chosenFrame)) {
        const mid = Math.max(1, Math.round((fStart + fEnd) / 2))
        if (!usedFrames.has(mid)) chosenFrame = mid
      }
      usedFrames.add(chosenFrame)
      tiles.push({
        segmentIndex: seg.index,
        action: seg.action,
        frame: chosenFrame,
        timeSec: Number((chosenFrame / 30).toFixed(2)),
      })
    }
    return tiles
  }

  // Fallback for single-segment / untimelined animations: divide frame range into evenly spaced bins
  const maxFrame = pool[pool.length - 1].frame
  const minFrame = pool[0].frame
  if (maxFrame <= minFrame || pool.length === 1) {
    return [{ frame: pool[0].frame, timeSec: Number((pool[0].frame / 30).toFixed(2)) }]
  }
  const tiles: StoryboardTile[] = []
  const used = new Set<number>()
  for (let b = 0; b < cap; b++) {
    const lo = minFrame + (b * (maxFrame - minFrame)) / cap
    const hi = minFrame + ((b + 1) * (maxFrame - minFrame)) / cap
    const inBin = pool.filter((e) => e.frame >= lo && (b === cap - 1 ? e.frame <= hi : e.frame < hi))
    if (inBin.length === 0) continue
    let best = inBin[0]
    for (const c of inBin) {
      if (c.energy > best.energy + 1e-4) best = c
    }
    if (used.has(best.frame)) continue
    used.add(best.frame)
    tiles.push({ frame: best.frame, timeSec: Number((best.frame / 30).toFixed(2)) })
  }
  return tiles
}

// ---------------------------------------------------------------- 三视图投影与渲染

type ViewKind = "front" | "side" | "three_quarter"

interface DrawCmd {
  depth: number
  draw: () => void
}

function projectPoint(p: Vec3, view: ViewKind): { u: number; v: number; depth: number } {
  if (view === "front") {
    // Camera at -Z looking toward +Z: viewer left = -X (char right), viewer right = +X (char left)
    // Smaller Z = closer to camera = drawn LAST (higher depth)
    return { u: p.x, v: p.y, depth: -p.z }
  }
  if (view === "side") {
    // Camera at -X (character's right side) looking toward +X:
    // Front (-Z) faces viewer LEFT, Back (+Z) faces viewer RIGHT; closer (-X) drawn LAST
    return { u: p.z, v: p.y, depth: -p.x }
  }
  // 3/4 view: pure yaw -35° around Y so y=0 floor plane remains exact across all 3 views
  const yaw = (-35 * Math.PI) / 180
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const rx = p.x * cy - p.z * sy
  const rz = p.x * sy + p.z * cy
  return { u: rx, v: p.y, depth: -rz }
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

interface SceneContext {
  bones: PmxBones
  keys: VmdBoneKey[]
  semantics: ReturnType<typeof detectPosSemantics>
  headRadius: number
  torsoRadius: number
  hipRadius: number
  heightUnits: number
}

const ANCHOR_LANDMARKS = [
  "センター", "腰", "上半身", "上半身2", "首", "頭",
  "左腕", "右腕", "左ひじ", "右ひじ", "左手首", "右手首",
  "左足首D", "右足首D", "左足首", "右足首", "左足先EX", "右足先EX",
]

function renderFramePanels(
  canvas: RasterCanvas,
  ctx: SceneContext,
  frame: number,
  x0: number,
  y0: number,
  panelH: number,
  views: Array<{ kind: ViewKind; label: string; width: number }>
): boolean {
  const solveMap = new Map<string, VmdBoneKey>()
  for (const k of ctx.keys) {
    if (k.frame <= frame) solveMap.set(k.jp, k)
  }
  const tf = solveFrameTransforms(ctx.bones, solveMap, ctx.semantics)
  if (!tf) return false

  const posOf = (jp: string): Vec3 | undefined => {
    const idx = ctx.bones.indexByJp.get(jp)
    return idx != null ? tf.pos[idx] : undefined
  }
  const quatOf = (jp: string): Quat | undefined => {
    const idx = ctx.bones.indexByJp.get(jp)
    return idx != null ? tf.quat[idx] : undefined
  }

  let minY = 0
  let maxY = ctx.heightUnits + 1.5
  let centerX = 0
  let centerZ = 0
  let cnt = 0
  for (const n of ANCHOR_LANDMARKS) {
    const p = posOf(n)
    if (!p) continue
    minY = Math.min(minY, p.y - 1.5)
    maxY = Math.max(maxY, p.y + (n === "頭" ? ctx.headRadius * 1.9 : 1.0))
    centerX += p.x
    centerZ += p.z
    cnt++
  }
  if (cnt > 0) {
    centerX /= cnt
    centerZ /= cnt
  }
  const spanY = Math.max(12, maxY - minY)
  const scale = Math.min(12.2, (panelH - 56) / spanY)
  const groundPy = Math.round(y0 + panelH - 22 + Math.min(0, minY) * scale)
  const hasDLegs = Boolean(posOf("左足D") && posOf("右足D"))

  let curX = x0
  for (let vi = 0; vi < views.length; vi++) {
    const vw = views[vi]
    const vx0 = curX
    curX += vw.width
    const clip: [number, number, number, number] = [vx0 + 2, y0 + 2, vx0 + vw.width - 3, y0 + panelH - 2]
    const cx = vx0 + vw.width / 2
    const refCenter = projectPoint({ x: centerX, y: 0, z: centerZ }, vw.kind)
    const toScreen = (p: Vec3) => {
      const pr = projectPoint(p, vw.kind)
      return {
        x: cx + (pr.u - refCenter.u) * scale,
        y: groundPy - pr.v * scale,
        depth: pr.depth,
      }
    }

    if (vi > 0) canvas.line(vx0, y0, vx0, y0 + panelH, [203, 213, 225, 255], 1)
    for (let gy = 5; gy <= 25; gy += 5) {
      const py = groundPy - gy * scale
      if (py > y0 + 24 && py < y0 + panelH - 4) {
        canvas.line(vx0 + 6, py, vx0 + vw.width - 6, py, [226, 232, 240, 255], 1, clip)
      }
    }
    canvas.line(vx0 + 4, groundPy, vx0 + vw.width - 4, groundPy, [21, 128, 61, 255], 2.5, clip)

    const cmds: DrawCmd[] = []

    const pLower = posOf("下半身") ?? posOf("腰")
    const pUpper = posOf("上半身")
    const pUpper2 = posOf("上半身2") ?? pUpper
    const pNeck = posOf("首")
    if (pLower && pUpper) {
      const a = toScreen(pLower)
      const b = toScreen(pUpper)
      cmds.push({
        depth: (a.depth + b.depth) / 2 - 0.4,
        draw: () => canvas.fillCapsule(a.x, a.y, b.x, b.y, ctx.hipRadius * scale * 0.78, [203, 213, 225, 130], clip),
      })
    }
    if (pUpper && pNeck) {
      const a = toScreen(pUpper)
      const b = toScreen(pUpper2 ?? pNeck)
      const c = toScreen(pNeck)
      cmds.push({
        depth: (a.depth + c.depth) / 2 - 0.3,
        draw: () => {
          canvas.fillCapsule(a.x, a.y, b.x, b.y, ctx.torsoRadius * scale * 0.85, [226, 232, 240, 145], clip)
          canvas.fillCapsule(b.x, b.y, c.x, c.y, ctx.torsoRadius * scale * 0.75, [226, 232, 240, 145], clip)
        },
      })
    }

    const pHead = posOf("頭")
    const qHead = quatOf("頭")
    if (pHead && qHead) {
      const headCenter = addVec(pHead, qRotate(qHead, { x: 0, y: ctx.headRadius * 0.72, z: 0 }))
      const sHead = toScreen(headCenter)
      const rPx = ctx.headRadius * scale
      cmds.push({
        depth: sHead.depth - 0.1,
        draw: () => {
          canvas.fillCircle(sHead.x, sHead.y, rPx, [254, 226, 226, 175], clip)
          canvas.strokeCircle(sHead.x, sHead.y, rPx, [148, 163, 184, 220], clip)
        },
      })
      const eyeL = addVec(pHead, qRotate(qHead, { x: 0.42, y: ctx.headRadius * 0.65, z: -ctx.headRadius * 0.86 }))
      const eyeR = addVec(pHead, qRotate(qHead, { x: -0.42, y: ctx.headRadius * 0.65, z: -ctx.headRadius * 0.86 }))
      const eyeMid = addVec(pHead, qRotate(qHead, { x: 0, y: ctx.headRadius * 0.65, z: -ctx.headRadius * 0.92 }))
      const gazeTip = addVec(eyeMid, qRotate(qHead, { x: 0, y: 0, z: -3.6 }))
      const mouthPt = addVec(pHead, qRotate(qHead, { x: 0, y: ctx.headRadius * 0.24, z: -ctx.headRadius * 0.94 }))
      const sEyeL = toScreen(eyeL)
      const sEyeR = toScreen(eyeR)
      const sEyeMid = toScreen(eyeMid)
      const sGazeTip = toScreen(gazeTip)
      const sMouth = toScreen(mouthPt)
      cmds.push({
        depth: sEyeMid.depth + 0.2,
        draw: () => {
          canvas.fillCircle(sEyeL.x, sEyeL.y, 2.3, [15, 23, 42, 240], clip)
          canvas.fillCircle(sEyeR.x, sEyeR.y, 2.3, [15, 23, 42, 240], clip)
          canvas.fillCircle(sMouth.x, sMouth.y, 2.5, [219, 39, 119, 240], clip)
          canvas.line(sEyeMid.x, sEyeMid.y, sGazeTip.x, sGazeTip.y, [22, 163, 74, 245], 2.2, clip)
          canvas.fillCircle(sGazeTip.x, sGazeTip.y, 2.8, [22, 163, 74, 255], clip)
        },
      })
    }

    const pushChain = (names: string[], col: RGBA, width: number, jointRadius = 2.8) => {
      for (let i = 1; i < names.length; i++) {
        const a3 = posOf(names[i - 1])
        const b3 = posOf(names[i])
        if (!a3 || !b3) continue
        const a = toScreen(a3)
        const b = toScreen(b3)
        cmds.push({
          depth: (a.depth + b.depth) / 2,
          draw: () => {
            canvas.line(a.x, a.y, b.x, b.y, col, width, clip)
            canvas.fillCircle(b.x, b.y, jointRadius, col, clip)
          },
        })
      }
    }

    pushChain(["下半身", "腰", "上半身", "上半身2", "首", "頭"], [51, 65, 85, 240], 3.5, 3.0)
    if (hasDLegs) {
      pushChain(["下半身", "左足D", "左ひざD", "左足首D", "左足先EX"], [30, 64, 175, 245], 4.0, 3.2)
      pushChain(["下半身", "右足D", "右ひざD", "右足首D", "右足先EX"], [153, 27, 27, 245], 4.0, 3.2)
    } else {
      pushChain(["下半身", "左足", "左ひざ", "左足首", "左足先EX"], [30, 64, 175, 245], 4.0, 3.2)
      pushChain(["下半身", "右足", "右ひざ", "右足首", "右足先EX"], [153, 27, 27, 245], 4.0, 3.2)
    }
    pushChain(["上半身2", "左肩", "左腕", "左ひじ", "左手首"], [37, 99, 235, 250], 3.8, 3.6)
    pushChain(["上半身2", "右肩", "右腕", "右ひじ", "右手首"], [220, 38, 38, 250], 3.8, 3.6)

    for (const side of ["左", "右"] as const) {
      const wrist = posOf(`${side}手首`)
      if (!wrist) continue
      const col: RGBA = side === "左" ? [6, 182, 212, 245] : [249, 115, 22, 245]
      for (const fName of ["親指", "人指", "中指", "薬指", "小指"]) {
        const p1 = posOf(`${side}${fName}１`) ?? posOf(`${side}${fName}０`)
        const p2 = posOf(`${side}${fName}２`)
        const p3 = posOf(`${side}${fName}３`) ?? p2
        const pts = [wrist, p1, p2, p3].filter((x): x is Vec3 => Boolean(x))
        for (let i = 1; i < pts.length; i++) {
          const a = toScreen(pts[i - 1])
          const b = toScreen(pts[i])
          cmds.push({
            depth: (a.depth + b.depth) / 2 + 0.15,
            draw: () => canvas.line(a.x, a.y, b.x, b.y, col, 1.5, clip),
          })
        }
      }
    }

    cmds.sort((a, b) => a.depth - b.depth)
    for (const cmd of cmds) cmd.draw()

    if (vw.label) {
      const badgeW = Math.min(vw.width - 12, vw.label.length * 6 + 10)
      canvas.fillRect(vx0 + 6, y0 + 5, badgeW, 14, [15, 23, 42, 210])
      canvas.drawText(vx0 + 11, y0 + 9, vw.label, [248, 250, 252, 255], 1)
    }
  }
  return true
}

function buildSceneContext(bones: PmxBones, vmd: Uint8Array): SceneContext | null {
  const rawKeys = readVmdBoneKeys(vmd)
  if (!rawKeys || rawKeys.length === 0) return null
  const keys = [...rawKeys].sort((a, b) => a.frame - b.frame)
  const semantics = detectPosSemantics(bones)
  const geom = measureModelGeometry(bones)
  return {
    bones,
    keys,
    semantics,
    headRadius: geom.headRadius ?? 1.55,
    torsoRadius: Math.max(1.1, Math.min(2.1, (geom.shoulderHalfWidth ?? 1.8) * 0.72)),
    hipRadius: Math.max(1.2, Math.min(2.2, (geom.hipHalfWidth ?? 1.4) * 0.95)),
    heightUnits: geom.heightUnits ?? 21,
  }
}

/**
 * 渲染指定帧（默认自动挑选峰值姿态帧）的三视图带包络 PNG（840×360）。
 */
export function renderPoseMultiViewPng(
  bones: PmxBones,
  vmd: Uint8Array,
  targetFrame?: number
): RenderedPosePng | null {
  try {
    const ctx = buildSceneContext(bones, vmd)
    if (!ctx) return null
    const frame = targetFrame ?? pickPeakPoseFrame(vmd, bones)

    const W = 840
    const H = 360
    const panelW = 280
    const panelH = 324
    const canvas = new RasterCanvas(W, H, [248, 250, 252])

    const ok = renderFramePanels(canvas, ctx, frame, 0, 0, panelH, [
      { kind: "front", label: "FRONT (-Z)", width: panelW },
      { kind: "side", label: "SIDE (R)", width: panelW },
      { kind: "three_quarter", label: "3/4 VIEW", width: panelW },
    ])
    if (!ok) return null

    const timeSec = Number((frame / 30).toFixed(2))
    canvas.fillRect(0, panelH, W, H - panelH, [15, 23, 42, 255])
    canvas.drawText(
      14,
      panelH + 14,
      `R-ARM=RED   L-ARM=BLUE   GAZE=GREEN   MOUTH=PINK   FLOOR=Y0   T=${timeSec.toFixed(2)}S`,
      [226, 232, 240, 255],
      1
    )

    const png = encodePng(W, H, canvas.px)
    const base64 = Buffer.from(png).toString("base64")
    return {
      png,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      frame,
      timeSec,
      width: W,
      height: H,
    }
  } catch {
    return null
  }
}

/**
 * 渲染长动作多帧分镜网格 PNG（每格含 FRONT + 3/4 VIEW，覆盖起承转合关键帧）。
 */
export function renderStoryboardPng(
  bones: PmxBones,
  vmd: Uint8Array,
  timeline?: StoryboardTimelineEntry[],
  opts?: { maxTiles?: number }
): RenderedStoryboardPng | null {
  try {
    const ctx = buildSceneContext(bones, vmd)
    if (!ctx) return null
    const tiles = pickStoryboardSamples(vmd, bones, timeline, opts?.maxTiles ?? 6)
    if (tiles.length === 0) return null

    const cols = tiles.length <= 2 ? tiles.length : 2
    const rows = Math.ceil(tiles.length / cols)
    const subW = 220
    const tileW = subW * 2
    const tileH = 216
    const legendH = 34
    const W = cols * tileW
    const H = rows * tileH + legendH
    const canvas = new RasterCanvas(W, H, [248, 250, 252])

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      const col = i % cols
      const row = Math.floor(i / cols)
      const tx0 = col * tileW
      const ty0 = row * tileH
      const segPrefix = tile.segmentIndex != null ? `#${tile.segmentIndex}` : `K${i}`
      const actionTag = (tile.action ?? "")
        .replace(/[^a-zA-Z0-9_ ]/g, " ")
        .trim()
        .slice(0, 14)
        .toUpperCase()
      const leftLabel = actionTag ? `${segPrefix} ${actionTag}` : `${segPrefix} FRONT`
      const rightLabel = `3/4 T=${tile.timeSec.toFixed(1)}S`

      renderFramePanels(canvas, ctx, tile.frame, tx0, ty0, tileH, [
        { kind: "front", label: leftLabel, width: subW },
        { kind: "three_quarter", label: rightLabel, width: subW },
      ])

      // Tile separators
      if (col > 0) canvas.line(tx0, ty0, tx0, ty0 + tileH, [100, 116, 139, 255], 2)
      if (row > 0) canvas.line(tx0, ty0, tx0 + tileW, ty0, [100, 116, 139, 255], 2)
    }

    canvas.fillRect(0, rows * tileH, W, legendH, [15, 23, 42, 255])
    canvas.drawText(
      14,
      rows * tileH + 13,
      `STORYBOARD ${tiles.length} FRAMES: LEFT=FRONT RIGHT=3/4  R-ARM=RED L-ARM=BLUE GAZE=GREEN FLOOR=Y0`,
      [226, 232, 240, 255],
      1
    )

    const png = encodePng(W, H, canvas.px)
    const base64 = Buffer.from(png).toString("base64")
    return {
      png,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      tiles,
      width: W,
      height: H,
    }
  } catch {
    return null
  }
}
