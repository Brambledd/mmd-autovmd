#!/usr/bin/env node
// pmx-info.mjs — dump PMX 2.x structure: header, counts, bones (with flags/IK), morph names,
// plus geometric measurements (height / limb lengths) for per-model conditioning.
// Usage: node scripts/pmx-info.mjs <file.pmx> [more.pmx ...] [--json]
import { readFileSync } from "node:fs"

const asJson = process.argv.includes("--json")
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"))

class R {
  constructor(buf) {
    this.dv = new DataView(buf)
    this.o = 0
  }
  u8() { return this.dv.getUint8(this.o++) }
  i8() { return this.dv.getInt8(this.o++) }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v }
  raw(n) { const s = this.o; this.o += n; return s }
  str(enc) {
    const len = this.i32()
    const start = this.raw(len)
    const bytes = this.dv.buffer.slice(start, start + len)
    return new TextDecoder(enc === 0 ? "utf-16le" : "utf-8").decode(bytes)
  }
  idx(size) { // PMX indices are SIGNED
    switch (size) {
      case 1: return this.i8()
      case 2: return this.i16()
      default: return this.i32()
    }
  }
}

function parse(path) {
  const buf = readFileSync(path)
  const r = new R(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const magicOff = r.raw(4)
  const magic = Buffer.from(r.dv.buffer, magicOff, 4).toString("latin1")
  if (magic !== "PMX ") throw new Error(`bad magic ${magic}`)
  const version = r.f32()
  const gCount = r.u8()
  const g = Array.from({ length: gCount }, () => r.u8())
  const [enc, addUV, vIdx, texIdx, matIdx, boneIdx, morphIdx, rbIdx] = g
  try {
    const model = { jp: r.str(enc), en: r.str(enc), commentJP: r.str(enc), commentEN: r.str(enc) }

    // ---- vertices
    const vCount = r.i32()
    const vStart = r.o
    for (let i = 0; i < vCount; i++) {
      r.raw(12 + 12 + 8 + addUV * 16) // pos, normal, uv, addUV
      const wt = r.u8()
      const skipBones = (n) => { for (let k = 0; k < n; k++) r.idx(boneIdx) }
      const skipW = (n) => r.raw(n * 4)
      if (wt === 0) skipBones(1)
      else if (wt === 1) { skipBones(2); skipW(1) }
      else if (wt === 2 || wt === 4) { skipBones(4); skipW(4) }
      else if (wt === 3) { skipBones(2); skipW(1); r.raw(60) } // SDEF C1,C2,R0,R1,R2
      r.raw(4) // edge scale
    }

    // ---- faces
    const fCount = r.i32()
    r.raw(fCount * vIdx)

    // ---- textures
    const tCount = r.i32()
    const textures = []
    for (let i = 0; i < tCount; i++) textures.push(r.str(enc))

    // ---- materials
    const mCount = r.i32()
    for (let i = 0; i < mCount; i++) {
      r.str(enc); r.str(enc)
      r.raw(16 + 12 + 4 + 12) // diffuse, specular(3+power), ambient
      r.u8()                  // draw flags
      r.raw(16 + 4)           // edge color, edge size
      r.idx(texIdx); r.idx(texIdx) // tex, sphere
      r.i8()                  // sphere mode
      const shared = r.i8()
      if (shared === 0) r.idx(texIdx); else r.i8()
      r.str(enc)              // memo
      r.i32()                 // face vertex count (metadata only, no payload follows)
    }

    // ---- bones
    const bCount = r.i32()
    const bones = []
    for (let i = 0; i < bCount; i++) {
      const jp = r.str(enc)
      const en = r.str(enc)
      const px = r.f32(), py = r.f32(), pz = r.f32()
      const parent = r.idx(boneIdx)
      r.raw(4)                  // layer
      const flags = r.i16()
      const b = {
        i, jp, en, parent,
        pos: [px, py, pz],
        rotatable: !!(flags & 0x0002), movable: !!(flags & 0x0004), ik: !!(flags & 0x0020),
        addRot: !!(flags & 0x0100), addLoc: !!(flags & 0x0200),
        fixedAxis: !!(flags & 0x0400), localAxes: !!(flags & 0x0800),
        afterPhysics: !!(flags & 0x1000), externalParent: !!(flags & 0x2000),
      }
      if (flags & 0x0001) b.tail = r.idx(boneIdx); else r.raw(12)
      if (flags & (0x0100 | 0x0200)) { r.idx(boneIdx); r.raw(4) }
      if (flags & 0x0400) r.raw(12)
      if (flags & 0x0800) r.raw(24)
      if (flags & 0x2000) r.raw(4)
      if (flags & 0x0020) { // IK
        b.ikTarget = r.idx(boneIdx)
        b.ikLoops = r.i32()
        b.ikAngle = r.f32()
        const links = r.i32()
        b.ikLinks = []
        for (let l = 0; l < links; l++) {
          const lb = { bone: r.idx(boneIdx) }
          const lim = r.u8()
          if (lim) { lb.min = [r.f32(), r.f32(), r.f32()]; lb.max = [r.f32(), r.f32(), r.f32()] }
          b.ikLinks.push(lb)
        }
      }
      bones.push(b)
    }

    // ---- morphs (names only, skip payloads)
    const moCount = r.i32()
    const morphs = []
    for (let i = 0; i < moCount; i++) {
      const jp = r.str(enc)
      r.str(enc)
      r.i8() // category
      const kind = r.i8()
      const m = { jp, kind: ["group", "vertex", "bone", "uv", "uv1", "uv2", "uv3", "uv4", "material"][kind] ?? kind }
      const n = r.i32()
      if (kind === 0) { for (let k = 0; k < n; k++) { r.idx(morphIdx); r.f32() } }
      else if (kind === 1) { for (let k = 0; k < n; k++) { r.idx(vIdx); r.raw(12) } }
      else if (kind === 2) { for (let k = 0; k < n; k++) { r.idx(boneIdx); r.raw(12) } }
      else if (kind >= 3 && kind <= 7) { for (let k = 0; k < n; k++) { r.idx(vIdx); r.raw(16) } }
      else if (kind === 8) { for (let k = 0; k < n; k++) { r.idx(matIdx); r.i8(); r.raw(4 * 4 + 4 * 3 + 4 + 4 * 3 + 4 * 4 + 4 + 4 * 4 + 4 * 4 + 4 * 4) } }
      morphs.push(m)
    }

    // ---- display frames
    const dfCount = r.i32()
    for (let i = 0; i < dfCount; i++) {
      r.str(enc); r.str(enc)
      r.u8()
      const n = r.i32()
      for (let k = 0; k < n; k++) { const t = r.u8(); r.idx(t === 0 ? boneIdx : morphIdx) }
    }

    // ---- rigid bodies + joints
    const rbCount = r.i32()
    for (let i = 0; i < rbCount; i++) {
      r.str(enc); r.str(enc)
      r.idx(boneIdx)
      r.raw(1 + 2 + 1 + 12 + 12 + 12 + 4 * 5 + 1)
    }
    const jCount = r.i32()
    for (let i = 0; i < jCount; i++) {
      r.str(enc); r.str(enc)
      r.u8()
      r.idx(rbIdx); r.idx(rbIdx)
      r.raw(12 * 8)
    }

    return { path, version, g, model, vCount, fCount, tCount, mCount, bones, morphs, rbCount, jCount, vStart }
  } catch (e) {
    throw new Error(`${e.message} (offset ${r.o}/${r.dv.byteLength})`)
  }
}

// ---- 几何测量（Layer 1 模型条件化用）
// 语义检测：规范规定 bone position 是父骨偏移，但部分转换模型（游戏改）直接存绝对坐标。
// 启发式：链条累加后的 頭.y 若远大于 頭 原始 y → 判定为绝对语义，直接用原始值。
function measureModel(bones) {
  const byIdx = new Map(bones.map((b) => [b.i, b]))
  const world = new Map()
  const chainWorld = (b, depth = 0) => {
    if (world.has(b.i)) return world.get(b.i)
    let w = { x: b.pos[0], y: b.pos[1], z: b.pos[2] }
    if (b.parent >= 0 && depth < bones.length) {
      const p = byIdx.get(b.parent)
      if (p) {
        const pw = chainWorld(p, depth + 1)
        w = { x: pw.x + b.pos[0], y: pw.y + b.pos[1], z: pw.z + b.pos[2] }
      }
    }
    world.set(b.i, w)
    return w
  }
  const byName = new Map(bones.map((b) => [b.jp, b]))
  const headB = byName.get("頭")
  let absolute = false
  if (headB) {
    const chainY = chainWorld(headB).y
    const rawY = headB.pos[1]
    if (rawY > 0 && chainY > rawY * 3) absolute = true // 链条累加爆炸 → 绝对坐标语义
  }
  const getWorld = (b) => (absolute ? { x: b.pos[0], y: b.pos[1], z: b.pos[2] } : chainWorld(b))
  const w = (jp) => {
    const b = byName.get(jp)
    return b ? getWorld(b) : null
  }
  const seg = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : null)
  const head = w("頭"), footL = w("左足首"), center = w("センター")
  const wristL = w("左手首"), elbowL = w("左ひじ"), shoulderL = w("左肩"), armL = w("左腕")
  const kneeL = w("左ひざ"), thighL = w("左足")
  const ys = bones.map((b) => getWorld(b).y)
  const armChain = [shoulderL, armL, elbowL, wristL].filter(Boolean)
  let armLen = 0
  for (let i = 1; i < armChain.length; i++) armLen += seg(armChain[i - 1], armChain[i])
  const legChain = [thighL, kneeL, footL].filter(Boolean)
  let legLen = 0
  for (let i = 1; i < legChain.length; i++) legLen += seg(legChain[i - 1], legChain[i])
  const topY = Math.max(...ys)
  const bottomY = Math.min(...ys)
  const U2CM = 8 // MMD 1 unit ≈ 8cm
  return {
    posSemantics: absolute ? "absolute" : "offset",
    heightUnits: +(topY - bottomY).toFixed(2),
    heightCm: +((topY - bottomY) * U2CM).toFixed(0),
    hipY: center ? +center.y.toFixed(2) : null,
    armLenUnits: +armLen.toFixed(2),
    armLenCm: +(armLen * U2CM).toFixed(0),
    legLenUnits: +legLen.toFixed(2),
    legLenCm: +(legLen * U2CM).toFixed(0),
    headY: head ? +head.y.toFixed(2) : null,
    footY: footL ? +footL.y.toFixed(2) : null,
  }
}

const out = []
for (const f of files) {
  try {
    const p = parse(f)
    out.push(p)
    if (asJson) continue
    const kb = ["センター", "全ての親", "上半身", "上半身2", "下半身", "首", "頭", "左肩", "右肩", "左腕", "右腕", "左ひじ", "右ひじ", "左手首", "右手首", "左足", "右足", "左ひざ", "右ひざ", "左足首", "右足首", "左足先EX", "右足先EX", "左足ＩＫ", "右足ＩＫ", "両目"]
    const have = new Set(p.bones.map((b) => b.jp))
    const missing = kb.filter((k) => !have.has(k))
    const ikBones = p.bones.filter((b) => b.ik).map((b) => b.jp)
    console.log(`\n=== ${p.path} ===`)
    console.log(`PMX v${p.version} | globals=${JSON.stringify(p.g)} | verts=${p.vCount} faces=${p.fCount / 3} tex=${p.tCount} mats=${p.mCount}`)
    console.log(`name: ${p.model.jp} / ${p.model.en}`)
    console.log(`bones=${p.bones.length} morphs=${p.morphs.length} rigid=${p.rbCount} joints=${p.jCount}`)
    console.log(`IK bones: ${ikBones.join(", ") || "(none)"}`)
    const m = measureModel(p.bones)
    console.log(`Measurements [${m.posSemantics}]: 身高 ${m.heightUnits}u (${m.heightCm}cm) | 腰高 y=${m.hipY} | 臂长 ${m.armLenUnits}u (${m.armLenCm}cm) | 腿长 ${m.legLenUnits}u (${m.legLenCm}cm) | 头 y=${m.headY} | 足首 y=${m.footY}`)
    console.log(`MPL-core bone coverage: missing [${missing.join(", ")}]`)
    console.log(`Morph kinds: ${JSON.stringify(p.morphs.reduce((a, m2) => { a[m2.kind] = (a[m2.kind] ?? 0) + 1; return a }, {}))}`)
    const face = p.morphs.filter((m2) => m2.kind === "vertex").map((m2) => m2.jp).slice(0, 18)
    console.log(`Vertex(face) morphs (up to 18): ${face.join(", ")}`)
    if (process.env.PMX_ALL_BONES === "1") console.log(p.bones.map((b) => `${b.i}: ${b.jp} / ${b.en}${b.ik ? " [IK]" : ""}${b.afterPhysics ? " [物理後]" : ""}${b.addRot || b.addLoc ? " [付与]" : ""}${b.fixedAxis ? " [軸固定]" : ""}${b.localAxes ? " [ローカル軸]" : ""}${b.externalParent ? " [外部親]" : ""}`).join("\n"))
  } catch (e) {
    console.error(`FAILED ${f}: ${e.message}`)
    process.exitCode = 1
  }
}
if (asJson) console.log(JSON.stringify(out, null, 2))
