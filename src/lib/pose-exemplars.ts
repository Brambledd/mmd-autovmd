/**
 * pose-exemplars.ts — Phase 2 少量样本双语姿态库与 RAG 检索器
 *
 * 每条示例均遵循 Topaz PMX + MPL2 契约（含 upper_body2 / reach / hand_<l|r> /
 * aim / plant / face），且必须在离线基准中 100% 通过 compileMPL2 + critiquePoseVmd。
 * Stage 2 生成 custom 段时按双语关键词动态检索 Top-K 注入 Prompt，替代臃肿静态示例。
 */

export interface PoseExemplar {
  id: string
  title: string
  /** 中英双语触发词与同义表达 */
  tags: string[]
  /** 英文片段描述，格式与 PLANNER → SEGMENT_PROMPT 衔接 */
  description: string
  /** 标准 MPL2 片段（含 @pose + 单个 @animation，无 main 块） */
  mpl: string
}

export const POSE_EXEMPLARS: PoseExemplar[] = [
  {
    id: "giggle_mouth_akimbo",
    title: "Lean Forward Giggling (Hand Near Mouth + Akimbo)",
    tags: [
      "捂嘴", "偷笑", "掩嘴", "轻笑", "捂口", "前倾", "叉腰", "看镜头",
      "giggle", "laugh", "mouth", "cover mouth", "lean forward", "akimbo", "smirk", "tease",
    ],
    description: "lean forward excitedly with right hand near mouth giggling, left hand on hip, looking at camera",
    mpl: `@pose start {
    waist reset;
    upper_body2 reset;
    head reset;
}

@pose giggle_lean {
    waist bend forward 10, turn right 10;
    upper_body2 bend forward 15, sway left 5;
    knee_l bend backward 10;
    knee_r bend backward 10;
    plant feet;
    reach hand_r to mouth;
    hand_r cup;
    wrist_twist_r turn left 30;
    reach hand_l to hip_l;
    hand_l akimbo;
    aim head at camera;
    face 笑い 0.8;
    face 照れ 0.5;
    face ワ 0.4;
}

@animation seg {
    0: start;
    0.7: giggle_lean;
    2.5: giggle_lean;
}`,
  },
  {
    id: "peace_wink_lean",
    title: "Peace Sign + Head Tilt + Wink",
    tags: [
      "剪刀手", "比耶", "耶", "胜利手势", "v手势", "歪头", "眨眼", "wink", "微笑",
      "peace", "victory", "v sign", "wink", "tilt head", "cute", "idol", "camera",
    ],
    description: "make a cute peace sign near cheek with tilted head, wink and bright smile at camera",
    mpl: `@pose ready {
    waist reset;
    upper_body2 reset;
    head reset;
}

@pose peace_wink {
    waist sway left 5, turn right 10;
    upper_body2 bend forward 8, sway right 5;
    head sway left 12, bend forward 3;
    reach hand_r to peace_r;
    hand_r peace;
    wrist_twist_r turn left 20;
    reach hand_l to hip_l;
    hand_l akimbo;
    aim head at camera;
    face ウィンク 0.9;
    face にこり 0.8;
}

@animation seg {
    0: ready;
    0.7: peace_wink;
    2.5: peace_wink;
}`,
  },
  {
    id: "half_kneel_touch",
    title: "Graceful Crouch / Half-Kneel Touching Knee",
    tags: [
      "单膝", "半跪", "蹲下", "下蹲", "屈膝", "扶膝盖", "扶住膝盖", "抬头", "蹲",
      "kneel", "half kneel", "crouch", "squat", "touch knee", "look up",
    ],
    description: "crouch or kneel gracefully with right hand resting on knee and smiling up at camera",
    mpl: `@pose stand {
    center reset;
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
}

@pose crouch_pose {
    center move down 2;
    leg_l bend forward 80, sway left 5;
    knee_l bend backward 95;
    leg_r bend backward 10;
    knee_r bend backward 150;
    plant feet;
    upper_body2 bend forward 10;
    reach hand_r to knee_l;
    hand_r relax;
    reach hand_l to hip_l;
    hand_l akimbo;
    aim head at camera;
    face にこり 0.7;
}

@animation seg {
    0: stand;
    0.9: crouch_pose;
    2.7: crouch_pose;
}`,
  },
  {
    id: "shy_two_hands_cheek",
    title: "Shy Two Hands Touching Cheeks",
    tags: [
      "捧脸", "双手捧脸", "害羞", "脸红", "贴脸", "捂脸", "不好意思",
      "shy", "blush", "cheek", "cheeks", "embarrassed", "bashful",
    ],
    description: "shyly touch both cheeks blushing with tilted head",
    mpl: `@pose ready {
    upper_body2 reset;
    head reset;
}

@pose shy_blush {
    upper_body2 bend forward 10, sway right 5;
    head bend forward 10, sway left 12;
    reach hand_l to cheek_l;
    hand_l cup;
    reach hand_r to cheek_r;
    hand_r cup;
    face 照れ 0.9;
    face はぅ 0.6;
}

@animation seg {
    0: ready;
    0.7: shy_blush;
    2.5: shy_blush;
}`,
  },
  {
    id: "look_back_shoulder",
    title: "Look Back Over Shoulder Confidently",
    tags: [
      "回头", "回眸", "转身看", "转头看", "斜身", "得意", "坏笑",
      "look back", "over shoulder", "turn around", "smirk", "confident", "glance back",
    ],
    description: "look back over shoulder with confident smirk and hand on hip",
    mpl: `@pose ready {
    waist reset;
    upper_body2 reset;
    head reset;
}

@pose look_back {
    waist turn right 25, sway left 5;
    upper_body2 turn right 20, bend backward 5;
    reach hand_r to hip_r;
    hand_r akimbo;
    reach hand_l to front_l + [0.4, -1.5, 1.5];
    hand_l relax;
    aim head at camera;
    face にやり２ 0.6;
    face ｷﾘｯ 0.5;
}

@animation seg {
    0: ready;
    0.7: look_back;
    2.5: look_back;
}`,
  },
  {
    id: "salute_confident",
    title: "Playful Confident Salute",
    tags: [
      "敬礼", "致敬", "军礼", "俏皮", "眨眼",
      "salute", "playful", "aye", "wink", "confident",
    ],
    description: "give a playful confident right-hand salute while winking at camera",
    mpl: `@pose ready {
    upper_body2 reset;
    head reset;
}

@pose salute_pose {
    waist sway left 5;
    upper_body2 bend backward 5, turn right 10;
    reach hand_r to salute_r;
    hand_r open;
    wrist_twist_r turn left 30;
    reach hand_l to hip_l;
    hand_l akimbo;
    aim head at camera;
    face ウィンク 0.85;
    face にこり 0.7;
}

@animation seg {
    0: ready;
    0.6: salute_pose;
    2.4: salute_pose;
}`,
  },
  {
    id: "point_camera_pose",
    title: "Pointing Toward Camera / Front",
    tags: [
      "指", "指着", "指镜头", "指前面", "食指", "指向", "就是你", "挑衅",
      "point", "pointing", "finger", "camera", "you", "bang",
    ],
    description: "lean slightly forward pointing playfully toward the camera with confident smile",
    mpl: `@pose ready {
    waist reset;
    upper_body2 reset;
}

@pose point_pose {
    waist turn left 15;
    upper_body2 bend forward 8, turn left 10;
    reach hand_r to front_r;
    hand_r point;
    reach hand_l to hip_l;
    hand_l akimbo;
    aim head at camera;
    face にやり２ 0.7;
    face ｷﾘｯ 0.5;
}

@animation seg {
    0: ready;
    0.6: point_pose;
    2.4: point_pose;
}`,
  },
  {
    id: "fist_cheer_pose",
    title: "Two-Hand Fist Cheer / Excited Pump",
    tags: [
      "握拳", "举拳", "加油", "欢呼", "打气", "兴奋", "开心", "冲鸭",
      "cheer", "fist", "fist pump", "excited", "happy", "fighting", "yay", "hurray",
    ],
    description: "raise both fists cheerfully in an excited victory pump smiling brightly",
    mpl: `@pose ready {
    upper_body2 reset;
    groove reset;
}

@pose cheer_pose {
    upper_body2 bend backward 10;
    groove move up 0.3;
    reach hand_l to wave_l;
    hand_l fist;
    reach hand_r to wave_r;
    hand_r fist;
    aim head at camera;
    face 笑い 0.9;
    face ワ 0.5;
}

@animation seg {
    0: ready;
    0.6: cheer_pose;
    2.4: cheer_pose;
}`,
  },
  {
    id: "heart_chest_gentle",
    title: "Hand on Heart / Gentle Bow",
    tags: [
      "抚胸", "捂胸", "胸口", "真心", "感谢", "温柔", "感动", "倾听",
      "heart", "chest", "gentle", "grateful", "thank", "sincere", "touch chest",
    ],
    description: "place right hand gently over heart tilting head warmly toward camera",
    mpl: `@pose ready {
    upper_body2 reset;
    head reset;
}

@pose heart_pose {
    upper_body2 bend forward 10, sway left 4;
    head sway right 6;
    reach hand_r to heart;
    hand_r cup;
    reach hand_l to front_l + [0.4, -2.0, 0.8];
    hand_l relax;
    aim head at camera;
    face なごみ 0.75;
    face にこり 0.6;
}

@animation seg {
    0: ready;
    0.6: heart_pose;
    2.4: heart_pose;
}`,
  },
  {
    id: "think_chin_tilt",
    title: "Hand on Chin Thinking / Curious",
    tags: [
      "托腮", "托下巴", "下巴", "思考", "思索", "疑惑", "奇怪", "发呆", "歪头想",
      "think", "thinking", "chin", "ponder", "wonder", "curious", "hmm",
    ],
    description: "rest chin thoughtfully on hand with slight head tilt and curious look",
    mpl: `@pose ready {
    upper_body2 reset;
    head reset;
}

@pose think_pose {
    upper_body2 turn right 10, bend forward 5;
    head sway left 14, bend forward 5;
    reach hand_r to chin;
    hand_r cup;
    reach hand_l to hip_l;
    hand_l relax;
    face 困る 0.35;
}

@animation seg {
    0: ready;
    0.6: think_pose;
    2.4: think_pose;
}`,
  },
  {
    id: "akimbo_confident",
    title: "Hands on Hips Confident Stand",
    tags: [
      "双手叉腰", "叉腰", "自信", "傲娇", "挺胸", "得意", "看着我",
      "akimbo", "hands on hips", "hips", "confident", "proud", "sassy", "stand",
    ],
    description: "stand confidently with both hands on hips, chest slightly lifted, looking at camera",
    mpl: `@pose ready {
    waist reset;
    upper_body2 reset;
}

@pose akimbo_pose {
    waist sway left 5, turn right 8;
    upper_body2 bend backward 5;
    reach hand_l to hip_l;
    hand_l akimbo;
    reach hand_r to hip_r;
    hand_r akimbo;
    aim head at camera;
    face ｷﾘｯ 0.65;
    face にこり 0.45;
}

@animation seg {
    0: ready;
    0.6: akimbo_pose;
    2.4: akimbo_pose;
}`,
  },
  {
    id: "lie_back_relaxed",
    title: "Lie Back Relaxed on Floor",
    tags: [
      "躺", "躺下", "仰卧", "仰躺", "躺平", "休息", "地上", "地板",
      "lie", "lying", "lay", "lie down", "supine", "floor", "relax", "rest",
    ],
    description: "lie back comfortably on the floor with knees slightly relaxed and soft smile",
    mpl: `@pose stand {
    base reset;
}

@pose lie_pose {
    base bend backward 90;
    center move up 1;
    leg_l sway right 8;
    leg_r sway left 8;
    knee_l bend backward 10;
    knee_r bend backward 10;
    reach hand_l to hip_l + [0.4, -0.8, 0.5];
    hand_l relax;
    reach hand_r to hip_r + [-0.4, -0.8, 0.5];
    hand_r relax;
    face にこり 0.65;
}

    @animation seg {
    0: stand;
    1.1: lie_pose;
    2.8: lie_pose;
}`,
  },
  {
    id: "crouch_tie_shoes",
    title: "Lunge-Crouch Down to Tie Shoelaces & Stand Back Up",
    tags: [
      "系鞋带", "鞋带", "绑鞋带", "鞋子", "蹲下系鞋带", "弯腰系鞋带", "再站起来", "站起来",
      "tie shoelaces", "shoelace", "shoelaces", "lace", "shoe", "crouch down", "squat down", "bend down", "brush off",
    ],
    description: "crouch forward on one knee cleanly to tie shoelaces on front shoe with both hands then stand back up smoothly",
    mpl: `@pose stand_start {
    center reset;
    waist reset;
    upper_body reset;
    upper_body2 reset;
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
    ankle_l reset;
    ankle_r reset;
}

@pose tie_crouch_a {
    center move down 7;
    leg_l bend forward 100, sway left 8;
    knee_l bend backward 110;
    leg_r bend forward 35, sway right 8;
    knee_r bend backward 120;
    plant feet;
    waist bend forward 50;
    upper_body bend forward 45;
    upper_body2 bend forward 20;
    head bend forward 15;
    reach hand_l to shoe_l;
    hand_l cup;
    reach hand_r to shoe_l;
    hand_r cup;
    face 真面目 0.45;
}

@pose tie_crouch_b {
    center move down 7;
    leg_l bend forward 100, sway left 8;
    knee_l bend backward 110;
    leg_r bend forward 35, sway right 8;
    knee_r bend backward 120;
    plant feet;
    waist bend forward 50, turn left 5;
    upper_body bend forward 45;
    upper_body2 bend forward 20;
    head bend forward 20;
    reach hand_l to shoe_l;
    hand_l cup;
    reach hand_r to shoe_l + [-0.3, 0.25, -0.2];
    hand_r fist;
    face 真面目 0.45;
}

@pose stand_finish {
    center reset;
    waist reset;
    upper_body reset;
    upper_body2 bend backward 3;
    leg_l reset;
    leg_r reset;
    knee_l reset;
    knee_r reset;
    head reset;
    arm_l reset;
    arm_r reset;
    aim head at camera;
    face なごみ 0.55;
}

@animation seg {
    0: stand_start;
    1.2: tie_crouch_a;
    2.4: tie_crouch_b;
    3.6: tie_crouch_a;
    4.8: tie_crouch_b;
    6.4: stand_finish;
}`,
  },
]

function extractQueryTerms(query: string): string[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return []
  const words = lower.split(/[^a-z0-9_\u4e00-\u9fff]+/).filter(Boolean)
  const terms = new Set<string>(words)
  // For CJK spans without spaces, also generate 2-char bigrams for fuzzy match
  for (const w of words) {
    if (/[\u4e00-\u9fff]{2,}/.test(w)) {
      for (let i = 0; i <= w.length - 2; i++) {
        terms.add(w.slice(i, i + 2))
      }
    }
  }
  return [...terms]
}

export function scoreExemplar(exemplar: PoseExemplar, query: string): number {
  const qLower = query.toLowerCase()
  const terms = extractQueryTerms(query)
  if (terms.length === 0) return 0

  let score = 0
  for (const tag of exemplar.tags) {
    const tl = tag.toLowerCase()
    if (qLower.includes(tl)) {
      score += tl.length >= 2 ? 4 + Math.min(4, tl.length * 0.5) : 1.5
      continue
    }
    for (const term of terms) {
      if (term.length >= 2 && (tl === term || tl.includes(term) || term.includes(tl))) {
        score += 2
      }
    }
  }
  const descLower = exemplar.description.toLowerCase()
  for (const term of terms) {
    if (term.length >= 3 && descLower.includes(term)) score += 1
  }
  return score
}

const DEFAULT_FALLBACK_IDS = ["giggle_mouth_akimbo", "peace_wink_lean", "akimbo_confident"]

/**
 * Retrieve top-K verified pose exemplars for a query (supports both Chinese and English).
 */
export function retrievePoseExemplars(query: string, topK = 3): PoseExemplar[] {
  const scored = POSE_EXEMPLARS.map((ex, idx) => ({
    ex,
    idx,
    score: scoreExemplar(ex, query),
  }))

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx)

  const picked: PoseExemplar[] = []
  const seen = new Set<string>()
  for (const item of scored) {
    if (picked.length >= topK) break
    if (item.score <= 0) break
    picked.push(item.ex)
    seen.add(item.ex.id)
  }

  // Pad with diverse baseline exemplars if fewer than topK matched
  for (const id of DEFAULT_FALLBACK_IDS) {
    if (picked.length >= topK) break
    if (seen.has(id)) continue
    const fb = POSE_EXEMPLARS.find((e) => e.id === id)
    if (fb) {
      picked.push(fb)
      seen.add(fb.id)
    }
  }

  return picked
}

export function formatExemplarsForPrompt(exemplars: PoseExemplar[]): string {
  return exemplars
    .map((ex) => `Segment description: ${ex.description}\n${ex.mpl}`)
    .join("\n\n")
}
