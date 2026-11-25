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

/** Exact facial surface landmarks derived directly from PMX vertex morphs (まばたき / あ / 照れ). */
export interface FacialLandmarks {
  eyeL?: [number, number, number]
  eyeR?: [number, number, number]
  mouth?: [number, number, number]
  cheekL?: [number, number, number]
  cheekR?: [number, number, number]
}

/** Real PMX mesh surface point snapped directly from vertices (in model rest space). */
export interface SnappedSurfacePoint {
  pos: [number, number, number]
  normal: [number, number, number]
}

/** Single axial elliptical cross-section slice in bone-local rest space. */
export interface EllipticalSlice {
  /** Local Y relative to bone rest position */
  y: number
  /** Local X center offset */
  cx: number
  /** Local Z center offset */
  cz: number
  /** Lateral half-width (X radius) */
  rx: number
  /** Front-back half-depth (Z radius) */
  rz: number
}

/** Metadata for any PMX morph (0=group, 1=vertex, 2=bone, 3..7=UV, 8=material; panel: 1=brow, 2=eye, 3=mouth, 4=other). */
export interface PmxMorphInfo {
  jp: string
  kind: number
  panel: number
}

export interface PmxBones {
  version: number
  modelName: string
  bones: PmxBone[]
  rigids: PmxRigid[]
  /** Vertex (face) morph names — the model's usable expressions. */
  faceMorphs: string[]
  /** Complete catalog of all PMX morphs across all kinds (group/vertex/bone/UV/material) with panel category. */
  allMorphs?: PmxMorphInfo[]
  /** jp -> bone index lookup for FK / audit code. */
  indexByJp: Map<string, number>
  /** Per-bone skinned vertex spatial envelopes (keyed by bone jp). */
  envelopes?: Record<string, BoneEnvelope>
  /** Hard-core per-bone envelopes excluding hair, soft cloth & physics-driven rigid bones. */
  coreEnvelopes?: Record<string, BoneEnvelope>
  /** True face-skin envelope (excluding hair/accessories) for accurate head skull radius & cheek surface. */
  faceSkinEnvelope?: BoneEnvelope
  /** Exact 3D facial landmarks extracted from vertex morphs (まばたき / あ / 照れ). */
  facialLandmarks?: FacialLandmarks
  /** Key body/face anchors snapped directly to real PMX surface vertices (eliminates AABB corner air-gap). */
  snappedSurfaces?: Record<string, SnappedSurfacePoint>
  /** 4-slice axial elliptical hulls per core bone (captures true non-circular anatomy of head/chest/waist/hips/legs). */
  boneSlices?: Record<string, EllipticalSlice[]>
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
  uidx(size: number) {
    switch (size) {
      case 1: return this.u8()
      case 2: { const v = this.dv.getUint16(this.o, true); this.o += 2; return v }
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

  // faces (keep vertex indices so material ranges can tag hair / face-skin / soft-cloth vertices)
  const fCount = r.i32()
  const faceVerts = new Uint32Array(fCount)
  for (let i = 0; i < fCount; i++) faceVerts[i] = r.uidx(vIdx)

  // textures
  const tCount = r.i32()
  for (let i = 0; i < tCount; i++) r.str(enc as 0 | 1)

  // materials — tag vertices into hair (1), faceSkin (2), softCloth (4)
  const TAG_HAIR = 1
  const TAG_FACE_SKIN = 2
  const TAG_SOFT_CLOTH = 4
  const vTag = new Uint8Array(vCount)
  const HAIR_RE = /髪|hair|头发|髮|bang|ponytail|ツインテ/i
  const FACE_RE = /顔|脸|face/i
  const EYE_MOUTH_RE = /eye|目|瞳|眉|brow|lash|まつげ|口|mouth|teeth|歯|舌|白目|ハイライト/i
  const SOFT_RE = /skirt|スカート|裙|ribbon|リボン|丝带|帯|cape|マント|披风|tie|ネクタイ|飾|accessory|tassel|流苏/i

  const mCount = r.i32()
  let faceCursor = 0
  for (let i = 0; i < mCount; i++) {
    const matJp = r.str(enc as 0 | 1)
    const matEn = r.str(enc as 0 | 1)
    r.raw(16 + 12 + 4 + 12)
    r.u8()
    r.raw(16 + 4)
    r.idx(texIdx); r.idx(texIdx)
    r.i8()
    const shared = r.i8()
    if (shared === 0) r.idx(texIdx); else r.i8()
    r.str(enc as 0 | 1)
    const mFaceCount = r.i32()

    const name = `${matJp} ${matEn}`
    let tag = 0
    if (HAIR_RE.test(name)) tag |= TAG_HAIR
    else if (FACE_RE.test(name) && !EYE_MOUTH_RE.test(name)) tag |= TAG_FACE_SKIN
    if (SOFT_RE.test(name)) tag |= TAG_SOFT_CLOTH

    if (tag !== 0) {
      const end = Math.min(fCount, faceCursor + mFaceCount)
      for (let k = faceCursor; k < end; k++) {
        const vi = faceVerts[k]
        if (vi < vCount) vTag[vi] |= tag
      }
    }
    faceCursor += mFaceCount
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

  // morphs (collect all morph metadata + extract exact 3D facial landmarks from まばたき / あ / 照れ)
  const moCount = r.i32()
  const faceMorphs: string[] = []
  const allMorphs: PmxMorphInfo[] = []
  const facialLandmarks: FacialLandmarks = {}
  const round2 = (n: number) => Number(n.toFixed(2))

  for (let i = 0; i < moCount; i++) {
    const jp = r.str(enc as 0 | 1)
    r.str(enc as 0 | 1)
    const panel = r.i8()
    const kind = r.i8()
    allMorphs.push({ jp, kind, panel })
    const n = r.i32()
    if (kind === 0) { for (let k = 0; k < n; k++) { r.idx(morphIdx); r.raw(4) } }
    else if (kind === 1) {
      faceMorphs.push(jp)
      const isBlink = jp === "まばたき" && !facialLandmarks.eyeL
      const isMouth = (jp === "あ" || jp === "あ２") && !facialLandmarks.mouth
      const isBlush = jp === "照れ" && !facialLandmarks.cheekL
      if (isBlink || isMouth || isBlush) {
        let lx = 0, ly = 0, lz = 0, lc = 0
        let rx = 0, ry = 0, rz = 0, rc = 0
        let mx = 0, my = 0, mz = 0, mc = 0
        for (let k = 0; k < n; k++) {
          const vi = r.uidx(vIdx)
          const dx = r.f32(), dy = r.f32(), dz = r.f32()
          if (vi >= 0 && vi < vCount && (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-4)) {
            const x = vPos[vi * 3], y = vPos[vi * 3 + 1], z = vPos[vi * 3 + 2]
            if (isMouth) {
              mx += x; my += y; mz += z; mc++
            } else if (x > 0.05) {
              lx += x; ly += y; lz += z; lc++
            } else if (x < -0.05) {
              rx += x; ry += y; rz += z; rc++
            }
          }
        }
        if (isBlink) {
          if (lc > 0) facialLandmarks.eyeL = [round2(lx / lc), round2(ly / lc), round2(lz / lc)]
          if (rc > 0) facialLandmarks.eyeR = [round2(rx / rc), round2(ry / rc), round2(rz / rc)]
        } else if (isMouth && mc > 0) {
          facialLandmarks.mouth = [round2(mx / mc), round2(my / mc), round2(mz / mc)]
        } else if (isBlush) {
          if (lc > 0) facialLandmarks.cheekL = [round2(lx / lc), round2(ly / lc), round2(lz / lc)]
          if (rc > 0) facialLandmarks.cheekR = [round2(rx / rc), round2(ry / rc), round2(rz / rc)]
        }
      } else {
        for (let k = 0; k < n; k++) { r.uidx(vIdx); r.raw(12) }
      }
    }
    else if (kind === 2) { for (let k = 0; k < n; k++) { r.idx(boneIdx); r.raw(12) } }
    else if (kind >= 3 && kind <= 7) { for (let k = 0; k < n; k++) { r.uidx(vIdx); r.raw(16) } }
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

  // Name-independent physics soft-bone detection: bones driven by mode=1/2 physics rigids (hair/skirt/ribbon/tassels)
  const CORE_PROTECTED_JP = new Set([
    "全ての親", "センター", "グルーブ", "腰", "下半身", "上半身", "上半身2", "首", "頭",
    "左肩", "右肩", "左腕", "右腕", "左ひじ", "右ひじ", "左手首", "右手首",
    "左足", "右足", "左ひざ", "右ひざ", "左足首", "右足首",
  ])
  const physicsSoftBones = new Set<number>()
  for (const rb of rigids) {
    if ((rb.mode === 1 || rb.mode === 2) && rb.bone >= 0 && rb.bone < bones.length) {
      if (!CORE_PROTECTED_JP.has(bones[rb.bone].jp)) physicsSoftBones.add(rb.bone)
    }
  }

  // aggregate per-bone vertex envelopes (full + hard-core excluding hair/soft cloth/physics-rigid bones + pure face skin)
  const envelopes: Record<string, BoneEnvelope> = {}
  const coreEnvelopes: Record<string, BoneEnvelope> = {}
  let faceSkinEnvelope: BoneEnvelope | undefined

  const accEnv = (map: Record<string, BoneEnvelope>, key: string, x: number, y: number, z: number, d: number) => {
    let env = map[key]
    if (!env) {
      map[key] = {
        count: 1,
        min: [round2(x), round2(y), round2(z)],
        max: [round2(x), round2(y), round2(z)],
        maxRadius: round2(d),
      }
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

  for (let i = 0; i < vCount; i++) {
    const bi = vBone[i]
    if (bi < 0 || bi >= bones.length) continue
    const bone = bones[bi]
    const x = vPos[i * 3], y = vPos[i * 3 + 1], z = vPos[i * 3 + 2]
    const d = Math.hypot(x - bone.pos[0], y - bone.pos[1], z - bone.pos[2])
    accEnv(envelopes, bone.jp, x, y, z, d)
    const tag = vTag[i]
    if ((tag & (TAG_HAIR | TAG_SOFT_CLOTH)) === 0 && !physicsSoftBones.has(bi)) {
      accEnv(coreEnvelopes, bone.jp, x, y, z, d)
    }
    if ((tag & TAG_FACE_SKIN) !== 0 && bone.jp === "頭") {
      const tmp: Record<string, BoneEnvelope> = faceSkinEnvelope ? { face: faceSkinEnvelope } : {}
      accEnv(tmp, "face", x, y, z, d)
      faceSkinEnvelope = tmp.face
    }
  }

  // Extract 4-slice axial elliptical hulls for core anatomical bones (captures true elliptical waist/hips/chest/head/legs!)
  const SLICE_BONES = ["頭", "上半身2", "上半身", "下半身", "左足", "右足", "左ひざ", "右ひざ"]
  const sliceBoneIndices = new Map<number, string>()
  for (const jp of SLICE_BONES) {
    const idx = indexByJp.get(jp)
    if (idx != null) sliceBoneIndices.set(idx, jp)
  }
  const vertsBySliceBone = new Map<string, Array<[number, number, number]>>()
  for (let i = 0; i < vCount; i++) {
    const bi = vBone[i]
    const jp = sliceBoneIndices.get(bi)
    if (!jp) continue
    const tag = vTag[i]
    if (jp === "頭" && faceSkinEnvelope && faceSkinEnvelope.count >= 100) {
      if ((tag & TAG_FACE_SKIN) === 0) continue
    } else if ((tag & (TAG_HAIR | TAG_SOFT_CLOTH)) !== 0 || physicsSoftBones.has(bi)) {
      continue
    }
    let list = vertsBySliceBone.get(jp)
    if (!list) { list = []; vertsBySliceBone.set(jp, list) }
    list.push([vPos[i * 3], vPos[i * 3 + 1], vPos[i * 3 + 2]])
  }

  const boneSlices: Record<string, EllipticalSlice[]> = {}
  const NUM_SLICES = 4
  const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))]
  for (const [jp, pts] of vertsBySliceBone.entries()) {
    if (pts.length < 16) continue
    const bPos = bones[indexByJp.get(jp)!].pos
    let yMin = 1e9, yMax = -1e9
    for (const p of pts) { if (p[1] < yMin) yMin = p[1]; if (p[1] > yMax) yMax = p[1] }
    const span = yMax - yMin
    if (span < 0.2) continue
    const slices: EllipticalSlice[] = []
    for (let s = 0; s < NUM_SLICES; s++) {
      const lo = yMin + (span * s) / NUM_SLICES
      const hi = yMin + (span * (s + 1)) / NUM_SLICES
      const xs: number[] = []
      const zs: number[] = []
      for (const p of pts) {
        if (p[1] >= lo && p[1] <= hi + 1e-4) {
          xs.push(p[0] - bPos[0])
          zs.push(p[2] - bPos[2])
        }
      }
      if (xs.length < 4) continue
      xs.sort((a, b) => a - b)
      zs.sort((a, b) => a - b)
      // 3rd / 97th percentile trims stray decorative outlier vertices while keeping true elliptical body hull
      const xLo = quantile(xs, 0.03), xHi = quantile(xs, 0.97)
      const zLo = quantile(zs, 0.03), zHi = quantile(zs, 0.97)
      slices.push({
        y: round2((lo + hi) * 0.5 - bPos[1]),
        cx: round2((xLo + xHi) * 0.5),
        cz: round2((zLo + zHi) * 0.5),
        rx: round2(Math.max(0.32, (xHi - xLo) * 0.5)),
        rz: round2(Math.max(0.32, (zHi - zLo) * 0.5)),
      })
    }
    if (slices.length >= 2) boneSlices[jp] = slices
  }

  // Snap key surface anchors directly to real PMX mesh vertices (eliminates AABB corner air-gap!)
  const snappedSurfaces: Record<string, SnappedSurfacePoint> = {}
  const norm3 = (x: number, y: number, z: number): [number, number, number] => {
    const l = Math.hypot(x, y, z) || 1
    return [round2(x / l), round2(y / l), round2(z / l)]
  }
  const headIdx = indexByJp.get("頭")
  const upperIdx = indexByJp.get("上半身")
  const upper2Idx = indexByJp.get("上半身2") ?? upperIdx

  if (headIdx != null && faceSkinEnvelope) {
    const mouthY = facialLandmarks.mouth ? facialLandmarks.mouth[1] : faceSkinEnvelope.min[1] + 0.35
    const eyeY = facialLandmarks.eyeL ? facialLandmarks.eyeL[1] : mouthY + 0.72
    // Lower cheek height (below eye so fingertips never brush the eye!)
    const cheekY = mouthY * 0.76 + eyeY * 0.24
    const faceCenterZ = (faceSkinEnvelope.min[2] + faceSkinEnvelope.max[2]) * 0.5

    // Pick actual cheek skin vertex on the curved front-side surface (45° front-lateral direction)
    for (const side of [1, -1] as const) {
      let bestScore = -1e9
      let bestP: [number, number, number] | null = null
      for (let i = 0; i < vCount; i++) {
        if ((vTag[i] & TAG_FACE_SKIN) === 0 || vBone[i] !== headIdx) continue
        const x = vPos[i * 3], y = vPos[i * 3 + 1], z = vPos[i * 3 + 2]
        if (Math.abs(y - cheekY) > 0.22) continue
        if (x * side < 0.32) continue // exclude nose/mouth center
        if (z > faceCenterZ) continue // front half only
        const score = x * side * 0.58 + (-z) * 0.81
        if (score > bestScore) {
          bestScore = score
          bestP = [round2(x), round2(y), round2(z)]
        }
      }
      if (bestP) {
        const n = norm3(bestP[0], -0.04, bestP[2] - faceCenterZ)
        snappedSurfaces[side > 0 ? "cheek_l" : "cheek_r"] = { pos: bestP, normal: n }
      }
    }

    // Snap chin & forehead to front-most center face-skin vertices
    let bestChinZ = 1e9, chinP: [number, number, number] | null = null
    let bestFhZ = 1e9, fhP: [number, number, number] | null = null
    for (let i = 0; i < vCount; i++) {
      if ((vTag[i] & TAG_FACE_SKIN) === 0 || vBone[i] !== headIdx) continue
      const x = vPos[i * 3], y = vPos[i * 3 + 1], z = vPos[i * 3 + 2]
      if (Math.abs(x) < 0.22 && y <= mouthY - 0.12 && z < bestChinZ) {
        bestChinZ = z; chinP = [round2(x), round2(y), round2(z)]
      }
      if (Math.abs(x) < 0.25 && Math.abs(y - (eyeY + 0.48)) < 0.22 && z < bestFhZ) {
        bestFhZ = z; fhP = [round2(x), round2(y), round2(z)]
      }
    }
    if (chinP) snappedSurfaces["chin"] = { pos: chinP, normal: [0, -0.3, -0.95] }
    if (fhP) snappedSurfaces["forehead"] = { pos: fhP, normal: [0, 0.15, -0.99] }
  }

  // Snap waist_side_l/r on core 上半身 vertices
  if (upperIdx != null && coreEnvelopes["上半身"]) {
    const ue = coreEnvelopes["上半身"]
    const waistY = ue.min[1] + (ue.max[1] - ue.min[1]) * 0.25
    const waistZ = (ue.min[2] + ue.max[2]) * 0.5
    for (const side of [1, -1] as const) {
      let bestX = -1e9
      let bestP: [number, number, number] | null = null
      for (let i = 0; i < vCount; i++) {
        if (vBone[i] !== upperIdx || (vTag[i] & (TAG_HAIR | TAG_SOFT_CLOTH)) !== 0) continue
        const x = vPos[i * 3], y = vPos[i * 3 + 1], z = vPos[i * 3 + 2]
        if (Math.abs(y - waistY) > 0.35 || Math.abs(z - waistZ) > 0.55) continue
        if (x * side > bestX) {
          bestX = x * side
          bestP = [round2(x), round2(y), round2(z)]
        }
      }
      if (bestP) snappedSurfaces[side > 0 ? "waist_side_l" : "waist_side_r"] = { pos: bestP, normal: [side, 0, -0.15] }
    }
  }

  // Snap chest_center on core 上半身2 vertices
  if (upper2Idx != null && coreEnvelopes[bones[upper2Idx].jp]) {
    const ce = coreEnvelopes[bones[upper2Idx].jp]
    const midY = (ce.min[1] + ce.max[1]) * 0.5
    let bestZ = 1e9, bestP: [number, number, number] | null = null
    for (let i = 0; i < vCount; i++) {
      if (vBone[i] !== upper2Idx || (vTag[i] & (TAG_HAIR | TAG_SOFT_CLOTH)) !== 0) continue
      const x = vPos[i * 3], y = vPos[i * 3 + 1], z = vPos[i * 3 + 2]
      if (Math.abs(x) < 0.35 && Math.abs(y - midY) < 0.45 && z < bestZ) {
        bestZ = z; bestP = [round2(x), round2(y), round2(z)]
      }
    }
    if (bestP) snappedSurfaces["chest_center"] = { pos: bestP, normal: [0, 0, -1] }
  }

  const hasLandmarks = Object.keys(facialLandmarks).length > 0
  const hasSnapped = Object.keys(snappedSurfaces).length > 0
  const hasSlices = Object.keys(boneSlices).length > 0
  return {
    version,
    modelName,
    bones,
    rigids,
    faceMorphs,
    allMorphs,
    indexByJp,
    envelopes,
    coreEnvelopes,
    ...(faceSkinEnvelope ? { faceSkinEnvelope } : {}),
    ...(hasLandmarks ? { facialLandmarks } : {}),
    ...(hasSnapped ? { snappedSurfaces } : {}),
    ...(hasSlices ? { boneSlices } : {}),
  }
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
