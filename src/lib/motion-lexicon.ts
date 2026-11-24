/**
 * motion-lexicon.ts — Phase 1 动作原语库（种子版）
 *
 * 设计契约（对应路线图 §1.1）：
 *  - 每个原语 = 参数化 MPL 片段（@pose 块 + 一个 @animation 块）
 *  - build() 输出的所有角度必须量化到 5° 且在极限表内（编译器会二次校验）
 *  - 最后一帧姿势 = 自然接续姿势（exitPose），供拼接时接缝插值
 *  - 时长 duration 与 @animation 内最大时间戳一致
 *
 * 注意（路线图风险①）：这些是手工精选的种子原语，先人工验证观感再扩库。
 */

export interface ParamSpec {
  min: number
  max: number
  default: number
}

export interface MotionPrimitive {
  name: string
  tags: string[]
  description: string
  params: Record<string, ParamSpec>
  /** 返回 MPL 片段：若干 @pose 块 + 一个 @animation 块 */
  build: (params: Record<string, number>) => string
}

const q5 = (v: number) => Math.max(0, Math.round(v / 5) * 5)
const f2 = (t: number) => Number(t.toFixed(2))

/** 波浪手：shoulder/arm/elbow 抬臂，wrist 左右摆 cycles 次（face>0 时全程带微笑表情） */
function waveHand(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const amp = p.amplitude ?? 1
  const face = Math.min(1, Math.max(0, p.face ?? 0.8))
  const smile = face > 0 ? `    face にこり ${face};\n` : ""
  const elbow = q5(90 * amp)
  const wristSwing = q5(30 * amp)
  const poses = `@pose wave_ready {
${smile}    shoulder_r bend backward ${q5(30 * amp)}, sway left ${q5(20 * amp)};
    arm_r bend backward ${q5(60 * amp)};
    elbow_r bend forward ${elbow};
    wrist_r sway left ${q5(20 * amp)};
}

@pose wave_l {
${smile}    upper_body2 sway left 3;
    shoulder_r bend backward ${q5(30 * amp)}, sway left ${q5(20 * amp)};
    arm_r bend backward ${q5(60 * amp)};
    elbow_r bend forward ${elbow};
    wrist_r sway left ${wristSwing};
}

@pose wave_r {
${smile}    upper_body2 sway right 3;
    shoulder_r bend backward ${q5(30 * amp)}, sway left ${q5(20 * amp)};
    arm_r bend backward ${q5(60 * amp)};
    elbow_r bend forward ${elbow};
    wrist_r sway right ${q5(wristSwing * 0.4)};
}
`
  let t = 0
  const frames = [`    ${f2(t)}: wave_ready;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: wave_l;`)
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: wave_r;`)
  }
  t = f2(t + 0.2); frames.push(`    ${f2(t)}: wave_ready;`)
  return `${poses}@animation wave_hand_anim {\n${frames.join("\n")}\n}\n`
}

/** 点头 */
function nodYes(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const amp = p.amplitude ?? 1
  const down = q5(20 * amp), neckDown = q5(10 * amp)
  const up = q5(10 * amp), neckUp = q5(5 * amp)
  const poses = `@pose nod_up {
    head bend backward ${up};
    neck bend backward ${neckUp};
}

@pose nod_down {
    head bend forward ${down};
    neck bend forward ${neckDown};
}
`
  let t = 0
  const frames = [`    0: nod_up;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: nod_down;`)
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: nod_up;`)
  }
  return `${poses}@animation nod_anim {\n${frames.join("\n")}\n}\n`
}

/** 摇头 */
function shakeHead(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const amp = p.amplitude ?? 1
  const poses = `@pose look_center {
    head reset;
    neck reset;
}

@pose look_l {
    head turn left ${q5(25 * amp)};
    neck turn left ${q5(10 * amp)};
}

@pose look_r {
    head turn right ${q5(25 * amp)};
    neck turn right ${q5(10 * amp)};
}
`
  let t = 0
  const frames = [`    0: look_center;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: look_l;`)
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: look_r;`)
  }
  t = f2(t + 0.2); frames.push(`    ${f2(t)}: look_center;`)
  return `${poses}@animation shake_anim {\n${frames.join("\n")}\n}\n`
}

/** 鞠躬，depth 30~90（站起时同步复位颈部与头部） */
function bow(p: Record<string, number>): string {
  const depth = q5(Math.min(90, Math.max(30, p.depth ?? 45)))
  const poses = `@pose upright {
    waist reset;
    upper_body reset;
    neck reset;
    head reset;
}

@pose bow_deep {
    face なごみ 0.6;
    waist bend forward ${depth};
    upper_body bend forward ${q5(depth * 0.6)};
    neck bend forward ${q5(depth * 0.3)};
    head bend forward ${q5(depth * 0.3)};
}
`
  return `${poses}@animation bow_anim {
    0: upright;
    0.8: bow_deep;
    1.6: upright;
}
`
}

/** 坐下（结尾保持坐姿） */
function sit(p: Record<string, number>): string {
  const deep = (p.deep ?? 0) >= 0.5
  const knee = deep ? 135 : 90
  const poses = `@pose stand_neutral {
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
}

@pose sitting {
    leg_l bend forward 80;
    leg_r bend forward 80;
    knee_l bend backward ${knee};
    knee_r bend backward ${knee};
    upper_body bend forward ${deep ? 15 : 5};
}
`
  return `${poses}@animation sit_anim {
    0: stand_neutral;
    1: sitting;
}
`
}

/** 起身 */
function standUp(): string {
  const poses = `@pose sitting_start {
    leg_l bend forward 80;
    leg_r bend forward 80;
    knee_l bend backward 90;
    knee_r bend backward 90;
}

@pose risen {
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
}
`
  return `${poses}@animation rise_anim {
    0: sitting_start;
    0.9: risen;
}
`
}

/** 双臂上举伸展 */
function armsUp(p: Record<string, number>): string {
  const amp = p.amplitude ?? 1
  const poses = `@pose arms_down {
    shoulder_l reset;
    shoulder_r reset;
    arm_l reset;
    arm_r reset;
}

@pose arms_raised {
    shoulder_l bend backward ${q5(60 * amp)};
    shoulder_r bend backward ${q5(60 * amp)};
    arm_l bend backward ${q5(90 * amp)};
    arm_r bend backward ${q5(90 * amp)};
}
`
  const hold = p.hold != null ? Math.max(0, p.hold) : 0.5
  return `${poses}@animation arms_up_anim {
    0: arms_down;
    0.5: arms_raised;
    ${f2(0.5 + hold)}: arms_raised;
}
`
}

/** 开合跳 */
function jumpingJack(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const poses = `@pose jack_idle {
    center reset;
    shoulder_l reset;
    shoulder_r reset;
    arm_l reset;
    arm_r reset;
    leg_l reset;
    leg_r reset;
}

@pose jack_out {
    shoulder_l bend backward 80, sway right 30;
    shoulder_r bend backward 80, sway left 30;
    arm_l bend backward 90;
    arm_r bend backward 90;
    leg_l sway right 25;
    leg_r sway left 25;
}
`
  let t = 0
  const frames = [`    0: jack_idle;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.4); frames.push(`    ${f2(t)}: jack_out;`)
    t = f2(t + 0.4); frames.push(`    ${f2(t)}: jack_idle;`)
  }
  return `${poses}@animation jack_anim {\n${frames.join("\n")}\n}\n`
}

/** 歪头，dir=0 左 / 1 右 */
function tiltHead(p: Record<string, number>): string {
  const dir = p.dir != null && p.dir >= 0.5 ? "right" : "left"
  const amp = p.amplitude ?? 1
  const poses = `@pose head_center {
    head reset;
    neck reset;
}

@pose head_tilt {
    head sway ${dir} ${q5(30 * amp)};
    neck sway ${dir} ${q5(15 * amp)};
}
`
  return `${poses}@animation tilt_anim {
    0: head_center;
    0.5: head_tilt;
}
`
}

/** 环顾四周 */
function lookAround(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 1))
  const amp = p.amplitude ?? 1
  const poses = `@pose gaze_center {
    head reset;
    neck reset;
}

@pose gaze_l {
    head turn left ${q5(45 * amp)};
    neck turn left ${q5(15 * amp)};
}

@pose gaze_r {
    head turn right ${q5(45 * amp)};
    neck turn right ${q5(15 * amp)};
}
`
  let t = 0
  const frames = [`    0: gaze_center;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: gaze_r;`)
    t = f2(t + 0.3); frames.push(`    ${f2(t)}: gaze_l;`)
  }
  t = f2(t + 0.3); frames.push(`    ${f2(t)}: gaze_center;`)
  return `${poses}@animation gaze_anim {\n${frames.join("\n")}\n}\n`
}

/** 出拳 */
function punch(): string {
  const poses = `@pose punch_ready {
    upper_body turn right 15;
    shoulder_l bend forward 30;
    arm_l bend forward 45;
    elbow_l bend forward 90;
    shoulder_r bend forward 20;
    arm_r bend forward 30;
    elbow_r bend forward 100;
}

@pose punch_hit {
    upper_body turn left 20;
    shoulder_l bend forward 60;
    arm_l bend forward 80;
    elbow_l bend forward 15;
    wrist_l bend forward 10;
}

@pose punch_retract {
    upper_body turn right 10;
    shoulder_l bend forward 35;
    arm_l bend forward 50;
    elbow_l bend forward 80;
}
`
  return `${poses}@animation punch_anim {
    0: punch_ready;
    0.25: punch_hit;
    0.55: punch_retract;
    0.9: punch_ready;
}
`
}

/** 站立待机（呼吸感微动） */
function idleStand(p: Record<string, number>): string {
  const hold = p.hold != null ? Math.max(0.5, p.hold) : 2
  const poses = `@pose idle_pose {
    center bend forward 5;
    neck bend forward 5;
    upper_body sway right 5;
}
`
  return `${poses}@animation idle_anim {
    0: idle_pose;
    ${f2(hold)}: idle_pose;
}
`
}

/** 呼吸循环待机（整周期正弦 → 循环无缝） */
function idleBreathe(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const amp = p.amplitude ?? 1
  const swell = q5(5 * amp)
  const swellNeck = q5(2 * amp)
  const poses = `@pose breathe_in {
    upper_body bend forward ${swell};
    neck bend forward ${swellNeck};
}

@pose breathe_out {
    upper_body bend backward ${swell};
    neck bend backward ${swellNeck};
}
`
  let t = 0
  const frames = [`    0: breathe_out;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.5)
    frames.push(`    ${f2(t)}: breathe_in;`)
    t = f2(t + 0.5)
    frames.push(`    ${f2(t)}: breathe_out;`)
  }
  return `${poses}@animation breathe_anim {\n${frames.join("\n")}\n}\n`
}

/** 双手叉腰（Topaz 语义锚点 + 胸椎微挺 + 看向镜头；较长停留时注入轻微重心微摆防僵直） */
function akimbo(p: Record<string, number>): string {
  const hold = Math.max(0.5, p.hold ?? 1.5)
  if (hold <= 2.2) {
    return `@pose akimbo_start {
    waist reset;
    upper_body2 reset;
}

@pose akimbo_pose {
    waist sway left 5;
    upper_body2 bend backward 5;
    reach hand_l to hip_l;
    reach hand_r to hip_r;
    aim head at camera;
    face ｷﾘｯ 0.6;
}

@animation akimbo_anim {
    0: akimbo_start;
    0.5: akimbo_pose;
    ${f2(0.5 + hold)}: akimbo_pose;
}
`
  }
  const mid1 = f2(0.5 + hold * 0.45)
  const endT = f2(0.5 + hold)
  return `@pose akimbo_start {
    waist reset;
    upper_body2 reset;
}

@pose akimbo_pose {
    waist sway left 5, turn right 4;
    upper_body2 bend backward 5;
    head sway right 4;
    reach hand_l to hip_l;
    reach hand_r to hip_r;
    aim head at camera;
    face ｷﾘｯ 0.55;
    face にこり 0.35;
}

@pose akimbo_shift {
    waist sway right 4, turn left 4;
    upper_body2 bend backward 6;
    head sway left 4;
    reach hand_l to hip_l;
    reach hand_r to hip_r;
    aim head at camera;
    face ｷﾘｯ 0.55;
    face にこり 0.4;
}

@animation akimbo_anim {
    0: akimbo_start;
    0.5: akimbo_pose;
    ${mid1}: akimbo_shift;
    ${endT}: akimbo_pose;
}
`
}

/** 单手敬礼 */
function salute(p: Record<string, number>): string {
  const hold = Math.max(0.5, p.hold ?? 1.5)
  return `@pose salute_ready {
    upper_body2 reset;
    head reset;
}

@pose salute_hold {
    upper_body2 bend backward 5;
    reach hand_r to salute_r;
    wrist_twist_r turn left 30;
    aim head at camera;
    face にこり 0.7;
    face ウィンク 0.8;
}

@animation salute_anim {
    0: salute_ready;
    0.5: salute_hold;
    ${f2(0.5 + hold)}: salute_hold;
}
`
}

/** 单手托腮思考 */
function thinkChin(p: Record<string, number>): string {
  const hold = Math.max(0.5, p.hold ?? 1.8)
  return `@pose think_ready {
    upper_body2 reset;
    head reset;
}

@pose think_pose {
    upper_body2 turn right 10, bend forward 5;
    head sway left 15, bend forward 5;
    reach hand_r to chin;
    face 困る 0.35;
}

@animation think_anim {
    0: think_ready;
    0.6: think_pose;
    ${f2(0.6 + hold)}: think_pose;
}
`
}

/** 害羞双手捧脸（照れ表情） */
function shyCheek(p: Record<string, number>): string {
  const hold = Math.max(0.5, p.hold ?? 1.6)
  return `@pose shy_ready {
    upper_body2 reset;
    head reset;
}

@pose shy_pose {
    upper_body2 bend forward 10;
    head bend forward 10, sway left 10;
    reach hand_l to cheek_l;
    reach hand_r to cheek_r;
    face 照れ 0.9;
    face なごみ 0.6;
}

@animation shy_anim {
    0: shy_ready;
    0.6: shy_pose;
    ${f2(0.6 + hold)}: shy_pose;
}
`
}

/** 单手抚胸致意 */
function heartChest(p: Record<string, number>): string {
  const hold = Math.max(0.5, p.hold ?? 1.5)
  return `@pose chest_ready {
    upper_body2 reset;
    head reset;
}

@pose chest_pose {
    upper_body2 bend forward 10;
    reach hand_r to heart;
    aim head at camera;
    face なごみ 0.7;
    face にこり 0.5;
}

@animation chest_anim {
    0: chest_ready;
    0.6: chest_pose;
    ${f2(0.6 + hold)}: chest_pose;
}
`
}

/** 举双手欢呼 */
function cheer(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const poses = `@pose cheer_ready {
    upper_body2 reset;
    groove reset;
}

@pose cheer_high {
    upper_body2 bend backward 10;
    groove move up 0.4;
    reach hand_l to up_l;
    reach hand_r to up_r;
    aim head at up;
    face 笑い 0.9;
    face ワ 0.5;
}

@pose cheer_mid {
    upper_body2 bend forward 5;
    groove move down 0.2;
    reach hand_l to wave_l;
    reach hand_r to wave_r;
    aim head at camera;
    face 笑い 0.8;
}
`
  let t = 0
  const frames = [`    0: cheer_ready;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.4); frames.push(`    ${f2(t)}: cheer_high;`)
    t = f2(t + 0.35); frames.push(`    ${f2(t)}: cheer_mid;`)
  }
  t = f2(t + 0.35); frames.push(`    ${f2(t)}: cheer_high;`)
  return `${poses}@animation cheer_anim {\n${frames.join("\n")}\n}\n`
}

/** 剧情对话比划：微倾前伸手解释 + 换手势 + 轻点头微笑（可循环长段） */
function talkExplain(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const face = Math.min(1, Math.max(0, p.face ?? 0.65))
  const smile = face > 0 ? `    face にこり ${face};\n` : ""
  const poses = `@pose talk_ready {
    upper_body2 reset;
    head reset;
}

@pose talk_beat_a {
${smile}    waist turn left 5, sway right 4;
    upper_body2 bend forward 6, turn right 6;
    head sway left 6, bend forward 5;
    reach hand_r to front_r + [-0.4, -0.4, 1.2];
    hand_r open;
    wrist_twist_r turn left 20;
    reach hand_l to hip_l;
    hand_l relax;
    aim head at camera;
}

@pose talk_beat_b {
${smile}    waist turn right 5, sway left 4;
    upper_body2 bend forward 4, turn left 5;
    head sway right 5;
    reach hand_r to heart;
    hand_r relax;
    reach hand_l to front_l + [0.4, -0.3, 1.2];
    hand_l open;
    wrist_twist_l turn right 20;
    aim head at camera;
}
`
  let t = 0
  const frames = [`    0: talk_ready;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.7); frames.push(`    ${f2(t)}: talk_beat_a;`)
    t = f2(t + 0.85); frames.push(`    ${f2(t)}: talk_beat_b;`)
  }
  t = f2(t + 0.6); frames.push(`    ${f2(t)}: talk_beat_a;`)
  return `${poses}@animation talk_anim {\n${frames.join("\n")}\n}\n`
}

/** 剧情走近几步：交替迈步向前移动并稳稳停住看镜头 */
function stepCloser(p: Record<string, number>): string {
  const steps = Math.max(1, Math.min(3, Math.round(p.steps ?? 2)))
  let z = 0
  const poseBlocks: string[] = [
    `@pose step_ready {
    center reset;
    waist reset;
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
}`,
  ]
  const frames: string[] = [`    0: step_ready;`]
  let t = 0
  for (let k = 0; k < steps; k++) {
    const isLeft = k % 2 === 0
    const lead = isLeft ? "l" : "r"
    const trail = isLeft ? "r" : "l"
    const swayDir = isLeft ? "left" : "right"
    z = f2(z + 1.4)
    poseBlocks.push(`@pose step_${k} {
    center move forward ${z};
    waist sway ${swayDir} 4, turn ${isLeft ? "right" : "left"} 5;
    leg_${lead} bend forward 20;
    knee_${lead} bend backward 15;
    leg_${trail} bend backward 10;
    knee_${trail} bend backward 20;
    plant feet;
    arm_${lead} bend forward 12;
    arm_${trail} bend backward 10;
    elbow_${trail} bend forward 15;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.6;
}`)
    t = f2(t + 0.55)
    frames.push(`    ${f2(t)}: step_${k};`)
  }
  z = f2(z + 0.6)
  poseBlocks.push(`@pose step_arrive {
    center move forward ${z};
    waist sway left 3;
    upper_body2 bend forward 5;
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
    plant feet;
    arm_l reset;
    arm_r reset;
    elbow_l reset;
    elbow_r reset;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.7;
}`)
  t = f2(t + 0.6)
  frames.push(`    ${f2(t)}: step_arrive;`)
  return `${poseBlocks.join("\n\n")}\n\n@animation step_anim {\n${frames.join("\n")}\n}\n`
}

/** 剧情自然换重心倾听/待机 */
function weightShift(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 1))
  const hold = Math.max(0.4, Math.min(3, p.hold ?? 0.8))
  const poses = `@pose shift_l {
    waist sway left 5, turn right 5;
    upper_body2 sway right 4;
    head sway left 8, bend forward 3;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face なごみ 0.6;
}

@pose shift_r {
    waist sway right 5, turn left 5;
    upper_body2 sway left 4;
    head sway right 8;
    hand_l relax;
    hand_r relax;
    aim head at camera;
    face にこり 0.55;
}
`
  let t = 0
  const frames = [`    0: shift_l;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + hold); frames.push(`    ${f2(t)}: shift_r;`)
    t = f2(t + hold); frames.push(`    ${f2(t)}: shift_l;`)
  }
  return `${poses}@animation shift_anim {\n${frames.join("\n")}\n}\n`
}

/** 告别温柔挥手：举起右手向镜头挥手致意 */
function goodbyeWave(p: Record<string, number>): string {
  const cycles = Math.max(1, Math.round(p.cycles ?? 2))
  const poses = `@pose bye_ready {
    upper_body2 reset;
    head reset;
}

@pose bye_a {
    waist sway left 4;
    upper_body2 bend backward 4;
    head sway left 8;
    reach hand_r to wave_r;
    hand_r open;
    wrist_r sway left 18;
    reach hand_l to hip_l;
    hand_l relax;
    aim head at camera;
    face 笑い 0.8;
    face にこり 0.5;
}

@pose bye_b {
    waist sway left 4;
    upper_body2 bend backward 4;
    head sway left 8;
    reach hand_r to wave_r;
    hand_r open;
    wrist_r sway right 15;
    reach hand_l to hip_l;
    hand_l relax;
    aim head at camera;
    face 笑い 0.8;
    face にこり 0.5;
}
`
  let t = 0
  const frames = [`    0: bye_ready;`]
  for (let k = 0; k < cycles; k++) {
    t = f2(t + 0.45); frames.push(`    ${f2(t)}: bye_a;`)
    t = f2(t + 0.4); frames.push(`    ${f2(t)}: bye_b;`)
  }
  t = f2(t + 0.4); frames.push(`    ${f2(t)}: bye_a;`)
  return `${poses}@animation bye_anim {\n${frames.join("\n")}\n}\n`
}

/**
 * 灵动深蹲（姿势照搬 examples/squat-lively.mpl）：预备后仰 → 髋铰链下蹲 → 触底弹跳 → 站起过冲回落。
 * depth 深度倍率（0.5 半蹲 ~ 1.1 全蹲）；cycles 次数（偶数拍双弹跳，最后一拍底部保持 hold 并眨眼）；
 * tempo 节奏倍率（越大越快）；hold 最后一拍底部保持秒数；arm_swing 摆臂幅度（< 0.5 手臂自然垂放、不前伸）。
 * 所有角度 5° 量化；踝角 = 膝角 − 髋角，脚掌保持水平；末帧回到 sq_top 接续姿势；时长 = 最大时间戳。
 * 每个下蹲姿势都带 plant feet（关键帧贴地；帧间由 final 管线的贴地烘焙补齐）。
 */
function squat(p: Record<string, number>): string {
  const d = p.depth ?? 1
  const cycles = Math.max(1, Math.round(p.cycles ?? 3))
  const tempo = p.tempo ?? 1
  const hold = p.hold ?? 0.6
  const a = p.arm_swing ?? 1
  const face = p.face ?? 0.6
  const reach = a >= 0.5
  const deg = (base: number) => q5(base * d)
  const f = (v: number) => f2(Math.min(1, Math.max(0, v * face)))
  const extra = (dir: "left" | "right", v: number) => (v > 0 ? `, sway ${dir} ${v}` : "")

  const legsStand =
    "    leg_l sway left 5;\n    leg_r sway right 5;\n    knee_l reset;\n    knee_r reset;\n    ankle_l reset;\n    ankle_r reset;\n"
  const legsBent = (hip: number, knee: number, out: number) =>
    `    leg_l bend forward ${hip}${extra("left", out)};\n` +
    `    leg_r bend forward ${hip}${extra("right", out)};\n` +
    `    knee_l bend backward ${knee};\n    knee_r bend backward ${knee};\n` +
    `    ankle_l bend backward ${knee - hip};\n    ankle_r bend backward ${knee - hip};\n`
  const armsHang =
    "    arm_l bend forward 10;\n    arm_r bend forward 10;\n    elbow_l bend forward 5;\n    elbow_r bend forward 5;\n"
  const armsSwing = (fwd: number, out: number, elbow: number, dir: "out" | "in") =>
    reach
      ? `    arm_l bend forward ${q5(fwd * a)}${extra(dir === "out" ? "left" : "right", q5(out * a))};\n` +
        `    arm_r bend forward ${q5(fwd * a)}${extra(dir === "out" ? "right" : "left", q5(out * a))};\n` +
        `    elbow_l bend forward ${q5(elbow * a)};\n    elbow_r bend forward ${q5(elbow * a)};\n`
      : armsHang
  const squatArms = reach
    ? "    reach hand_l to front_l;\n    reach hand_r to front_r;\n"
    : armsHang
  const hands = "    hand_l relax;\n    hand_r relax;\n    aim head at camera;\n"
  const faceLines = (nikori: number, warai: number, wink = 0) =>
    `    face にこり ${f(nikori)};\n    face 笑い ${f(warai)};\n    face ウィンク ${wink};\n`

  const hipH = deg(30)
  const kneeH = deg(50)
  const hipC = deg(76)
  const kneeC = deg(104)
  const hipB = deg(90)
  const kneeB = deg(120)

  const bentBody = (
    down: number,
    back: number,
    waist: number,
    upper: number,
    upper2: number,
    swayL: number,
    swayR: number
  ) =>
    `    center move down ${f2(down * d)};\n    center move backward ${f2(back * d)};\n    plant feet;\n` +
    `    waist bend forward ${deg(waist)};\n    upper_body bend forward ${deg(upper)};\n` +
    `    upper_body2 bend backward ${deg(upper2)}${extra("left", deg(swayL))};\n` +
    `    neck reset;\n    head sway right ${deg(swayR)};\n`

  const poses = `@pose sq_top {
    center reset;
    upper_body reset;
    upper_body2 reset;
    neck reset;
    head reset;
    waist reset;
${legsStand}${armsSwing(38, 0, 12, "out")}    wrist_l reset;
    wrist_r reset;
${hands}${faceLines(0.6, 0)}}

@pose sq_antic {
    center reset;
    upper_body bend backward 5;
    upper_body2 bend backward 5;
    neck bend backward 5;
    head bend backward 5;
    waist reset;
${legsStand}${armsSwing(24, 22, 14, "out")}    wrist_l reset;
    wrist_r reset;
${hands}${faceLines(0.8, 0)}}

@pose sq_hinge {
${bentBody(1, 0.8, 15, 5, 5, 0, 3)}${legsBent(hipH, kneeH, 5)}${squatArms}${hands}${faceLines(0.6, 0)}}

@pose sq_bottom {
${bentBody(4, 2.7, 25, 10, 8, 3, 6)}${legsBent(hipB, kneeB, deg(17))}${squatArms}${hands}${faceLines(0.5, 0.4)}}

@pose sq_bottom_wink {
${bentBody(4, 2.7, 25, 10, 8, 3, 10)}${legsBent(hipB, kneeB, deg(17))}${squatArms}${hands}${faceLines(0.7, 0.6, 1)}}

@pose sq_bounce {
${bentBody(3.3, 2.2, 21, 8, 7, 2, 5)}${legsBent(hipC, kneeC, deg(14))}${squatArms}${hands}${faceLines(0.6, 0.4)}}

@pose sq_over {
    center reset;
    upper_body bend backward 5;
    upper_body2 bend backward 5;
    neck bend backward 5;
    head bend backward 5, sway left 5;
    waist reset;
${legsStand}${armsSwing(16, 24, 10, "in")}    wrist_l reset;
    wrist_r reset;
${hands}${faceLines(0.8, 0.5)}}
`
  const dt = (x: number) => f2(x / tempo)
  let t = 0
  const frames = [`    0: sq_top;`]
  const at = (delta: number, pose: string) => {
    t = f2(t + dt(delta))
    frames.push(`    ${t}: ${pose};`)
  }
  for (let k = 1; k <= cycles; k++) {
    const last = k === cycles
    at(k === 1 ? 0.5 : 0.3, "sq_antic")
    at(0.2, "sq_hinge")
    at(0.5, "sq_bottom")
    const bounces = k % 2 === 0 ? 2 : 1
    for (let b = 0; b < bounces; b++) {
      at(0.15, "sq_bounce")
      const toWink = last && b === bounces - 1 && hold > 0
      at(toWink ? hold : 0.25, toWink ? "sq_bottom_wink" : "sq_bottom")
    }
    at(0.75, "sq_top")
    at(0.2, "sq_over")
    at(0.35, "sq_top")
  }
  return `${poses}@animation squat_anim {\n${frames.join("\n")}\n}\n`
}

export const LEXICON: MotionPrimitive[] = [
  { name: "wave_hand", tags: ["greeting", "loopable", "arm"], description: "Raise right hand and wave (smiles if face > 0)", params: { cycles: { min: 1, max: 6, default: 2 }, amplitude: { min: 0.5, max: 1.5, default: 1 }, face: { min: 0, max: 0.85, default: 0.8 } }, build: waveHand },
  { name: "nod_yes", tags: ["gesture", "loopable", "head"], description: "Nod head up and down", params: { cycles: { min: 1, max: 5, default: 2 }, amplitude: { min: 0.5, max: 1.5, default: 1 } }, build: nodYes },
  { name: "shake_head", tags: ["gesture", "loopable", "head"], description: "Shake head left and right (no)", params: { cycles: { min: 1, max: 5, default: 2 }, amplitude: { min: 0.5, max: 1.5, default: 1 } }, build: shakeHead },
  { name: "bow", tags: ["greeting", "formal", "body"], description: "Polite bow forward and return", params: { depth: { min: 30, max: 90, default: 45 } }, build: bow },
  { name: "sit", tags: ["pose_change", "body"], description: "Sit down and stay seated", params: { deep: { min: 0, max: 1, default: 0 } }, build: sit },
  { name: "stand_up", tags: ["pose_change", "body"], description: "Stand up from sitting", params: {}, build: standUp },
  { name: "arms_up", tags: ["stretch", "arm"], description: "Raise both arms overhead and hold", params: { amplitude: { min: 0.5, max: 1.2, default: 1 }, hold: { min: 0, max: 3, default: 0.5 } }, build: armsUp },
  { name: "jumping_jack", tags: ["exercise", "loopable", "fullbody"], description: "Jumping jacks", params: { cycles: { min: 1, max: 8, default: 2 } }, build: jumpingJack },
  { name: "tilt_head", tags: ["gesture", "head"], description: "Tilt head to one side", params: { dir: { min: 0, max: 1, default: 0 }, amplitude: { min: 0.5, max: 1.5, default: 1 } }, build: tiltHead },
  { name: "look_around", tags: ["gesture", "loopable", "head"], description: "Look left and right curiously", params: { cycles: { min: 1, max: 4, default: 1 }, amplitude: { min: 0.5, max: 1.2, default: 1 } }, build: lookAround },
  { name: "punch", tags: ["action", "arm"], description: "Throw a quick punch and return to guard", params: {}, build: punch },
  { name: "idle_stand", tags: ["idle", "loopable"], description: "Neutral standing with subtle sway", params: { hold: { min: 0.5, max: 6, default: 2 } }, build: idleStand },
  { name: "idle_breathe", tags: ["idle", "loopable", "breathing"], description: "Seamless breathing loop with subtle body/neck motion", params: { cycles: { min: 1, max: 6, default: 2 }, amplitude: { min: 0.5, max: 1.5, default: 1 } }, build: idleBreathe },
  { name: "akimbo", tags: ["pose_change", "confident", "arm"], description: "Confident hands-on-hips akimbo pose looking at camera", params: { hold: { min: 0.5, max: 5, default: 1.5 } }, build: akimbo },
  { name: "salute", tags: ["greeting", "pose_change", "arm"], description: "Playful right-hand salute with wink and smile", params: { hold: { min: 0.5, max: 5, default: 1.5 } }, build: salute },
  { name: "think_chin", tags: ["gesture", "pose_change", "arm"], description: "Hand resting on chin in thoughtful pose", params: { hold: { min: 0.5, max: 5, default: 1.8 } }, build: thinkChin },
  { name: "shy_cheek", tags: ["emotion", "pose_change", "arm"], description: "Shy blush with both hands touching cheeks", params: { hold: { min: 0.5, max: 5, default: 1.6 } }, build: shyCheek },
  { name: "heart_chest", tags: ["emotion", "greeting", "arm"], description: "Gentle hand over heart/chest with warm smile", params: { hold: { min: 0.5, max: 5, default: 1.5 } }, build: heartChest },
  { name: "cheer", tags: ["emotion", "loopable", "fullbody"], description: "Cheerful jumping celebration raising both arms", params: { cycles: { min: 1, max: 5, default: 2 } }, build: cheer },
  { name: "talk_explain", tags: ["acting", "dialogue", "loopable", "arm"], description: "Natural conversational hand gesturing and nodding while smiling at camera", params: { cycles: { min: 1, max: 5, default: 2 }, face: { min: 0, max: 1, default: 0.65 } }, build: talkExplain },
  { name: "step_closer", tags: ["acting", "walk", "fullbody"], description: "Walk a few graceful steps forward closer to the camera and stop", params: { steps: { min: 1, max: 3, default: 2 } }, build: stepCloser },
  { name: "weight_shift", tags: ["acting", "idle", "loopable"], description: "Gentle weight shift side to side listening attentively", params: { cycles: { min: 1, max: 4, default: 1 }, hold: { min: 0.4, max: 3, default: 0.8 } }, build: weightShift },
  { name: "goodbye_wave", tags: ["acting", "greeting", "loopable", "arm"], description: "Warm farewell wave smiling gently at the camera", params: { cycles: { min: 1, max: 4, default: 2 } }, build: goodbyeWave },
  { name: "squat", tags: ["exercise", "fullbody", "loopable"], description: "Lively squat reps with feet planted: anticipation, hip hinge, bottom bounce, overshoot settle (depth 0.5 half ~ 1.1 full; even reps double-bounce; last rep holds and winks)", params: { depth: { min: 0.5, max: 1.1, default: 1 }, cycles: { min: 1, max: 6, default: 3 }, tempo: { min: 0.6, max: 1.6, default: 1 }, hold: { min: 0, max: 2, default: 0.6 }, arm_swing: { min: 0, max: 1.2, default: 1 }, face: { min: 0, max: 1, default: 0.6 } }, build: squat },
]

export const LEXICON_MAP: Record<string, MotionPrimitive> = Object.fromEntries(LEXICON.map((m) => [m.name, m]))

function clampParams(prim: MotionPrimitive, params?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, spec] of Object.entries(prim.params)) {
    const v = params?.[k] ?? spec.default
    out[k] = Math.min(spec.max, Math.max(spec.min, v))
  }
  return out
}

/** 计算片段时长：取 @animation 内最大时间戳（容许行首缩进） */
export function fragmentDuration(fragment: string): number {
  let max = 0
  for (const m of fragment.matchAll(/^\s*([\d.]+)\s*:/gm)) max = Math.max(max, parseFloat(m[1]))
  return f2(max)
}

/** 用词库展开一个分段（clamp 参数 → 按目标时长自适应 cycles/hold → build → 可选镜像），返回片段、时长与实际生效的参数（clamp / 自适应之后） */
export function expandLexiconSegment(
  action: string,
  params?: Record<string, number>,
  mirror = false,
  targetDuration?: number
) {
  const prim = LEXICON_MAP[action]
  if (!prim) return null
  const clamped = clampParams(prim, params)
  let fragment = prim.build(clamped)
  let dur = fragmentDuration(fragment)

  // 若调用方/Planner 指定了更长的目标时长，优先自适应增加循环次数或 hold 参数而非末尾硬拉静止帧
  if (targetDuration != null && targetDuration > dur + 0.5) {
    if (prim.params.cycles && params?.cycles == null) {
      const perCycle = Math.max(0.5, dur / Math.max(1, clamped.cycles))
      const wantCycles = Math.min(prim.params.cycles.max, Math.max(clamped.cycles, Math.round(targetDuration / perCycle)))
      if (wantCycles > clamped.cycles) {
        clamped.cycles = wantCycles
        fragment = prim.build(clamped)
        dur = fragmentDuration(fragment)
      }
    } else if (prim.params.hold && params?.hold == null) {
      const baseLead = Math.max(0.4, dur - clamped.hold)
      const wantHold = Math.min(prim.params.hold.max, Math.max(clamped.hold, f2(targetDuration - baseLead)))
      if (wantHold > clamped.hold + 0.2) {
        clamped.hold = wantHold
        fragment = prim.build(clamped)
        dur = fragmentDuration(fragment)
      }
    }
  }

  if (mirror) {
    // 姿势语句镜像，动画帧不动（引用的姿势名不变）
    fragment = mirrorPoseBlocksFragment(fragment)
  }
  return { fragment, duration: dur, name: prim.name, params: { ...clamped } }
}

// 行级左右镜像（与 mpl-macros.mirrorStatementLine 同逻辑；刻意内联以保持本文件零运行时依赖，
// 使其可被 Next 与纯 Node（type-stripping）双端加载）
function mirrorLineLocal(line: string): string {
  let out = line
  out = out.replace(/\bleft\b/g, "\u0000R\u0000").replace(/\bright\b/g, "left").replace(/\u0000R\u0000/g, "right")
  out = out.replace(/_l\b/g, "\u0000S\u0000").replace(/_r\b/g, "_l").replace(/\u0000S\u0000/g, "_r")
  return out
}

function mirrorPoseBlocksFragment(fragment: string): string {
  const lines = fragment.split("\n")
  let blockType: "pose" | "animation" | "main" | null = null
  let brace = 0
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("@pose")) { blockType = "pose"; brace = 0 }
    else if (t.startsWith("@animation")) { blockType = "animation"; brace = 0 }
    else if (t.startsWith("main")) { blockType = "main"; brace = 0 }
    brace += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
    out.push(blockType === "pose" ? mirrorLineLocal(line) : line)
    if (blockType && brace <= 0 && t.includes("}")) blockType = null
  }
  return out.join("\n")
}
