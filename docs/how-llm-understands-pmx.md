# 语言模型如何"理解" .pmx 模型 — PoPo 架构分析

> 结论先行：**LLM 从不读取 PMX 二进制**。它"理解"的是被两层确定性代码投影出来的**语义骨架**（MPL 词汇表 + 动作规则），真正的 PMX 解析和骨骼驱动由 `reze-engine` 完成，两者只在**日文骨骼名字符串**上交汇。

## 1. 数据流全景

```
用户自然语言 ("wave right hand")
        │  POST /api/pose-generate
        ▼
┌─────────────────────────────────────────────────────────┐
│ LLM (AI_MODEL, OpenAI 兼容接口)                          │
│ 世界观 = system prompt（route.ts，~5.5k token）：         │
│   · 61 个 MPL 语义骨骼词（upper_body / arm_l / …）        │
│   · 4 个动作原语 bend / turn / sway / move + 6 方向词     │
│   · 关节极限表（手工写死，与编译器 rules 表重复维护）       │
│   · few-shot 例句（简单动作 / 循环动作 / 复杂动作）        │
│ 输出 = MPL 文本（~200 token，可读、可 diff）              │
└─────────────────────────────────────────────────────────┘
        │  MPL 源码
        ▼
┌─────────────────────────────────────────────────────────┐
│ mmd-mpl WASM 编译器（useMPLCompiler.ts）                 │
│   · 词法/语法检查（bone action direction amount;）        │
│   · validate(bone, action, direction, degrees)          │
│     → 查 rules 表：axis 向量 + limit（编译期拦截幻觉）     │
│   · 语义骨名 → 标准日文骨名（translations 表）            │
│ 输出 = VMD 二进制（中间格式：日文骨名 + 四元数 + 位移）    │
└─────────────────────────────────────────────────────────┘
        │  Blob → URL.createObjectURL
        ▼
┌─────────────────────────────────────────────────────────┐
│ reze-engine（Babylon.js）                                │
│   · loadModel("*.pmx")：唯一真正解析 PMX 的环节           │
│     header → vertex → face → texture → material → bone  │
│     → morph → displayFrame → rigidBody → joint          │
│   · loadAnimation(vmd)：按**骨骼名字符串**匹配 PMX 骨骼，  │
│     把四元数写进骨骼节点（父子层级自然继承）               │
│   · 刚体/关节 → 物理模拟（裙摆、头发随动，LLM 不可见）     │
└─────────────────────────────────────────────────────────┘
```

关键文件：
- Prompt 与 LLM 调用：[route.ts](../src/app/api/pose-generate/route.ts)
- 编译→VMD→加载：[chat-input.tsx:44-55](../src/components/chat-input.tsx)
- WASM 编译器 hook：[useMPLCompiler.ts](../src/hooks/useMPLCompiler.ts)
- PMX 加载入口：[main-scene.tsx:29](../src/components/main-scene.tsx)
- 骨名映射/规则表（上游源码，GitHub AmyangXYZ/MPL `src/bone.rs`）：`BONES`（61 词）、`translations`（EN↔日文）、`rules`（轴向量+极限）

## 2. 实测：工作区里 3 个 PMX 到底装了什么

用 `scripts/pmx-info.mjs`（本仓库新增，`node scripts/pmx-info.mjs <pmx>`）解析：

| | topaz.pmx | 深空之眼-梵天.pmx | 深空之眼-梵天2.pmx |
|---|---|---|---|
| 版本 / 编码 | PMX v2.0 / UTF-16LE | 同 | 同 |
| 顶点 / 面 | 21605 / 26874 | 22764 / 28216 | 28378 / 38428 |
| 材质 / 贴图 | 33 / 9 | 18 / 9 | 23 / 12 |
| **骨骼** | **243** | **656** | **381** |
| IK 骨 | 右/左足ＩＫ + つま先ＩＫ | 同 | **无足ＩＫ** |
| 刚体 / 关节 | 153 / 161 | 519 / 816 | 1152 / 1640 |
| 表情 morph | 66（vertex） | 45（42v+1g+2m） | 97（92v+4g+1m） |
| MPL 核心骨覆盖 | ✅ 无缺失 | ✅ 无缺失 | ✅ 无缺失 |

三个模型的差异（656 vs 243 骨、有无足ＩＫ、表情拆成 _R/_L）**对 LLM 完全透明**：同一个 prompt、同一套极限表、同一批 few-shot。这就是"模型无感"的设计。

## 3. "理解"的三次翻译（LLM 视角）

1. **词汇压缩**：LLM 只需掌握 26 个核心语义词（topaz 有 243 个骨名，梵天有 656 个）。`arm_l` 一个 token 覆盖「左腕/LeftArm/L_shoulder_xxx」所有方言。
2. **解剖学动词**：`bend/turn/sway` 不是欧拉轴，而是每个骨骼各自定义的语义映射 —— 如 `elbow_l bend forward → 轴 [0.6, 0.8, 0]`（非正交轴，模拟肘部内旋），`shoulder_l sway left → 轴 [-0.6, -0.8, 0]`。LLM 不碰四元数和局部坐标系。
3. **约束前置 + 双重防御**：极限表同时存在于 prompt（软约束）和编译器 `rules`（硬约束 `validate()`）。LLM 幻觉出 `elbow bend backward` 时，编译期直接报错 `Max 180 degrees for ...`。

结果：LLM 只负责 **语言 → 语义姿态计划**；**语义 → 数学**（轴、四元数、层级）由编译器和引擎确定性完成。

## 4. 当前盲区

| 盲区 | 后果 |
|---|---|
| 表情 morph 不可见（66/45/97 个） | "big laugh" 只能靠摆手指/头，模型自带的 `にこり`、`笑い` 无法被利用 |
| IK 骨无概念 | 梵天2 没有足ＩＫ → 所有腿部姿势走 FK 链，质量不受 prompt 控制 |
| 模型差异无感知 | 依赖"标准日文骨名"约定；改了骨名的非标准模型会**静默失配**（VMD 帧写不上骨骼） |
| 材质/物理/toon 全盲 | 与姿势无关，但 519 刚体的裙摆物理效果 LLM 只能"祈祷" |
| 极限表是全局经验值 | 5° 步进 + 统一极限与具体模型的 A-pose 初始朝向未必一致 |
| prompt 与编译器两处维护极限表 | 手工漂移风险（route.ts 表格 vs bone.rs rules） |

## 5. 改进路线（按性价比排序）

1. **Per-model 几何条件化（已部分落地）**：`scripts/pmx-info.mjs` 现在直接输出 `Measurements` 行——身高/腰高/臂长/腿长/关键骨骼 y 坐标（骨骼 position 沿父链计算，MMD 1u≈8cm）。把这些数字注入 prompt，LLM 从"人类大概 90 度"升级为"这个模型腰在 y=8、臂长 6.5u"。**实测坑：工作区三个模型的骨骼 position 都是绝对坐标语义而非规范的父骨偏移**（链条累加会算出 7 米身高）——测量器已加语义自动检测（chainY > 3×rawY → absolute）。落地路径：reze-engine 加载后直接读运行时骨骼位置生成同样的 JSON 注入 prompt，无需再读二进制。
2. **FK 几何检查闭环**：生成后用前向运动学把 VMD 帧应用到骨骼树，数值化检查"手脚末端 y≈0？""身体穿地？"——把目检自动化，开环变闭环；不合格的差异回填 LLM 修正。
3. **接触语法下沉**：mpl2 增加 `plant wrist_l;` 类语句，编译期用解析 IK（参考 reze-engine 自带 `ik-solver.ts`）把末端钉到地面目标——撑地/坐/躺类动作的确定性解法，比教 LLM 空间推理可靠一个数量级。
4. **语料学习**：目检修正过的（描述→最终 MPL）对沉淀 → RAG 相似检索 few-shot（便宜先行）→ 攒够再 fine-tune。
5. **Morph 通道**：MPL 增加 `face smile 0.8;` 类 morph 语句 ✅（Phase 2 已落地，见 §6）。
6. **单一事实源**：极限表由 bone.rs `rules` 生成 JSON，构建时注入 route.ts prompt，消除双份维护。
7. **自愈回路**：编译失败时把 validate 错误回传 LLM 二次修复（现在 chat-input 只展示错误）。
8. **训练数据**：用 `mpl -r x.vpd -o out.mpl` 反编译批量把 VPD/VMD 动作转成 MPL，做 fine-tune 语料（README 的路线图）。

## 6. 反向问题：给定 VMD，LLM 能知道模型在做什么吗？

**能，但必须先"翻译"，LLM 不能直接读 VMD。** VMD 是二进制（Shift-JIS 骨名 + float 四元数 + 64B 贝塞尔插值），直接喂给 LLM 是几何噪声。而桥梁已经存在且已验证：

```js
// node_modules/mmd-mpl 0.3.6 的 d.ts —— 应用已在用的同一个 WASM 就带反向编译
compiler.reverse_compile("vmd", vmdBytes) // → MPL 文本
```

实测往返（scripts/vmd-roundtrip.mjs）：

| 方向 | 结果 |
|---|---|
| MPL → VMD | 754 字符 → 5981 字节，magic `Vocaloid Motion Data 0002` |
| VMD → MPL | 5981 字节 → 1432 字符，**所有角度精确还原**（30/20/60/90/10/15/20/25…），时间轴 0→1.8s 精确保留 |
| 损耗 | 姿势名丢失（`wave_start`→`pose_0`）、动画名丢失、出现 0° 噪声项（`turn left 0`）、插值曲线丢失 |

反向产物 MPL 正是 LLM 被训练/提示的词汇 —— 所以"VMD 动作理解"只需一条 captioning 链：

```
VMD bytes → reverse_compile → MPL 文本 → LLM → "右手举起挥动约1.8秒，来回3次"
```

**限制**：① 只有 MPL 61 词表内的骨骼被捕获 —— 裙摆/头发物理骨、IK 帧、morph（表情）帧全部丢弃；② 真实舞蹈 VMD 有数千帧，需先降采样；③ "挥手 vs 招手"这类语义判读是统计任务，GPT-4o-mini 级别可用，fine-tune 后更稳；④ 动作"质感"（缓动）不可恢复。

**落地建议**：加 `/api/pose-caption`（VMD → reverse_compile → LLM 描述），或前端直接用现有 `useMPLCompiler` hook —— 零新增依赖。

## 7. 动作僵硬与穿模：根因定位（源码实证）与解决路线

### 根因 A：僵硬（实证于上游源码）

| # | 根因 | 证据 | 影响 |
|---|---|---|---|
| A1 | 每帧硬编码**极端 S 曲线** (x1=64, y1=0, x2=63, y2=127) | MPL `vmd.rs create_ease_in_out_interpolation()` | "定格→猛甩→急停"节奏，比 MMD 默认 (20,20,107,107) 机械得多 |
| A2 | 每个动作**每骨只有 2 个关键帧**（start+target），所有关节同时抵达 | LLM 输出的 @animation 结构（route.ts few-shot 即如此） | 无预备、无过冲、无跟随，机器人式同步 |
| A3 | 度数 5° 量化 + LLM 手写等间隔时间戳（0/0.3/0.6…） | prompt "Round all degrees to nearest 5" | 节拍器感 |
| A4 | 编译器**全局关闭腿 IK**（右足ＩＫ/左足ＩＫ/ＩＫ親写进 ik_disabled_bones） | MPL `vmd.rs` L99-110 | 身体移动时双脚漂移/滑步 |
| A5 | 无 idle 微动层 | — | 动作间/结束后完全静止 |

### 根因 B：穿模

1. **全链路无碰撞校验**：prompt 只有单骨角度极限，没有骨骼间（手-躯干/手-裙/膝-手）约束；VMD 生成后无几何验证。
2. **复合旋转越界**：多骨 turn+bend+sway 组合各自合法但整体穿模（手进胸口、进裙摆）。
3. **模型差异无感知**：topaz（无裙）与梵天（大裙+519 刚体/816 关节）共用同一套极限。
4. 物理刚体只推布料，不阻止 FK 肢体穿透。

### 解决路线（按性价比排序）

**Phase 1 — 纯编译器润色 pass（✅ 已落地 2024，实现在 `src/lib/vmd-enhancer.ts`）**

落地形态：不动 LLM、不动 MPL 语法、不动引擎，在 mmd-mpl 编译产物（VMD 二进制）上做确定性后处理，接入 `chat-input.tsx` 与 `mpl-editor.tsx` 两个编译点。验证脚本 `scripts/vmd-enhance-demo.mjs`（含 reverse_compile 结构校验）：

1. ✅ 曲线库：替换全局硬编码 S 曲线 (64,0,63,127) —— 默认 soft (20,20,107,107)、发力段 snap (25,95,64,127)、收势段 settle (38,13,102,114)
2. ✅ 自动 embellishment：≥30° 且邻段为保持段时插预备帧（-15% 反向）+ 过冲帧（+10%）+ 收敛帧；运动链错峰（肩2/臂3/肘4/腕4帧，封顶 4）
3. ✅ 预卷 rest 关键帧：MPL 片段首帧直接是第一姿势（角色"闪现"入姿势），增强器在 f0 补 identity 关键帧使其缓入
4. ✅ 腿 IK 条件开启：无腿部关键帧时重开腿 IK（脚钉地），有腿部动作时保持关闭
5. ✅ 兜底契约：任何解析异常原样返回输入，绝不破坏管线

实测（wave/sit 两个动作）：反向编译器可完整解析增强后 VMD（结构合法性证明）；腕部时间线呈现 `rest→pose→overshoot(+3°)→settle` 的跟随曲线。

**Phase 2 — 几何校验闭环（✅ 已落地，实现在 `src/lib/pose-audit.ts` + `src/lib/pmx-bones.ts` + `src/lib/model-conditioning.ts`）**

落地形态：管线变为 `compileMPL2 → auditVmd（FK 碰撞预检+自动回退）→ enhanceVmd → engine`，接入 chat-input 与 mpl-editor；条件化文本由客户端解析当前 PMX 生成，经请求体注入 `/api/pose-generate-long` 的 planner/segment 双 prompt。验证脚本 `scripts/phase2-demo.mjs`：

1. ✅ `parsePmxBones`：骨骼/刚体/表情 morph 解析（三个模型计数与权威解析器完全一致；修复 SDEF 跳转 60B 与 material morph 载荷 112B 两处坑）
2. ✅ FK 引擎：step-eval + 父链累积旋转，恒等自检 max|world−rest| = 0.00
3. ✅ 胶囊预检：躯干/头/大腿/小腿胶囊（半径=REST 骨长×比例，随模型自动缩放），检测对：手→躯干/头/对侧腿、肘→躯干（同侧大腿白名单=合理接触）
4. ✅ 自动回退：违例链（腕→肘→臂→肩）按最大可行比例二分回退（下限 0.35），实测 chest 穿模 ×0.98+×0.62 双级修正；`radiiScale` 灵敏度旋钮（×1.6 捕捉擦边）
5. ✅ 条件化：topaz（全骨+有IK+裙44刚体）vs 梵天2（无腿IK+裙772刚体）生成不同 NOTES，注入 planner 与 segment prompt
6. ✅ 兜底契约：解析/加载失败一律跳过审计或原样返回，绝不阻断管线

**Phase 3 — 质感天花板（⑧B idle + ⑥ 语料管线 ✅ 已落地；⑦ 待 spike）**

✅ **⑧B Idle 微动层**（`src/lib/idle-motion.ts`）：程序化呼吸循环 VMD 生成器（上半身 ±2°/首 ∓1.2°/腕 ±1.5°/重心 bob，整周期正弦 → 接缝 |Δq|≈8.6e-18 无缝），10Hz 软曲线，72KB/8s。接入三处：模型加载即播、生成失败回退、动作播完轮询回 idle（安装版 reze 0.6.6 无 onEnd，`getAnimationProgress` 轮询）。词库新增 `idle_breathe` 原语供 Plan/Stitch 使用。

✅ **⑥ 语料管线**（`src/lib/motion-corpus.ts` + `scripts/corpus-demo.mjs`）：真实素材 → 片段的完整摄入链
```
VPD→reverse_compile 或 VMD→downsampleVmd(0.2s/帧)→reverse_compile
  → normalizeFragment（词库契约：确定性命名/单动画/剥 main/hold 尾）
  → 离线 auditVmd 门禁（穿模片段不得入库）
```
实测：VPD 样例自动检出穿模并回退 ×0.72 后入库（Phase 2 协同生效）；lexicon→VMD→往返降采样 24→16 帧、契约满足（4 poses/单动画/无 main）。**顺带修复 compileMPL2 隐患**：无 main 块的输入 wasm 编译器静默返回 0 字节，新增 `ensureMain` 兜底。剩余工作非代码：收集真实 VPD/VMD 素材批量入库。

**⑦ 手臂 IK 目标（未开工，先 spike）**：安装版 reze 0.6.6 导出 `IKSolverSystem.solve` 且 model 配置有 `ikSolvers?: IKSolver[]` 线索，但内部 `solveIKChains` 为 private，任意链 IK 的接入点需 1 天可行性验证；语义锚定半边已由 Phase 2 `skeletonAt` 备好。

Phase 3 剩余（可选）：⑧A blend 叠加需升级 reze master（0.6.6 无 BlendEntry API）；⑥ 素材批量入库属运营动作。

## 8. 附：PMX 二进制速查（解析中验证过的布局）

- Header: `"PMX "`(4B) + version(f32) + globalsCount(u8) + globals[8]（编码/附加UV/各类索引大小）
- 顺序：模型名×4(字符串) → vertex(weightType 0-4，SDEF 额外 60B) → face → texture → material(末尾仅记录面数) → **bone** → morph → 表示枠 → 刚体 → 关节
- 骨骼 flags（易错点，按 blender_mmd_tools 权威实现）：
  `0x0001` 接続先=骨索引 · `0x0100/0x0200` 付与回転/移動(idx+f32) · `0x0400` 軸固定(vec3) · `0x0800` ローカル軸(2×vec3) · `0x1000` 物理後算出 · `0x2000` 外部親(i32) · `0x0020` IK 数据块
- 索引一律**有符号**（负值=无效引用）
