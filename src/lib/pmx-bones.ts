/**
 * PMX skeleton reader — bones, rigid bodies, face morphs.
 *
 * Ports the proven PMX 2.x walking logic from scripts/pmx-info.mjs into a
 * dependency-free module that runs in both Node (demo scripts) and the
 * browser (fetch + parse of the active model, see src/lib/model.ts).
 *
 * Bone flags follow the authoritative blender_mmd_tools layout:
 *   0x0001 tail-is-index · 0x0100/0x0200 grant (idx+f32) · 0x0400 fixed axis
 *   0x0800 local axes · 0x1000 after-physics · 0x2000 external parent · 0x0020 IK
 */

export interface PmxBone {
  jp: string
  en: string
  /** Rest position in model space. */
  pos: [number, number, number]
  /** Parent bone index, -1 for roots. PMX lists parents before children. */
  parent: number
  ik: boolean
  /** 付与（grant）：每帧额外复制 grant 父骨骼的本地旋转×ratio（游戏改模型的
   *  D 链视觉骨骼靠它跟随标准链，如 左足D→付与→左足 ratio=1；
   *  腰キャンセル 付与 腰 ratio=-1 用于抵消上半身弯腰对腿的影响）。 */
  grant?: { parent: number; ratio: number; rotate: boolean; move: boolean }
}

export interface PmxRigid {
  jp: string
  /** Attached bone index. */
  bone: number
  /** 0 = sphere, 1 = box, 2 = capsule */
  shape?: 0 | 1 | 2
  /** [width/radius, height, depth] */
  size?: [number, number, number]
  /** Rest center position in model space */
  pos?: [number, number, number]
  /** Euler XYZ in radians */
  rot?: [number, number, number]
  /** 0 = bone-driven, 1 = physics, 2 = physics+bone */
  mode?: number
}

export interface BoneEnvelope {
  /** Number of vertices primarily skinned to this bone */
  count: number
  min: [number, number, number]
  max: [number, number, number]
  /** Max radial distance from bone rest position to its skinned vertices */
  maxRadius: number
}

export interface PmxBones {
  version: number
  modelName: string
  bones: PmxBone[]
  rigids: PmxRigid[]
  /** Vertex (face) morph names — the model's usable expressions. */
  faceMorphs: string[]
  /** jp -> bone index lookup for FK / audit code. */
  indexByJp: Map<string, number>
  /** Per-bone skinned vertex spatial envelopes (keyed by bone jp). */
  envelopes?: Record<string, BoneEnvelope>
}

class Reader {
  dv: DataView
  o = 0
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8() { return this.dv.getUint8(this.o++) }
  i8() { return this.dv.getInt8(this.o++) }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v }
  raw(n: number) { const s = this.o; this.o += n; return this.bytes.subarray(s, s + n) }
  str(enc: 0 | 1) {
    const len = this.i32()
    const bytes = this.raw(len)
    return new TextDecoder(enc === 0 ? "utf-16le" : "utf-8").decode(bytes)
  }
  idx(size: number) {
    switch (size) {
      case 1: return this.i8()
      case 2: return this.i16()
      default: return this.i32()
    }
  }
}

export function parsePmxBones(data: Uint8Array): PmxBones {
  const r = new Reader(data)
  const magic = new TextDecoder("latin1").decode(r.raw(4))
  if (magic !== "PMX ") throw new Error("not a PMX file")
  const version = r.f32()
  const gCount = r.u8()
  const g = Array.from({ length: gCount }, () => r.u8())
  const [enc, addUV, vIdx, texIdx, matIdx, boneIdx, morphIdx] = g as [
    number, number, number, number, number, number, number,
  ]
  // (globals[7] rigidbody index size unused: we only record rigid→bone links)

  const modelName = r.str(enc as 0 | 1)
  r.str(enc as 0 | 1)
  r.str(enc as 0 | 1)
  r.str(enc as 0 | 1)

  // vertices — record position + primary skin bone so we can build real body envelopes
  const vCount = r.i32()
  const vPos = new Float32Array(vCount * 3)
  const vBone = new Int32Array(vCount)
  for (let i = 0; i < vCount; i++) {
    vPos[i * 3] = r.f32()
    vPos[i * 3 + 1] = r.f32()
    vPos[i * 3 + 2] = r.f32()
    r.raw(20 + addUV * 16) // normal(12) + uv(8) + addUV*16
    const wt = r.u8()
    let primary = -1
    if (wt === 0) {
      primary = r.idx(boneIdx)
    } else if (wt === 1) {
      const b0 = r.idx(boneIdx)
      const b1 = r.idx(boneIdx)
      const w0 = r.f32()
      primary = w0 >= 0.5 ? b0 : b1
    } else if (wt === 2 || wt === 4) {
      const b0 = r.idx(boneIdx), b1 = r.idx(boneIdx), b2 = r.idx(boneIdx), b3 = r.idx(boneIdx)
      const w0 = r.f32(), w1 = r.f32(), w2 = r.f32(), w3 = r.f32()
      const bs = [b0, b1, b2, b3]
      const ws = [w0, w1, w2, w3]
      let best = 0
      for (let k = 1; k < 4; k++) if (ws[k] > ws[best]) best = k
      primary = bs[best]
    } else if (wt === 3) {
      primary = r.idx(boneIdx)
      r.idx(boneIdx)
      r.raw(60) // SDEF C1,C2,R0,R1,R2
    }
    vBone[i] = primary
    r.raw(4)
  }

  // faces
  const fCount = r.i32()
  r.raw(fCount * vIdx)

  // textures
  const tCount = r.i32()
  for (let i = 0; i < tCount; i++) r.str(enc as 0 | 1)

  // materials
  const mCount = r.i32()
  for (let i = 0; i < mCount; i++) {
    r.str(enc as 0 | 1); r.str(enc as 0 | 1)
    r.raw(16 + 12 + 4 + 12)
    r.u8()
    r.raw(16 + 4)
    r.idx(texIdx); r.idx(texIdx)
    r.i8()
    const shared = r.i8()
    if (shared === 0) r.idx(texIdx); else r.i8()
    r.str(enc as 0 | 1)
    r.i32()
  }

  // bones
  const bCount = r.i32()
  const bones: PmxBone[] = []
  const indexByJp = new Map<string, number>()
  for (let i = 0; i < bCount; i++) {
    const jp = r.str(enc as 0 | 1)
    const en = r.str(enc as 0 | 1)
    const pos: [number, number, number] = [r.f32(), r.f32(), r.f32()]
    const parent = r.idx(boneIdx)
    r.raw(4) // layer
    const flags = r.i16()
    let grant: PmxBone["grant"]
    if (flags & 0x0001) r.idx(boneIdx); else r.raw(12)
    if (flags & (0x0100 | 0x0200)) {
      const gp = (() => {
        const v = boneIdx === 1 ? r.i8() : boneIdx === 2 ? r.i16() : r.i32()
        return v
      })()
      const ratio = r.f32()
      grant = { parent: gp, ratio, rotate: !!(flags & 0x0100), move: !!(flags & 0x0200) }
    }
    if (flags & 0x0400) r.raw(12)
    if (flags & 0x0800) r.raw(24)
    if (flags & 0x2000) r.raw(4)
    let ik = false
    if (flags & 0x0020) {
      ik = true
      r.idx(boneIdx)
      r.raw(8) // loop count + unit angle
      const links = r.i32()
      for (let l = 0; l < links; l++) {
        r.idx(boneIdx)
        const lim = r.u8()
        if (lim) r.raw(24)
      }
    }
    indexByJp.set(jp, i)
    bones.push({ jp, en, pos, parent, ik, ...(grant ? { grant } : {}) })
  }

  // morphs (collect vertex-morph names only)
  const moCount = r.i32()
  const faceMorphs: string[] = []
  for (let i = 0; i < moCount; i++) {
    const jp = r.str(enc as 0 | 1)
    r.str(enc as 0 | 1)
    r.i8()
    const kind = r.i8()
    const n = r.i32()
    if (kind === 0) { for (let k = 0; k < n; k++) { r.idx(morphIdx); r.raw(4) } }
    else if (kind === 1) { faceMorphs.push(jp); for (let k = 0; k < n; k++) { r.idx(vIdx); r.raw(12) } }
    else if (kind === 2) { for (let k = 0; k < n; k++) { r.idx(boneIdx); r.raw(12) } }
    else if (kind >= 3 && kind <= 7) { for (let k = 0; k < n; k++) { r.idx(vIdx); r.raw(16) } }
    else if (kind === 8) { for (let k = 0; k < n; k++) { r.idx(matIdx); r.i8(); r.raw(112) } } // diffuse4+spec3+shin+ambient3+edge4+edgeSize+3×factor4
  }

  // display frames
  const dfCount = r.i32()
  for (let i = 0; i < dfCount; i++) {
    r.str(enc as 0 | 1); r.str(enc as 0 | 1)
    r.u8()
    const n = r.i32()
    for (let k = 0; k < n; k++) { const t = r.u8(); r.idx(t === 0 ? boneIdx : morphIdx) }
  }

  // rigid bodies
  const rbCount = r.i32()
  const rigids: PmxRigid[] = []
  for (let i = 0; i < rbCount; i++) {
    const jp = r.str(enc as 0 | 1)
    r.str(enc as 0 | 1)
    const bone = r.idx(boneIdx)
    r.raw(3) // group(1) + nonCollisionMask(2)
    const shapeByte = r.u8()
    const shape: 0 | 1 | 2 = shapeByte === 0 ? 0 : shapeByte === 1 ? 1 : 2
    const size: [number, number, number] = [r.f32(), r.f32(), r.f32()]
    const pos: [number, number, number] = [r.f32(), r.f32(), r.f32()]
    const rot: [number, number, number] = [r.f32(), r.f32(), r.f32()]
    r.raw(20) // mass + linearDamp + angularDamp + restitution + friction
    const mode = r.u8()
    rigids.push({ jp, bone, shape, size, pos, rot, mode })
  }
  // (joints and any trailing data are irrelevant to the skeleton reader)

  // aggregate per-bone vertex envelopes (compact spatial hull for conditioning & collision)
  const envelopes: Record<string, BoneEnvelope> = {}
  const round2 = (n: number) => Number(n.toFixed(2))
  for (let i = 0; i < vCount; i++) {
    const bi = vBone[i]
    if (bi < 0 || bi >= bones.length) continue
    const bone = bones[bi]
    const x = vPos[i * 3], y = vPos[i * 3 + 1], z = vPos[i * 3 + 2]
    const d = Math.hypot(x - bone.pos[0], y - bone.pos[1], z - bone.pos[2])
    let env = envelopes[bone.jp]
    if (!env) {
      env = {
        count: 1,
        min: [round2(x), round2(y), round2(z)],
        max: [round2(x), round2(y), round2(z)],
        maxRadius: round2(d),
      }
      envelopes[bone.jp] = env
    } else {
      env.count++
      if (x < env.min[0]) env.min[0] = round2(x)
      if (y < env.min[1]) env.min[1] = round2(y)
      if (z < env.min[2]) env.min[2] = round2(z)
      if (x > env.max[0]) env.max[0] = round2(x)
      if (y > env.max[1]) env.max[1] = round2(y)
      if (z > env.max[2]) env.max[2] = round2(z)
      if (d > env.maxRadius) env.maxRadius = round2(d)
    }
  }

  return { version, modelName, bones, rigids, faceMorphs, indexByJp, envelopes }
}

/** Fetch + parse model bones by URL (browser) — caller may pass a cache. */
export async function loadPmxBones(url: string): Promise<PmxBones> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`)
  return parsePmxBones(new Uint8Array(await res.arrayBuffer()))
}

// ---------------------------------------------------------------- 序列化（客户端 → 服务端 FK 用）

/** 可 JSON 序列化的骨架（indexByJp 由 deserialize 重建）。 */
export interface SerializedPmxBones {
  version: number
  modelName: string
  bones: PmxBone[]
  rigids: PmxRigid[]
  faceMorphs: string[]
  envelopes?: Record<string, BoneEnvelope>
}

export function serializePmxBones(b: PmxBones): SerializedPmxBones {
  return {
    version: b.version,
    modelName: b.modelName,
    bones: b.bones,
    rigids: b.rigids,
    faceMorphs: b.faceMorphs,
    ...(b.envelopes ? { envelopes: b.envelopes } : {}),
  }
}

/** 从 JSON 重建 PmxBones（校验形状，非法返回 null）。 */
export function deserializePmxBones(o: unknown): PmxBones | null {
  try {
    const s = o as SerializedPmxBones
    if (!s || !Array.isArray(s.bones) || s.bones.length === 0) return null
    const indexByJp = new Map<string, number>()
    s.bones.forEach((b, i) => {
      if (!b || typeof b.jp !== "string" || !Array.isArray(b.pos) || b.pos.length !== 3) throw new Error("bad bone")
      indexByJp.set(b.jp, i)
    })
    return {
      version: typeof s.version === "number" ? s.version : 2,
      modelName: typeof s.modelName === "string" ? s.modelName : "",
      bones: s.bones,
      rigids: Array.isArray(s.rigids) ? s.rigids : [],
      faceMorphs: Array.isArray(s.faceMorphs) ? s.faceMorphs : [],
      indexByJp,
      ...(s.envelopes && typeof s.envelopes === "object" ? { envelopes: s.envelopes } : {}),
    }
  } catch {
    return null
  }
}
