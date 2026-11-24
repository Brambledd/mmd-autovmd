/**
 * mpl-macros.ts — PoPo MPL 宏展开器（编译前 desugar 成标准 MPL，wasm 编译器零改动）
 *
 * 支持的编辑态糖语法（只出现在 PoPo 生成/编辑层，导出前一律展开）：
 *   #repeat 4 { 0: a; 0.6: b; }      // 动画语句循环，按周期最大时间戳平移
 *   #speed 1.5 { 0: a; 0.6: b; }     // 时间戳 ÷1.5
 *   #hold 2 { 0: a; 0.6: b; }        // 末帧姿势保持 +2s
 *   #mirror { ...pose statements }   // 姿势语句左右镜像（仅限 @pose 块内语句）
 *
 * 注意（对应路线图风险④/⑤）：
 *  - #mirror 只做姿势语句文本变换：骨骼 _l/_r 互换 + 方向词 left/right 互换。
 *    极限表的左右不对称在规则表中是镜像对称的（leg_l sway left 180 ↔ leg_r sway right 180），
 *    因此文本级镜像天然满足镜像后的极限约束；但左右轴向量不对称的骨骼（如肩部复合轴）
 *    会有细微偏差，高精度场景应在上游做四元数级镜像。
 *  - 导出/编译永远用 desugar 后的标准 MPL。
 */

export interface MacroReport {
  repeat: number
  speed: number
  hold: number
  mirror: number
}

/** 左右镜像一行 MPL 语句（姿势语句或动画引用行不动引用名） */
export function mirrorStatementLine(line: string): string {
  let out = line
  // 方向词互换（\b 保证不会命中 wave_left 这类姿势名）
  out = out.replace(/\bleft\b/g, "\u0000R\u0000").replace(/\bright\b/g, "left").replace(/\u0000R\u0000/g, "right")
  // 骨骼后缀互换
  out = out.replace(/_l\b/g, "\u0000S\u0000").replace(/_r\b/g, "_l").replace(/\u0000S\u0000/g, "_r")
  return out
}

/** 镜像一段只含 @pose 块的 MPL 文本（动画块原样保留） */
export function mirrorPoseBlocks(text: string): string {
  const lines = text.split("\n")
  let blockType: "pose" | "animation" | "main" | null = null
  let brace = 0
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("@pose")) { blockType = "pose"; brace = 0 }
    else if (t.startsWith("@animation")) { blockType = "animation"; brace = 0 }
    else if (t.startsWith("main")) { blockType = "main"; brace = 0 }
    brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
    if (blockType === "pose") out.push(mirrorStatementLine(line))
    else out.push(line)
    if (blockType && brace <= 0 && t.includes("}")) blockType = null
  }
  return out.join("\n")
}

interface Frame {
  time: number
  refs: string[] // 支持 `a & b` 复合引用
  raw: string
}

function parseAnimFrames(content: string): Frame[] {
  const frames: Frame[] = []
  for (const line of content.split("\n")) {
    const t = line.trim()
    const m = t.match(/^([\d.]+)\s*:\s*(.+?);$/)
    if (m) frames.push({ time: parseFloat(m[1]), refs: m[2].split("&").map((s) => s.trim()), raw: t })
  }
  return frames
}

function fmtTime(t: number): string {
  const s = t.toFixed(2)
  return s.replace(/\.?0+$/, "") || "0"
}

function framesToLines(frames: Frame[]): string[] {
  return frames.map((f) => `${fmtTime(f.time)}: ${f.refs.join(" & ")};`)
}

/** 找到从 openLine 开始的配对大括号块，返回 {content, end} */
function findBraceBlock(lines: string[], openIdx: number): { content: string[]; end: number } {
  let depth = 0
  let end = openIdx
  for (let i = openIdx; i < lines.length; i++) {
    depth += (lines[i].match(/{/g) ?? []).length - (lines[i].match(/}/g) ?? []).length
    if (depth <= 0 && i > openIdx) { end = i; break }
    if (depth <= 0 && lines[i].includes("{")) { end = i; break }
  }
  const content = lines.slice(openIdx + 1, end).filter((l) => l.trim() !== "{")
  return { content, end }
}

function transformFrames(content: string[], mode: "repeat" | "speed" | "hold", arg: number): string[] {
  const frames = parseAnimFrames(content.join("\n"))
  if (frames.length === 0) return content
  const maxT = Math.max(...frames.map((f) => f.time))
  if (mode === "repeat") {
    const out: Frame[] = []
    const seenTimes = new Set<string>()
    for (let k = 0; k < Math.max(1, Math.round(arg)); k++) {
      for (const f of frames) {
        const shifted: Frame = { time: f.time + k * maxT, refs: f.refs, raw: f.raw }
        const key = fmtTime(shifted.time)
        // 按时间去重（先写者优先）：循环接缝处 t=0 帧与上一周期末帧同时刻，
        // 引擎对同一时刻同骨骼双关键帧行为未定义，必须丢弃后者
        if (!seenTimes.has(key)) { seenTimes.add(key); out.push(shifted) }
      }
    }
    return framesToLines(out)
  }
  if (mode === "speed") {
    const x = arg > 0 ? arg : 1
    return framesToLines(frames.map((f) => ({ ...f, time: f.time / x })))
  }
  // hold
  const last = frames.reduce((a, b) => (b.time > a.time ? b : a), frames[0])
  return framesToLines([...frames, { time: maxT + arg, refs: last.refs, raw: last.raw }])
}

/**
 * 展开 MPL 源中的宏指令，返回标准 MPL。
 * 迭代展开直到没有指令（防止嵌套），上限 50 轮防死循环。
 */
export function desugarMPL(src: string): MacroReport & { output: string } {
  const report: MacroReport = { repeat: 0, speed: 0, hold: 0, mirror: 0 }
  let output = src
  for (let round = 0; round < 50; round++) {
    const lines = output.split("\n")
    const idx = lines.findIndex((l) => l.trim().startsWith("#repeat") || l.trim().startsWith("#speed") || l.trim().startsWith("#hold") || l.trim().startsWith("#mirror"))
    if (idx === -1) break
    const t = lines[idx].trim()
    const openBraceOnLine = t.includes("{")
    // 允许 "#repeat 4 {" 或 "#repeat 4\n{"（罕见）；找不到 { 则丢弃该行
    let contentStart = idx
    if (!openBraceOnLine) {
      const next = lines.findIndex((l, i) => i > idx && l.includes("{"))
      if (next === -1) { lines.splice(idx, 1); output = lines.join("\n"); continue }
      contentStart = next
    }
    const { content, end } = findBraceBlock(lines, contentStart)
    let replacement: string[]
    if (t.startsWith("#repeat")) {
      const n = parseFloat(t.replace("#repeat", "")) || 1
      replacement = transformFrames(content, "repeat", n); report.repeat++
    } else if (t.startsWith("#speed")) {
      const x = parseFloat(t.replace("#speed", "")) || 1
      replacement = transformFrames(content, "speed", x); report.speed++
    } else if (t.startsWith("#hold")) {
      const s = parseFloat(t.replace("#hold", "")) || 0
      replacement = transformFrames(content, "hold", s); report.hold++
    } else {
      replacement = content.map((l) => mirrorStatementLine(l)); report.mirror++
    }
    lines.splice(idx, end - idx + 1, ...replacement)
    output = lines.join("\n")
  }
  return { ...report, output }
}
