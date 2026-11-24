/**
 * vmd-morph.ts — VMD 表情通道注入器（Phase 2 语言层的运行时半边）
 *
 * 背景（docs/how-llm-understands-pmx.md §7 / 路线图 §2-3）：
 *   mmd-mpl WASM 编译器的 morph 通道永远为空（compiler.rs 里
 *   `MPLKeyFrame::new(time, bone_frames, vec![])`），而 reze-engine 的
 *   VMDLoader 完整解析 morph 帧（vmd-loader.ts readMorphFrame）并在
 *   动画播放时应用（model.ts:879 `for (const morphFrame of keyFrame.morphFrames)`）。
 *   所以在 TS 层把表情关键帧注入 VMD 二进制即可打通全链路，无需改 Rust。
 *
 * VMD 布局（与 vmd-enhancer.parseVmd 实测一致）：
 *   header 30B + modelName 20B
 *   + boneChunk   = u32 count + count × 111B
 *   + morphChunk  = u32 count + count × 23B   ← 注入点
 *   + camera/light/shadow/property/trailing
 *
 * morph 条目（23B）：Shift-JIS 名称 15B（NUL 填充）+ 帧号 u32(LE) + 权重 f32(LE)
 *
 * 稳健性契约：任何解析异常都原样返回输入，不抛错（与 vmd-enhancer 一致）。
 */

import Encoding from "encoding-japanese"

export interface MorphKey {
  /** morph 名称，需与 PMX 内 morph 名一致（不一致时引擎忽略，无副作用） */
  name: string
  /** 帧号（30fps 整数网格） */
  frame: number
  /** 0.0 ~ 1.0 */
  weight: number
}

const MORPH_ENTRY_SIZE = 23
const NAME_FIELD_SIZE = 15

/** VMD magic 校验：header 字段 30B NUL 填充，magic 本体 25 字符，必须先剥掉尾部 NUL */
function isVmd(vmd: Uint8Array): boolean {
  if (vmd.byteLength < 54) return false
  try {
    const head = new TextDecoder("shift_jis").decode(vmd.subarray(0, 26))
    return head.replace(/\0+$/, "") === "Vocaloid Motion Data 0002"
  } catch {
    return false
  }
}

function toSjisName(name: string): Uint8Array {
  const out = new Uint8Array(NAME_FIELD_SIZE)
  try {
    const bytes = Encoding.convert(name, { to: "SJIS", type: "array" }) as number[]
    const n = Math.min(bytes.length, NAME_FIELD_SIZE)
    for (let i = 0; i < n; i++) out[i] = bytes[i] & 0xff
  } catch {
    // 编码失败退化为 latin1 截断（引擎端忽略未知名，无副作用）
    for (let i = 0; i < Math.min(name.length, NAME_FIELD_SIZE); i++) out[i] = name.charCodeAt(i) & 0xff
  }
  return out
}

/** 秒 → 30fps 帧号（与 mmd-mpl WASM 截断语义 floor(t*30) 精确对齐，+1e-6 防浮点下偏） */
export const secondsToFrame = (t: number) => Math.max(0, Math.floor(t * 30 + 1e-6))

/**
 * 把表情关键帧注入 VMD 二进制。同名同帧的条目按"后者覆盖"去重，
 * 输出按帧号稳定排序。任何解析异常原样返回输入。
 */
export function injectMorphFrames(vmd: Uint8Array, keys: MorphKey[]): Uint8Array {
  if (keys.length === 0) return vmd
  try {
    if (!isVmd(vmd)) return vmd
    const dv = new DataView(vmd.buffer, vmd.byteOffset, vmd.byteLength)

    const boneCount = dv.getUint32(50, true)
    const morphCountOffset = 50 + 4 + boneCount * 111
    if (morphCountOffset + 4 > vmd.byteLength) return vmd
    const oldMorphCount = dv.getUint32(morphCountOffset, true)
    const restOffset = morphCountOffset + 4 + oldMorphCount * MORPH_ENTRY_SIZE
    if (restOffset > vmd.byteLength) return vmd

    // 同名同帧后者覆盖
    const dedup = new Map<string, MorphKey>()
    for (const k of keys) {
      const frame = Math.max(0, Math.round(k.frame))
      const weight = Math.min(1, Math.max(0, k.weight))
      dedup.set(`${k.name}\u0000${frame}`, { name: k.name, frame, weight })
    }
    const merged = [...dedup.values()].sort((a, b) => a.frame - b.frame || a.name.localeCompare(b.name, "ja"))

    const entries = new Uint8Array(merged.length * MORPH_ENTRY_SIZE)
    merged.forEach((k, i) => {
      const o = i * MORPH_ENTRY_SIZE
      entries.set(toSjisName(k.name), o)
      const edv = new DataView(entries.buffer, o, MORPH_ENTRY_SIZE)
      edv.setUint32(NAME_FIELD_SIZE, k.frame, true)
      edv.setFloat32(NAME_FIELD_SIZE + 4, k.weight, true)
    })

    const out = new Uint8Array(morphCountOffset + 4 + entries.length + (vmd.byteLength - restOffset))
    out.set(vmd.subarray(0, morphCountOffset), 0)
    new DataView(out.buffer).setUint32(morphCountOffset, merged.length, true)
    out.set(entries, morphCountOffset + 4)
    out.set(vmd.subarray(restOffset), morphCountOffset + 4 + entries.length)
    return out
  } catch {
    return vmd
  }
}

/** 读回 VMD 中的 morph 条目（测试/校验用）。异常返回 null。 */
export function parseMorphFrames(vmd: Uint8Array): MorphKey[] | null {
  try {
    if (!isVmd(vmd)) return null
    const dv = new DataView(vmd.buffer, vmd.byteOffset, vmd.byteLength)
    const boneCount = dv.getUint32(50, true)
    const o = 50 + 4 + boneCount * 111
    if (o + 4 > vmd.byteLength) return null
    const count = dv.getUint32(o, true)
    if (o + 4 + count * MORPH_ENTRY_SIZE > vmd.byteLength) return null
    const out: MorphKey[] = []
    for (let i = 0; i < count; i++) {
      const base = o + 4 + i * MORPH_ENTRY_SIZE
      let end = NAME_FIELD_SIZE
      for (let k = 0; k < NAME_FIELD_SIZE; k++) {
        if (vmd[base + k] === 0) { end = k; break }
      }
      out.push({
        name: new TextDecoder("shift_jis").decode(vmd.subarray(base, base + end)),
        frame: dv.getUint32(base + NAME_FIELD_SIZE, true),
        weight: dv.getFloat32(base + NAME_FIELD_SIZE + 4, true),
      })
    }
    return out
  } catch {
    return null
  }
}
