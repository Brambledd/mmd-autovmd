/**
 * mpl2.ts — Phase 2 语言层：在不动上游 Rust 的情况下扩展 MPL 语法
 *
 * 新增语法（全部在编译前 deterministically 展开为标准 MPL，wasm 编译器零改动）：
 *
 * 1. main 组合语义（修复路线图 §2-1 实测的碰撞缺陷）
 *      main {
 *          intro;              // 从 0s 开始
 *          chorus offset 8.0;  // 从 8s 开始（时间戳平移）
 *          wave_end @ 12.5;    // `@` 等价 `offset`
 *          sit_pose @ 14;      // 姿势引用 = 该时刻的单帧关键帧
 *      }
 *    展开为单一 @animation（标准 MPL），时间戳偏移后合并。
 *
 * 2. 表情语句（路线图 §2-3，morph 通道）
 *      @pose smile_big {
 *          face にこり 0.8;    // morph 名需与 PMX 内一致，不一致引擎忽略
 *          head bend backward 10;
 *      }
 *    提取 → 从姿势中剥离（wasm 编译器不认识）→ 组合后按出现时刻生成
 *    morph 关键帧 → 注入 VMD（vmd-morph.ts）。reze-engine 播放时应用
 *    （model.ts:879）。
 *
 * 3. 骨骼碰撞检测（Phase 1 实测病灶的静态预警）
 *    同一时刻同一骨骼出现两条关键帧 → 警告（引擎行为未定义）。
 *
 * 不变式：任何输入若不含新语法，compileMPL2 的输出与直接 wasm compile 字节一致。
 */

import { desugarMPL } from "./mpl-macros.ts"
import { injectMorphFrames, secondsToFrame } from "./vmd-morph.ts"
import type { MorphKey } from "./vmd-morph.ts"
import {
  applyPoseDirectivesToVmd,
  EXTENDED_BONE_NAMES,
  isValidAimTarget,
  isValidReachTarget,
} from "./ik-solver.ts"
import type { FrameDirectives, PoseDirectives, V3 } from "./ik-solver.ts"
import type { PmxBones } from "./pmx-bones.ts"

interface AnimFrames {
  name: string
  frames: Array<{ time: number; refs: string[] }>
}

interface ParsedScript {
  poseBlocks: string[] // 原样保留的 @pose 块文本（含头尾大括号）
  anims: AnimFrames[]
  mainRefs: Array<{ name: string; offset: number | null }>
  hasMain: boolean
}

function parseScript(source: string): ParsedScript {
  const out: ParsedScript = { poseBlocks: [], anims: [], mainRefs: [], hasMain: false }
  const lines = source.split("\n")
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t.startsWith("@pose")) {
      const block: string[] = []
      let depth = 0
      let j = i
      for (; j < lines.length; j++) {
        block.push(lines[j])
        depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
        if (depth <= 0 && j > i) break
        if (depth <= 0 && lines[j].includes("{")) break
      }
      out.poseBlocks.push(block.join("\n"))
      i = j + 1
      continue
    }
    if (t.startsWith("@animation")) {
      const name = t.split(/\s+/)[1]?.replace("{", "").trim() ?? ""
      const frames: AnimFrames["frames"] = []
      let depth = 0
      let j = i
      for (; j < lines.length; j++) {
        const lt = lines[j].trim()
        if (j > i) {
          depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
          const m = lt.match(/^([\d.]+)\s*:\s*(.+?);$/)
          if (m) frames.push({ time: parseFloat(m[1]), refs: m[2].split("&").map((s) => s.trim()) })
          if (depth <= 0) break
        } else {
          depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
        }
      }
      out.anims.push({ name, frames })
      i = j + 1
      continue
    }
    if (t.startsWith("main")) {
      out.hasMain = true
      let depth = 0
      let j = i
      for (; j < lines.length; j++) {
        const lt = lines[j].trim()
        if (j > i) {
          depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
          const m = lt.match(/^([\w_]+)(?:\s+(?:offset|@)\s+([\d.]+))?;$/)
          if (m) out.mainRefs.push({ name: m[1], offset: m[2] != null ? parseFloat(m[2]) : null })
          if (depth <= 0) break
        } else {
          depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
        }
      }
      i = j + 1
      continue
    }
    i++
  }
  return out
}

const f2 = (n: number) => {
  const s = n.toFixed(2)
  return s.replace(/\.?0+$/, "") || "0"
}

/**
 * main 组合语义展开：多引用/带偏移的 main → 单一标准动画。
 * 单引用无偏移 → 原文返回（wasm 原生即可处理）。
 */
export function composeMain(source: string): { output: string; composed: boolean } {
  const script = parseScript(source)
  if (!script.hasMain || script.mainRefs.length === 0) return { output: source, composed: false }
  const single = script.mainRefs.length === 1 && script.mainRefs[0].offset == null
  if (single) return { output: source, composed: false }

  const animMap = new Map(script.anims.map((a) => [a.name, a]))
  const poseNames = new Set(
    script.poseBlocks.map((b) => b.match(/@pose\s+([\w_]+)/)?.[1] ?? "")
  )
  const frames: Array<{ time: number; refs: string[] }> = []
  for (const ref of script.mainRefs) {
    const start = ref.offset ?? 0
    const anim = animMap.get(ref.name)
    if (anim) {
      for (const f of anim.frames) frames.push({ time: Number((start + f.time).toFixed(2)), refs: f.refs })
    } else if (poseNames.has(ref.name)) {
      frames.push({ time: Number(start.toFixed(2)), refs: [ref.name] })
    }
    // 两者都不是：交给 wasm 编译器报错（保持错误信息与原生一致）
  }
  frames.sort((a, b) => a.time - b.time)

  // 合并同时刻帧（同刻多引用 → 复合 `a & b`，与 Phase 1 语义一致）
  const merged: Array<{ time: number; refs: string[] }> = []
  for (const f of frames) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.time - f.time) < 1e-9) last.refs.push(...f.refs)
    else merged.push({ time: f.time, refs: [...f.refs] })
  }

  let animName = "composed"
  if (animMap.has("composed")) animName = "composed_mpl2"

  const animBlock = [
    `@animation ${animName} {`,
    ...merged.map((f) => `    ${f2(f.time)}: ${f.refs.join(" & ")};`),
    "}",
  ].join("\n")

  const out = [...script.poseBlocks, animBlock, "", "main {", `    ${animName};`, "}", ""].join("\n")
  return { output: out, composed: true }
}

// ---------------------------------------------------------------- face 语句

export interface FaceEntry {
  name: string
  weight: number
}

/**
 * 从 @pose 块中剥离 `face <morph> <weight>;` 语句。
 * 返回标准 MPL 文本与 pose → 表情条目映射。
 */
export function extractFace(source: string): { output: string; faces: Map<string, FaceEntry[]>; malformed: number } {
  const lines = source.split("\n")
  const faces = new Map<string, FaceEntry[]>()
  let current = ""
  let malformed = 0
  const out: string[] = []
  let blockType: "pose" | "anim" | "main" | null = null
  let brace = 0
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("@pose")) { blockType = "pose"; brace = 0; current = t.split(/\s+/)[1]?.replace("{", "").trim() ?? "" }
    else if (t.startsWith("@animation")) { blockType = "anim"; brace = 0 }
    else if (t.startsWith("main")) { blockType = "main"; brace = 0 }

    if (blockType === "pose" && t.startsWith("face ")) {
      const m = t.match(/^face\s+(\S+)\s+([\d.]+);$/)
      if (m) {
        const list = faces.get(current) ?? []
        list.push({ name: m[1], weight: Math.min(1, Math.max(0, parseFloat(m[2]))) })
        faces.set(current, list)
      } else malformed++
      brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
      if (brace <= 0 && t.includes("}")) blockType = null
      continue
    }
    out.push(line)
    brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
    if (blockType && brace <= 0 && t.includes("}")) blockType = null
  }
  return { output: out.join("\n"), faces, malformed }
}

/** 组合后的脚本 → 表情关键帧（姿势出现的每个时刻都生成一条） */
export function collectMorphKeys(source: string, faces: Map<string, FaceEntry[]>): MorphKey[] {
  const script = parseScript(source)
  const keys: MorphKey[] = []
  for (const anim of script.anims) {
    for (const f of anim.frames) {
      for (const ref of f.refs) {
        const entries = faces.get(ref)
        if (!entries) continue
        for (const e of entries) keys.push({ name: e.name, frame: secondsToFrame(f.time), weight: e.weight })
      }
    }
  }
  return keys
}

// ---------------------------------------------------------------- MPL2 手型预设宏（展开为标准 MPL 手指语句）

export const VALID_HAND_PRESETS = new Set(["relax", "cup", "akimbo", "fist", "open", "peace", "point"])

function buildHandPresetLines(side: "l" | "r", preset: string): string[] {
  // In MMD A-pose, fingers sit ordered from -Z (thumb/index side) to +Z (ring/pinky side):
  // for Right hand, sway left shifts toward -Z (thumb side) and sway right shifts toward +Z (pinky side);
  // for Left hand, sway right shifts toward -Z (thumb side) and sway left shifts toward +Z (pinky side).
  const towardThumb = side === "r" ? "left" : "right"
  const towardPinky = side === "r" ? "right" : "left"
  switch (preset) {
    case "relax":
      return [
        `    thumb_${side} bend forward 10, sway ${towardPinky} 5;`,
        `    index_${side} bend forward 15;`,
        `    middle_${side} bend forward 25;`,
        `    ring_${side} bend forward 35;`,
        `    pinky_${side} bend forward 45;`,
      ]
    case "cup":
      return [
        `    thumb_${side} bend forward 15, sway ${towardPinky} 10;`,
        `    index_${side} bend forward 20;`,
        `    middle_${side} bend forward 25;`,
        `    ring_${side} bend forward 30;`,
        `    pinky_${side} bend forward 35;`,
      ]
    case "akimbo":
      return [
        `    thumb_${side} bend forward 20, sway ${towardThumb} 15;`,
        `    index_${side} bend forward 45;`,
        `    middle_${side} bend forward 55;`,
        `    ring_${side} bend forward 65;`,
        `    pinky_${side} bend forward 70;`,
      ]
    case "fist":
      return [
        `    thumb_${side} bend forward 45, sway ${towardPinky} 30;`,
        `    index_${side} bend forward 85;`,
        `    middle_${side} bend forward 85;`,
        `    ring_${side} bend forward 85;`,
        `    pinky_${side} bend forward 85;`,
      ]
    case "open":
      return [
        `    thumb_${side} bend forward 5, sway ${towardThumb} 20;`,
        `    index_${side} bend forward 5, sway ${towardThumb} 12;`,
        `    middle_${side} bend forward 5;`,
        `    ring_${side} bend forward 5, sway ${towardPinky} 10;`,
        `    pinky_${side} bend forward 5, sway ${towardPinky} 16;`,
      ]
    case "peace":
      return [
        `    thumb_${side} bend forward 45, sway ${towardPinky} 25;`,
        `    index_${side} bend forward 0, sway ${towardThumb} 12;`,
        `    middle_${side} bend forward 0, sway ${towardPinky} 12;`,
        `    ring_${side} bend forward 85;`,
        `    pinky_${side} bend forward 85;`,
      ]
    case "point":
      return [
        `    thumb_${side} bend forward 45, sway ${towardPinky} 25;`,
        `    index_${side} bend forward 2;`,
        `    middle_${side} bend forward 85;`,
        `    ring_${side} bend forward 85;`,
        `    pinky_${side} bend forward 85;`,
      ]
    default:
      return []
  }
}

function inferHandPresetForAnchor(anchor: string): string {
  const t = anchor.trim().toLowerCase()
  if (t.startsWith("peace")) return "peace"
  if (t.startsWith("hip") || t.startsWith("waist")) return "akimbo"
  if (t === "mouth" || t === "chin" || t.startsWith("cheek") || t === "chest" || t === "heart") return "cup"
  if (t.startsWith("salute") || t.startsWith("forehead")) return "open"
  return "relax"
}

/**
 * 展开 `@pose` 块内的 `hand_l/r <preset>;` 宏，并在使用 `reach` 但未显式指定手型时
 * 自动补齐匹配的默认手型（无新语法的纯标准 MPL 原样通过，保证字节一致不变式）。
 */
export function expandHandPresets(source: string): {
  output: string
  expandedHands: number
  invalidPresets: string[]
} {
  if (!/\b(hand_[lr]\s+\w+|reach\s+hand_[lr]\s+to)\b/i.test(source)) {
    return { output: source, expandedHands: 0, invalidPresets: [] }
  }
  const lines = source.split("\n")
  const out: string[] = []
  const invalidPresets: string[] = []
  let expandedHands = 0
  let i = 0

  while (i < lines.length) {
    const t = lines[i].trim()
    if (!t.startsWith("@pose")) {
      out.push(lines[i])
      i++
      continue
    }
    // Collect whole @pose block
    const start = i
    const block: string[] = []
    let depth = 0
    for (let j = start; j < lines.length; j++) {
      block.push(lines[j])
      depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
      i = j + 1
      if (depth <= 0 && (j > start || lines[j].includes("{"))) break
    }
    const blockText = block.join("\n")
    const hasManualFinger = (side: "l" | "r") =>
      new RegExp(`^\\s*(?:thumb|index|middle|ring|pinky)(?:_\\d+)?_${side}\\b`, "m").test(blockText)
    const explicitPreset = new Set<"l" | "r">()
    const reachAnchors = new Map<"l" | "r", string>()

    const newBlock: string[] = []
    for (let k = 0; k < block.length; k++) {
      const lt = block[k].trim()
      const hm = lt.match(/^hand_(l|r)\s+([a-z0-9_]+)\s*;$/i)
      if (hm) {
        const side = hm[1].toLowerCase() as "l" | "r"
        const preset = hm[2].toLowerCase()
        explicitPreset.add(side)
        if (!VALID_HAND_PRESETS.has(preset)) {
          invalidPresets.push(preset)
        } else if (!hasManualFinger(side)) {
          newBlock.push(...buildHandPresetLines(side, preset))
          expandedHands++
        }
        continue
      }
      const rm = lt.match(/^reach\s+hand_(l|r)\s+to\s+([a-z0-9_]+|\[[^\]]+\])/i)
      if (rm) {
        reachAnchors.set(rm[1].toLowerCase() as "l" | "r", rm[2])
      }
      // Insert auto-inferred finger presets right before closing brace
      if (k === block.length - 1 && lt.startsWith("}")) {
        for (const [side, anchor] of reachAnchors) {
          if (!explicitPreset.has(side) && !hasManualFinger(side)) {
            newBlock.push(...buildHandPresetLines(side, inferHandPresetForAnchor(anchor)))
            expandedHands++
          }
        }
      }
      newBlock.push(block[k])
    }
    out.push(...newBlock)
  }

  return { output: out.join("\n"), expandedHands, invalidPresets }
}

// ---------------------------------------------------------------- MPL2 高级指令（扩展骨骼 + reach / aim / plant）

function emptyDirectives(): PoseDirectives {
  return { extendedBones: [], reaches: [], aims: [], plants: [] }
}

function parseOffsetVec(raw?: string): V3 | undefined {
  if (!raw) return undefined
  const m = raw.trim().match(/^\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]$/)
  if (!m) return undefined
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]
}

/**
 * 从 @pose 块中剥离 MPL2 扩展指令：
 *  - 扩展骨骼（upper_body2 / groove / arm_twist_l/r / wrist_twist_l/r / eyes）
 *  - reach <hand_l|hand_r> to <anchor> [+ [dx,dy,dz]];
 *  - aim <head|eyes> at <target>;
 *  - plant <feet|foot_l|foot_r>;
 */
export function extractDirectives(source: string): {
  output: string
  directives: Map<string, PoseDirectives>
  malformed: number
  invalidTargets: string[]
} {
  const lines = source.split("\n")
  const directives = new Map<string, PoseDirectives>()
  let current = ""
  let malformed = 0
  const invalidTargets: string[] = []
  const out: string[] = []
  let blockType: "pose" | "anim" | "main" | null = null
  let brace = 0

  const getDir = (name: string) => {
    let d = directives.get(name)
    if (!d) {
      d = emptyDirectives()
      directives.set(name, d)
    }
    return d
  }

  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("@pose")) { blockType = "pose"; brace = 0; current = t.split(/\s+/)[1]?.replace("{", "").trim() ?? "" }
    else if (t.startsWith("@animation")) { blockType = "anim"; brace = 0 }
    else if (t.startsWith("main")) { blockType = "main"; brace = 0 }

    if (blockType === "pose") {
      if (t.startsWith("reach ")) {
        const m = t.match(/^reach\s+(hand_l|hand_r)\s+to\s+([a-z0-9_]+|\[[^\]]+\])(?:\s*\+\s*(\[[^\]]+\]))?\s*;$/i)
        if (m) {
          if (!isValidReachTarget(m[2])) {
            invalidTargets.push(`unknown reach anchor "${m[2]}"`)
            malformed++
          } else {
            const offset = parseOffsetVec(m[3])
            getDir(current).reaches.push({
              limb: m[1].toLowerCase() as "hand_l" | "hand_r",
              target: m[2],
              ...(offset ? { offset } : {}),
            })
          }
        } else {
          malformed++
        }
        brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
        if (brace <= 0 && t.includes("}")) blockType = null
        continue
      }
      if (t.startsWith("aim ")) {
        const m = t.match(/^aim\s+(head|eyes)\s+at\s+([a-z0-9_]+|\[[^\]]+\])\s*;$/i)
        if (m) {
          if (!isValidAimTarget(m[2])) {
            invalidTargets.push(`unknown aim target "${m[2]}"`)
            malformed++
          } else {
            getDir(current).aims.push({
              part: m[1].toLowerCase() as "head" | "eyes",
              target: m[2],
            })
          }
        } else {
          malformed++
        }
        brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
        if (brace <= 0 && t.includes("}")) blockType = null
        continue
      }
      if (t.startsWith("plant ")) {
        const m = t.match(/^plant\s+(feet|foot_l|foot_r)\s*;$/i)
        if (m) {
          getDir(current).plants.push({ target: m[1].toLowerCase() as "feet" | "foot_l" | "foot_r" })
        } else {
          malformed++
        }
        brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
        if (brace <= 0 && t.includes("}")) blockType = null
        continue
      }

      const firstToken = t.split(/\s+/)[0]
      if (EXTENDED_BONE_NAMES.has(firstToken)) {
        const resetMatch = t.match(/^([a-z0-9_]+)\s+reset\s*;$/i)
        if (resetMatch) {
          getDir(current).extendedBones.push({ bone: resetMatch[1], reset: true, actions: [] })
        } else {
          const stmtMatch = t.match(/^([a-z0-9_]+)\s+(.+);$/i)
          if (stmtMatch) {
            const bone = stmtMatch[1]
            const clauses = stmtMatch[2].split(",").map((s) => s.trim()).filter(Boolean)
            const actions: Array<{ action: "bend" | "turn" | "sway" | "move"; direction: string; amount: number }> = []
            let ok = clauses.length > 0
            for (const c of clauses) {
              const cm = c.match(/^(bend|turn|sway|move)\s+(forward|backward|left|right|up|down)\s+([\d.]+)$/i)
              if (!cm) { ok = false; break }
              actions.push({
                action: cm[1].toLowerCase() as "bend" | "turn" | "sway" | "move",
                direction: cm[2].toLowerCase(),
                amount: parseFloat(cm[3]),
              })
            }
            if (ok) getDir(current).extendedBones.push({ bone, actions })
            else malformed++
          } else {
            malformed++
          }
        }
        brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
        if (brace <= 0 && t.includes("}")) blockType = null
        continue
      }
    }

    out.push(line)
    brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
    if (blockType && brace <= 0 && t.includes("}")) blockType = null
  }
  return { output: out.join("\n"), directives, malformed, invalidTargets }
}

function collectFrameDirectives(source: string, directives: Map<string, PoseDirectives>): FrameDirectives[] {
  if (directives.size === 0) return []
  const script = parseScript(source)
  const out: FrameDirectives[] = []
  for (const anim of script.anims) {
    for (const f of anim.frames) {
      const merged = emptyDirectives()
      for (const ref of f.refs) {
        const d = directives.get(ref)
        if (!d) continue
        merged.extendedBones.push(...d.extendedBones)
        merged.reaches.push(...d.reaches)
        merged.aims.push(...d.aims)
        merged.plants.push(...d.plants)
      }
      if (
        merged.extendedBones.length > 0 ||
        merged.reaches.length > 0 ||
        merged.aims.length > 0 ||
        merged.plants.length > 0
      ) {
        out.push({ frame: secondsToFrame(f.time), directives: merged })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- 碰撞检测

export interface BoneCollision {
  time: number
  bone: string
}

function poseBones(body: string): Set<string> {
  const bones = new Set<string>()
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (
      t === "" ||
      t.startsWith("@") ||
      t.startsWith("face ") ||
      t.startsWith("reach ") ||
      t.startsWith("aim ") ||
      t.startsWith("plant ") ||
      t === "{" ||
      t === "}"
    ) continue
    const first = t.replace(/;$/, "").split(",")[0].trim().split(/\s+/)[0]
    if (first) bones.add(first)
  }
  return bones
}

/** 静态检测：同一时刻同一骨骼被两条关键帧引用（引擎行为未定义，Phase 1 实测病灶） */
export function findBoneCollisions(source: string): BoneCollision[] {
  const script = parseScript(source)
  const bonesByName = new Map<string, Set<string>>()
  for (const block of script.poseBlocks) {
    const name = block.match(/@pose\s+([\w_]+)/)?.[1] ?? ""
    if (name) bonesByName.set(name, poseBones(block))
  }
  const collisions: BoneCollision[] = []
  const seen = new Set<string>()
  for (const anim of script.anims) {
    for (const f of anim.frames) {
      const present = new Set<string>()
      for (const ref of f.refs) {
        for (const b of bonesByName.get(ref) ?? []) {
          const key = `${f.time}\u0000${b}`
          if (present.has(b)) {
            if (!seen.has(key)) { seen.add(key); collisions.push({ time: f.time, bone: b }) }
          } else present.add(b)
        }
      }
    }
  }
  return collisions
}

// ---------------------------------------------------------------- 编译管道

export interface MPL2Result {
  vmd: Uint8Array
  /** 注入的表情关键帧数 */
  morphCount: number
  /** 求解的扩展骨骼 / reach / aim / plant 指令数 */
  ikOps: number
  /** 展开的手型预设次数 */
  handPresets: number
  /** 未通过语法/锚点校验的扩展指令错误列表 */
  directiveErrors: string[]
  /** 语义与兼容性告警（如模型不存在的表情 morph、同一 pose 内 reach 与 raw arm/elbow 冲突） */
  warnings: string[]
  /** 骨骼同时刻碰撞（应尽量为空） */
  collisions: BoneCollision[]
  /** 是否触发了 main 组合展开 */
  composed: boolean
  /** 脚本旋转了 base（全ての親）= 全身动作：引擎必须关闭腿部 IK，
   *  否则足ＩＫ每帧把腿拉回绑定方向（身体放平时表现为全身绷直）。
   *  引擎的 vmd-loader 不解析 VMD 属性帧，文件级 IK 开关无效，只能运行时设
   *  engine.disableIK。裙摆物理同理（刚体世界系模拟，倒置姿势会乱），一并关闭。 */
  baseRotated: boolean
  /** 脚本显式驱动了腿部骨骼（leg/knee/ankle/toe）：需要关闭引擎足 IK，否则足 IK 会覆盖膝盖弯曲 */
  legsKeyed: boolean
  /** 宏展开统计 */
  macroReport: { repeat: number; speed: number; hold: number; mirror: number }
}

/**
 * wasm 编译器要求 main 块（缺失时静默返回 0 字节）。词库片段/语料片段
 * 按契约只有 @pose + @animation，这里补一个指向唯一动画的 main。
 */
export function ensureMain(source: string): string {
  if (/^\s*main\s*\{/m.test(source)) return source
  const animName = source.match(/@animation\s+([\w_]+)/)?.[1]
  if (!animName) return source
  return `${source.trimEnd()}\n\nmain {\n    ${animName};\n}\n`
}

/**
 * MPL2 编译管道：宏展开 → main 组合 → 表情/高级指令提取 → wasm 编译 → morph 注入 → 扩展骨骼与解析 IK 求解。
 * compiler: mmd-mpl 的 WasmMPLCompiler（浏览器端已有实例，复用之）。
 * bones: 当前激活模型的 PMX 骨架（传入后可精确求解 reach / aim / plant 空间约束）。
 */
export function compileMPL2(
  compiler: { compile: (s: string) => Uint8Array },
  source: string,
  bones?: PmxBones | null
): MPL2Result {
  const mac = desugarMPL(source)
  const composedResult = composeMain(mac.output)
  const handExpanded = expandHandPresets(composedResult.output)
  const { output: noFace, faces } = extractFace(handExpanded.output)
  const { output: stripped, directives, malformed, invalidTargets } = extractDirectives(noFace)
  const bytes = compiler.compile(ensureMain(stripped))
  const keys = collectMorphKeys(stripped, faces)
  const withMorphs = injectMorphFrames(bytes, keys)
  const frameDirs = collectFrameDirectives(stripped, directives)
  const { vmd, solvedOps } =
    frameDirs.length > 0 ? applyPoseDirectivesToVmd(withMorphs, frameDirs, bones) : { vmd: withMorphs, solvedOps: 0 }
  const directiveErrors = [
    ...handExpanded.invalidPresets.map((p) => `unknown hand preset "${p}" (valid: relax, cup, akimbo, fist, open, peace, point)`),
    ...invalidTargets,
    ...(malformed > invalidTargets.length ? [`${malformed - invalidTargets.length} malformed MPL2 directive(s)`] : []),
  ]
  const warnings: string[] = []
  if (bones && bones.faceMorphs.length > 0 && keys.length > 0) {
    const morphSet = new Set(bones.faceMorphs)
    const unknownMorphs = [...new Set(keys.map((k) => k.name).filter((n) => !morphSet.has(n)))]
    for (const um of unknownMorphs) {
      warnings.push(
        `unknown face morph "${um}" (not in ${bones.modelName || "model"} faceMorphs — engine will ignore it)`
      )
    }
  }
  // Warn when a @pose combines `reach hand_<l|r>` with raw arm_<l|r>/elbow_<l|r>/arm_twist_<l|r> on the same side
  for (const block of parseScript(handExpanded.output).poseBlocks) {
    const poseName = block.match(/@pose\s+([^\s{]+)/)?.[1] ?? "pose"
    const body = block.toLowerCase()
    for (const side of ["l", "r"] as const) {
      if (new RegExp(`\\breach\\s+hand_${side}\\s+to\\b`).test(body)) {
        const rawMatch = body.match(new RegExp(`\\b(arm_${side}|elbow_${side}|arm_twist_${side})\\s+(?:bend|turn|sway)\\b`))
        if (rawMatch) {
          warnings.push(
            `@pose "${poseName}" mixes "reach hand_${side}" with raw "${rawMatch[1]}" rotation (reach overwrites arm/elbow; remove raw arm/elbow/arm_twist on that side)`
          )
        }
      }
    }
  }
  return {
    vmd,
    morphCount: keys.length,
    ikOps: solvedOps,
    handPresets: handExpanded.expandedHands,
    directiveErrors,
    warnings,
    collisions: findBoneCollisions(handExpanded.output),
    composed: composedResult.composed,
    baseRotated: /^\s*base\s+(bend|turn|sway)/m.test(stripped),
    legsKeyed: /^\s*(leg|knee|ankle|toe)_[lr]\s+(bend|turn|sway)/m.test(stripped),
    macroReport: { repeat: mac.repeat, speed: mac.speed, hold: mac.hold, mirror: mac.mirror },
  }
}
