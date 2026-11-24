#!/usr/bin/env node
// render-pose.mjs — 骨架预览渲染器：把 FK 世界坐标投影成 PNG（正视图/侧视图），供目检调试
// 用法: node scripts/render-pose.mjs <pose.mpl> [frameNumber=24]
import { readFileSync, writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import init, { WasmMPLCompiler } from "mmd-mpl"
import { parsePmxBones } from "../src/lib/pmx-bones.ts"
import { compileMPL2 } from "../src/lib/mpl2.ts"
import { readVmdBoneKeys, solveFrameWorld } from "../src/lib/fk.ts"

// ---------------------------------------------------------------- PNG 编码（最小实现）
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, "latin1"), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 画布
class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h
    this.px = Buffer.alloc(w * h * 4, 255) // 白底
  }
  set(x, y, [r, g, b]) {
    x = Math.round(x); y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const o = (y * this.w + x) * 4
    this.px[o] = r; this.px[o + 1] = g; this.px[o + 2] = b; this.px[o + 3] = 255
  }
  line(x0, y0, x1, y1, color, width = 2) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps
      const y = y0 + ((y1 - y0) * s) / steps
      const half = width / 2
      for (let ox = -half; ox <= half; ox++) for (let oy = -half; oy <= half; oy++) this.set(x + ox, y + oy, color)
    }
  }
  circle(cx, cy, r, color) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) this.set(cx + x, cy + y, color)
  }
  save(path) { writeFileSync(path, encodePNG(this.w, this.h, this.px)) }
}

// ---------------------------------------------------------------- 骨架连线定义
const CHAINS = [
  { color: [70, 70, 70], width: 3, bones: ["全ての親", "センター", "グルーブ", "腰", "上半身", "上半身2", "首", "頭"] }, // 脊柱
  { color: [70, 70, 70], width: 2, bones: ["上半身", "左肩", "左腕", "左ひじ", "左手首"] },
  { color: [70, 70, 70], width: 2, bones: ["上半身", "右肩", "右腕", "右ひじ", "右手首"] },
  { color: [190, 190, 190], width: 2, bones: ["下半身", "左足", "左ひざ", "左足首", "左足先EX"] }, // 标准腿（暗）
  { color: [190, 190, 190], width: 2, bones: ["下半身", "右足", "右ひざ", "右足首", "右足先EX"] },
  { color: [200, 30, 30], width: 3, bones: ["下半身", "左足D", "左ひざD", "左足首D", "左足先EX"] }, // 视觉腿 D 链（红=视觉真值）
  { color: [30, 90, 200], width: 3, bones: ["下半身", "右足D", "右ひざD", "右足首D", "右足先EX"] }, // 视觉腿右（蓝）
]
const MARKS = ["左手首", "右手首", "左足首D", "右足首D", "左足先EX", "右足先EX", "頭", "センター"]

// ---------------------------------------------------------------- 主流程
const mplPath = process.argv[2]
const frameNo = parseInt(process.argv[3] ?? "24", 10)
const outPrefix = process.argv[4] ?? ".tmp-pose"
await init(readFileSync(new URL("../node_modules/mmd-mpl/mmd_mpl_bg.wasm", import.meta.url)))
const compiler = new WasmMPLCompiler()
const bones = parsePmxBones(new Uint8Array(readFileSync(new URL("../public/models/topaz/topaz.pmx", import.meta.url))))

const mpl = readFileSync(mplPath, "utf8")
const { vmd, baseRotated } = compileMPL2(compiler, mpl, bones)
const keys = readVmdBoneKeys(vmd)
const byFrame = new Map()
for (const k of keys) { if (!byFrame.has(k.frame)) byFrame.set(k.frame, new Map()); byFrame.get(k.frame).set(k.jp, k) }
// 帧选择：落在键间隙时向前吸附到最近的关键帧（VMD 保持语义），而不是跳到动画末尾
const keyTimes = [...byFrame.keys()].sort((a, b) => a - b)
const frame = keyTimes.find((t) => t >= frameNo) ?? keyTimes[keyTimes.length - 1]
// 累积保持语义：frame 处每根骨骼取"≤frame 的最新关键帧"（VMD 标准保持行为，
// 否则 IK 后处理写入的稀疏关键帧会让未触及骨骼回落绑定姿势）
const solveMap = new Map()
for (const k of [...keys].sort((a, b) => a.frame - b.frame)) {
  if (k.frame <= frame) solveMap.set(k.jp, k)
}
const world = solveFrameWorld(bones, solveMap, "absolute")
const W = (jp) => world[bones.indexByJp.get(jp)]
const y = (jp) => W(jp)?.y

// 地面 y=0 基准：取模型 y 范围适配画布
const SCALE = 14 // px per unit
const Wc = 580, Hc = 360
const groundRow = 300
const cxSide = 230, cxFront = 290, cxTop = 290

function drawView(kind, outPath) {
  const c = new Canvas(Wc, Hc)
  const px = (p) => (kind === "side" ? cxSide + p.z * SCALE : kind === "top" ? cxTop + p.x * SCALE : cxFront + p.x * SCALE)
  const py = (p) => (kind === "top" ? groundRow - 40 - p.z * SCALE : groundRow - p.y * SCALE)
  // 网格：每 5u 一条淡线 + 地面线
  for (let gy = 0; gy <= 25; gy += 5) {
    if (kind === "top") {
      // 俯视图：z 方向网格（z 越大越靠上=头侧）
      c.line(10, groundRow - 40 - gy * SCALE, Wc - 10, groundRow - 40 - gy * SCALE, [235, 235, 235], 1)
    } else {
      c.line(10, groundRow - gy * SCALE, Wc - 10, groundRow - gy * SCALE, [235, 235, 235], 1)
    }
  }
  if (kind !== "top") c.line(0, groundRow, Wc, groundRow, [0, 150, 0], 3) // 地面 y=0（侧/正视图）
  else c.line(cxTop, 10, cxTop, Hc - 10, [0, 150, 0], 3) // 俯视图：x=0 体轴中线
  for (const chain of CHAINS) {
    for (let i = 1; i < chain.bones.length; i++) {
      const a = W(chain.bones[i - 1]), b = W(chain.bones[i])
      if (a && b) c.line(px(a), py(a), px(b), py(b), chain.color, chain.width)
    }
  }
  for (const jp of MARKS) {
    const p = W(jp)
    if (p) c.circle(px(p), py(p), 4, [0, 0, 0])
  }
  // 両目（眼睛骨骼）= 脸的朝向标记（绿点：在脊柱线上方=仰面，下方=趴着）
  const eyes = W("両目")
  if (eyes) c.circle(px(eyes), py(eyes), 6, [0, 160, 0])
  c.save(outPath)
}

drawView("side", new URL(`../${outPrefix}-side.png`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))
drawView("front", new URL(`../${outPrefix}-front.png`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))
drawView("top", new URL(`../${outPrefix}-top.png`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))

console.log(`frame=${frame} baseRotated=${baseRotated}`)
console.log(`关键高度: 腰=${y("センター")?.toFixed(2)} 头=${y("頭")?.toFixed(2)} 手腕=${y("左手首")?.toFixed(2)}/${y("右手首")?.toFixed(2)}`)
console.log(`标准腿足首=${y("左足首")?.toFixed(2)} | 视觉足首D=${y("左足首D")?.toFixed(2)} 足先EX=${y("左足先EX")?.toFixed(2)}`)
console.log("已输出 .tmp-pose-side.png / .tmp-pose-front.png")
