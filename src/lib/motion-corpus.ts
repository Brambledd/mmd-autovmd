/**
 * motion-corpus.ts — Phase 3 ⑥: motion corpus pipeline.
 *
 * Upgrades the motion library's SOURCE from hand-written lexicon seeds to
 * real motion data, reusing every tool built in Phase 1/2:
 *
 *   real VPD/VMD asset
 *     → [vpd] reverse_compile("vpd")          (mmd-mpl wasm, already proven)
 *     → [vmd] downsampleVmd → reverse_compile("vmd")   (frame decimation first:
 *        reverse output size grows with key count, and reverse only emits the
 *        61-bone MPL vocabulary, so bone filtering is free)
 *     → normalizeFragment  (lexicon contract: pose blocks + ONE @animation,
 *       deterministic names, no main block, hold-tail for pose-only sources)
 *     → auditVmd offline    (Phase 2 collision check as a build-time gate —
 *       library entries that clip never ship)
 *
 * Nothing here touches the runtime pipeline; this is a build-time ingestion
 * tool whose output feeds motion-lexicon-style libraries.
 */

import { parseVmd, serializeVmd } from "./vmd-enhancer.ts"
import type { BoneKey, Quat } from "./vmd-enhancer.ts"
import { auditVmd } from "./pose-audit.ts"
import { ensureMain } from "./mpl2.ts"
import type { PmxBones } from "./pmx-bones.ts"

export interface CorpusCompiler {
  compile(script: string): Uint8Array
  reverse_compile(source: string, data: Uint8Array): string
}

export interface CorpusEntry {
  name: string
  /** Lexicon-contract fragment: @pose blocks + ONE @animation, no main. */
  fragment: string
  /** Animation length in seconds. */
  duration: number
  source: "vmd" | "vpd"
  /** VMD frames before downsample (vmd path only, else 0). */
  framesBefore: number
  framesAfter: number
  audit: {
    violations: number
    fixed: number
    unresolved: number
    report: string
  }
}

// ------------------------------------------------------------------ VPD

export interface VpdBonePose {
  jp: string
  pos: [number, number, number]
  quat: Quat
}

/**
 * Parse VPD (Vocaloid Pose Data) — the text pose format this repo's
 * MediaPipe solver exports (Shift-JIS, `Bone<N>{<jpname>` + trans + quat).
 */
export function parseVpd(data: Uint8Array): VpdBonePose[] {
  const text = new TextDecoder("shift_jis").decode(data)
  const lines = text.split(/\r?\n/)
  const poses: VpdBonePose[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^Bone\d+\{(.+?)\s*$/)
    if (!m) continue
    // next two content lines: trans `x,y,z;` then quat `x,y,z,w;`
    const nums: number[][] = []
    for (let j = i + 1; j < lines.length && nums.length < 2; j++) {
      const t = lines[j].trim()
      if (t === "" || t === "}" || t.startsWith("//")) continue
      nums.push(t.replace(/;.*$/, "").split(",").map((v) => parseFloat(v)))
    }
    if (nums.length === 2 && nums[1].length >= 4) {
      poses.push({
        jp: m[1].trim(),
        pos: [nums[0][0] ?? 0, nums[0][1] ?? 0, nums[0][2] ?? 0],
        quat: { x: nums[1][0], y: nums[1][1], z: nums[1][2], w: nums[1][3] },
      })
    }
  }
  return poses
}

// ------------------------------------------------------- VMD downsampling

/**
 * Keep every `intervalFrames`-th key plus first/last per bone track, then
 * re-serialize. Decimating BEFORE reverse_compile keeps generated fragments
 * compact (long dances: thousands of keys → reverse output explodes).
 */
export function downsampleVmd(bytes: Uint8Array, intervalFrames = 6): { vmd: Uint8Array; framesBefore: number; framesAfter: number } {
  const parsed = parseVmd(bytes)
  if (!parsed) return { vmd: bytes, framesBefore: 0, framesAfter: 0 }
  const tracks = new Map<string, BoneKey[]>()
  for (const k of parsed.boneKeys) {
    let t = tracks.get(k.jp)
    if (!t) {
      t = []
      tracks.set(k.jp, t)
    }
    t.push(k)
  }
  const kept: BoneKey[] = []
  let framesBefore = 0
  for (const [, keys] of tracks) {
    keys.sort((a, b) => a.frame - b.frame)
    framesBefore += keys.length
    const total = keys.length
    for (let i = 0; i < total; i++) {
      if (i === 0 || i === total - 1 || keys[i].frame % intervalFrames === 0) kept.push(keys[i])
    }
  }
  const framesAfter = kept.length
  return { vmd: serializeVmd(parsed, kept), framesBefore, framesAfter }
}

// ------------------------------------------------- fragment normalization

/**
 * Rewrite reversed MPL into the lexicon contract:
 *  - strip markdown fences and any main block
 *  - rename poses to `${name}_p0..` (deterministic, collision-free across
 *    library entries) and rewrite animation references
 *  - exactly one @animation named `${name}_anim`
 *  - pose-only sources (VPD) get a hold tail so duration > 0
 */
export function normalizeFragment(mpl: string, name: string, holdSeconds = 1): { fragment: string; duration: number } {
  let text = mpl.replace(/```(?:mpl|MPL)?\n?/g, "").replace(/```$/g, "").trim()

  // strip main block (line-based: from `main` line to the first closing brace at column 0/indent)
  const lines = text.split("\n")
  const outLines: string[] = []
  let inMain = 0
  for (const line of lines) {
    const t = line.trim()
    if (inMain === 0 && /^main\s*\{/.test(t)) {
      inMain = 1
      const opens = (t.match(/{/g) ?? []).length
      const closes = (t.match(/}/g) ?? []).length
      if (closes >= opens && t.includes("}")) inMain = 0
      continue
    }
    if (inMain > 0) {
      const closes = (t.match(/}/g) ?? []).length
      inMain -= closes
      continue
    }
    outLines.push(line)
  }
  text = outLines.join("\n").trim()

  // rename poses in declaration order and rewrite references
  const poseRe = /@pose\s+([\w_]+)/g
  const order: string[] = []
  let pm: RegExpExecArray | null
  while ((pm = poseRe.exec(text)) !== null) {
    if (!order.includes(pm[1])) order.push(pm[1])
  }
  const renamed = new Map<string, string>()
  order.forEach((old, i) => renamed.set(old, `${name}_p${i}`))
  for (const [old, nw] of renamed) {
    text = text.replace(new RegExp(`@pose\\s+${old}\\b`, "g"), `@pose ${nw}`)
    text = text.replace(new RegExp(`(^|[^\\w_])${old}\\b`, "g"), `$1${nw}`)
  }

  // ensure exactly one animation named `${name}_anim`
  const animCount = (text.match(/@animation\s+/g) ?? []).length
  text = text.replace(/@animation\s+[\w_]+/g, `@animation ${name}_anim`)

  // pose-only source: synthesize a hold animation
  let duration = 0
  for (const tm of text.matchAll(/(?:^|\n)\s*([\d.]+)\s*:/g)) {
    duration = Math.max(duration, parseFloat(tm[1]))
  }
  if (animCount === 0) {
    const firstPose = renamed.get(order[0]) ?? order[0]
    if (!firstPose) return { fragment: "", duration: 0 }
    text += `\n\n@animation ${name}_anim {\n    0: ${firstPose};\n    ${holdSeconds.toFixed(2)}: ${firstPose};\n}`
    duration = holdSeconds
  }
  if (duration === 0) duration = 1

  return { fragment: text, duration }
}

// ----------------------------------------------------------------- entry

export interface CorpusEntryOptions {
  compiler: CorpusCompiler
  /** Model skeleton — enables the Phase 2 offline collision gate. */
  bones?: PmxBones
  name: string
  source: { kind: "vmd" | "vpd"; bytes: Uint8Array }
  /** Key decimation interval for vmd sources (frames). Default 6 (=0.2s @30fps). */
  intervalFrames?: number
  /** Hold tail for pose-only sources. Default 1s. */
  holdSeconds?: number
}

export function buildCorpusEntry(opts: CorpusEntryOptions): CorpusEntry | null {
  try {
    let reversed: string
    let framesBefore = 0
    let framesAfter = 0

    if (opts.source.kind === "vmd") {
      const ds = downsampleVmd(opts.source.bytes, opts.intervalFrames ?? 6)
      framesBefore = ds.framesBefore
      framesAfter = ds.framesAfter
      reversed = opts.compiler.reverse_compile("vmd", ds.vmd)
    } else {
      // Validate it parses as VPD first so parse errors are not mistaken for
      // compiler errors.
      const poses = parseVpd(opts.source.bytes)
      if (poses.length === 0) return null
      reversed = opts.compiler.reverse_compile("vpd", opts.source.bytes)
    }

    const { fragment, duration } = normalizeFragment(reversed, opts.name, opts.holdSeconds ?? 1)
    if (!fragment) return null

    let violations = 0
    let fixed = 0
    let unresolved = 0
    let report = "audit skipped (no model bones)"
    if (opts.bones) {
      // ensureMain: wasm compiler silently returns 0 bytes for main-less input
      const compiled = opts.compiler.compile(ensureMain(fragment))
      const audit = auditVmd(compiled, opts.bones)
      violations = audit.violations.length
      fixed = audit.fixed.length
      unresolved = audit.unresolved.length
      report = violations === 0 ? "clean" : formatAuditLines(audit)
    }

    return {
      name: opts.name,
      fragment,
      duration,
      source: opts.source.kind,
      framesBefore,
      framesAfter,
      audit: { violations, fixed, unresolved, report },
    }
  } catch {
    return null
  }
}

function formatAuditLines(audit: { violations: { frame: number; mover: string; target: string; depth: number }[]; fixed: { frame: number; chain: string[]; scale: number }[]; unresolved: unknown[] }): string {
  const out: string[] = []
  for (const v of audit.violations) out.push(`clip @f${v.frame}: ${v.mover} into ${v.target}`)
  for (const f of audit.fixed) out.push(`relaxed @f${f.frame} ×${f.scale}`)
  if (audit.unresolved.length > 0) out.push(`unresolved: ${audit.unresolved.length}`)
  return out.join("; ")
}
