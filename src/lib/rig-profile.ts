/**
 * rig-profile.ts — 模型“二次建模”层（Semantic-Kinematic Avatar Rig Profile）
 *
 * 将原始 PMX 骨骼、顶点包络（envelopes）、刚体（rigids）和表情（morphs）
 * 自动抽象为一份持久化、可校准的 JSON 代理模型档案（`<model>.rig-profile.json`）：
 *   1. Neutral Pose 零点：自动消除 A-pose / T-pose 差异，提供自然放松基准态
 *   2. 脊柱样条联动权重（Spine Synergy）：把高层 curl/twist/lean 分配到整条脊柱链
 *   3. 臂/腿运动学链（ArmRig / LegRig）：含肩肱耦合比例、扭转骨映射、实测骨长
 *   4. 身体碰撞胶囊（Capsules）与随动表面法线锚点（Surface Anchors）
 *   5. 质量分布代理（Mass Proxy）：用于质心（CoM）与平衡补偿
 *   6. 归一化表情通道（MorphMap）与手型基底（HandGrips）
 */

import { measureModelGeometry, restWorldPositions, type ModelMeasurements, type Vec3 } from "./model-geometry.ts"
import type { EllipticalSlice, PmxBones } from "./pmx-bones.ts"

export type V3 = [number, number, number]
export interface Quat { x: number; y: number; z: number; w: number }

export interface SpineLink {
  boneJp: string
  curlWeight: number
  twistWeight: number
  leanWeight: number
  maxDeg: number
}

export interface ArmRig {
  side: "l" | "r"
  shoulderJp: string
  armJp: string
  armTwistJp: string | null
  elbowJp: string
  wristTwistJp: string | null
  wristJp: string
  upperLen: number
  foreLen: number
  /** Measured distance from wrist to knuckle/palm center (in u) so surface touches land on palm/fingers, not wrist */
  palmLen: number
  /** Rest unit direction from arm to elbow in model space */
  restUpperDir: V3
  /** Rest unit direction from elbow to wrist in model space */
  restForeDir: V3
  /** Rest unit direction from wrist toward middle fingers in model space */
  restFingerDir: V3
  /** Rest unit outward palm normal in model space (measured from wrist/index/pinky) */
  restPalmNormal: V3
  /** Fraction of arm elevation automatically coupled to clavicle/shoulder */
  shoulderCoupling: number
}

export interface LegRig {
  side: "l" | "r"
  hipJp: string
  kneeJp: string
  ankleJp: string
  toeJp: string | null
  thighLen: number
  shinLen: number
  restHipPos: V3
  restAnklePos: V3
  restFootMinY: number
  hasLegIk: boolean
}

export interface BodyCapsule {
  id: string
  boneJp: string
  /** Segment endpoint A in bone-local rest space */
  localA: V3
  /** Segment endpoint B in bone-local rest space */
  localB: V3
  /** Tapered radius at endpoint A */
  radiusA: number
  /** Tapered radius at endpoint B */
  radiusB: number
  /** Max radius (compat alias) */
  radius: number
  /** Optional multi-slice axial elliptical cross-sections (y, cx, cz, rx, rz) for true non-circular body anatomy */
  slices?: EllipticalSlice[]
}

export interface JointRomSpec {
  /** Max forearm axial pronation/supination twist (degrees) */
  forearmTwistMaxDeg: number
  /** Max wrist swing flexion/extension/deviation (degrees) */
  wristSwingMaxDeg: number
  /** Max clavicle lift (degrees) */
  shoulderLiftMaxDeg: number
  /** Max knee flexion (degrees) */
  kneeFlexMaxDeg: number
}

export interface SurfaceAnchor {
  boneJp: string
  /** Offset from bone rest position in bone-local space */
  localPos: V3
  /** Outward surface normal in bone-local space (unit vector) */
  localNormal: V3
}

export interface MassNode {
  boneJp: string
  localOffset: V3
  massRatio: number
}

export interface HandGripSpec {
  thumbCurl: number
  indexCurl: number
  middleCurl: number
  ringCurl: number
  pinkyCurl: number
  spread: number
}

export interface RigProfile {
  version: "1.0"
  modelId: string
  modelName: string
  measurements: ModelMeasurements
  /** Bone-local rest offsets that define the natural relaxed standing pose (replaces A/T-pose as logical 0) */
  neutralPose: Record<string, Quat>
  spineChain: SpineLink[]
  arms: { l: ArmRig; r: ArmRig }
  legs: { l: LegRig; r: LegRig }
  capsules: BodyCapsule[]
  anchors: Record<string, SurfaceAnchor>
  massProxy: MassNode[]
  /** Semantic channel -> one or more PMX morph names (supports _L/_R split models) */
  morphMap: Record<string, string[]>
  /** Built-in hand grip basis poses */
  handGrips: Record<string, HandGripSpec>
  /** Anatomical joint range-of-motion soft limits */
  jointRom: JointRomSpec
  /** Optional per-model calibration notes */
  calibrationNotes: string[]
}

// ------------------------------------------------------------------ math helpers

const r2 = (n: number) => Number(n.toFixed(3))
const v3r = (v: V3): V3 => [r2(v[0]), r2(v[1]), r2(v[2])]

function vSub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function vAdd(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function vDot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function vCross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function vLen(a: V3): number { return Math.hypot(a[0], a[1], a[2]) }
function vNorm(a: V3): V3 {
  const l = vLen(a)
  return l > 1e-6 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, -1]
}

function qFromAxisAngle(axis: V3, deg: number): Quat {
  const n = vNorm(axis)
  const half = ((deg * Math.PI) / 180) * 0.5
  const s = Math.sin(half)
  return { x: r2(n[0] * s), y: r2(n[1] * s), z: r2(n[2] * s), w: r2(Math.cos(half)) }
}

function qMul(a: Quat, b: Quat): Quat {
  return {
    x: r2(a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y),
    y: r2(a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x),
    z: r2(a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w),
    w: r2(a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z),
  }
}

function toV3(p: Vec3 | undefined | null, fallback: V3 = [0, 0, 0]): V3 {
  return p ? [p.x, p.y, p.z] : fallback
}

// ------------------------------------------------------------------ morph normalization

// Multi-channel semantic expressions: separate EYEBROW / EYE / MOUTH so gentle smiles keep eyes OPEN!
const SEMANTIC_MORPH_CANDIDATES: Record<string, string[][]> = {
  // Natural open-eye smile: gentle brows (にこり) + lifted mouth corners (口角上げ), eyes stay OPEN!
  smile: [["にこり", "口角上げ"], ["口角上げ"], ["にこり"]],
  warm_smile: [["にこり", "口角上げ"], ["口角上げ"], ["にこり"]],
  // Explicit eye-closing smiles (only squint/close eyes when requested!)
  happy_squint: [["なごみ", "口角上げ"], ["なごみ"]],
  laugh: [["笑い", "ワ"], ["笑い"], ["笑い1"]],
  shy: [["照れ"]],
  serious: [["真面目"], ["真面目_L", "真面目_R"]],
  sharp: [["ｷﾘｯ"], ["ｷﾘｯ_L", "ｷﾘｯ_R"]],
  troubled: [["困る"]],
  surprised: [["びっくり"], ["びっくり_L", "びっくり_R"]],
  angry: [["怒り"]],
  smirk: [["にやり２"]],
  blink: [["まばたき"]],
  wink_l: [["ウィンク"], ["ウィンク２"]],
  wink_r: [["ウィンク右"], ["ｳｨﾝｸ２右"]],
  mouth_a: [["あ"], ["あ２"]],
  mouth_i: [["い"]],
  mouth_u: [["う"]],
  mouth_e: [["え"]],
  mouth_o: [["お"]],
  grin: [["ワ"], ["あ"]],
}

function buildMorphMap(faceMorphs: string[]): Record<string, string[]> {
  const present = new Set(faceMorphs)
  const out: Record<string, string[]> = {}
  for (const [semantic, groups] of Object.entries(SEMANTIC_MORPH_CANDIDATES)) {
    for (const group of groups) {
      if (group.every((name) => present.has(name))) {
        out[semantic] = group
        break
      }
    }
  }
  return out
}

// ------------------------------------------------------------------ standard hand grips

export const DEFAULT_HAND_GRIPS: Record<string, HandGripSpec> = {
  relax: { thumbCurl: 0.22, indexCurl: 0.22, middleCurl: 0.28, ringCurl: 0.34, pinkyCurl: 0.40, spread: 0.08 },
  open:  { thumbCurl: 0.02, indexCurl: 0.02, middleCurl: 0.03, ringCurl: 0.04, pinkyCurl: 0.05, spread: 0.35 },
  fist:  { thumbCurl: 0.78, indexCurl: 0.92, middleCurl: 0.95, ringCurl: 0.95, pinkyCurl: 0.92, spread: 0.0 },
  point: { thumbCurl: 0.65, indexCurl: 0.04, middleCurl: 0.90, ringCurl: 0.92, pinkyCurl: 0.90, spread: 0.05 },
  peace: { thumbCurl: 0.68, indexCurl: 0.04, middleCurl: 0.04, ringCurl: 0.90, pinkyCurl: 0.90, spread: 0.30 },
  cup:   { thumbCurl: 0.35, indexCurl: 0.48, middleCurl: 0.52, ringCurl: 0.56, pinkyCurl: 0.60, spread: 0.05 },
}

// ------------------------------------------------------------------ main builder

export function buildRigProfile(bones: PmxBones, modelId = "unknown"): RigProfile {
  const m = measureModelGeometry(bones)
  const world = restWorldPositions(bones)
  const env = bones.envelopes ?? {}
  const coreEnv = bones.coreEnvelopes ?? env
  const faceEnv = bones.faceSkinEnvelope
  const fl = bones.facialLandmarks
  const snapped = bones.snappedSurfaces ?? {}
  const boneSlices = bones.boneSlices ?? {}
  const notes: string[] = []

  const getPos = (jp: string): V3 | null => {
    const i = bones.indexByJp.get(jp)
    return i != null ? toV3(world.get(i)) : null
  }
  const has = (jp: string) => bones.indexByJp.has(jp)

  // 1. Neutral Pose calibration (convert A/T-pose into relaxed standing zero-point)
  const restBelowHoriz = m.armRestAngleDeg ?? 35
  // Natural relaxed arm hangs ~78° below horizontal (~12° off vertical)
  const targetBelowHoriz = 78
  const armDropDeg = Math.max(0, Math.min(72, targetBelowHoriz - restBelowHoriz))
  notes.push(`A-pose arm rest ${restBelowHoriz}° below horizontal → Neutral Pose drops arms by ${armDropDeg.toFixed(1)}°`)

  // MMD coordinate system: +X = model left, +Y = up, -Z = forward
  // Rotating left arm (+X) downward (-Y) is a NEGATIVE rotation around +Z (right-hand rule: +Z × +X = +Y)
  const neutralPose: Record<string, Quat> = {}
  if (has("左腕")) {
    neutralPose["左腕"] = qMul(
      qFromAxisAngle([0, 0, 1], -armDropDeg),
      qFromAxisAngle([0, 1, 0], 6), // slight natural forward drift
    )
  }
  if (has("右腕")) {
    neutralPose["右腕"] = qMul(
      qFromAxisAngle([0, 0, 1], armDropDeg),
      qFromAxisAngle([0, 1, 0], -6),
    )
  }
  // Slight natural elbow flexion (~12° forward) so arms never look locked straight
  if (has("左ひじ")) neutralPose["左ひじ"] = qFromAxisAngle([0, 1, 0], 12)
  if (has("右ひじ")) neutralPose["右ひじ"] = qFromAxisAngle([0, 1, 0], -12)
  // Subtle natural upper chest poise
  if (has("上半身2")) neutralPose["上半身2"] = qFromAxisAngle([1, 0, 0], -2)

  // 2. Spine synergy chain
  const hasUpper2 = has("上半身2")
  const hasWaist = has("腰")
  const spineChain: SpineLink[] = []
  if (hasWaist) {
    spineChain.push({ boneJp: "腰", curlWeight: 0.15, twistWeight: 0.15, leanWeight: 0.15, maxDeg: 25 })
  }
  if (has("上半身")) {
    spineChain.push({
      boneJp: "上半身",
      curlWeight: hasUpper2 ? 0.35 : 0.65,
      twistWeight: hasUpper2 ? 0.35 : 0.65,
      leanWeight: hasUpper2 ? 0.35 : 0.65,
      maxDeg: 35,
    })
  }
  if (hasUpper2) {
    spineChain.push({ boneJp: "上半身2", curlWeight: 0.38, twistWeight: 0.38, leanWeight: 0.38, maxDeg: 35 })
  }
  if (has("首")) {
    spineChain.push({ boneJp: "首", curlWeight: 0.12, twistWeight: 0.12, leanWeight: 0.12, maxDeg: 25 })
  }

  // 3. Arm rigs
  const buildArm = (side: "l" | "r"): ArmRig => {
    const p = side === "l" ? "左" : "右"
    const s = side === "l" ? 1 : -1
    const armP = getPos(`${p}腕`) ?? [s * 1.25, 16.5, 0]
    const elbP = getPos(`${p}ひじ`) ?? [s * 3.6, 14.7, 0.2]
    const wriP = getPos(`${p}手首`) ?? [s * 5.6, 13.2, 0.2]
    const idxP = getPos(`${p}人指１`)
    const pnkP = getPos(`${p}小指１`)
    const upperVec = vSub(elbP, armP)
    const foreVec = vSub(wriP, elbP)
    const palmLen = idxP ? r2(vLen(vSub(idxP, wriP))) : 0.85

    // Auto-derive exact palm local basis from wrist + index + pinky
    let restFingerDir = vNorm(foreVec)
    let restPalmNormal: V3 = [0, -1, 0]
    if (idxP && pnkP) {
      const vIdx = vSub(idxP, wriP)
      const vPnk = vSub(pnkP, wriP)
      restFingerDir = vNorm(vAdd(vIdx, vPnk))
      const rawN = side === "l" ? vCross(vIdx, vPnk) : vCross(vPnk, vIdx)
      if (vLen(rawN) > 1e-4) {
        // Gram-Schmidt orthogonalize against restFingerDir
        const d = vDot(rawN, restFingerDir)
        restPalmNormal = vNorm([rawN[0] - restFingerDir[0] * d, rawN[1] - restFingerDir[1] * d, rawN[2] - restFingerDir[2] * d])
      }
    }

    return {
      side,
      shoulderJp: `${p}肩`,
      armJp: `${p}腕`,
      armTwistJp: has(`${p}腕捩`) ? `${p}腕捩` : null,
      elbowJp: `${p}ひじ`,
      wristTwistJp: has(`${p}手捩`) ? `${p}手捩` : null,
      wristJp: `${p}手首`,
      upperLen: r2(vLen(upperVec)),
      foreLen: r2(vLen(foreVec)),
      palmLen,
      restUpperDir: v3r(vNorm(upperVec)),
      restForeDir: v3r(vNorm(foreVec)),
      restFingerDir: v3r(restFingerDir),
      restPalmNormal: v3r(restPalmNormal),
      shoulderCoupling: 0.28,
    }
  }
  const arms = { l: buildArm("l"), r: buildArm("r") }

  // 4. Leg rigs
  const hasLegIk = has("左足ＩＫ") && has("右足ＩＫ")
  const buildLeg = (side: "l" | "r"): LegRig => {
    const p = side === "l" ? "左" : "右"
    const s = side === "l" ? 1 : -1
    const hipP = getPos(`${p}足`) ?? [s * 0.9, 12.1, -0.3]
    const kneeP = getPos(`${p}ひざ`) ?? [s * 0.9, 6.9, -0.1]
    const ankleP = getPos(`${p}足首`) ?? [s * 0.9, 1.5, 0.4]
    const toeJp = has(`${p}足先EX`) ? `${p}足先EX` : has(`${p}つま先`) ? `${p}つま先` : null
    const toeEnv = toeJp ? env[toeJp] : undefined
    const restFootMinY = toeEnv ? r2(toeEnv.min[1]) : 0
    return {
      side,
      hipJp: `${p}足`,
      kneeJp: `${p}ひざ`,
      ankleJp: `${p}足首`,
      toeJp,
      thighLen: r2(vLen(vSub(kneeP, hipP))),
      shinLen: r2(vLen(vSub(ankleP, kneeP))),
      restHipPos: v3r(hipP),
      restAnklePos: v3r(ankleP),
      restFootMinY,
      hasLegIk,
    }
  }
  const legs = { l: buildLeg("l"), r: buildLeg("r") }

  // 5. Tapered hard-core collision capsules (anatomy-matched A→B taper + coreEnvelopes excluding hair/soft cloth)
  const capsules: BodyCapsule[] = []
  const addTaperedCapsule = (
    id: string,
    boneJp: string,
    scaleA: number,
    scaleB: number,
    fallbackR = 1.0,
    overrideEnv?: { count: number; min: [number, number, number]; max: [number, number, number] },
  ) => {
    const bp = getPos(boneJp)
    if (!bp) return
    const e = overrideEnv ?? coreEnv[boneJp] ?? env[boneJp]
    if (e && e.count >= 20) {
      const cx = (e.min[0] + e.max[0]) * 0.5 - bp[0]
      const cz = (e.min[2] + e.max[2]) * 0.5 - bp[2]
      const halfX = (e.max[0] - e.min[0]) * 0.5
      const halfZ = (e.max[2] - e.min[2]) * 0.5
      const baseR = Math.max(0.45, Math.min(halfX, halfZ))
      const radiusA = r2(Math.max(0.35, baseR * scaleA))
      const radiusB = r2(Math.max(0.35, baseR * scaleB))
      const maxR = Math.max(radiusA, radiusB)
      const yMin = e.min[1] - bp[1] + radiusA * 0.45
      const yMax = e.max[1] - bp[1] - radiusB * 0.45
      const lo = Math.min(yMin, yMax)
      const hi = Math.max(yMin, yMax)
      const slices = boneSlices[boneJp]
      capsules.push({
        id,
        boneJp,
        localA: v3r([cx, lo, cz]),
        localB: v3r([cx, hi, cz]),
        radiusA,
        radiusB,
        radius: maxR,
        ...(slices ? { slices } : {}),
      })
    } else {
      capsules.push({
        id,
        boneJp,
        localA: [0, 0, 0],
        localB: [0, 1.2, 0],
        radiusA: r2(fallbackR * scaleA),
        radiusB: r2(fallbackR * scaleB),
        radius: fallbackR,
      })
    }
  }
  // Head: narrow jaw/cheek (A) -> wider cranium (B), using hair-free faceSkinEnvelope
  addTaperedCapsule("head", "頭", 0.62, 0.88, 0.85, faceEnv)
  // Chest: narrower lower ribs (A) -> fuller upper chest (B)
  addTaperedCapsule("chest", hasUpper2 ? "上半身2" : "上半身", 0.78, 0.92, 1.15)
  // Abdomen: slim waist core
  addTaperedCapsule("abdomen", "上半身", 0.78, 0.74, 0.90)
  // Pelvis: fuller lower hip (A) -> narrower upper waist (B)
  addTaperedCapsule("pelvis", "下半身", 0.88, 0.72, 1.30)

  // Thighs: fuller upper thigh (A) -> slimmer knee (B)
  for (const side of ["l", "r"] as const) {
    const leg = legs[side]
    const hipP = getPos(leg.hipJp)
    const kneeP = getPos(leg.kneeJp)
    if (hipP && kneeP) {
      const seg = vSub(kneeP, hipP)
      capsules.push({
        id: `thigh_${side}`,
        boneJp: leg.hipJp,
        localA: v3r([seg[0] * 0.15, seg[1] * 0.15, seg[2] * 0.15]),
        localB: v3r([seg[0] * 0.85, seg[1] * 0.85, seg[2] * 0.85]),
        radiusA: 0.84,
        radiusB: 0.56,
        radius: 0.84,
      })
    }
  }

  // 6. Semantic surface anchors (bone-attached, with outward normals)
  const anchors: Record<string, SurfaceAnchor> = {}
  const snapOnBone = (name: string, boneJp: string, bonePos: V3, fallback: SurfaceAnchor): SurfaceAnchor => {
    const s = snapped[name]
    if (!s) return fallback
    return { boneJp, localPos: v3r(vSub(s.pos, bonePos)), localNormal: v3r(vNorm(s.normal)) }
  }

  const headP = getPos("頭")
  const headSkin = faceEnv ?? coreEnv["頭"] ?? env["頭"]
  if (headP) {
    // Use true face-skin envelope (hair excluded!) + exact vertex-morph facial landmarks (まばたき / あ)
    const faceHalfX = headSkin ? (headSkin.max[0] - headSkin.min[0]) * 0.5 : (m.headRadius ?? 1.0) * 0.78
    const faceFrontZ = headSkin ? headSkin.min[2] - headP[2] : -(m.headRadius ?? 1.0)
    const chinY = headSkin ? headSkin.min[1] - headP[1] + 0.12 : 0.04
    const mouthY = fl?.mouth ? fl.mouth[1] - headP[1] : chinY + 0.30
    const eyeY = fl?.eyeL ? fl.eyeL[1] - headP[1] : mouthY + 0.72
    const cheekY = mouthY * 0.76 + eyeY * 0.24
    const cheekX = faceHalfX * 0.72
    const cheekZ = faceFrontZ * 0.86

    if (faceEnv || fl?.eyeL) {
      notes.push(
        `Face landmarks calibrated from PMX ${faceEnv ? "faceSkin material" : "core envelope"} (faceHalfX=${r2(faceHalfX)}u)` +
        (fl?.eyeL ? ` + vertex morphs (eyeY=${fl.eyeL[1]}, mouthY=${fl.mouth?.[1] ?? "?"})` : ""),
      )
    }

    anchors["chin"]     = snapOnBone("chin", "頭", headP, { boneJp: "頭", localPos: v3r([0, chinY, faceFrontZ * 0.82]), localNormal: [0, -0.3, -0.95] })
    anchors["mouth"]    = { boneJp: "頭", localPos: v3r([0, mouthY, faceFrontZ * 0.96]), localNormal: [0, 0, -1] }
    anchors["cheek_l"]  = snapOnBone("cheek_l", "頭", headP, { boneJp: "頭", localPos: v3r([cheekX, cheekY, cheekZ]), localNormal: v3r(vNorm([0.55, -0.05, -0.83])) })
    anchors["cheek_r"]  = snapOnBone("cheek_r", "頭", headP, { boneJp: "頭", localPos: v3r([-cheekX, cheekY, cheekZ]), localNormal: v3r(vNorm([-0.55, -0.05, -0.83])) })
    anchors["forehead"] = snapOnBone("forehead", "頭", headP, { boneJp: "頭", localPos: v3r([0, eyeY + 0.52, faceFrontZ * 0.92]), localNormal: [0, 0.2, -0.98] })
    anchors["head_top"] = { boneJp: "頭", localPos: v3r([0, headSkin ? headSkin.max[1] - headP[1] + 0.15 : 2.1, 0]), localNormal: [0, 1, 0] }
    if (snapped["cheek_r"]) {
      notes.push(`Cheek anchors mesh-snapped directly to PMX face-skin vertices (cheek_r=${JSON.stringify(snapped["cheek_r"].pos)})`)
    }
  }

  const chestBone = hasUpper2 ? "上半身2" : "上半身"
  const chestP = getPos(chestBone)
  const chestEnv = env[chestBone]
  if (chestP) {
    const frontZ = chestEnv ? chestEnv.min[2] - chestP[2] - 0.25 : -1.8
    const halfW = m.shoulderHalfWidth ?? 1.25
    const midY = chestEnv ? (chestEnv.min[1] + chestEnv.max[1]) * 0.5 - chestP[1] : 1.0
    anchors["chest_center"] = { boneJp: chestBone, localPos: v3r([0, midY, frontZ]), localNormal: [0, 0, -1] }
    anchors["heart"]        = { boneJp: chestBone, localPos: v3r([halfW * 0.35, midY + 0.15, frontZ]), localNormal: [0, 0, -1] }
    anchors["chest_l"]      = { boneJp: chestBone, localPos: v3r([halfW * 0.55, midY, frontZ]), localNormal: v3r(vNorm([0.3, 0, -0.95])) }
    anchors["chest_r"]      = { boneJp: chestBone, localPos: v3r([-halfW * 0.55, midY, frontZ]), localNormal: v3r(vNorm([-0.3, 0, -0.95])) }
    // Expressive air targets relative to upper chest (auto-scaled to arm length)
    const armReach = m.armLenUnits || 6.4
    anchors["wave_l"]       = { boneJp: chestBone, localPos: v3r([halfW + armReach * 0.42, midY + armReach * 0.42, -armReach * 0.28]), localNormal: [0, 0, -1] }
    anchors["wave_r"]       = { boneJp: chestBone, localPos: v3r([-(halfW + armReach * 0.42), midY + armReach * 0.42, -armReach * 0.28]), localNormal: [0, 0, -1] }
    anchors["front_present_l"] = { boneJp: chestBone, localPos: v3r([halfW * 1.05, midY - 0.2, -armReach * 0.55]), localNormal: [0, 0.3, -0.95] }
    anchors["front_present_r"] = { boneJp: chestBone, localPos: v3r([-halfW * 1.05, midY - 0.2, -armReach * 0.55]), localNormal: [0, 0.3, -0.95] }
    anchors["cheer_l"]      = { boneJp: chestBone, localPos: v3r([halfW + armReach * 0.36, midY + armReach * 0.46, -armReach * 0.22]), localNormal: [0, 0.3, -0.95] }
    anchors["cheer_r"]      = { boneJp: chestBone, localPos: v3r([-(halfW + armReach * 0.36), midY + armReach * 0.46, -armReach * 0.22]), localNormal: [0, 0.3, -0.95] }
  }

  const upperP = getPos("上半身")
  const upperEnv = coreEnv["上半身"] ?? env["上半身"]
  if (upperP) {
    const waistHalfW = upperEnv ? Math.max(Math.abs(upperEnv.min[0]), Math.abs(upperEnv.max[0])) : 1.25
    anchors["waist_side_l"] = snapOnBone("waist_side_l", "上半身", upperP, { boneJp: "上半身", localPos: v3r([waistHalfW + 0.12, 0.25, -0.15]), localNormal: [1, 0, -0.15] })
    anchors["waist_side_r"] = snapOnBone("waist_side_r", "上半身", upperP, { boneJp: "上半身", localPos: v3r([-(waistHalfW + 0.12), 0.25, -0.15]), localNormal: [-1, 0, -0.15] })
  }

  const hipP = getPos("下半身")
  if (hipP) {
    const hipW = m.hipHalfWidth ?? 1.8
    anchors["hip_side_l"] = { boneJp: "下半身", localPos: v3r([hipW - 0.05, -0.25, -0.12]), localNormal: [1, 0, 0] }
    anchors["hip_side_r"] = { boneJp: "下半身", localPos: v3r([-(hipW - 0.05), -0.25, -0.12]), localNormal: [-1, 0, 0] }
    anchors["waist_front"]= { boneJp: "下半身", localPos: v3r([0, 0.2, -1.6]), localNormal: [0, 0, -1] }
    anchors["rest_hand_l"]= { boneJp: "下半身", localPos: v3r([hipW + 0.45, -2.0, -0.25]), localNormal: [1, 0, 0] }
    anchors["rest_hand_r"]= { boneJp: "下半身", localPos: v3r([-(hipW + 0.45), -2.0, -0.25]), localNormal: [-1, 0, 0] }
  }

  // 7. Mass proxy for CoM balance reasoning
  const massProxy: MassNode[] = [
    { boneJp: "頭", localOffset: [0, 1.0, 0], massRatio: 0.08 },
    { boneJp: chestBone, localOffset: [0, 1.0, -0.3], massRatio: 0.28 },
    { boneJp: "上半身", localOffset: [0, 0.8, -0.2], massRatio: 0.14 },
    { boneJp: "下半身", localOffset: [0, -0.5, 0], massRatio: 0.14 },
    { boneJp: "左腕", localOffset: [1.2, -0.8, 0], massRatio: 0.045 },
    { boneJp: "右腕", localOffset: [-1.2, -0.8, 0], massRatio: 0.045 },
    { boneJp: "左足", localOffset: [0, -2.5, 0], massRatio: 0.135 },
    { boneJp: "右足", localOffset: [0, -2.5, 0], massRatio: 0.135 },
  ].filter((n) => has(n.boneJp))

  // 8. Normalized morph map
  const morphMap = buildMorphMap(bones.faceMorphs)

  return {
    version: "1.0",
    modelId,
    modelName: bones.modelName || modelId,
    measurements: m,
    neutralPose,
    spineChain,
    arms,
    legs,
    capsules,
    anchors,
    massProxy,
    morphMap,
    handGrips: DEFAULT_HAND_GRIPS,
    jointRom: {
      forearmTwistMaxDeg: 85,
      wristSwingMaxDeg: 58,
      shoulderLiftMaxDeg: 20,
      kneeFlexMaxDeg: 142,
    },
    calibrationNotes: notes,
  }
}
