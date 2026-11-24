# 长动作演进路线图 — 从 3 秒片段到分钟级编舞

## 0. 现状诊断（全部有实测证据）

| # | 瓶颈 | 证据 |
|---|---|---|
| 1 | **MPL 没有组合算子**：`main { a; b; }` 不做时间偏移，两段关键帧直接重叠碰撞 | `scripts/main-composition-test.mjs`：seg_a(抬臂) + seg_b(放臂) 编译后合并成 `arm_l bend backward 90, reset;` 落在同一时刻，seg_b 永远不会"接着"播 |
| 2 | 因此现在唯一的"长"办法 = 一次性生成一个巨型 `@animation`（手动累加时间戳） | `pose-generate/route.ts` 单次调用；例句最长仅 7 关键帧 ~3s |
| 3 | 长生成质量必然衰减：时间轴漂移、姿势复读、token 上限、延迟线性增长 | LLM 生成通用问题，输出越长越失控 |
| 4 | 无循环/镜像/变速/保持语法（`loop`/`mirror`/`speed`/`hold`） | compiler.rs 语法只有 `@pose` / `@animation` / `main` |
| 5 | morph 通道永远为空（表情） | compiler.rs `MPLKeyFrame::new(time, bone_frames, vec![])` |
| 6 | 词汇天花板：LLM 逐关节手搓角度，长舞蹈必然僵硬；没有真实动作数据源 | 61 词表 × 4 动作，prompt 全靠 few-shot |

核心判断：**瓶颈不在"LLM 不够聪明"，而在"词汇太低级 + 没有组合算子"。** 让 LLM 编舞（组合原语），而不是让它当木偶师（逐关节画角度）。

## 1. Phase 1 — 编排层（纯 TS，零 Rust 改动，最高杠杆）

### 1.1 动作原语库（Motion Lexicon）
每个原语 = 一个参数化 MPL 片段 + 元数据契约：

```ts
interface MotionPrimitive {
  name: string            // "wave_hand"
  tags: string[]          // ["greeting", "loopable", "upper_body"]
  duration: number        // 1.8
  startPose: string       // MPL 姿势契约（接缝连续性用）
  exitPose: string
  params: Record<string, {min:number, max:number, default:number}>  // amplitude, tempo
  mpl: (p: Params) => string   // 模板展开
}
```

**来源三路（后两路仓库已有半成品）**：
- a. 现有 gallery 精选（`types.ts` 的 Pose 表已存 `mpl` 字段）
- b. **VMD 摄取管线**：社区舞蹈 VMD → 降采样（每 0.2~0.3s）→ `reverse_compile("vmd")`（mpl-editor.tsx 已实现单文件上传版！）→ 清洗（去 0° 噪声项、量化到 5°、只保留 61 词表内骨骼、拆分成 2-4s 原语）→ 入库
- c. **动捕**：图片/摄像头 → MediaPipe Holistic → VPD → MPL（`mediapipe_solver.ts` + editor 的图片上传已经在做）

### 1.2 编舞 API：Plan → Generate → Stitch（把一次长生成拆成多次短生成）

```
用户: "跳一段 30 秒欢快的舞，最后挥手告别"
  │
  ├─ Stage 1  PLAN（一次调用，输出 JSON 剧本，不是 MPL）
  │     { segments: [
  │        {action:"wave_hand", duration:1.8, tempo:1.2},
  │        {action:"step_touch", duration:2.0, mirror:false},
  │        ... ×15
  │        {action:"wave_goodbye", duration:2.5} ], total: 30 }
  │
  ├─ Stage 2  GENERATE（每段并行一次调用，每次都只生成 2-4s 的短 MPL）
  │     prompt = 原语库菜单(带参数) + 上一段 exitPose + 该段参数 + 风格约束
  │     → 每次调用质量与现在 3s 生成完全等价
  │     → 每段先 compile()，validate 报错回填 LLM 重试一次（自愈）
  │
  └─ Stage 3  STITCH（纯 TS）
        时间戳累加展开成单个 @animation，接缝处插 0.15~0.3s 过渡关键帧
        → 一个 VMD，一次播放
```

### 1.3 TS 宏展开器（不碰 Rust 就能加语法）
compile 之前把糖语法 desugar 成纯 MPL，wasm 编译器零改动：

```text
repeat 4 { step_touch; }        →  展开成时间戳平移后的平铺关键帧
mirror { wave_hand; }           →  左右骨骼名互换 + 方向词翻转
hold 2s { sit; }                →  相同姿势关键帧 ×2
speed 1.5x { ... }              →  时间戳 ÷1.5
```

### 1.4 第一周可跑的最小版本
- 从 route.ts 现有 few-shot 例子手工提取 8~12 个种子原语
- 上线 plan→generate→stitch 三段 API
- 效果：3s → 30s+，每段质量不掉，且失败可分段重试

## 2. Phase 2 — 语言层（MMD-MPL Rust 仓库）

1. **修 main 组合语义**（本次实测的 bug/缺失）：`main { intro; chorus offset 8.0; }` 或自动累计时长
2. 原生 `repeat / mirror / hold / speed / transition`
3. **VMD morph 通道**：`face smile 0.8;` → 写 morph 帧（长动作里表情是灵魂）
4. 移动语义：`move` 极限 100 太小，走路需要 locomotion 级位移 + 脚步防滑

## 3. Phase 3 — 数据/模型层（长动作质量的天花板）

1. **Text-to-motion 模型**（MotionGPT / MDM / T2M-GPT）→ HumanML3D → retarget 到 MMD 61 骨 → MPL 化；LLM 退居"导演"
2. 用 Phase 1 摄取的（动作描述 ↔ MPL）对做 **fine-tune**
3. **音乐对齐**：WebAudio BPM 检测 → 段长对齐到小节/节拍

## 4. 验收指标（避免"看起来能动"就上线）

- 接缝角速度连续性（段边界 bone angular velocity 突变 < 阈值）
- 足底滑动距离（locomotion 场景）
- 极限违规数（compile 拦截后应为 0）
- LLM-judge 语义命中率（"说好挥手，第 20s 真的在挥手吗"）
- 节拍偏差（有音乐时）

## 5. UX 配套

- MPL 编辑器加**大纲导航**（按 segment 分节、点击跳转时间点）
- 分段缩略图/预览 + **单段重新生成**按钮（不用整段重来）
- 剧本 JSON 面板：用户可直接增删段、改参数后局部重生成

## 6. 本计划的负面结果与缓解（诚实清单）

按"严重度 × 概率"排序。每条都是方案内生的风险，不是泛泛的工程警告。

| 风险 | 机制 | 缓解 |
|---|---|---|
| **① 编排放大既有质量** | 组合是乘法：垃圾原语 × 15 段 = 垃圾的 30s。原语库质量没验证前就上编排，等于把坏内容规模化 | 先人工精选 ≤12 个种子原语做盲测，原语库验收标准（可循环、接缝自然）先于编排 API |
| **② 拼积木机械感** | 接缝过渡解决"跳变"，但解决不了"同一原语每次执行一模一样"；exitPose 契约会诱发"回中再出发"的木偶感。我提的接缝角速度指标测不出这种重复感 | 每次执行注入参数抖动（±10% 角度/时长）；接缝用重叠窗口（前后段共享 0.3s 交叉插值）而非硬切；指标加"逐段姿态多样性"与用户 A/B |
| **③ 版权/社区规范踩雷** | 社区 VMD/模型动辄带 per-author 使用条款（本仓库模型目录里就有 `使用规则.txt`）。把社区动作摄取进商用原语库/fine-tune 语料，MMD 社区对此极其敏感 | 原语库每条带 license 字段（来源 URL + 条款摘要 + 署名）；摄取只做"用户上传自己的 VMD"（编辑器现状），产品方不批量爬取；fine-tune 语料先做条款审计 |
| **④ 成本与延迟 ×15** | plan(1) + segments(15) + 自愈重试 → 单请求 LLM 调用从 1 次变 16+ 次，线上成本和 P95 延迟同比放大 | 库命中的段零 LLM 调用（Stage 2 只对"库里没有"的段生成）；剧本级缓存；流式：先播第一段、后续段边生成边追加（需引擎支持追加 VMD，当前 `loadAnimation` 是整文件） |
| **⑤ 宏/镜像制造方言 + 正确性陷阱** | `repeat/mirror` 是 PoPo 私有糖：导出的 MPL 在编辑器外不可用，gallery 内容失去可移植性，与上游 mmd-mpl 分叉。且"左右名互换+方向翻转"是真错的：极限表左右不对称（leg_l sway 左 180°/右 30°）、轴向量非对称、模型有自定义命名骨骼（SkirtSide/hff_x_x），朴素镜像会编译失败或超限 | 导出永远用 desugar 后的标准 MPL（糖只是编辑态）；mirror 走四元数空间变换 + 按镜像后的对称极限二次 validate，而不是字符串替换 |
| **⑥ Phase 2 是破坏性变更** | 改 main 组合语义/加语法会静默改变所有存量 MPL（gallery、用户脚本、已 fine-tune 模型的输出先验）的行为 | MPL 加 `@version` 头，旧语义默认路径保留；语义变更与上游仓库同步发版，产品端灰度 |
| **⑦ 动捕来源被高估** | mpl-editor 现有 MediaPipe 路径是 `runningMode: IMAGE`——单图 → 静态姿势，**采不出 2~4s 的动作原语**；且 MediaPipe 无脚趾/膝关节扭转映射，噪声会被永久烘焙进词库 | 视频 runningMode + 时序平滑另立项目；原语库初期不依赖动捕，Phase 1 用 VMD 摄取 + 手工精选 |
| **⑧ Phase 3 最后一公里损耗** | 扩散模型动作 → retarget 到 61 骨 → 量化 5° + 4 动作词，MPL 抽象层把自然度在最后一步磨掉 | 高质量动效绕过 MPL：引擎直接吃 retarget 后的四元数帧；MPL 只保留为 LLM 交互层 |
| **⑨ Fine-tune 模式坍缩** | 用词库习语训练 → 输出向训练原语收敛，多样性反而低于基座模型 | 保留基座模型路由（难请求走基座）；采样温度 + 词库随机化 |
| **⑩ 指标的 Goodhart 效应** | 优化接缝角速度 → 过度平滑"糊感"；足滑指标驱动 IK 补丁 → 膝盖弹跳 | 指标只做回归门禁，不做优化目标；上线以用户 A/B 为主判据 |
| **⑪ UX 状态机复杂化** | 局部重生成有依赖：改第 3 段，第 4 段的 entryPose 就失效了——段版本管理是新产品面，bug 温床 | 段不可变 + 只允许向后重锚定；契约未变的段才允许原位替换 |

**一句话结论**：这套计划最大的负面结果不是"做不出来"，而是**把现有的 3 秒质量等比例放大成 30 秒的平庸**（①②），以及**内容合规（③）**。Phase 1 先用人工精选小词库验证"组合后的观感"，再谈规模化。

## 7. Phase 1 实施记录（已完成，29 项测试通过）

### 交付物

| 文件 | 职责 |
|---|---|
| [src/lib/mpl-macros.ts](../src/lib/mpl-macros.ts) | 宏展开器：`#repeat/#speed/#hold/#mirror` → 标准 MPL。repeat 按**时间去重**（先写者优先）防同刻双关键帧；导出永远是 desugar 后的标准 MPL（风险⑤缓解） |
| [src/lib/motion-lexicon.ts](../src/lib/motion-lexicon.ts) | 12 个种子原语（wave_hand/nod_yes/shake_head/bow/sit/stand_up/arms_up/jumping_jack/tilt_head/look_around/punch/idle_stand），参数钳制 + 角度量化 5° + 可选文本级镜像；零运行时依赖（Next/Node 双端可加载） |
| [src/lib/long-motion.ts](../src/lib/long-motion.ts) | 纯函数层：片段解析 → 逐段 `s{i}_` 前缀重命名 → 时间戳平移缝合（接缝 GAP=0.25s 引擎插值）→ 单一 `long_sequence` 动画；plan 归一化（段数≤40、总时长≤120s、未知动作模糊匹配/丢弃）；LLM JSON 稳健提取 |
| [src/app/api/pose-generate-long/route.ts](../src/app/api/pose-generate-long/route.ts) | Plan→Generate→Stitch 编排端点。成本模型：剧本 1 次调用；词库命中段 0 次调用；词库外段走 LLM（上限 2 段，失败降级 idle_stand） |
| [scripts/test-phase1.mjs](../scripts/test-phase1.mjs) | 29 项端到端测试：宏语义 / 全部原语逐个过 wasm 编译器（极限表真值校验）/ plan 归一化 / 8 段缝合→编译→反编译往返 |

前端 `chat-input.tsx` 已切到 `/api/pose-generate-long`（响应兼容 `{mpl}` 字段，vmd-enhancer 后处理链不受影响）。

### 实测结论

- 8 段缝合场景（wave→bow→sit→look→stand→jack×3→punch→mirror wave）总时长 12.15s，VMD 16415 bytes，编译通过，反编译 34 关键帧首尾时间轴一致
- VMD 是 30fps 整数帧网格：12.15s×30=364.5 帧被截断 → 末帧 12.133s，所有时长对齐误差 ≤1/30s

### 实现中发现并修复的坑

1. `#repeat` 去重最初按 `(时间,引用)` 键——接缝处同时刻不同姿势会双双保留（正是 main 碰撞的同款病灶），改为按时间去重
2. 片段级时长计算正则没容许行首缩进 → duration 恒 0（词库模板行有 4 空格缩进）
3. 词库片段没有 `main` 块时 `compile()` 返回空 VMD（`to_key_frames` 以 main 为入口）——测试用 compileFrag 补 main 后逐个校验

### Phase 1 未做（刻意留白）

- 接缝只有引擎线性插值，无缓动曲线叠加（vmd-enhancer 已存在，后续把它的 easing 应用到接缝关键帧）
- Stage 2 自愈回路（编译错误回填 LLM 重试）——当前编译在客户端，报错直接展示
- 原语库 DB 化（现在硬编码 TS）与 gallery VMD 摄取脚本
- 流式播放（引擎追加 VMD 支持）

## 8. Phase 2 实施记录（已完成，17 项测试通过）

语言层路线图 §2 的四项中三项已在 TS 层落地（不改上游 Rust），一项确认为非瓶颈：

| §2 目标 | 落地方式 | 状态 |
|---|---|---|
| main 组合语义 | [src/lib/mpl2.ts](../src/lib/mpl2.ts) `composeMain`：`main { a; b offset 3; c @ 7; pose @ 1; }` → 单一标准动画。wasm 原生组合语义未动（旧碰撞仍在，但 PoPo 全链路已不走那条路） | ✅ |
| VMD morph 通道 | [src/lib/vmd-morph.ts](../src/lib/vmd-morph.ts) 二进制注入器 + mpl2 `face <morph> <weight>;` 语句提取。引擎侧已验证支持：reze-engine `vmd-loader.ts` 解析 morph 帧，`model.ts:879` 播放时应用 | ✅ |
| repeat/mirror/hold/speed 原生语法 | Phase 1 已有 TS 宏展开器， mpl2 管道已集成 | ✅（复用） |
| locomotion/move 极限 | move=100 单位 ≈ 8 米，**不是真瓶颈**；真缺口是走路原语与足滑 → 归入词库扩充 + vmd-enhancer 的 planted feet | ⏸ 重定性 |

### 交付物

- **[src/lib/vmd-morph.ts](../src/lib/vmd-morph.ts)**：`injectMorphFrames`（整体替换 morph chunk，幂等）/ `parseMorphFrames` / `secondsToFrame`。encoding-japanese 做 Shift-JIS 编码，round-trip 与 TextDecoder 校验一致。稳健性契约：解析异常原样返回输入
- **[src/lib/mpl2.ts](../src/lib/mpl2.ts)**：`compileMPL2` 管道 = 宏展开 → main 组合 → face 提取 → wasm 编译 → morph 注入；附 `findBoneCollisions` 静态碰撞检测（同刻同骨骼双关键帧预警）
- **词库 enrich**：wave_hand 新增 `face` 参数（默认 0.8 微笑），bow 固定 真面目 0.6
- **[scripts/test-phase2.mjs](../scripts/test-phase2.mjs)**：17 项——组合偏移帧号断言、旧碰撞回归（反编译不再出现 `90, reset`）、face 剥离必要性（wasm 直编 face 必须抛错）、morph 往返、enhanceVmd 端到端保留 morph chunk、无新语法字节不变式

### 前端管道（chat-input）

```
resp.mpl → compileMPL2(mplCompiler, mpl)   // 宏→组合→face→wasm→morph 注入
         → enhanceVmd(vmd)                 // 缓动/预备帧/落脚（原样保留 morph chunk）
         → loadVMD
```

### 实现中踩的坑

1. **VMD magic 校验**：header 字段 30B NUL 填充、magic 本体 25 字符——26 字节 slice 直接与 25 字符串比较永远不等，导致注入器**静默空转**（首轮测试 `deepEqual(null,null)` 空过暴露）。教训：魔术数校验必须先剥尾部 NUL
2. encoding-japanese 的编码名是 `'SJIS'` 不是 `'SHIFT_JIS'`（类型系统拦截）
3. 无 main 的词库片段 wasm 产出 0 字节 VMD——morph 注入器靠 isVmd 守卫安全跳过；测试需补 main 再走全管道

### Phase 2 未做（留白）

- mpl2 语法尚未进入 planner/SEGMENT_PROMPT（LLM 还不会主动生成 `offset`/`face`——当前只有词库模板带表情）
- `main` 组合的骨骼碰撞只有静态警告，无自动错峰
- locomotion 原语（walk/turn-around）待词库扩充

## 9. Phase 3 可行性评估（当前仓库状态实测）

结论先行：**三条 Track 难度天差地别。现在就好做的只有 A（音乐对齐）；B（fine-tune）中等；C（text-to-motion）现在做不了——缺推理基础设施 + retarget 工程 + 权许可炸弹。**

### Track A 音乐对齐 — 2~3 天，现在就能做
- 前置已满足：reze-engine 有 `seekAnimation(time)` / `getAnimationProgress(): {duration,...}` → 音画同步前端对表即可，**无需改引擎**
- 还缺：音频素材（版权！）、上传/URL 播放 UI、BPM 检测（webaudio onset 或现成库）、`stitchSegments` 加 beat grid 参数（段长取整到小节）

### Track D 摄取管线（A/B 的共同前置）— ~1 周
- **存储决策（硬前置）**：DB 层已被删（database.ts / pose-publish / upload-image API 均不存在），`@libsql/client`、`@aws-sdk/s3`、`@vercel/blob` 依赖挂空——先决定词库/语料存哪（libsql 回归 / 静态 JSON / 保持 TS 硬编码）
- VMD 清洗 CLI：降采样、去 0° 噪声项、61 词表过滤、拆段（复用 reverse_compile + 现有解析器，1~2 天）
- 版权元数据字段 + 审计流程（风险③）

### Track B fine-tune — 3~5 天 POC，收益要有预期管理
- 前置：训练通道确认（OpenAI 兼容 provider 是否给 fine-tune API / 本地 LoRA 需 GPU）；评测脚本（现有 46 项测试基建可扩展）
- 语料：词库参数扫掠 + LLM 描述改写可秒产几千对合成语料——但模式坍缩风险（§6-⑨）；真实多样性靠 D
- 预期管理：fine-tune 提升**语法可靠性与风格一致性**，对"长动作好不好看"帮助有限（那是词库内容与编排问题）

### Track C text-to-motion — 1~2 人月起，两个硬前置 + 一个炸弹
1. **推理基础设施**：MDM/MotionGPT = Python/PyTorch/GB 级权重；仓库纯 TS、部署 Vercel、无 GPU。需独立推理服务（Modal/RunPod/自托管）；浏览器 ONNX 无现成转换
2. **骨架 retarget**：SMPL/HumanML3D 22 骨 T-pose → MMD 61 骨 A-pose，单位/轴向/足接触处理——最大工作量，出名的脏活
3. **权许可炸弹**：HumanML3D 为 CC BY-NC-SA，主流 text-to-motion 权重多为 non-commercial——popo.love 是公开产品，直接撞风险③
- 务实替代：video-to-motion 商用 API（DeepMotion 等）或社区 VMD（走 D 摄取），都绕开自训模型

### 推荐顺序
~~A（音乐对齐）~~ → D（存储决策 + 摄取，词库扩张引擎）→ B-POC（合成语料）→ C（拿到前三步真实收益数据后再决定投入 retarget 工程）。附带：B 的合成语料脚本可顺带教 LLM mpl2 语法（offset/face），补齐 Phase 2 留白。

## 10. Phase 3 方向修正（用户决策）

1. **砍掉音乐对齐（Track A）**——生成对象不是舞蹈
2. **目标定义为"日常 MMD 动作"**（sit/bow/wave/pick up/look around…），非舞蹈
3. **事实澄清**：原 PoPo 从来没有 text-to-motion 模型——所谓"模型"就是 OpenAI 兼容 API 调的通用 LLM（README: GPT-4o-mini）+ `pose-generate/route.ts` 手写 system prompt（MPL 语法 + 极限表 + few-shot）。仓库实测零训练代码、零权重、零语料。README 的 "fine-tunes LLMs with MPL" 是对通用 LLM 做 MPL 代码生成的方向宣称，仓库中无实现
4. **因此 C（text-to-motion）降级为远期可选**：日常动作是离散语义单元，天然适配已建成的词库+编排路线；diffusion 模型的强项（舞蹈连续性/节奏）恰好不需要；权许可炸弹与 GPU 设施两个最大障碍随之消失。若未来确需"任意动作自由生成"，优先评估 video-to-motion 商用 API 而非自训

修正后的 Phase 3 = 两件事：
- **词库扩张（12 → 30~40 个日常动作）** + 摄取管线。分组清单：头脸（点头/摇头/歪头/环顾/叹气）、手臂（拍手/抱胸/摊手/指向/挠头/比心）、上身（伸懒腰/打哈欠/后仰/前倾）、全身（蹲下/踢腿/踏步/原地走/转身/跳跃/后退）、组合序列（打招呼=鞠躬+挥手、疑问=歪头+摊手、拒绝=摆手+摇头）。来源三路：手写 MPL / 社区日常动作 VMD 摄取 / MiKaPo 图片摆姿 → VPD → MPL
- **B 合成语料 fine-tune**（语法可靠性 + 教 mpl2 语法），前置：存储决策（建议仓库内 JSON 起步）+ 语料生成脚本

## 11. "模型理解"Layer 1+2 实施记录（已完成，FK 8 项测试通过）

背景：用户以"仰面撑地 M 字型 + 臀部摆动"实测暴露了核心缺陷——LLM 猜关节角，没有模型身材与地面的概念，开环生成无法发现"撑得不像"。

### 交付物

| 文件 | 内容 |
|---|---|
| [src/lib/model-geometry.ts](../src/lib/model-geometry.ts) | 共享几何层：位置语义自动检测（absolute/offset，启发式 chainY>3×rawY）、静止世界坐标、measureModelGeometry（身高/腰高/臂长/腿长/锚点高度，1u≈8cm） |
| [src/lib/model-conditioning.ts](../src/lib/model-conditioning.ts) | Layer 1：conditioning 新增 Geometry 段（身高/腰高/臂腿长度/地面 y=0/腰降到地面的 move 量/四肢长度上限），LLM 从"猜角度"升级为"按模型身材推理" |
| [src/lib/fk.ts](../src/lib/fk.ts) | Layer 2：四元数最小集 + `readVmdBoneKeys` + `solveFrameWorld`（逐帧前向运动学，支持绝对/偏移双语义 + VMD 世界系位移）+ `analyzeGroundContactKeys/analyzeGroundContact`（逐帧末端 y、穿地帧计数、人类可读 summary 可直接回填 LLM 修正） |
| [scripts/test-fk.mjs](../scripts/test-fk.mjs) | 8 项：语义检测/测量一致性/conditioning 注入/静止 FK 恒等/蟹式闭环（抓错→修正→验证）/站立足部不漂移/穿地告警/异常稳健 |

### FK 闭环的第一次实战（当轮抓错）

手调蟹式初版 `center move down 6`：FK 算出 **腰 y=-6（穿地）**——因为 `base bend backward 90` 的枢轴在地面，放平后 センター 已在 y≈0。修正为 `move up 3`（抬臀）后 FK 复核：**手腕 y=0.73/0.73（≈6cm 贴地）、足首 y=3.07、腰 y=3.00，0 穿地帧**。目检看不见的错，FK 一轮数值就定位。

### 待做（Layer 2.1 → Layer 3）

- ~~FK 检查接入 pose-generate-long 自愈回路~~ ✅（见 §12）
- Layer 3：mpl2 `plant <bone>;` 接触语法 + 解析 IK（参考 reze-engine `ik-solver.ts`）

## 12. Layer 2.1 自愈回路实施记录（已完成，repair 7 项测试通过）

**闭环形态：生成 → 服务端编译（compileMPL2 全管道）→ FK 地面接触分析 → 穿地段落定位 → 定向 LLM 重生成（≤2 轮）→ 复核**

### 交付物

| 文件 | 内容 |
|---|---|
| [src/lib/server-compile.ts](../src/lib/server-compile.ts) | 服务端 wasm 编译器单例：import.meta.url 邻接文件 → cwd/node_modules 两级候选读字节显式 init；全失败返回 null → 路由优雅跳过检查。`next.config.ts` 加 `serverExternalPackages: ["mmd-mpl"]` 保 wasm 以真实文件存在 |
| [src/lib/pmx-bones.ts](../src/lib/pmx-bones.ts) | `serializePmxBones`/`deserializePmxBones`：客户端骨架随请求上传（topaz ≈50KB JSON），服务端重建 indexByJp，形状校验失败返回 null |
| [src/lib/long-motion.ts](../src/lib/long-motion.ts) | `findOffendingSegments`：FK 穿地帧（centerY<0，30fps→秒）→ 时间轴 → 责任段索引 + 最低腰高 |
| [src/app/api/pose-generate-long/route.ts](../src/app/api/pose-generate-long/route.ts) | Stage 3 后自愈循环（≤2 轮）：compileMPL2 服务端编译 → analyzeGroundContact → findOffendingSegments → **只重生成 LLM/custom 源段**（带 corrective feedback：最低腰 y、穿地时刻、枢轴提示）；词库段穿地 → warning 提示人工修模板；响应新增 `fk: {summary, repairs}` |
| [src/components/chat-input.tsx](../src/components/chat-input.tsx) | 请求携带 `modelBones`（serializePmxBones） |
| [scripts/test-repair.mjs](../scripts/test-repair.mjs) | 7 项：序列化往返/畸形输入/段落定位/阈值语义/服务端编译器/服务端 mpl2 全管道/端到端定位（旧蟹式穿地 → 段 0 责任） |

### 设计取舍

- **只修穿地，不修"悬空"**：悬空是意图相关的（站立挥手的手在 y=10 是正确的），自动修复会大面积误报；悬空留待 Layer 3 的显式 `plant` 语法表达意图
- **词库段穿地不自动改**：模板是手工验证资产，自动改会破坏确定性；记 warning 引导人工调模板（模板调好后所有用户受益）
- **修复预算**：≤2 轮 × 每轮只修穿地段，防止成本失控（风险④）

### 留白

- Layer 3：`plant` 语法 + 解析 IK（把"猜测+检查+修复"升级为"直接求解"）
- 词库段穿地的人工修复流程（warning 已就位）
