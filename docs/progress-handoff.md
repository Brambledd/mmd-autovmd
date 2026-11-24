# PoPo 项目结构、当前进展与会话交接文档

> 生成时间：2026-11-22  
> 适用范围：供新会话快速接手 `e:\PoPo` 的架构理解、已落地能力、本轮改动与后续验证。

---

## 一、项目技术栈与目录结构

- **框架与运行时**：Next.js `15.5.6`（App Router，实测构建输出 `15.5.9`，`dev` 端口 `4000`）、React `19.0.0`、TypeScript `5`、Tailwind CSS `4`
- **3D 与动作引擎**：Babylon.js (`@babylonjs/core ^8.11.0`) + `reze-engine ^0.6.6`（MMDs / VMD 加载与播放、`disableIK` / `disablePhysics` / `getAnimationProgress()`）
- **动作语言编译**：`mmd-mpl ^0.3.6`（Rust/WASM 编译器）+ PoPo 自研 TS MPL2 编译/运动学/增强全管线
- **LLM 与视觉评审**：`openai ^5.7.0`（OpenAI 兼容接口，环境变量 `AI_API_KEY` / `AI_API_BASE_URL` / `AI_MODEL`，可选视觉通道 `VLM_API_KEY` / `VLM_API_BASE_URL` / `VLM_MODEL` / `ENABLE_VISUAL_CRITIC`）
- **默认角色模型**：`public/models/topaz/topaz.pmx`（含扩展骨骼、Leg IK、44 个裙摆刚体与 66 个表情 morph）

### 核心目录树

```text
e:\PoPo
├── docs/
│   ├── how-llm-understands-pmx.md
│   ├── long-motion-roadmap.md          # Phase 1~3 / Layer 1~2.1 演进路线图与实测记录
│   ├── pipeline-optimization-audit.md
│   ├── pmx-parse-to-llm-understanding.md
│   └── progress-handoff.md             # 本文档
├── public/models/topaz/                # 默认测试与演示 PMX 模型
├── src/
│   ├── app/
│   │   ├── page.tsx                    # 主舞台页面
│   │   ├── playground/page.tsx         # MPL Playground 调试页
│   │   └── api/
│   │       ├── pose-generate/route.ts      # 早期单段生成接口
│   │       └── pose-generate-long/route.ts # 主编排接口（Plan → Generate → Stitch → FK自愈 → Storyboard视觉Critic，支持 SSE 流式）
│   ├── components/
│   │   ├── chat-input.tsx              # 主对话输入 + SSE 进度消费 + MPL2 编译/Audit/Enhancer/IK调度播放链路
│   │   ├── main-scene.tsx              # 主 3D 场景与 runRenderLoop 逐帧动态 IK 调度
│   │   ├── playground-scene.tsx        # Playground 3D 场景与动态 IK 调度
│   │   ├── mpl-editor.tsx              # Playground 编辑器（接 compileMPL2 / computeIkSchedule）
│   │   ├── code-editor.tsx / models-panel.tsx / header.tsx / playground-wrapper.tsx
│   │   └── ui/                         # 基础 UI 组件
│   ├── hooks/
│   │   └── useMPLCompiler.ts           # 客户端 WASM 编译器加载 hook
│   └── lib/
│       ├── pmx-bones.ts                # PMX 骨骼、刚体与包络（envelopes）解析及前后端序列化
│       ├── model-geometry.ts           # 位置语义检测（absolute/offset）与模型尺寸/包络测量
│       ├── model-conditioning.ts       # 生成注入 Prompt 的 ACTIVE MODEL NOTES 与安全表情白名单
│       ├── model.ts                    # 模型列表与 ACTIVE 模型骨骼获取
│       ├── motion-lexicon.ts           # 23 条参数化动作原语词库（含自适应 cycles/hold 展开）
│       ├── motion-corpus.ts            # 语料相关工具
│       ├── pose-exemplars.ts           # 13 条带中英双语标签的黄金姿态范例 + RAG 检索器
│       ├── mpl-macros.ts               # `#repeat` / `#speed` / `#hold` / `#mirror` 宏展开（desugarMPL）
│       ├── mpl2.ts                     # `composeMain` / `extractFace` / 手型预设 / `compileMPL2` 总管道
│       ├── ik-solver.ts                # MPL2 扩展骨骼与解析 IK（`reach` / `aim` / `plant`）
│       ├── vmd-morph.ts                # VMD morph 二进制注入/解析与帧号换算 (`secondsToFrame`)
│       ├── long-motion.ts              # 剧本归一化、`stitchSegments`（seamless 状态同步/表情互斥）、`findOffendingSegments`、SSE 编解码
│       ├── fk.ts                       # 赋予感知 FK 求解与 `analyzeGroundContactKeys` 地面接触分析
│       ├── pose-critic.ts              # 零成本确定性运动学门禁（穿地/悬空脚/肘翻折/遮眼/人体包络穿模）
│       ├── pose-audit.ts               # 编译后自碰撞胶囊预检与肢体链回退放松
│       ├── pose-renderer.ts            # 纯 TS+zlib PNG 渲染器：单帧三视图 (`840×360`) & 多帧分镜 (`renderStoryboardPng`)
│       ├── visual-critic.ts            # VLM 多视角 / 分镜视觉闭环评审与 `targetSegmentIndex` 归因
│       ├── vmd-enhancer.ts             # 曲线缓动、预备/过冲/停顿呼吸/安全眨眼、分段 `PropertyFrame` 与 `computeIkSchedule`
│       ├── idle-motion.ts              # 待机呼吸循环 VMD 生成
│       ├── mediapipe_solver.ts         # 图片姿态解算工具
│       ├── server-compile.ts           # Node 服务端 WASM 编译器单例（`next.config.ts` 配 `serverExternalPackages: ["mmd-mpl"]`）
│       └── types.ts / utils.ts
└── scripts/                            # 离线回归与基准测试脚本（test-*.mjs, benchmark-harness.mjs, *-demo.mjs）
```

---

## 二、当前演进进展总览

1. **基础阶段（Phase 1 / 2 / 3 & Layer 1 / 2 / 2.1）— 已落地**
   - `Plan → Generate → Stitch` 分段编排架构（`pose-generate-long`）、23 条词库原语、13 条双语 RAG 范例。
   - `MPL2` 管道：宏展开 + `main` 组合 + `face` VMD morph 通道 + `hand_<l|r>` 7 种手型预设 + 扩展骨骼（`upper_body2`, `groove`, `arm_twist`, `wrist_twist`, `eyes`）+ 解析 IK（`reach` / `aim` / `plant`）。
   - 服务端编译验证自愈 + FK 运动学 Critic 闭环 + `pose-audit` + `vmd-enhancer`（曲线/呼吸/安全眨眼）。
2. **长动作演进（Phase L1 / L2 / L3）— 已落地**
   - **Phase L1**：`stitchSegments(..., { seamless: true })` 无缝拼装、自动生成 `entry_sync` 清理跨段残留骨骼/表情、自适应过渡窗、剧情原语扩充（`talk_explain` / `step_closer` / `weight_shift` / `goodbye_wave`）。
   - **Phase L2**：`MAX_CUSTOM_SEGMENTS = 8`、`summarizeFragmentExit` 段间退出状态摘要、Multi-beat 段内节奏提示、`vmd-enhancer` 分时段动态 Leg IK 调度（`computeIkSchedule` + `MainScene`/`PlaygroundScene` 渲染循环实时切换）。
   - **Phase L3（本会话完成）**：多帧分镜 Storyboard 渲染与 VLM 段落归因、SSE 全链路流式进度推送与前端进度条 UI。
3. **30s 剧情实测后系统性稳定性修复 — 本会话已完成并通过全量离线验证**（待重启 dev server 后做真实 LLM 在线体感复测）。

---

## 三、本会话实际完成的工作清单

### 1. Phase L3 实施（[pose-renderer.ts](file:///e:/PoPo/src/lib/pose-renderer.ts)、[visual-critic.ts](file:///e:/PoPo/src/lib/visual-critic.ts)、[long-motion.ts](file:///e:/PoPo/src/lib/long-motion.ts)、[route.ts](file:///e:/PoPo/src/app/api/pose-generate-long/route.ts)、[chat-input.tsx](file:///e:/PoPo/src/components/chat-input.tsx)）
- **多帧分镜 Storyboard 渲染与共享绘制抽取**：在 `pose-renderer.ts` 抽取 `renderFramePanels` 与 `computeFrameEnergies`，新增 `pickStoryboardSamples` 与 `renderStoryboardPng`（最多 6 格、每格含 `FRONT (-Z)` 与 `3/4 VIEW` 并标 `#<segmentIndex> <ACTION> T=<sec>S`，优先采样 `source === "llm"` 定制段并覆盖首尾叙事点）。
- **分镜模式 VLM 视觉 Critic 与段落归因**：扩展 `visual-critic.ts` 新增 `STORYBOARD_CRITIC_SYSTEM`，在传入 `storyboard`（≥2 帧）时切换分镜模式、附带每格活跃表情并解析 `targetSegmentIndex`，Stage 4 优先定向重生成该指定段落；同时将图片 `detail` 设为 `"auto"` 以降低 VLM 延迟。
- **SSE 流式进度协议与前端实时进度条**：在 `long-motion.ts` 新增 `LongMotionStreamEvent`、`encodeSseEvent`、`parseSseBuffer`；`route.ts` 抽离 `executeLongPosePipeline`，兼容非流式 JSON，同时在 `stream: true` / `Accept: text/event-stream` 下实时推送 `stage` / `plan_done` / `segment_done` / `fk_check` / `fk_repair` / `visual_critic_start` / `visual_critic_done` / `complete` / `error`；`chat-input.tsx` 消费 SSE 流并在遮罩层实时展示阶段文本与百分比进度条。

### 2. 针对 30s 实测坏例的系统性根因定位与修复（全局有效）
针对用户两轮实测生成的 ~30s“鞠躬 → 挥手 → 蹲下系鞋带再站起 → 双手叉腰看镜头”长动作脚本做 FK/碰撞/morph 逐帧诊断后，修复了以下核心缺陷：
1. **消除 WASM 与 MPL2 的 1 帧错位（根因级修复）**：
   - 将 [vmd-morph.ts](file:///e:/PoPo/src/lib/vmd-morph.ts#L60-L61) `secondsToFrame` 改为与 `mmd-mpl` WASM 一致的 `Math.max(0, Math.floor(t * 30 + 1e-6))`，并同步 [pose-critic.ts](file:///e:/PoPo/src/lib/pose-critic.ts#L96) 帧解析，彻底消除 `.x5s` 时间戳上的 `plant feet`/`reach`/`face` 晚 1 帧抖动。
   - 修复 [fk.ts](file:///e:/PoPo/src/lib/fk.ts#L243-L256) `analyzeGroundContactKeys` 未按帧 step-hold 累积骨骼状态导致深蹲必误报 `ground_penetration`（及由此白跑 2 轮无用 LLM 重生成）的问题。
   - [vmd-enhancer.ts](file:///e:/PoPo/src/lib/vmd-enhancer.ts#L460-L486) 增加 `< 6` 帧过冲导致的 IK 窗口闪烁去抖，且对含 `全ての親`（`base`）旋转的躺倒动作关闭四肢延迟交错避免瞬时穿地。
2. **段内多拍表情互斥归零 + Conditioning 安全白名单**：
   - [long-motion.ts](file:///e:/PoPo/src/lib/long-motion.ts#L298-L329) 在 `seamless` 缝合中除了段边界 `entry_sync`，也在**段内每一拍**显式 `face` 时自动插 `s{i}_f{idx}_morph_sync` 清零前拍残留非眨眼表情。
   - [model-conditioning.ts](file:///e:/PoPo/src/lib/model-conditioning.ts#L58-L90) 收敛为带英文语义注释的安全表情白名单，屏蔽 `上 / 下 / 口上 / 口下 / う / 瞳小` 等易被 LLM 误当视线/专注的部件 morph，禁止叠超 2 个表情。
3. **鞋/足部 `reach` 锚点 + 胶囊防误伤校准 + 悬空脚门禁**：
   - [ik-solver.ts](file:///e:/PoPo/src/lib/ik-solver.ts#L406-L420) 新增 `foot`/`shoe`/`ankle` 解析 IK 锚点（落位 `[s*0.42, 0.85, -0.55]`）。
   - [pose-audit.ts](file:///e:/PoPo/src/lib/pose-audit.ts#L159-L167) 将过肥的 `thigh=0.36 / shin=0.30 / hand=0.30` 校准为 `0.18 / 0.13 / 0.16`，停止把伸向鞋面的手臂误判穿模并回退成 A-pose。
   - [pose-critic.ts](file:///e:/PoPo/src/lib/pose-critic.ts#L360-L384) 新增 `floating_foot` 错误拦截（禁止非踢腿/跳跃动作中单脚高悬腰臀后方），并在 [pose-exemplars.ts](file:///e:/PoPo/src/lib/pose-exemplars.ts#L410-L492) 补充经 `topaz.pmx` 物理验证的 `crouch_tie_shoes` 范例。
4. **编排防拆段、词库表情/节奏优化与耗时观测**：
   - [route.ts](file:///e:/PoPo/src/app/api/pose-generate-long/route.ts) `PLANNER_PROMPT` 禁止把连续落地动作拆成 2–3 个互相跳变的 custom 段、禁止插无请求 `idle_stand`；`SEGMENT_PROMPT` 注入世界坐标系与蹲姿几何要求；Stage 2 多 custom 段收敛 RAG 为 Top-2；Stage 3 对连续相同错误签名跳过重复盲修；响应新增 `timing: { planMs, generateMs, criticMs, visualMs, totalMs }`。
   - [motion-lexicon.ts](file:///e:/PoPo/src/lib/motion-lexicon.ts) 修复 `bow` `upright` 补全头颈 `reset` 且改用 `なごみ 0.6`；收紧 `wave_hand` 表情上限并加轻微躯干晃动；统一 `akimbo_pose`/`akimbo_shift` 表情；`expandLexiconSegment` 支持按目标时长自适应扩展循环次数/停留；[long-motion.ts](file:///e:/PoPo/src/lib/long-motion.ts#L334-L337) 将段尾静止延长上限由 `1.5s` 收紧至 `0.45s`。

---

## 四、当前已验证结果（全部在最终代码改动后通过）

| 检查命令 | 结果 | 说明 |
|---|---|---|
| `npx tsc --noEmit` | 退出码 `0` | 零类型错误 |
| `npm run lint` | 通过 | `No ESLint warnings or errors` |
| `npm run build` | 通过 | Next.js `15.5.9` 生产构建成功（8/8 页面/路由，含 `/api/pose-generate-long`） |
| `node scripts/test-topaz-mpl2.mjs` | **36 tests passed** | 包含 `[1]~[9]` 全部模块（含 Phase L3 分镜/SSE 与本轮帧对齐/表情互斥/`shoe_l`/悬空脚回归） |
| `node scripts/test-phase1.mjs` | **41 tests passed** | 宏语义、23 词库编译、plan 归一化、30s+ 缝合与反编译往返 |
| `node scripts/test-phase2.mjs` | **18 tests passed** | `composeMain`、`face` morph 注入、全链路融合保留 |
| `node scripts/test-fk.mjs` | **8 tests passed** | 几何测量、conditioning、FK 地面接触 |
| `node scripts/test-repair.mjs` | **7 tests passed** | 骨骼序列化、穿地段落定位、服务端 WASM 编译 |
| `node scripts/test-p0-fixes.mjs` | **8 passed, 0 failed** | conditioning 词表一致、编译期自愈与 idle 眨眼 |
| `node scripts/benchmark-harness.mjs` | **44/44 passed (100.0%)** | 23 条词库 + 13 条 exemplar + 8 条高难度 golden pose 全通过 |
| `node scripts/phase2-demo.mjs` | 通过 | 胸前穿模精准检测与放松、蹲姿膝间/屈肘 clean |
| `node scripts/vmd-enhance-demo.mjs` | 通过 | `wave hand: legIK re-enabled: true`、`sit: legIK re-enabled: false` |

---

## 五、交接给下一会话的注意事项与待办

1. **先重启本地开发服务器再实测**：本会话修复期间执行了 `npm run build`（重写了 `.next`），若原先有后台运行的 `npm run dev`，建议先重启 `npm run dev`（端口 `4000`）后再打开页面实测真实长动作效果与返回体中的 `timing` 字段。
2. **真机 LLM/VLM 在线 E2E 尚待复测**：由于本会话的终端沙箱无外网访问能力，Phase L3 与最后一次修复后的**真实大模型在线生成（含 SSE + Storyboard VLM 实测）**还未走活体 API 复跑；下一会话可开启 `视觉质检` 开关用同一句 30s 提示词跑一次实测，根据返回的 `timing` 和生成脚本继续迭代。
3. **工作区临时文件提醒**：`git status -s` 显示仓库根目录存在若干历史临时测试产物（`.tmp-e2e-*.png`、`.tmp-e2e-giggle.mpl`、`.tmp-sse-long.mpl`、`.tmp-story*.png`、`.tmp-view-*.png`），提交代码前可按需清理；另原项目删除了 DB/gallery 相关旧路由（`database.ts`、`gallery` 等）均属早期架构裁剪状态。
