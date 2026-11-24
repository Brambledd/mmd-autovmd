# PoPo 管线优化审计 — "理解层已建成，操作层有 6 个断点"

> 2026-11-05 源码排查。背景：用户反馈"项目对模型的操作非常糟糕"。结论：**模型理解层（条件化/FK/付与感知/胶囊审计）已经建成且领先 GitHub 同类生态位，操作质量差的根因在生成/执行层**，以下每条均有源码实证。

## 0. 两个问题的直接回答

1. **当前项目能让 LLM 更好地理解模型吗？** 能，而且这正是 GitHub 生态的空白点（2026-11 探测：无任何 "PMX→LLM 可读摘要/MCP" 项目）。已建成：几何条件化注入 prompt、骨骼覆盖/IK/裙摆检测、付与感知 FK、地面接触自愈、胶囊碰撞自动回退。
2. **操作为什么糟糕？** 理解层没问题，坏在执行链路——好资产没接线、过时指令、缺编译自愈、表达力天花板低、验证是"盲人"。

## 1. 断点清单（源码实证）

| # | 断点 | 证据 | 后果 |
|---|---|---|---|
| 1 | **最好的 prompt 是死代码** | `/api/pose-generate`（含 10 个精调 few-shot 示例）无任何调用方；[chat-input.tsx:54](../src/components/chat-input.tsx#L54) 只调 pose-generate-long | custom 段实际用零示例的 SEGMENT_PROMPT（[pose-generate-long/route.ts:46](../src/app/api/pose-generate-long/route.ts#L46)），生成质量最低配 |
| 2 | **条件化里有过时的反向指令** | [model-conditioning.ts:111](../src/lib/model-conditioning.ts#L111) "morph channel not driven yet — do not emit face commands" | mpl2 早已支持 `face にこり 0.8;`（[mpl2.ts:170](../src/lib/mpl2.ts#L170)，词库 wave_hand 已在用），这条禁令让 custom 段永远不用表情——模型 66/97 个表情 morph 全浪费 |
| 3 | **custom 段无编译自愈** | Stage 2 只查 `.includes("@animation")` 就收下（[route.ts:157](../src/app/api/pose-generate-long/route.ts#L157)）；FK 循环对 `vmd.length===0` 静默 break（[route.ts:184](../src/app/api/pose-generate-long/route.ts#L184)） | 语法错误的片段到客户端 compileMPL2 才炸，用户看到 Error、本次生成作废；"编译错误回传 LLM 修复"回路不存在 |
| 4 | **表达力天花板：词库 13 条 + custom 上限 2** | [motion-lexicon.ts:383-397](../src/lib/motion-lexicon.ts#L383-L397)；[route.ts:148](../src/app/api/pose-generate-long/route.ts#L148) | 复杂请求（词库外动作 >2 个）多余段直接丢弃换 idle_stand，大多数请求实际是"13 个模板循环" |
| 5 | **验证是几何子集，生成是盲的** | FK 自愈只查穿地；[pose-audit.ts](../src/lib/pose-audit.ts) 只查 5 对胶囊 | "手臂方向反了/朝向不对/不像描述"这类视觉错误零闭环；render-pose.mjs 能截图但没接进生成链 |
| 6 | **接触/到达类动作无解** | 语言只有角度（bend/turn/sway），无 plant/reach 语义；Phase 3 ⑦ 解析 IK spike 未开工 | "手叉腰/手扶桌/躺平"只能靠 LLM 瞎猜角度组合，天然不可靠 |

## 2. 优化路线（按性价比排序）

### P0 — 纯接线，一周内可完成，立刻改变体验

1. **few-shot 迁移**：把 pose-generate 的成熟示例（sit down relaxed / hang / punch 等）转成 SEGMENT_PROMPT 的 3-4 个定制段示例，或直接用词库模板反推 few-shot（它们是手工验证过的）。
2. **删 face 禁令**：改写为 `Face morphs available: ... — use "face <名> <0-1>;" with ONLY these exact names`。顺手给 planner 加 face 参数透传（wave_hand 已支持）。
3. **逐段编译自愈**：Stage 2 收下片段前用 getServerCompiler 编译验证；失败把编译错误原文回传 LLM 重试 1 次。`vmd.length===0` 静默 break 至少改成 warning 返回。
4. **custom 上限 2→4**；mpl2.collisions 的 console.warn 改为随响应返回。
5. **眨眼白送**：idle-motion 呼吸循环加 `まばたき` morph 周期（每个模型的 faceMorphs 里都有，vmd-morph 通道现成）——成本最低的"活起来"观感提升。

### P1 — 表达力

6. **词库 13→30+**：按 docs/long-motion-roadmap.md §10 分组扩张；把 route.ts 死代码里的成熟模板批量转词库条目（顺带支持 face/offset 语法）。
7. **mpl2 加目标驱动语句**：`plant <bone>;` / `reach <bone> to <target>;`，编译期用解析 IK 求解（reze ik-solver 参考）——比教 LLM 空间角度推理可靠一个数量级，是接触类动作的根治方案。

### P2 — 把盲生成变睁眼

8. **视觉自愈回路**：生成后渲染 1 帧截图 → 视觉模型判"是否符合描述"→ 差异回传定向重生成（1 轮即可大幅减少"看起来不对"）。render-pose.mjs 已具备出图能力。
9. **corpus RAG few-shot**：motion-corpus 摄入管线已建成；用户手工修正过的（描述→最终 MPL）对入库，custom 生成前检索 top-2 注入。

### P3 — 引擎级（远期）

10. ⑦ 手臂 IK 接入点 spike（reze 0.6.6 `IKSolverSystem.solve` 已导出，`solveIKChains` 为 private，1 天可行性验证）。
11. ⑧A blend 叠加需升级 reze master。

## 3. 一句话总结

> 项目已经站在 GitHub 无人占据的"PMX→LLM 语义摘要"正确位置上；"操作糟糕"不是因为不懂模型，而是因为**最好的 few-shot 没接线、表情通道被过时禁令封死、语法错误没有编译期自愈、词库+custom 上限太低、生成全程盲检**。P0 五项全是接线级改动，改完即可显著见效。
