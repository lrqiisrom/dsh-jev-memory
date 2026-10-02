# 两个工业界 agent 记忆系统的调研笔记（对照 dsh-jev-memory）

调研对象：

1. **TencentDB-Agent-Memory**（腾讯云）— <https://github.com/TencentCloud/TencentDB-Agent-Memory>
2. **OpenViking**（字节跳动 / 火山引擎）— <https://github.com/volcengine/OpenViking>

方法：`git clone --depth 1` 到 `/tmp` 后逐文件核对源码，配合官方博客与 GitHub API。仓库快照：
腾讯 `29bb8dffa9b11617316d50f21d7a8af9f47240be`（分支 `feat/server_team`，2026-09-28）；字节 `af11ccb1d7fc9b65f6d77c966e65953c0ed6282b`（分支 `main`，2026-09-29）。元数据抓取时间：2026-09-29。

本文只写**可验证的事实**：每条结论后跟来源链接。凡属推断标 `(推断)`，查不到写"未找到"，不用常识补。

---

## 结论摘要

1. 两家都**不是插件，是独立服务**：腾讯是团队级"记忆资产平台"（Chat Memory / Skill / Wiki / CodeGraph 四类资产），字节是"上下文数据库"（`viking://` 虚拟文件系统 + 向量索引）。接进 agent 都要先起进程（[腾讯 README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)、[OpenViking README_CN](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)）。
2. 记忆分类两家都做**分层**：腾讯 L0 对话 / L1 原子 / L2 场景 / L3 画像，L1 再分 3 类（chat）或 4 类（work）；字节 Resource / Memory / Skill 三类型 × L0 摘要 / L1 概览 / L2 详情三层，Memory 下 **11 个 YAML schema（9 启用 / 2 禁用）**（[腾讯 l1-writer.ts:31](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/record/l1-writer.ts#L31)、[字节 templates/memory/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/prompts/templates/memory)）。
3. 写入都由 **LLM 抽取**决定，不是全量落盘，但**两家都没有确定性的"值不值得记"硬闸门**——腾讯把"宁缺毋滥 / priority<50 丢弃"写在 prompt 里，代码里 grep 不到 priority 阈值判断；字节的提取协议里**根本没有"不记这条"的输出位**，只能返回空操作（[腾讯 l1-extraction.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-extraction.ts)、[字节 json_protocol.py:87](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/extraction_output_protocol/json_protocol.py#L87)）。
4. 冲突处理**两家都强于我们**：腾讯有 `store/update/merge/skip` 四动作 + 跨类型、多目标合并；字节有 `merge_policy`（同一 identity 才合并 + 原子事实守恒 + 超大则拆分），且改名撞 URI 时**整批报冲突、拒绝覆盖**（[腾讯 l1-dedup 提示词](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-dedup.ts)、[字节 merge_policy.py](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/merge_policy.py)）。
5. 召回三家三条路线：腾讯 **RRF k=60**（或 TCVDB 服务端混合，无 rerank）；字节 **不是 RRF**——dense/sparse 用单一 `sparse_weight`（默认 0，即纯 dense），目录范围下推为向量前置过滤，再叠可选 rerank（[腾讯 auto-recall.ts:733](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L733)、[字节 hierarchical_retriever.py:165](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L165)）。
6. **评测差距极大**：腾讯仓库里**没有任何评测代码、数据集或结果文件**，PersonaMem 48%→76% 只出现在 README 与官方博客；字节有 `benchmark/` 11 个子集与可复现脚本，但**该目录下零结果文件**，那 10 个公开数字在 `*.md/*.py/*.sh/*.yaml/*.json/*.csv` 全仓 grep 里只命中 3 行 README 图片 alt 文本 + 2 个 SVG（[腾讯 README_CN](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)、[字节 benchmark/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark)）。
7. 字节的**方法学明显更硬**：`memory_organization` 用**无 LLM 的确定性 grader** + 配对 A/B + 双侧 McNemar 精确检验 + 两个刻意正交的指标，并自带"旧结果不得当证据"的声明；这是唯一一处"指标定义写清到能直接抄"的地方（[memory_organization/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/memory_organization/README.md)）。
8. 两家的公开数字**都不可用默认配置复现**：字节 issue #1258 里第三方跑 LoCoMo 只得 7.66%，维护者承认"插件默认检索值较低"，要手动把 `recallLimit` 调到 30 才拿到 80%+；腾讯则连脚本都没给（[issue #1258](https://github.com/volcengine/OpenViking/issues/1258)）。
9. **两家都进了 DSH，而且字节和我们用同一个扩展点**：OpenViking 官方有 `@openviking/dsh-memory-plugin`，它把召回**追加到 `agent/pre-step` 的消息里、刻意不进 system prompt**，理由是 DSH 里声明 `complete: true` 的 preset 会**静默丢弃其他 prompt section**。这条我们必须自己验证（[dsh-memory-plugin README](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/README.md#L111)）。
10. 我们只有 28 个历史会话、约 1000 条真实候选，**做不了他们那种端到端评测**（他们要公开数据集 + LLM judge + 数百次采样）；能抄的是**指标定义形式与统计检验结构**，数据集必须自己标。详见 §关于评测。

---

## TencentDB-Agent-Memory

仓库：<https://github.com/TencentCloud/TencentDB-Agent-Memory>（README 里的链接仍写 `github.com/Tencent/...`，是同一仓库的重命名别名）。
相关文档：[README_CN.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)、[INSTALL_CN.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/INSTALL_CN.md)、[ROADMAP_CN.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/ROADMAP_CN.md)、MemoryCore 源码。

### 分类

四层，逐层沉淀，README 明确给了每层的职责与用途：

| 层级 | 保存什么 | 用途 |
|---|---|---|
| L0 Conversation | 原始对话与完整上下文 | 核对原话、时间和来源 |
| L1 Atom | 从对话提取的事实、偏好、约束与事件 | 精确召回可执行信息 |
| L2 Scenario | 围绕项目或场景组织的知识块 | 快速恢复一个工作场景 |
| L3 Core / Persona | 长期画像、稳定模式与高层认知 | 让 Agent 迅速进入用户与团队语境 |

→ 出处：[README_CN.md:250-258](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)、[MemoryCore/README_CN.md:5](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/README_CN.md)

**L1 的实际类型是两套**（代码里的联合类型，不是文档描述）：

```ts
export type MemoryType =
  | "persona" | "episodic" | "instruction"          // chat 模式
  | "work_fact" | "work_task" | "work_method" | "work_artifact";  // work/团队模式
```

→ 出处：[l1-writer.ts:31-38](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/record/l1-writer.ts#L31)

注释还记了一次真实的类型收敛：**v3 把 `preference` 从 4 类减到 3 类，折进 `persona`** → 出处：[l1-writer.ts:53](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/record/l1-writer.ts#L53)

每类的定义与打分档位写在提取 prompt 里，可直接对照（[l1-extraction.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-extraction.ts)）：

- **persona**（个性化记忆）：稳定属性、偏好、技能、价值观、习惯；句式"用户（[姓名]）喜欢/是/擅长…"；priority 80-100（健康/禁忌/核心特质）、50-70（一般喜好）、**<50 丢弃**；
- **episodic**（客观事件记忆）：客观发生的动作、决定、计划或达成结果，"绝不包含纯主观感受"；要求推算绝对时间并写入 `metadata.activity_start_time / activity_end_time`（ISO 8601）；priority 80-100 / 60-70、**<60 丢弃**；
- **instruction**（全局指令记忆）：对 AI 的长期行为规则、格式偏好、语气控制；priority **-1 = 极其严格的全局死命令**、90-100 / 70-80、**<70 丢弃**。
- work 模式的四类：`work_fact`（项目事实/需求/决策/状态/风险/约束/实验结果/客户反馈）、`work_task`（待办/owner/deadline/下一步）、`work_method`（SOP/禁忌/原则/经验/设计思路/Agent 行为规则）、`work_artifact`（文档/PR/Issue/Prompt/报告/分支/设计稿/链接）→ 出处：[WORK_CONFLICT_DETECTION_SYSTEM_PROMPT](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-dedup.ts)

**"什么都不要记"有三层机制**：

1. **prompt 级否决**——提取 prompt 有独立的"不应该提取的内容"段：琐碎闲聊、问候、临时性纯工具性请求（"这次帮我翻译一下"）、一次性操作指令、重复内容、AI 自身行为输出、不属于 3 类的信息、纯主观感受；总原则写的是"宁缺毋滥" → 出处：[l1-extraction.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-extraction.ts)（原文："宁缺毋滥：过滤琐碎闲聊、临时性指令和一次性操作"）
2. **schema 级 skip**——冲突检测 LLM 可对单条新记忆判 `"skip"`（"已有记忆更好，新记忆无增量或更模糊，忽略当前记忆"）→ 出处：[l1-dedup.ts 提示词](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-dedup.ts)
3. **运维级 kill switch**——MemoryProxy 的 `extraction: { enabled, extractors: [...] }`，`enabled:false` 拒绝一切抽取，`extractors:[]` 拒绝一切，可只放行 `["skill"]`；配置缺失时**故意宽松**（allow all）以免误关 → 出处：[extraction-gate.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryProxy/src/extraction-gate.ts)

> **反直觉的一条**：priority 阈值（<50/<60/<70 丢弃）**只存在于 prompt 文字里**，代码里没有任何地方拿 priority 做写入闸门。全仓 grep `priority` 只命中一处展示用途：`memory-search.ts:194` 的 `(priority: ${item.priority})` → 出处：[memory-search.ts:194](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/tools/memory-search.ts#L194)。**"值不值得记"完全交给抽取 LLM 自觉。**

### 写入路径

完整链路（每一步都有源码位置）：

```
agent_end 钩子
  └─ performAutoCapture()            ← 只做 L0，不做抽取
       ├─ checkpoint.captureAtomically(...)  原子：读游标 → 写 L0 → 推游标（文件锁内）
       ├─ L0 向量索引（sqlite 走 fire-and-forget 后台 embed；VDB 走同步 embed）
       └─ scheduler.notifyConversation(sessionKey, [])   ← 只通知，不抽取
            └─ MemoryPipelineManager 决定何时触发 L1
                 ├─ 会话数阈值 everyNConversations（默认 5）+ warmup（1→2→4→8…）
                 ├─ 或空闲 l1IdleTimeoutSeconds（默认 60s）兜底
                 └─ L2：L1 完成后延迟 90s；min 900s / max 3600s 轮询；会话静默 24h 停止
                      └─ L3：PersonaTrigger 五条件（显式请求 / 冷启动 / …）
```

→ 出处：[auto-capture.ts:1-11](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-capture.ts#L1)（注释原文："Extraction is NOT triggered here. The pipeline manager decides when."）、[pipeline-manager.ts:37-68](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/utils/pipeline-manager.ts#L37)、[persona-trigger.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/persona/persona-trigger.ts)

**是异步后台抽取**：钩子只写 L0 + 通知，抽取由 pipeline manager 在后台批量跑 → 出处同上 [auto-capture.ts:305-308](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-capture.ts#L305)。

**谁决定"这条值得记"**：抽取 LLM（一次调用同时做"情境切分 + 记忆提取"）→ 出处：[l1-extraction.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-extraction.ts)（"System prompt handles scene segmentation + memory extraction in a single LLM call"）。

**去重/合并/冲突**：两阶段批量处理 → 出处：[l1-dedup.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/record/l1-dedup.ts)

1. **Phase 1（快，无 LLM）**：对每条新记忆做候选召回，`conflictRecallTopK` 默认 **5**；用的是和 memory_search 同一套混合检索（native hybrid，否则 FTS ∥ client-vector + RRF）；隔离按会话；
2. **Phase 2（一次 LLM 调用判全部）**：输出每条新记忆的 `action` ∈ `store | update | merge | skip`，带 `target_ids` 数组（支持一条新记忆替换/合并**多条**旧记忆）、`merged_content`、`merged_type`、`merged_priority`、`merged_timestamps`；
3. **fast path**：若既无 FTS 又无向量数据，**冲突检测整体跳过，全部直接 store** → 出处：[l1-dedup.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/record/l1-dedup.ts)（"No vector data and no FTS available, skipping conflict detection for ${memories.length} memories"）
4. 落盘按 decision 执行：`store` 追加；`update`/`merge` 删旧 + 追加合并结果；`skip` 什么都不做 → 出处：[l1-writer.ts:152-161](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/record/l1-writer.ts#L152)

> **和我们最大的分野**：`merged_content` 是**判定层生成的文本**。我们的纪律是"模型不写"，腾讯这里恰恰相反——合并/更新必须由模型写出新正文。设计理由是它要支持跨类型合并（"episodic 用户在 2018 年开始做播客" + "persona 用户有播客制作经验" → 合并成一条）→ 出处：[l1-dedup.ts 提示词](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-dedup.ts)

L2/L3 的生成也是 LLM 写文件：L2 用 read/write/edit 工具在 `scene_blocks/` 沙箱内维护场景 md（**删除是写 `[DELETED]` 标记的软删除**，之后由 SceneExtractor unlink）；L3 由 Persona Architect 写 `persona.md`（首次 `write`，增量 `edit`）→ 出处：[scene-extraction.ts:1-22](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/scene-extraction.ts#L1)、[persona-generation.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/persona-generation.ts)

### 召回路径

策略三选一，默认 hybrid，**没有 rerank 模型**（全仓未找到 rerank 相关实现）：

| 策略 | 实现 | 依赖 |
|---|---|---|
| `keyword` | FTS5 BM25；**没有内存兜底**（避免 O(N) 全扫） | SQLite FTS5 |
| `embedding` | 向量余弦 | EmbeddingService |
| `hybrid`（默认） | keyword ∥ embedding 并行 + **RRF 合并，k=60** | 两者 |

→ 出处：[auto-recall.ts:1-11](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L1)、[auto-recall.ts:645-780](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L645)

短路径：若 store 自报 `nativeHybridSearch`（TCVDB 服务端 dense+sparse+RRF），直接一次 API 调用，省掉本地 embed 与第二次请求 → 出处：[auto-recall.ts:507-518](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L507)

**配额与阈值**（都是 config 默认值，源码可查）：

| 参数 | 默认 | 出处 |
|---|---|---|
| `recall.maxResults` | **5** | [config.ts:596](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/config.ts#L596) |
| `recall.scoreThreshold` | **0.3** | [config.ts:599](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/config.ts#L599) |
| `recall.strategy` | `hybrid` | [config.ts:600](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/config.ts#L600) |
| `recall.timeoutMs` | **5000**（超时返回结构化 error，不是 undefined） | [auto-recall.ts:107](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L107) |
| `recall.maxCharsPerMemory` / `maxTotalRecallChars` | **0 = 关闭** | [config.ts:597-598](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/config.ts#L597) |

有一个**诚实的小文档集补丁**值得记：BM25 在 1–3 条记录时 IDF→0、绝对分不可靠，所以当 FTS 原始命中数 ≤ maxResults 时**无视阈值直接返回** → 出处：[auto-recall.ts:560-569](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L560)

**注入到哪**——按 prompt 缓存友好切分，这点我们没做：

- `appendSystemContext`（system prompt 末尾，**稳定可缓存**）：L3 persona（`<user-persona>`）、L2 scene navigation（`<scene-navigation>`）、记忆工具使用指南；
- `prependContext`（**user prompt 前缀，每轮都变**）：L1 相关记忆（`<relevant-memories>`）——刻意移出 system prompt 以免击穿缓存；
- L2 是**全量注入**（注释原文 "L2 scene navigation (full injection, LLM decides relevance)"），没找到字符上限 `(未找到)`。

→ 出处：[auto-recall.ts:259-291](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L259)

**工具化召回**：注入块尾部固定附 `<memory-tools-guide>`，告诉模型可调 `tdai_memory_search`（L1）与 `tdai_conversation_search`（L0），并**硬性限次**："每轮对话中…合计最多调用 3 次" → 出处：[auto-recall.ts:41-54](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L41)

MemoryProxy 侧的接法不同（表见 [MemoryProxy/README_CN.md:56-73](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryProxy/README_CN.md)）：L2/L3 **直接注入 system prompt**，L0/L1 **通过只读工具接口**暴露给模型主动查询——注释理由是"避免破坏上游 KV cache"。

### 存储与依赖

- **默认纯本地**：SQLite + 本地文件 + 进程内状态，默认监听 `127.0.0.1:8420`，数据目录 `~/.memory-tencentdb/memory-tdai`；"除 LLM API 外没有必需的外部服务"；**默认关闭远程 Embedding，用 BM25 召回** → 出处：[MemoryCore/README_CN.md:42-50](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/README_CN.md)
- **DB 后端三选一**：`sqlite | tcvdb | mongodb`（TCVDB = 腾讯云向量数据库；MongoDB 为试验特性，默认关闭）→ 出处：[backend-selection/types.ts:20](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/backend-selection/types.ts#L20)、[README_CN.md:48](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)
- **文件后端三选一**：`local | cos | rowfs`（COS = 腾讯云对象存储；`mongofs` 把字节全放 Mongo，零磁盘）→ 出处：[backend-selection/types.ts:30-56](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/backend-selection/types.ts#L30)
- **运行时**：Node.js `>= 22.16.0`；**需要一个 OpenAI-compatible LLM API**——"只读查询可以不触发 LLM，但记忆抽取和归纳需要有效凭证" → 出处：[MemoryCore/README_CN.md:52-56](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/README_CN.md)
- **能纯本地跑吗**：能（SQLite + local + BM25，无需 embedding 服务），但**抽取/归纳必须有 LLM**；把 `TDAI_LLM_BASE_URL` 指向本地 OpenAI-compatible 服务即可离线 `(推断)`。

### 评测

> **结论：腾讯仓库内不存在任何记忆质量评测。** 对全仓（排除 `.git`/`node_modules`）grep `personamem` 只命中两处，都是 README 的表格行：[README.md:275](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README.md#L275)、[README_CN.md:277](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md#L277)。仓库里唯一的 `bench*` 是 `MemoryCore/scripts/bench-l0-mongo/`，那是 **L0 在 MongoDB 上的延迟/吞吐压测**（nearest-rank 百分位 p50…p99.9、max、mean、ops/s），与记忆质量无关 → 出处：[metrics.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/scripts/bench-l0-mongo/metrics.ts)

**数字从哪来**：官方博客（腾讯云开发者社区，腾讯云 NoSQL 技术账号，2026-05-13）给出了完整表格——<https://cloud.tencent.com/developer/article/2668579>

| 记忆能力 | Benchmark | 无插件成功率 | 加插件后 | 相对变化 | Token 消耗 | 加插件后 | 相对变化 |
|---|---|---|---|---|---|---|---|
| 短期记忆 | WideSearch | 33% | 50% | **+51.52%** | 221.31M | 85.64M | **−61.38%** |
| 短期记忆 | SWE-bench | 58.4% | 64.2% | +9.93% | 3474.1M | 2375.4M | −33.09% |
| 短期记忆 | AA-LCR | 44.0% | 47.5% | +7.95% | 112.0M | 77.3M | −30.98% |
| 长期记忆 | **PersonaMem** | **48%** | **76%** | **+59%** | — | — | — |

→ 出处：同上博客；PersonaMem 评测集外链指向第三方仓库 <https://github.com/bowen-upenn/PersonaMem>

**这份评测缺什么（逐条对照我们的清单）**：

| 该有的 | 腾讯的情况 |
|---|---|
| 指标定义 | **未找到**。博客只写"准确率""成功率"，没有定义分母、判分方式、是否 LLM judge |
| 数据来源 | 评测集名给了（PersonaMem/WideSearch/SWE-bench/AA-LCR），PersonaMem 指向公开仓库；其余三个的**具体版本与切分未找到** |
| 具体数字 | 有（上表），但没有置信区间、没有采样次数 |
| 对照基线 | 有（"无插件"的 OpenClaw 原生记忆、同一 LLM 无记忆） |
| 复现脚本 | **未找到**。仓库里没有，博客也没给 |
| 作者自证局限 | **未找到**。README 的"注意事项"只提 Wiki/CodeGraph 异步构建与私有仓库支持，不涉及评测 |
| 评测对象 | 博客明确是**作为 OpenClaw 记忆插件接入**的版本（+ 上下文卸载 + Mermaid 画布两项技术），与我们关心的"写入判定质量"不是同一个量 |

> 也就是说：**PersonaMem 48→76 是一个无法独立复核的营销数字**。它不假，但它既不可复现，也不回答"记错了多少条"。

### 冲突 / 过期 / 遗忘

- **冲突**：写入时的 `update/merge`（LLM 判，见上）。合并后 priority 规则写进 prompt："合并后信息更完整、更确定，通常应**酌情提升** priority（例如两条 70 的可升到 80）" → 出处：[l1-dedup.ts 提示词](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/prompts/l1-dedup.ts)
- **时间线保留**：`merge/update` 时 `merged_timestamps` 要求是"所有相关记忆时间戳的**并集**（去重排序）"，用来保留完整时间线 → 出处同上
- **过期**：**L1/L2/L3 没有 TTL、没有衰减、没有 expire**——全仓 grep `expire|ttl` 的命中全在 Skill 版本管理（`skill-core.ts:519-696`，非 head 版本按 `versionTtlSeconds` 过期，head 永不过期）→ 出处：[skill-core.ts:682](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/skill/skill-core.ts#L682)
- **遗忘**：有删除 API（`/v2/atomic/*`、`/v3/atomic/*` 的 delete；列表见 [MemoryCore/README_CN.md:174-188](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/README_CN.md)），没有自动遗忘策略
- **HITL**：**未找到面向记忆的确认/审批机制**。Proxy 里的交互式表单（team → agent → task 选择）是会话初始化，不是记忆审核 → 出处：[MemoryProxy/README_CN.md:25-38](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryProxy/README_CN.md)
- **作者自己承认的坑**（ROADMAP 原文）："自动抽取的记忆不会永远正确 —— 事实过期、结论被推翻、抽取本身也可能有偏差。**目前面板只能查看和删除，无法修正**"，编辑 L1-L3 排在 v2.0.1 → 出处：[ROADMAP_CN.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/ROADMAP_CN.md)

### 隔离与隐私

- **三维强隔离，默认强制**：`IsolationContext { teamId?, userId, agentId, sessionId }`，`DEFAULT_ISOLATION_CONFIG.enforce = true`——写入缺字段直接**抛错**（除非开 `legacyCompatMode` 填 `__legacy__`）；查询侧用 `IsolationFilter` 逐维收窄 → 出处：[isolation.ts:1-75](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/store/isolation.ts#L1)
- v3 数据面要求 `team_id`/`agent_id`/`user_id`，可走 body 或 `x-tdai-*` header；`session_id` 可选 → 出处：[MemoryCore/README_CN.md:190](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/README_CN.md)
- **资产可见性四级**：`private`（只有 Owner，团队管理员也不行）/ `team` / `restricted`（User/Role/Agent ACL）/ `agent`（同团队 Agent 定向装配）；"新 Chat Memory 和 Skill 默认私有。分享是一个明确动作，不是默认泄漏" → 出处：[README_CN.md:230-239](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)
- 召回路径也带隔离：L2/L3 profile 按 `team+agent` scope 落盘，"recall resolves the same scope and never falls back to the unscoped data root, preventing cross-scope profile reads" → 出处：[auto-recall.ts:163-175](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/src/core/hooks/auto-recall.ts#L163)
- **数据会不会离开机器**：默认不会（SQLite + localfs）；一旦选 TCVDB / COS / mongofs，内容与向量就落到腾讯云 `(推断：这些是腾讯云产品的自托管 SDK 端点，需自行配置连接)`

### 成熟度

抓取于 2026-09-29，来源 [GitHub API](https://api.github.com/repos/TencentCloud/TencentDB-Agent-Memory)：

| 事实 | 值 |
|---|---|
| Star / Fork | **27,453** / 2,643 |
| Open issues | **856** |
| 创建 / 最近推送 | 2026-04-07 / **2026-09-29** |
| Archived | `false` |
| 默认分支 | `feat/server_team`（不是 main） |
| 主语言 | TypeScript（约 20 万行 `.ts`）+ Python（约 9 千行） |
| 版本 | README 写"当前版本 v2.0.0"；ROADMAP 写"当前版本 v2.0.1-beta.1" |

- **License 有个坑**：`LICENSE` 正文写 "TencentDB Agent Memory is licensed under the MIT."，但 GitHub API 报 `NOASSERTION / Other`——因为文件开头是腾讯自加的版权前言，GitHub 识别不出标准 MIT 模板。**实际协议是 MIT** → 出处：[LICENSE](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/LICENSE)
- **是产品不是原型**：有云上托管版（问卷入口）、Docker Hub 镜像、npm 包 `@tencentdb-agent-memory/memory-tencentdb`、多 Agent 接入矩阵、迁移工具（v2→v3）、CONTRIBUTING/Discussions、承诺 issue 24 小时内响应 → 出处：[README_CN.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)
- 856 个 open issue 对 2.7 万 star 偏高 `(推断：产品面铺得宽——四类资产 + 面板 + 代理 + 多 Agent 适配)`

### 与 agent 的接线

| 方式 | 说明 | 出处 |
|---|---|---|
| **OpenAI-compatible Proxy**（首推） | 把 Agent 的 base URL 指向 Proxy 即可，"不需要插件、Hook 或 MCP Server"；**官方支持 DSH** | [README_CN.md:56-58](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md)、[agents/dsh/README.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/agents/dsh/README.md) |
| OpenClaw 插件 | `openclaw plugins install @tencentdb-agent-memory/memory-tencentdb` | [README_CN.md:32-44](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/README_CN.md) |
| Hermes Memory Provider | `hermes-plugin/`，Docker 镜像 `agentmemory/hermes-memory` | 同上 |
| SDK | TypeScript / Python（`sdk/memory-core/`） | [MemoryCore/README_CN.md:161-167](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryCore/README_CN.md) |
| MCP | **只有知识侧**：`MemoryKnowledge/src/mcp/` 暴露 `code_search` / `code_explore` / `code_callers` / `code_callees` / `code_impact` / `wiki_search` / `wiki_read` / `wiki_list` / `wiki_graph`——**记忆本身不走 MCP** | [MemoryKnowledge/src/mcp/tools.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/MemoryKnowledge/src/mcp/tools.ts) |

**DSH 的具体接法**（和我们直接相关）：`~/.dsh/settings.yaml` 里把 `baseURL` 指到 `http://127.0.0.1:8096/dsh/<spaceId>`，**尾巴不加 `/v1`**（dsh 硬编码 `${baseURL}/chat/completions`），key 走 `~/.dsh/.credentials.yaml` 的 `PROXY_USER_KEY`；session id 从 `x-deepseek-harness-session-id` / `x-session-id` header 取，**没有 body 兜底** → 出处：[agents/dsh/README.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/29bb8dffa9b11617316d50f21d7a8af9f47240be/agents/dsh/README.md)

> **对我们的意义**：腾讯和我们在 DSH 里**不冲突但会互相干扰**——它走网络代理层（改 baseURL），我们走进程内插件（`systemPrompt.context`）。若两个都开，同一个会话会有两份记忆注入：它注入 L2/L3 + L1，我们注入类型化 Top-K。这是"双份注入"风险的第二个来源（第一个是 `@zilliz/memsearch-dsh`，见 [DESIGN.md §7](https://github.com/TencentCloud/TencentDB-Agent-Memory) 的同类记录）。

---

## OpenViking

仓库：<https://github.com/volcengine/OpenViking>。
相关文档：[README_CN.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)、`docs/zh/concepts/*`、[benchmark/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark)。

规模：Python 约 1940 个文件 + Rust 150（`crates/ragfs`、`ov_cli`）+ C++（`src/index/` 索引引擎）+ TS/TSX 566（Web Studio）+ Go SDK 21。是一个**多语言系统**，不是脚本集合。

### 分类

**三个正交维度**，别混：

**(a) 上下文类型 3 种**（[02-context-types.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/02-context-types.md)）：

| 类型 | 用途 | 生命周期 | 主动性 |
|---|---|---|---|
| Resource | 知识和规则（API 文档、代码仓库、论文） | 长期，相对静态 | 用户添加 |
| **Memory** | Agent 的认知 | 长期，动态更新 | **Agent 记录** |
| Skill | 可声明的 agent 能动性配置 | 长期，静态 | 用户或系统添加 |

代码里是真的枚举，不是文档转述：`ContextType{SKILL, MEMORY, RESOURCE}`（[core/context.py:26-31](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/core/context.py#L26)）；`memories/` **只属于 user scope**，不存在可写的 `viking://agent/memories`（[core/namespace.py:14-17](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/core/namespace.py#L14)：`"user": {"memories": "memory", ...}` / `"agent": {"skills": "skill"}`）。

**(b) 信息层级 3 层**——同样是代码枚举 `ContextLevel{ABSTRACT=0, OVERVIEW=1, DETAIL=2}`（[core/context.py:34-39](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/core/context.py#L34)），URI 后缀映射写死在检索器里（`LEVEL_URI_SUFFIX = {0: ".abstract.md", 1: ".overview.md"}`，[hierarchical_retriever.py:60](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L60)）：

| 层级 | 文件 | 默认正文上限 | 用途 |
|---|---|---|---|
| L0 摘要 | `.abstract.md` | **256 字符** | **向量检索**、快速过滤 |
| L1 概览 | `.overview.md` | **4000 字符** | **Rerank**、内容导航 |
| L2 详情 | 原始文件 | 无统一上限 | 完整内容，按需加载 |

上限来自配置而非文档：`abstract_max_chars: int = 256` / `overview_max_chars: int = 4000` → 出处：[parser_config.py:715,718](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/parser_config.py#L715)。**注意 README 说的 "~100 tokens / ~2k tokens" 与代码的 256/4000 字符不是同一口径。**

关键设计：**L0/L1 是目录级 sidecar，不是每个文件一份**；L0 从 L1 正文里抽取（取 H1 之后、第一个 `##` 之前的段落），frontmatter 不参与；目录摘要默认采样上限 `semantic.overview_sample_limit = 32`，超过则稳定采样 → 出处：[03-context-layers.md:13](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/03-context-layers.md#L13)、[semantic_processor.py:384](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/queuefs/semantic_processor.py#L384)。**memory 目录不冒泡生成父级 L0/L1**（父级冒泡只用于 resource/skill）→ 出处：[03-context-layers.md:174](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/03-context-layers.md#L174)

**(c) Memory 下 11 个内置 YAML schema（9 启用 / 2 禁用）**——真源是 `openviking/prompts/templates/memory/*.yaml`，不是文档表格。每个 schema 有一等字段 `operation_mode`（`upsert` / `add_only`）、`stage`（`user` / `agent`）、`peer_enabled` → 出处：[dataclass.py:239-249](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/dataclass.py#L239)

| memory_type | 默认位置 | operation_mode | stage | enabled | 说明 |
|---|---|---|---|---|---|
| profile | `~/memories/profile.md` | upsert | user | ✅ | 用户基本信息（每条 bullet 带 `(as of YYYY-MM-DD)`） |
| preferences | `~/memories/preferences/{user}/{topic}.md` | upsert | user | ✅ | 按主题组织的偏好 |
| entities | `~/memories/entities/{category}/{name}.md` | upsert | user | ✅ | 人物、项目、组织等实体知识 |
| events | `~/memories/events/{年}/{月}/{日}/{event_name}.md` | **add_only** | user | ✅ | 决策、里程碑等事件 |
| identity | `~/memories/identity.md` | upsert | user | ✅ | 助手名称、形象、气质、自我介绍 |
| soul | `~/memories/soul.md` | upsert | user | ✅ | 助手核心原则、边界、风格、连续性 |
| cases | `~/memories/cases/{case_name}.md` | upsert | user | ✅（`peer_enabled: false`） | 训练/评估用任务案例 |
| trajectories | `~/memories/trajectories/{name}_{timestamp}.md` | **add_only** | **agent** | ✅ | 可复用任务执行轨迹 |
| experiences | `~/memories/experiences/{name}.md` | upsert | **agent** | ✅ | 从执行结果提炼的可复用经验 |
| skills | `~/memories/skills/` | — | — | ❌ **禁用** | `memories/skills/` 与独立 Skill 是两回事 |
| tools | `~/memories/tools/` | — | — | ❌ **禁用** | |

→ 出处：[templates/memory/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/prompts/templates/memory)（逐文件核对 `enabled` / `operation_mode` / `stage` / `peer_enabled`）；`stage` 缺省推导规则见 [memory_type_registry.py:191-195](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/memory_type_registry.py#L191)（有 `agent_only: true` → `agent`，否则 `user`）

**检索侧另有一套只有 4 类的配额桶**：`MEMORY_CATEGORIES = ("events", "entities", "preferences", "experiences")`，其余归入 `OTHER_MEMORY_CATEGORY = "memories"` → 出处：[context_assembler/params.py:16,22](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/params.py#L16)。**"能写 9 类"和"召回时分 4 类配额"是两个不同的切分。**

每个字段还带 `merge_op`（`patch` / `replace` / `sum` / `immutable`）→ 出处：[merge_op/base.py:121-127](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/merge_op/base.py#L121)。例：preferences 的 `user`/`topic` 是 `immutable`（即**身份键不可改，改名撞已有 URI 就冲突**），`content` 是 `patch`。

**"什么都不要记"的实际情况比文档说的少**——这是本次调研最重要的发现之一：

1. **LLM 侧根本没有"不记这条"的输出位**。提取协议只提供 写 / 改 / 删 现有记忆三种操作；"没有变更"的表达方式是**返回全空的 JSON 形状**，而不是一条 `skip` 决策 → 出处：[extraction_output_protocol/json_protocol.py:87-93](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/extraction_output_protocol/json_protocol.py#L87)、[dataclass.py:532](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/dataclass.py#L532)（`return len(self.write_uris) == 0 and len(self.edit_uris) == 0 and len(self.delete_ids) == 0`）
2. **系统级 skip 是 9 个固定 reason code**，全部关于**隔离/越权/范围非法**，与"这条值不值得记"无关：`MEMORY_TYPE_FILTERED`、`SELF_MEMORY_DISABLED`、`PEER_MEMORY_DISABLED`、`INVALID_PEER_ID`、`PEER_NOT_ALLOWED`、`INVALID_RANGES`、`AMBIGUOUS_TARGET`、`NO_WRITABLE_TARGET`（+ 一个内部类型过滤）→ 出处：[dataclass.py:173-184](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/dataclass.py#L173)、[memory_isolation_handler.py:25-46](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/memory_isolation_handler.py#L25)
3. **真正可用的 opt-out 在 harness 插件层**：`captureFilters` 支持 `d|pattern|` 正则丢弃消息，但**默认是空列表** → 出处：[input-filters.mjs:3-7](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/memory-plugin-shared/lib/input-filters.mjs#L3)、[config-schema.mjs:147](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/memory-plugin-shared/lib/config-schema.mjs#L147)（`{ name: "captureFilters", ... default: [], ... }`）
4. **prompt 级软约束**存在且写得不错：profile.yaml 的 "A temporary mood/state, current task, speculative inference, role-play, assistant-only claim, or trivial detail -> **discard**"、"Never infer attributes from assistant text, jokes, hypotheticals, or role-play"、"do not infer personality from behavior"（[profile.yaml:24-37](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/prompts/templates/memory/profile.yaml#L24)）；skills 侧 SKILL.md 写 "What not to persist: secrets and credentials, transient state, speculation, or bulk transcript dumps — store conclusions, not scrollback."（[SKILL.md:77-80](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/agent-plugins/skills/openviking-memory/SKILL.md#L77)）

> **`no_store` / `opt_out` / `do_not_store` 作为配置、API 或 schema 字段：未找到。** 对比我们：我们把否决做成了**代码里的确定性 `veto:*` 原因码并写进台账**，OpenViking 把否决留给 prompt 自觉 + 一个默认关闭的正则开关。

### 写入路径

源码把提交分成**两个阶段**，这个划分本身就是设计事实 → 出处：[session.py:1250-1257](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/session.py#L1250)（注释原文："Phase 1 (Archive prep, path-lock protected)… enqueue Phase 2, then publish the retained root state… Phase 2 (Memory extraction): Runs through the persistent QueueFS queue."）

```
session.add_message(...)
  └─ session.commit() / commit_async()
       ├─ Phase 1（同步，inline，文件锁保护）
       │    ├─ 切分 archive / retain 消息
       │    ├─ 持久化可恢复的 intent + 归档原文
       │    └─ 入队 QueueFS，返回 task_id
       └─ Phase 2（后台，持久队列，重启可恢复）
            └─ ExtractLoop（"Simplified ReAct orchestrator for memory updates —
               single LLM call with tool use"）
                 ├─ 按 schema 生成工具集（MEMORY_TOOLS_REGISTRY）
                 ├─ 解析 operations，按字段 merge_op 落盘（VikingFS patch/write）
                 ├─ 解析不通过 → resolution repair 指令重试
                 └─ 越权/范围非法 → MemoryOperationSkip(code)
```

→ 出处：[session.py:1236](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/session.py#L1236)（`async def commit_async(`）、[session.py:1943](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/session.py#L1943)、[session_commit_msg.py:3-13](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/queuefs/session_commit_msg.py#L3)（`"""Persistent Session Phase 2 queue message."""`）、[session_service.py:420-421](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/service/session_service.py#L420)

- **是异步后台抽取**：Phase 1 内联完成归档，Phase 2 走持久队列；`commit_async` 返回 `task_id` 供轮询 → 出处同上
- **有一个只归档不抽取的开关**：`extraction_enabled: bool = Field(default=True)`（"When disabled, sessions are archived but no memory extraction is performed. Useful for read-only…"）→ 出处：[memory_config.py:79-87](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/memory_config.py#L79)
- **默认输出协议不是 JSON，是受限 Python DSL**：`extraction_output_format: Literal["json","python"] = Field(default="python", ...)`（"`'python'` uses the restricted internal memory SDK DSL (default); `'json'` preserves the legacy structured JSON protocol."）→ 出处：[memory_config.py:88-95](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/memory_config.py#L88)。**这正是 `memory_organization` 那个 A/B 在比较的东西。**
- **工具输出默认不进提取 prompt**（防泄漏环境状态）："By default this provider extracts user/session memories, so tool calls/results are omitted: they are execution evidence rather than user utterances and **can leak environment/database state into user memories**."（`include_tool_parts_in_conversation: bool = False`）→ 出处：[session_extract_context_provider.py:59,313-317](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/session_extract_context_provider.py#L313)。**这是"防止把工具输出当用户记忆"的一个显式设计，和我们筛掉"工具错误签名之外的载荷"的动机同类。**
- **主提取 prompt 的硬约束**：只用只读/搜索工具（"ONLY read and search tools are available - DO NOT use write tool"）；改任何已有记忆前必须先读全文；"Message role is authoritative for newly extracted facts… Do not infer ownership from neighboring messages." → 出处：[session_extract_context_provider.py:221-247](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/session_extract_context_provider.py#L221)
- **决定权在 schema + LLM**：每种记忆类型的"收什么 / 不收什么 / 字段怎么合并"都写在对应 YAML 里（`description` 直接进 prompt），由 LLM 按 schema 填。不是全量落盘，也**没有确定性的重要性阈值** `(推断：全仓未找到 priority / importance 分级字段；profile 用 "as of" 日期、preferences 用 user+topic 做身份，不用分数)`
- **删除有明确的粒度规则**（防误删）：`delete_ids` 删**整条**，只在"该条所有实质事实都在本次范围内"时可用；否则必须用行级 DELETE 块，且"not inferring scope from the file name/topic"；规范化合并要设 `replacement_page_id` 指定继承链接的存活页 → 出处：[json_protocol.py:59-61](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/extraction_output_protocol/json_protocol.py#L59)

**冲突/合并的决策点（这是我们最该学的一段）**：

- **通用策略** `MEMORY_MERGE_POLICY`：相似度/同类目/话题重叠**只算候选，不算同一性证据**；"Merge memories only when they have the same identity"；不同的人/宠物/作品/产品/地点/事件/偏好即使共享属性也要分开；删源记忆前必须为其中每个实质原子事实在存活目标里找到唯一去处，做不到就保留源；太大或混合多重身份则拆分（"Suggested length limits are readability targets, not permission to lose facts"）→ 出处：[merge_policy.py:5-19](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/merge_policy.py#L5)
- **逐类型规则**，例如 profile.yaml："For conflicting mutable states (occupation, residence, relationship status, education), **replace the old state with the latest confirmed value; never retain state history here**"，并且整理时要 "Remove…stale superseded states" → 出处：[profile.yaml:56-68](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/prompts/templates/memory/profile.yaml#L56)
- **走不走 LLM 合并的判据写在代码里**：`operation_mode == "add_only"` → 跳过合并；全是新文件且 URI 无重复 → 跳过合并（`unique_new_files`）；**其余一律走 LLM 合并**，多 patch 批次即使全是新文件也要走，理由是"the LLM handles semantic deduplication and directory name normalization" → 出处：[streaming_memory_updater.py:1256-1266](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/streaming_memory_updater.py#L1256)
- **冲突时整批拒绝，不静默选一个**：跨模板快照冲突直接 `raise ConflictError`；同批 upsert/delete 撞同一 URI 有专门的冲突键保护 → 出处：[streaming_memory_updater.py:631-653](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/streaming_memory_updater.py#L631)、[memory_updater.py:746-750,1045-1048](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/memory_updater.py#L746)
- **经验记忆用 `supersedes` 表达取代**："Same `experience_name` as an existing one → updates it in place… `supersedes` set → old experience is deleted and its history is inherited" → 出处：[agent_experience_context_provider.py:86-89](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/agent_experience_context_provider.py#L86)
- **有软阈值触发强制维护**：`maintenance_review_tokens` 默认 **1000**，超过就要求整理 → 出处：[memory_config.py:71-77](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/memory_config.py#L71)、[tools.py:41-42](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/tools.py#L41)
- **另有向量库层的非语义去重**：memory 父级语义重复入队有去重窗口（"Skipping duplicate memory semantic enqueue… see #769"）→ 出处：[semantic_queue.py:52-59](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/queuefs/semantic_queue.py#L52)

**每条记忆实际存三份东西**（这点和"记忆 = 一行记录"的直觉很不一样）：

1. **文件**（AGFS/RAGFS）= 正文 + `<!-- MEMORY_FIELDS {json} -->` 元数据注释，元数据带 `version` 用于并发/合并判断 → 出处：[memory_file_utils.py:23-36,124-129](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/utils/memory_file_utils.py#L124)
2. **一条 `level=2` 向量行**，`abstract` = 去链接后的正文（截断上限 50,000 字节），`embedding_text` 默认等于该 abstract（或按 `embedding_template` 渲染）→ 出处：[memory_updater.py:57,1793-1842](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/memory_updater.py#L1793)。**注意：`abstract` 字段存的是整篇正文**（因为它兼作 embedding 文本），所以检索的 abstract 层就是完整文件、零读取成本——这一点源码里有注释说明 → 出处：[context_assembler/params.py:45-48](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/params.py#L45)
3. **目录 `.overview.md`** sidecar（按 `overview_template` 渲染，模板驱动而非 LLM 概括）→ 出处：[memory_updater.py:2030-2047](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/memory_updater.py#L2030)

另外**每次 commit 会产出一份可读的变更审计文件** `{archive_uri}/memory_diff.json`（含 adds / updates / deletes 与 `trace_id`）→ 出处：[session.py:1867](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/session.py#L1867)、[06-memory-consolidation.md:72-78](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/context-compilation/06-memory-consolidation.md#L72)。**我此前写"未见记忆级审计"是错的——它有，只是粒度是"每次提交的文件级 diff"，不是我们的"每次判定的原因码"。**

### 召回路径

文档给的概览（[07-retrieval.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/07-retrieval.md)）是「意图分析 → 层级检索 → Rerank」。读源码后是**八个阶段**，其中两处与文档印象不同（下面标出）：

**阶段 0 — 入口就分流**：`find()` 不做意图分析、单查询、低延迟；`search()` 需要 session 上下文、用 LLM 分析意图。代码里是显式的 `if session is not None and self.is_intent_enabled()` 守卫 → 出处：[search_service.py:103,122-124,150](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/service/search_service.py#L122)

**阶段 1 — 意图分析（LLM，0–5 个 TypedQuery，仅 `search()`）**：`IntentAnalyzer(max_recent_messages=5)`，输出含 `query` / `context_type` / `intent` / `priority 1-5`。0 个查询 = 闲聊问候不检索。`query_planner` 可单独配模型，未设回退 `vlm` → 出处：[intent_analyzer.py:51,88](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/intent_analyzer.py#L51)

**阶段 2 — 确定检索起点目录（这就是"向量排序前确定目录范围"）**：有显式 `target_dirs` 就用它，否则按 `context_type` 取默认根（MEMORY → `viking://~/memories`）→ 出处：[hierarchical_retriever.py:165-169](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L165)

**阶段 3 — 范围下推为向量库的前置过滤条件**（不是后置排序）：`PathScope("uri", target_dir, depth=-1)` 组进 `filters`，同时叠加租户 filter 与 `level` → 出处：[viking_vector_index_backend.py:2849-2871](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/viking_vector_index_backend.py#L2849)。**这是"目录感知检索"在代码里的真身。**

**阶段 4 — 向量检索：dense + 可选 sparse，一次 embed**：query 向量只算一次（`dense_vector` / `sparse_vector` 复用）→ 出处：[hierarchical_retriever.py:149-163](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L149)。QUICK 模式只做一次全局检索；THINKING 模式先全局再递归 → 出处：[hierarchical_retriever.py:175-188](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L175)。**集合不存在时直接返回空，不是降级 BM25** → 出处：[hierarchical_retriever.py:138-147](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L138)

**阶段 5 — dense/sparse 融合：不是 RRF**（重要更正）：融合由向量库内部的单权重 `SearchWithSparseLogitAlpha` 完成，**默认 `sparse_weight = 0.0`，即默认纯 dense**；`sparse_weight > 0` 要求配了 sparse/hybrid embedding，否则配置校验直接报错；索引类型随之在 `flat` / `flat_hybrid` 间切换 → 出处：[volcengine_adapter.py:182](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/vectordb_adapters/volcengine_adapter.py#L182)、[account_vector.py:154](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/config/account_vector.py#L154)、[base.py:188,257](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/vectordb_adapters/base.py#L257)。**全仓 grep `rrf|reciprocal_rank|rank_fusion` 零命中 → RRF 未找到。** 这与腾讯的 RRF(k=60) 是明确的技术路线差异。

**阶段 6 — 递归下钻与分数传播**：常量 `MAX_CONVERGENCE_ROUNDS = 3`、`DIRECTORY_DOMINANCE_RATIO = 1.2`、`GLOBAL_SEARCH_TOPK = 10`、`MAX_PARALLEL_CHILD_SEARCHES = 4` → 出处：[hierarchical_retriever.py:56-59](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L56)。分数传播权重 `score_propagation_alpha` **默认 1.0**（只用子节点自身分数、忽略父分）→ 出处：[retrieval_config.py:19-27](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/retrieval_config.py#L19)。热度混合 `hotness_alpha` **默认 0.0（关闭）** → 出处：[retrieval_config.py:10-17](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/retrieval_config.py#L10)

**阶段 7 — Rerank（可选，不是必然）**：

- 模式由是否配了 rerank client 决定：没配就是 QUICK，配了才是 THINKING → 出处：[hierarchical_retriever.py:126-127](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L126)
- **默认模型 `doubao-seed-rerank` version `251028`，阈值 `0.1`**；provider 支持 `vikingdb` / `cohere` / `openai` / `litellm` / **`jev`** → 出处：[rerank_config.py:13,22-23,46-47](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/rerank_config.py#L22)、[models/rerank/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/models/rerank)。**注意：OpenViking 支持把 Jev 当 reranker——和 memsearch 是同一个用法，和我们"Jev 只做写入判定"仍然不同。**
- 失败或结果长度不匹配 → 回退向量分（"[HierarchicalRetriever] Invalid rerank result, fallback to vector scores"）→ 出处：[hierarchical_retriever.py:410-412](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L410)
- **没配 rerank 时 threshold = 0**（不是 0.1）→ 出处：[hierarchical_retriever.py:85-86](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/hierarchical_retriever.py#L85)

**阶段 8 — 注入集选择：这一层和我们的设计最像**（也是文档完全没写的一层）：

| 机制 | 值 | 出处 |
|---|---|---|
| 总 token 预算 | `DEFAULT_MAX_TOKENS = 1600` | [params.py:32-37](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/params.py#L32) |
| 条数上限 | `DEFAULT_LIMIT = 10` | 同上 |
| 规划查询上限 | `MAX_PLANNED_QUERIES = 3` | 同上 |
| **按用途的硬配额** | `coding`: events 1 / entities 2 / preferences 1 / experiences 1 / resources 3 / skills 2 | [params.py:81-98](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/params.py#L81) |
| 无用途时的兜底配额 | events 10 / entities 10 / preferences 3 / **experiences 0** | [params.py:100-105](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/params.py#L100) |
| **每类的默认读取层级** | 只有 `events` 用 `overview`，其余停在 `abstract` | [params.py:52-61](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/params.py#L52) |
| 单条上限 | 平均份额的 **2 倍**（`max_tokens // candidate_count * 2`） | [budget.py:44-46](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/budget.py#L44) |
| 超预算时的行为 | **降级层级而不是截断**；按正文去重 | [budget.py:5-8,128-134](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/budget.py#L128) |
| 跨轮去重 | `RECALL_DEDUP_TURNS = 5` | [recall_preset.py:31](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/recall_preset.py#L31) |
| 插件侧默认 | `recallLimit 10`、`scoreThreshold 0.35`、`recallMaxTokens 1600` | [config-schema.mjs:79-87](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/memory-plugin-shared/lib/config-schema.mjs#L79) |

**两条设计说明值得逐字引用**：

- **没有绝对分数阈值兜底**，理由是分数带太窄："Slots are in score order, so the depth passes spend whatever budget is left on the best hits first — no absolute score threshold, which the observed **0.38-0.50 score band** cannot support anyway." → 出处：[budget.py:164-166](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/budget.py#L164)
- **为什么"每条先放默认层、再用余额加深"**："Scores cluster in a narrow band, so spending the whole budget on the top hit is a bad bet." → 出处：[budget.py:5-8](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/context_assembler/budget.py#L5)

> **对我们的意义**：这两条直接对应我们的两个设计选择。①"分数带太窄，不用绝对阈值"——我们用的是 `scoreThreshold` 那套还是配额那套，值得对照；②"先把每条放到默认层，再用余量加深"——这正是我们"类型配额 + 总预算"的同构思路，但 OpenViking 把它做进了 L0/L1/L2 的层级维度。

**`TrieHI` 只在 README 里存在**：全仓源码、docs 正文、crates、src 中**均未找到 TrieHI 的实现或定义**，`trie` 也零命中（除 "retrieval" 误匹配）→ 出处：[README_CN.md:290](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md#L290)。`(推断)` 源码里与之对应的是阶段 2 + 阶段 3（起点目录解析 + 范围下推为向量前置过滤）。**引用"TrieHI 已集成"时必须注明它只有 README 一处出处。**

**注入到哪 / 怎么给模型**：

- **Agent 侧**：agent plugin 作为 `contextEngine`（OpenClaw）或 hook（Claude Code / Codex / Cursor / TRAE / OpenCode / pi / Hermes）自动召回；OpenClaw 侧旋钮是 `autoRecall` / `recallLimit` / `recallScoreThreshold` / `recallMaxContentChars` → 出处：[issue #1258 维护者回复](https://github.com/volcengine/OpenViking/issues/1258)（示例配置，非仓库文档，标注为二手）、[examples/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples)
- **工具侧**：MCP server 暴露 16 个工具——`find` `search` `read` `list` `tree` **`remember`** `write` `edit` `add_resource` `add_skill` `list_watches` `cancel_watch` `grep` `glob` **`forget`** `health`，带 read-only / destructive 注解；启动日志自己打印这份清单 → 出处：[mcp_endpoint.py:2027-2029](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/mcp_endpoint.py#L2027)
- **渐进披露**：Agent 先读目录 `.abstract.md`（L0），再决定读 `.overview.md`（L1），最后才读全文（L2）→ 出处：[README_CN.md:60](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)

### 存储与依赖

- **两层存储，默认全本地**：`VikingFS`（URI 抽象层）+ **RAGFS**（内容层，Rust 重写版 AGFS，**进程内**通过 `ragfs-python` 绑定使用）+ **自研内嵌向量库**（Python abi3 扩展包 C++ 引擎 + **内嵌 LevelDB**）。索引层只存 URI/向量/元数据，**不存文件内容** → 出处：[crates/ragfs/src/lib.rs:1,5](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/crates/ragfs/src/lib.rs#L1)、[vectordb/README.md:14](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/vectordb/README.md#L14)、[persist_store.cpp:21](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/src/store/persist_store.cpp#L21)、[05-storage.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/05-storage.md)
- **后端可选性**：向量后端默认 `local`，另有 `cuvs` / `http` / `volcengine` / `vikingdb`（私有化）/ `opengauss`；内容后端默认 `local`，另有 `s3` / `memory` → 出处：[vectordb_config.py:403-409](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/vectordb_config.py#L403)、[agfs_config.py:393-395](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/agfs_config.py#L393)
- **URI 映射**：`viking://~/memories` → `/local/{account_id}/user/{user_id}/memories`（`~` 在服务端按认证身份展开；`account_id` 是物理路径强制前缀）→ 出处：[04-viking-uri.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/04-viking-uri.md)、[viking_fs/_access.py:685-697](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/viking_fs/_access.py#L685)
- **部署只需要两个容器**：`docker-compose.yml` 里只有 `openviking` 和 `caddy`，**没有任何数据库容器**；Helm chart 的默认 ov.conf 也是 `vectordb.backend: local` + `agfs.backend: local` → 出处：[docker-compose.yml:19,47](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docker-compose.yml#L19)、[deploy/helm/openviking/values.yaml:92-98](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/deploy/helm/openviking/values.yaml#L92)
- **运行时**：Python **3.10+**（`requires-python = ">=3.10"`），构建期需要 **cmake + maturin**（两个平台相关的 abi3 原生扩展）；Rust **≥ 1.91.1**；Node 24 只用于构建 Web Studio（缺 npm 就跳过 /studio）→ 出处：[pyproject.toml:2-9,16](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/pyproject.toml#L2)、[crates/ragfs/Cargo.toml:5](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/crates/ragfs/Cargo.toml#L5)、[setup.py:546-550](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/setup.py#L546)（"Keep wheels platform-specific because ragfs-python is a native artifact."）
- **Embedding 事实上是必需的，而且不可关闭**：schema 层要求 dense/sparse/hybrid 至少一个；**但配置校验前会先注入一个默认的本地 GGUF 模型** `bge-small-zh-v1.5-f16`（provider `local`），所以用户什么都不配也能跑——代价是**首次启动要从 HuggingFace 下载模型** → 出处：[embedding_config.py:680-694](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/embedding_config.py#L680)、[local_embedders.py:39-43](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/models/embedder/local_embedders.py#L39)
- **没有纯 BM25 无模型回退**：`find()` 拿不到 embedder 直接抛 `RuntimeError("Embedder not configured.")`；BM25 只在 VikingDB 系后端可用，本地后端强制走文件系统 grep → 出处：[viking_fs/_semantic.py:218-227,259-261](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/viking_fs/_semantic.py#L259)、[viking_fs/_grep.py:163-165](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/viking_fs/_grep.py#L163)
- **VLM 可选且有降级**：未配置不报错；不可用时摘要退化为空串、概览退化为 `[Directory overview is not ready]` → 出处：[semantic_processor.py:1296-1301,1521-1523](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/queuefs/semantic_processor.py#L1296)
- **能纯本地跑吗**：能，且比 README 说得好——内置 Ollama 检测/启动（`localhost:11434`），provider 支持 `ollama` / `local`；`ov init` 也提供本地选项。**唯一现实阻碍是首次下载那个 GGUF** → 出处：[ollama.py:30-31](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/ollama.py#L30)、[bootstrap.py:248-255](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/bootstrap.py#L248)、[README_CN.md:133](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)
- **不会偷偷外发**：OTel tracer 默认 `enabled: false`、endpoint 为空；usage reporter 默认关闭、sinks 为空、内置 sink 只有本地 `file_log`；进程内 telemetry 事件捕获被显式禁用；**全仓 grep 不到 posthog / sentry / analytics / beacon 等第三方上报端点**（`未找到`）。唯一的默认云端地址是 `ov` CLI 可选托管服务的配置项 → 出处：[telemetry_config.py:9-10](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/telemetry_config.py#L9)、[server/config.py:193-200,251-253](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/config.py#L193)、[store.rs:16](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/crates/ov_cli/src/config_wizard/store.rs#L16)
- **云端依赖**：**不是强依赖**（可自托管、无激活码、默认全本地），但**有商业 SaaS 版**（火山引擎托管）和 BYOC 私有化版（激活码）→ 出处：[README_CN.md:252-279](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)
- `(推断)` **实际外发取决于你选的 embedding/VLM provider**——官方评测用的是火山方舟云模型，用云模型时会话内容会发给该厂商；默认本地模型不外发。

> **文档与源码的偏差（引用时注意）**：`docs/zh/concepts/05-storage.md` 的集合字段表列了源码里**不存在**的 `parent_uri`（全仓 0 命中）与 `is_leaf`（它只是插入时的临时键，[collection_schemas.py:594](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/collection_schemas.py#L594)），同时**漏列**了实际存在并参与索引的 `level` / `tags` / `search_tags` / `content` / `md5` / `account_id` / `owner_user_id` / ACL 字段 → 出处：[05-storage.md:115-124](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/05-storage.md#L115) vs [collection_schemas.py:93-165](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/collection_schemas.py#L93)

### 评测（重点）

这是两个项目差距最大的地方。OpenViking 有一整个 `benchmark/` 目录，**11 个子集**：

| 子集 | 测什么 | 数据集来源 | 出处 |
|---|---|---|---|
| `locomo/` | 长对话用户记忆，**端到端问答准确率**（7 个 arm：openviking / openclaw / claudecode / hermes / vikingbot / mem0 / supermemory） | `locomo10.json`，**未提交进仓库**，需自备（下载源在同仓 `benchmark/RAG/scripts/download_dataset.py`） | [locomo/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/README.md)、[download_dataset.py](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/scripts/download_dataset.py) |
| `tau2/` | 多轮 agent 任务成功率（经验记忆）；域为 **retail + airline** | 外部 `sierra-research/tau2-bench` checkout（需钉到 PR #297） | [tau2/llm/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/README.md)、[baseline.yaml](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/config/baseline.yaml) |
| **`memory_organization/`** | **记忆重组协议的配对 A/B（方法学最硬的一个，且 grader 无 LLM）** | **仓库自带 JSON 夹具**（12 确定性 + 3 压力 + 3 自主） | [memory_organization/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/memory_organization/README.md) |
| `RAG/` | 单轮 RAG：Locomo / SyllabusQA / Qasper / FinanceBench | 官方源下载（GitHub zip、S3 tgz），实测用**子采样** | [RAG/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/README.md) |
| `aml/` | Agent Memory Leaderboard 适配器（longmemeval / locomo_refined / **personamem_v2_32k** / clbench / beam） | PersonaMem-v2 取自 HuggingFace `bowen-upenn/PersonaMem-v2`（sha256 校验）；部分单元官方未发布 → 显式列为 `UNAVAILABLE` | [aml/eval/run_ecs.py](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/aml/eval/run_ecs.py) |
| `longmemeval/openviking/` | 长记忆评测，流程与 LoCoMo arm 同构 | 外部 `longmemeval_s_cleaned.json` | [longmemeval/openviking/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/longmemeval/openviking/README.md) |
| `skillsbench/` | OpenClaw 使用 skill 的能力 | 外部 `benchflow-ai/skillsbench`（排除 10 个任务） | [skill_bench_eval.py](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/skillsbench/skill_bench_eval.py) |
| `cuvs/` | 向量索引性能（native flat vs cuVS brute-force / CAGRA），**不含 embedding/HTTP/rerank/LLM** | ann-benchmarks `glove-100-angular`（1,183,514 × 100D）+ 合成向量 | [cuvs/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/cuvs/README.md)、[PRELIMINARY_RESULTS.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/cuvs/PRELIMINARY_RESULTS.md) |
| `retrieval/grep/`、`vectordb_perf/`、`custom/` | grep 效果与性能、向量后端性能验收、Server 并发压测 | 真实代码仓（手动下载）/ 合成向量 / `.fvecs` | [benchmark/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark) |

**一个必须知道的负面事实**：`benchmark/` 下**没有任何提交的结果文件**（无 `result/`、无 CSV/JSON 结果），`benchmark/.gitignore` 第一行就是 `results/`；而 README 那 10 个数字（82.08 / 82.86 / 80.32 / 77.81 / 66.25 / 70.94 / 54.38 / 24.20 / 33.38 / 57.21）在**全仓 `*.md/*.py/*.sh/*.yaml/*.json/*.csv` 里只命中 3 行**——`README.md:116`、`README_CN.md:116`、`README_JA.md:116` 的图片 alt 文本（另有 `docs/images/benchmark-{light,dark}.svg` 里的文本节点）→ 已逐条 grep 验证。**仓库提供的是"可复现的脚本"，不是"可核对的结果"**，二者不是一回事。

> 附：`RELEASE.md` / `RELEASE_CN.md` 全文**不含** benchmark/locomo/tau2/eval/评测任何字样 → 发版说明不承载评测结论。

#### 指标定义（能查到的部分）

**LoCoMo 的 "accuracy" 是怎么算的**——这是唯一能从代码里读全的口径：

- **规模**：10 个 sample（两人对话）、**1986 个 QA / 5 个类别**，非对抗计分题为 **1540** → 出处：[locomo/mem0/README.md:34-40](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/mem0/README.md#L34)、[RAG/README.md:222](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/README.md#L222)（issue #1258 里第三方跑出的分母正是 1540，与之吻合）
- **判分方式：LLM-as-judge**。`judge.py` 让模型输出 JSON `{"label": "CORRECT"|"WRONG", "reasoning": "..."}` → 出处：[locomo/openviking/judge.py:38-58](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/judge.py#L38)
- **解析失败与 API 异常一律记 WRONG，不是丢弃**：`parse_judge_result` 返回 `None` 时，调用方 `return False, reasoning`；异常分支 `return False, f"[API ERROR] …"` → 出处：[judge.py:132-140](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/judge.py#L132)。**这意味着判分链路的不稳定会直接压低准确率** `(推断：这是保守方向——但它把"judge 挂了"和"答错了"混成了同一个数)`
- **有 4 种 judge prompt 变体**：普通 / 带 evidence / strict / strict+evidence，靠 `--strict-prompt`、evidence 参数切换 → 出处：[judge.py:66-120](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/judge.py#L66)、[locomo/openviking/README.md:98-100](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/README.md#L98)
- **默认（宽松）判分规则里有两条会显著抬高分数**：`PARTIAL CREDIT`——"只要答案包含 gold 答案列表中的**至少一项**就判 CORRECT"；`DATE TOLERANCE`——"日期相差 14 天内算对，时长相差 50% 内算对" → 出处：[locomo_prompts.py:142-169](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/locomo_prompts.py#L142)
- **类别映射在仓库里自相矛盾（引用时必须声明用的是哪一套）**：`openviking` arm 的代码是 `1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial`（[locomo_prompts.py:7-15](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/locomo_prompts.py#L7)）；而 `mem0`/`supermemory` 的 README 写的是 `1=single-hop, 2=multi-hop, 3=temporal, 4=world-knowledge, 5=adversarial`（[locomo/mem0/README.md:34-40](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/mem0/README.md#L34)）。**两套互斥**。
- **跨 arm 的 judge 口径也不统一**：`openviking/` 用 `label` 字段 + lenient/strict 模板；`openclaw/`、`claudecode/`、`vikingbot/`、`hermes/` 用另一套 mem0 风格的 `is_correct` 字段模板 → 出处：[openclaw/judge.py:22-45](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openclaw/judge.py#L22)。**所以 README 表格里"原生记忆 vs +OpenViking"是同一 arm 内对比，但"OpenClaw vs Hermes vs Claude Code"三方并列并不严格同口径。**
- **类别排除**：统计时**跳过 category 5（adversarial）**，并单独统计 `is_valid=True` 的题目（把 `is_invalid` 的题排除）→ 出处：[locomo/openviking/stat_judge_result.py:8-79](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/stat_judge_result.py#L8)、[locomo/openviking/README.md:102](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/README.md#L102)
- **accuracy = CORRECT / (CORRECT + WRONG)，按题 micro 聚合，全局一个数**——没有 per-conversation，也没有 macro 平均 → 出处：[judge.py:305-308](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/judge.py#L305)、[stat_judge_result.py:137-138](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/stat_judge_result.py#L137)
- **judge 模型默认 `doubao-seed-2-0-pro-260215`，base_url 默认 `https://ark.cn-beijing.volces.com/api/v3`**，token 从 `ARK_API_KEY` / `OPENAI_API_KEY` 取，环境文件固定读 `~/.openviking_benchmark_env` → 出处：[judge.py:32,198,209,219](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/judge.py#L198)
- **同时统计 token 与时延，甚至成本**：openclaw 报 no-cache / cacheRead / output / total input tokens 与 elapsed min/avg/max；claudecode 还报**美元成本**与 turns；openviking/vikingbot 报 `token_usage`（prompt / memory_prompt / completion / total）+ `time_cost` + `iteration` → 出处：[openclaw/stat_judge_result.py:136-157](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openclaw/stat_judge_result.py#L136)、[claudecode/stat_judge_result.py:190-195](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/claudecode/stat_judge_result.py#L190)
- **答题侧有硬截断**：记忆按时间排序后**只留 200 条**（`ANSWERER_MEMORY_LIMIT = 200`）→ 出处：[locomo_prompts.py:79,105](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/openviking/locomo_prompts.py#L79)
- **仓库里唯一的"bad case 文件"其实是数据质量问题**：`locomo_bad_case_questions.csv` 只有 2 条数据，两条的 `reasoning` 都是"**gold 答案本身错了，bot 答对了**"（"Gold本身有问题…记忆正确，Bot也成功找出和回答"）→ 出处：[locomo_bad_case_questions.csv](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/locomo/locomo_bad_case_questions.csv)。**它不是模型弱点清单。**

**没有的东西**：LoCoMo 全目录**没有任何 Recall@K / MRR / NDCG / F1 实现**（grep `recall|mrr|ndcg|f1|hit_rate` 只命中 judge 系统提示词里的英文单词 "recall"）；**整个 `benchmark/` 目录 grep `ndcg|MRR` 零命中** → 未找到。OpenViking 只报端到端问答准确率，**不报检索质量**。

**`memory_organization` 是方法学标杆**（建议只抄这一份）：

- **假设与设计**：比较 JSON 与受限 Python 两种输出协议下的模型行为，**保持模型、已有文件、schema、指令、重试预算、输出 token 上限完全一致**——只变协议 → 出处：[memory_organization/README.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/memory_organization/README.md)
- **自主决策套件只有 3 个 case**，且**期望结果只存在于 grader 里**，不暴露给模型；用生产 `SessionExtractContextProvider` 的子类 + 生产 YAML schema，**不额外加 benchmark 专用提示** → 出处同上
- **两个正交指标**（刻意解耦）：
  - `organization_action_success`：要求的 merge / move / split **动作**是否发生（结构指标）；
  - `information_integrity`：每条期望事实是否**恰好保留一次**（内容指标）。
  "The action metric is deliberately structural. Missing, duplicated, or misclassified content is reflected only by information integrity, keeping the two metrics independent." → 出处同上
- **统计**：重复采样（`--repeat 20 --parallel 6`）+ **双侧精确 McNemar p 值**（配对检验），并明确"**一次有利样本不算证据**"（"one favorable sample is not sufficient"）
- **确定性套件**：12 个 fixture（4 个重复文件合并 / 4 个混合文件拆分 / 4 个合并+拆分组合），事实带**不可变 `Fxx` 标记**，所以 grader 能确定性地检查最终位置、保留、重复、删除、规范化替换；压力套件用 24–32 条完整事实行 → 出处同上
- **grader 里没有 LLM**：纯 marker（`[Fxx]` 正则）解析，指标是确定性的——`fact_recall = len(present)/len(expected_markers)`、`placement_precision = matched_intersections/total_assignments`、`file_tree_accuracy = exact_group_matches/max(len(expected),len(actual),1)`、`replacement_accuracy = 成功替换数/替换检查数`；`content_organization_success` 要求分区完全相等且 missing/misplaced/duplicates/altered/unexpected 全为 0 → 出处：[grader.py:35-120](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/memory_organization/grader.py#L35)、[models.py:9](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/memory_organization/models.py#L9)
- **主指标定义在报告层**：`PRIMARY_METRICS = ("organization_action_success", "information_integrity")`，各自算率 → 出处：[report_autonomous.py:18,59-64](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/memory_organization/report_autonomous.py#L18)
- **作者自证局限**（罕见地具体）："older guided result artifacts explicitly disclosed target groupings and **must not be used as evidence of autonomous planning quality**"；`autonomous_*` 且无 `production_` 前缀的产物"predate exact production-prompt reuse and are superseded" → 出处同上

**`tau2` 的指标与证据纪律**：

- **成功判据 = `reward >= 1.0`**，主指标是 **`avg_reward`（reward 算术均值）**，另有 `db_match_rate` → 出处：[run_memory_v2_eval.py:132-133](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/scripts/run_memory_v2_eval.py#L132)、[run_eval.py:240-245](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/scripts/run_eval.py#L240)
- **scoreboard 按 simulation 数加权，不是 cell 等权**（schema `openviking.tau2.scoreboard.v0`）→ 出处：[run_eval.py:795-843](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/scripts/run_eval.py#L795)
- **`pass^k` 未找到**（grep `pass^|pass_k|passk` 无命中）——报的是均值，不是 pass^k
- **采样设置**：`repeat_count: 8`、`seed: 300`、`reasoning_effort: high`、`retrieval_top_k: 4`、`prewrite_retrieval_top_k: 6`、`prewrite_inject_top_k: 2` → 出处：[baseline.yaml](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/config/baseline.yaml)
- **`baseline.yaml` 本身不是可运行的 evidence cell**，只是协议/默认值文件；要跑基线用 `no_memory.yaml`，要跑处理组用 `template_indexed_trajectory.yaml`（后者同时含 no_memory + 处理组两条 strategy 成对跑）→ 出处：[tau2/llm/README.md:41-43](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/README.md#L41)
- **README 开头就写 "The reproduction surface is intentionally narrow"**，只给两格可跑配置；并明确把 "Category rerank, experience-memory routes, fixed-count-only ablations, character-budget ablations, and official-user parity controls" **排除在 README 与配置集之外**，"so reproduction agents do not mistake diagnostic routes for current evidence" → 出处：[tau2/llm/README.md:1-20](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/README.md#L1)
- **证据边界写死在文档里**："Only completed `retail + airline` runs with the same config, same seeds/repeats, and non-empty artifacts should be read as benchmark evidence. Partial runs, single-task probes, or missing OpenViking corpus identity are **diagnostics**." → 出处：[tau2/llm/README.md:290-292](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/README.md#L290)
- **超时 cell 被记为 rc=124 并从 scoreboard 指标中剔除** → 出处：[tau2/llm/README.md:268-271](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/llm/README.md#L268)
- **只从 train split 抽记忆，test split held out** → 出处：[tau2/vikingbot/README.md:8-11](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/vikingbot/README.md#L8)
- **记忆召回预算是刻意调过的**：`exp_recall_limit: 2`（默认 5）、`exp_recall_max_chars: 10000`（默认 2000），README 的解释是 tau2 偏好"**少而长**"而非"多而浅"→ 出处：[tau2/vikingbot/README.md:245-257](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/tau2/vikingbot/README.md#L245)。**又是一个"默认值不等于评测值"的例子。**

**`RAG` 的指标定义**（这一份比 LoCoMo 细致）：

- **`F1`**：token 级 PRF，先 normalize（去标点、小写、去 a/an/the/and）：`common = Counter(pred) & Counter(truth)` → 出处：[metrics.py:9-28](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/src/core/metrics.py#L9)
- **`Recall`**：**证据命中率**——严格子串优先；长证据 fallback 到 token 覆盖率 ≥ 0.8（软匹配）；**短于 4 token 的证据禁止软匹配**；最终 `hit_count / len(evidence_list)` → 出处：[metrics.py:56-86](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/src/core/metrics.py#L56)
- **`Accuracy`**：LLM 判 0–4 分；**Locomo 数据集被硬钳为 0 或 4**；normalized accuracy = 均分 / 4 → 出处：[judge_util.py:42,126-129](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/src/core/judge_util.py#L126)、[pipeline.py:178-185](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/src/pipeline.py#L178)
- **聚合**：逐 query 平均（macro over queries）→ 出处同上
- **一个可质疑的写法**：拒答启发式——当答案和任一 gold 都被判为拒答时，**F1 直接置 1.0 且 Accuracy 置 4.0** → 出处：[pipeline.py:315-318](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/src/pipeline.py#L315)
- **实测是子采样**：Locomo 3 文档/80 题、SyllabusQA 7/90、Qasper 8/60、FinanceBench 3/12，均 seed=42；但**提交的 `locomo_config.yaml` 写着 `max_queries: 20`**，与 README 声称的 80 不一致 → 出处：[RAG/README.md:520-525](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/README.md#L520)、[locomo_config.yaml:14](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/RAG/config/locomo_config.yaml#L14)

**其余子集的判分方式**：`skillsbench` 跑任务自带 tests，`passed = returncode == 0`，`test_score = passed_count/total_count`（[skill_bench_eval.py:401-413](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/skillsbench/skill_bench_eval.py#L401)）；`cuvs` 报 QPS 与 Recall@K（[PRELIMINARY_RESULTS.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/cuvs/PRELIMINARY_RESULTS.md)）。

**`aml` 是唯一接入第三方榜单的**：数据集含 `longmemeval_s` / `locomo_refined` / **`personamem_v2_32k`** / `clbench_0_4k` / `clbench_16_32k` / `beam_100k` / `beam_1m`；PersonaMem-v2 来自 HuggingFace `bowen-upenn/PersonaMem-v2` 并按 sha256 校验；未发布的数据被显式列为 `UNAVAILABLE`（如 `longmemeval_refined: "AML has not published the transformed production data"`）→ 出处：[aml/eval/run_ecs.py:33-48](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/aml/eval/run_ecs.py#L33)、[aml/eval/prepare_personamem.py:123](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/aml/eval/prepare_personamem.py#L123)。**作者主动声明自己给的不是官方分**："These remain local proxy results rather than official leaderboard scores" → 出处：[aml/README.md:179-181](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/aml/README.md#L179)

> **注意**：腾讯的 PersonaMem 和字节的 PersonaMem 是**同一个公开评测集**（腾讯外链 `bowen-upenn/PersonaMem`，字节用 `bowen-upenn/PersonaMem-v2`）→ 出处：[腾讯博客](https://cloud.tencent.com/developer/article/2668579)、[prepare_personamem.py:123](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/benchmark/aml/eval/prepare_personamem.py#L123)。**这是两家唯一可比的交集**，但腾讯没给脚本、字节用的是 v2 且只作为 AML 的一个单元，口径仍不可直接并列。

#### 公开数字

官方博客（[OpenViking Benchmark Update](https://blog.openviking.ai/post/openviking-benchmark-results/)，2026-05-29）与 [README_CN.md:108-120](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)：

**LoCoMo（端到端准确率 / 平均查询时延 / 输入 token）**

| 接入方式 | 准确率 | 平均查询时延 | 输入 tokens |
|---|---|---|---|
| OpenClaw 原生记忆 | 24.20% | 95.14s | 392,559,404 |
| **OpenClaw + OpenViking** | **82.08%** | **38.8s** | **37,423,456** |
| Hermes 原生记忆 | 33.38% | 82.4s | 79,228,398 |
| **Hermes + OpenViking** | **82.86%** | **27.9s** | **52,026,755** |
| Claude Code auto-memory | 57.21% | 49.1s | 353,306,422 |
| **Claude Code + OpenViking** | **80.32%** | **20.4s** | **129,968,899** |

时延降 58.45%–66.10%，token 降 34.3%–91.0%（[博客](https://blog.openviking.ai/post/openviking-benchmark-results/)）。

**tau2-bench（经验记忆）**：Retail 70.94% → **77.81%（+6.87pp）**；Airline 54.38% → **66.25%（+11.87pp）**，对照是"同一 LLM 无记忆"（[博客](https://blog.openviking.ai/post/openviking-benchmark-results/)）。

**知识库问答**：HotpotQA top-20 = **91.00%**（0.23s/QA）；单轮 RAG 五数据集平均 **66.87%**（0.19s 检索延迟），索引 token 8.67M ≈ LightRAG 的 13.8%（[博客](https://blog.openviking.ai/post/openviking-benchmark-results/)）。对照方法有 Naive RAG / HippoRAG 2 / LightRAG / PageIndex / LangChain SQL。

**评测用的模型**：Embedding = `doubao-embedding-vision-251215`，VLM = `doubao-seed-2-0-pro` 或 `doubao-seed-2-0-code-preview-260215`（[README_CN.md:112](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)、[issue #1258](https://github.com/volcengine/OpenViking/issues/1258)）——**都是火山引擎方舟的闭源云模型**，这意味着公开评测**无法在不依赖厂商 API 的情况下复现**。

#### 第三方复现失败（最有价值的一条）

[issue #1258](https://github.com/volcengine/OpenViking/issues/1258)（label `question`，34 条评论，2026-04-07 开 → 2026-04-28 关）：

1. 用户用**完整 LoCoMo 数据集**按仓库脚本跑，得到 **7.66%（118/1540）**，按类目 10.28% / 4.98% / 16.67% / 6.78%；
2. 维护者（chenjw）诊断：eval 的 ingest 把**整个 session 当成一条 message 上传**（新版事件提取逻辑依赖 message 下标），且**没有提供 session 的发生时间**作为 message 时间戳；"主要是前者导致了事件记忆基本上没有生效"；
3. 用户提出方法学质疑："如果记忆注入阶段各个插件的操作方式不一致，那么就评估不出来对话过程中记忆提取的质量了"，并指出另一家（LanceDB）的做法是**只评索引、不评注入阶段**；
4. 维护者随后给出 **Memory V2** 设置 + 一键脚本（PR #1287），报告 **LoCoMo 最高准确率 83.44%**，并**承认默认值不够**："因为 locomo category4 的题目侧重于完整性、推理性，**目前插件的默认检索值较低会导致这些题目普遍得分较低**"——复现要求把 `recallLimit` 从默认值调到 **30**、`recallScoreThreshold` 设为 **0.35**、`recallMaxContentChars` 设为 **4000**；
5. 用户升级后先遇到 **Python 3.14 崩溃**（维护者回复"回退到 python 3.12"），修好后**单跑 sample2 得 61.18%（93/152）**，仍低于文档的 80%+，但比之前的 30 多分明显改善；
6. 期间还暴露一个隔离问题：`import` 注入的数据落在 `conv-41` 用户下，旧脚本注入的落在 `default` 下，**导致检索不到**。

> **这条 issue 的价值**：它是"官方数字 → 第三方复现 → 维护者定位 → 承认默认值不可用"的完整链条。结论是：**OpenViking 的 82% 是调参后的上限，不是默认配置的表现**。

### 冲突 / 过期 / 遗忘

- **冲突**：`merge_policy.py` + 逐类型规则（见"写入路径"）。profile 的策略最明确：可变状态**用最新确认值替换旧值，不保留状态历史**，并删除 "stale superseded states" → 出处：[merge_policy.py:5-19](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/merge_policy.py#L5)、[profile.yaml:56-68](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/prompts/templates/memory/profile.yaml#L56)
- **改名撞 URI 时拒绝覆盖**（文档与源码一致）："**冲突不覆盖**：如果改名后的目标 URI 已存在，整理会报冲突，不会覆盖。模型必须先读取两份记忆，把独立事实更新到明确的目标文件，再用 replacement 关系删除源文件。" → 出处：[06-memory-consolidation.md:66](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/context-compilation/06-memory-consolidation.md#L66)、代码 [streaming_memory_updater.py:653](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/streaming_memory_updater.py#L653)
- **矛盾关系可以被显式建模**：link 类型里有 `contradicts`（"for mutually inconsistent facts"）与 `evolved_from`（时间性变化）→ 出处：[dataclass.py:94-98](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/dataclass.py#L94)。**但 `link_enabled` 默认 `false`** → 出处：[memory_config.py:104-110](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/memory_config.py#L104)
- **唯一的"整理"入口是用户主动触发的离线任务**：`ov compile --skill memory`（"Compile is an offline, user-initiated task, so favor an agentic loop"），整理 prompt 的硬约束是 "Do NOT create memories from nothing; only reorganize what already exists." → 出处：[consolidation_context_provider.py:75,114](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/consolidation_context_provider.py#L75)、[06-memory-consolidation.md:20,45](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/context-compilation/06-memory-consolidation.md#L20)
- **过期 / TTL / 自动遗忘：未找到**。全仓 memory 相关代码没有 `ttl` / `expire` / `decay` 字段。唯一的时间衰减是**排序用的 hotness 分**，且**默认关闭**（`hotness_alpha: 0.0`），而且 `hotness_score` 目前只在统计聚合里用，不在召回打分里：半衰期常量是 `DEFAULT_HALF_LIFE_DAYS = 7.0` → 出处：[memory_lifecycle.py:15-16,29,61-62](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/retrieve/memory_lifecycle.py#L15)、[retrieval_config.py:10-17](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/retrieval_config.py#L10)、[stats_aggregator.py:96](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/stats_aggregator.py#L96)。**`freshness` / `pending_child_changes` 是目录摘要的新鲜度**（决定父目录 L1/L0 是否向上刷新），不是记忆条目的过期。
- **显式遗忘有三条路**：① MCP 工具 `forget(uri, recursive=False)`（"Irreversible — confirm with user before calling."）；② 提取循环里 LLM 可 `delete_ids` / 行级 DELETE 块；③ 底层 `rm` / `mv`（同步更新向量）→ 出处：[mcp_endpoint.py:1903-1905](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/mcp_endpoint.py#L1903)、[json_protocol.py:59-61](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/extraction_output_protocol/json_protocol.py#L59)、[05-storage.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/05-storage.md)
- **隐私配置只覆盖 Skill，不覆盖记忆**：`viking://user/{user}/privacy/{category}/{target_key}/`（`.meta.json` / `current.json` / `history/version_N.json`，支持 upsert / activate / 版本切换）；`category` 目前只有 `skill`。**记忆本身没有 PII 检测或脱敏**，只有 prompt 层的"不要存 secrets"和内联图片 redact → 出处：[13-privacy.md:19,27-33,77](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/13-privacy.md#L19)、[working_memory.py:52](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/working_memory.py#L52)
- **HITL：未找到**。提取在 commit 后台直接落盘，**没有 pending / approve 状态**；全仓 grep `hitl` / `human_in_the_loop` / `needs_review` / `pending_review` 无命中。Web Studio 只有 compile 任务页与 agent-experience 页，唯一的 `window.confirm` 是"停止任务" → 出处：[compile/tasks/$taskId.tsx:124](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/web-studio/src/routes/compile/tasks/$taskId.tsx#L124)
- **可审计性**：靠 `memory_diff.json`（文件级 diff + `trace_id`），不是逐条判定的原因码 → 出处：[session.py:1867](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/session.py#L1867)

### 隔离与隐私

- **三层身份边界：account → user → peer**（比 README 的两层多一层）。`account_id` 是最外层租户边界（"不同 `account` 之间的数据默认完全隔离"）；`user_id` 是 account 内边界；`peer_id` 是 **user 边界内**的内容范围（"不会改变 tenant 或 user 身份"）→ 出处：[11-multi-tenant.md:3,25-35,123](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/11-multi-tenant.md#L25)
- **隔离在存储层是强制的，不靠 URI 前缀**：逻辑 URI → 物理路径时**强制插入** `/local/{account_id}/...`；向量检索强制带 tenant filter（ROOT 除外；非 ROOT 必带 `account_id`，无 ACL 时再加可见根 `PathScope`）→ 出处：[viking_fs/_access.py:685-697](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/viking_fs/_access.py#L685)、[viking_vector_index_backend.py:2887-2905](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/storage/viking_vector_index_backend.py#L2887)、[11-multi-tenant.md:105](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/11-multi-tenant.md#L105)
- **peer 隔离在文件系统层也是硬约束**：不能 read / list / tree / grep / search / find / write / move / delete 其他 peer 的内容 → 出处：[11-multi-tenant.md:130](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/11-multi-tenant.md#L130)
- **写目标解析失败会产生结构化 skip（可审计）**：8 个 reason code 带优先级，`AMBIGUOUS_TARGET` / `NO_WRITABLE_TARGET` 等都会留痕 → 出处：[memory_isolation_handler.py:25-46,73-99](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/session/memory/memory_isolation_handler.py#L25)
- **角色三层 + ACL**：ROOT（全局，跨租户）/ ADMIN（单 account）/ USER；ACL 是 account 内共享资源的细粒度补充 → 出处同上 + [15-acl.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/15-acl.md)
- **认证两模式**：`api_key`（Root key / user key）或 `trusted`（上游注入 `X-OpenViking-Account` / `X-OpenViking-User`，网关断言角色，`X-OpenViking-Role: root` 会被拒）→ 出处同上
- **一个必须知道的安全默认值**：若 `auth_mode = "api_key"` 且**未配置 `root_api_key`**，服务端进入开发模式——**所有请求都被视为 ROOT**，默认身份 `default/default`，只允许绑 localhost。**开发模式与多租户模式的行为完全不同** → 出处：[11-multi-tenant.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/concepts/11-multi-tenant.md)
- **数据会不会离开机器**：默认不会——tracer / usage reporter 全默认关闭，无第三方上报端点，无强制云端握手（见上节）。但**抽取与召回都需要 embedding/VLM**，用云模型时会话内容会发给该厂商 `(推断：README 未给显式数据出境声明)`；另外 `/` 的 CLI 配置向导里有一个默认托管服务地址常量 `https://api.vikingdb.cn-beijing.volces.com/openviking`，仅在主动选托管时使用 → 出处：[store.rs:16](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/crates/ov_cli/src/config_wizard/store.rs#L16)

### 成熟度

抓取于 2026-09-29，来源 [GitHub API](https://api.github.com/repos/volcengine/OpenViking)：

| 事实 | 值 |
|---|---|
| Star / Fork | **38,930** / 3,043 |
| Open issues | **686** |
| 创建 / 最近推送 | 2026-01-05 / **2026-09-29** |
| Archived | `false` |
| 默认分支 | `main` |
| License | **AGPL-3.0**（主项目，`pyproject.toml` 声明 `license = "AGPL-3.0"`）；`crates/` 与 `examples/` 为 Apache-2.0 |
| 版本 | **由 `setuptools_scm` 从 git tag 解析**，无硬编码；README 评测口径绑 0.3.22，changelog 最新 v0.4.9（2026-07-10），桌面包路径停在 0.0.19 |
| 项目自述阶段 | `Development Status :: 3 - Alpha`；"OpenViking is currently in its early development stage" |
| 测试规模 | 795 个测试文件 / 8411 个 `def test_`；28 个 CI workflow |
| 研究背景 | VikingMem（VLDB 2026）、Directory-Aware Query（ICDE）、VikingRAG（投递中） |

→ 出处：[LICENSE](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/LICENSE)、[pyproject.toml:13,20,22](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/pyproject.toml#L13)、[02-changelog.md:30](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/en/about/02-changelog.md#L30)、[01-about-us.md:62](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/en/about/01-about-us.md#L62)、[README_CN.md:281-302](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)

- **是产品**：商业 SaaS（火山引擎托管，个人版/企业版/迁移工具）+ 私有化 BYOC 版（激活码）+ 桌面客户端 Beta（macOS/Windows）+ 在线 Studio + Railway 一键部署 → 出处：[README_CN.md:230-279](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README_CN.md)
- **有 breaking change 且明确标注**（说明不是玩具）：changelog 里有 "Watch API migration (breaking change)"、"Pi extension tool surface (breaking change)"、"**Legacy Memory V1 removed**"、"Legacy `role_id` memory isolation is no longer supported; use the User / Peer model" → 出处：[02-changelog.md:8,22,145,192](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/en/about/02-changelog.md#L8)
- **有一个实验性记忆开关，默认关闭**：`experimental_memory_switch: bool = Field(default=False, ...)`（开启后才加载 `prompts/templates/memory/experimental_memory/` 下的覆盖模板）→ 出处：[memory_config.py:47-53](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/memory_config.py#L47)
- **文档与自身默认值有一处矛盾**：`eager_prefetch` 的 `default=True`，但 description 写 "When disabled (default), LLM has read tool and reads files on-demand." → 出处：[memory_config.py:54-59](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking_cli/utils/config/memory_config.py#L54)
- **`RELEASE.md` / `RELEASE_CN.md` 不是版本历史，是发版指南**（我最初误读为 release notes）；真正的版本历史在 `docs/en/about/02-changelog.md`（753 行 / 52 个版本条目）。`SECURITY.md` 未声明 supported versions，但 README 声称它包含 → 出处：[RELEASE.md:1,35](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/RELEASE.md#L1)、[SECURITY.md](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/SECURITY.md)
- **README 的效果宣称绑在旧版本上**：`README.md:110` 写 "OpenViking **0.3.22** has been evaluated on…"，研究节又写 "OpenViking open-sources **a subset** of these core capabilities" → 出处：[README.md:110,283](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/README.md#L110)
- **AGPL-3.0 是个实际约束**：主项目是强 copyleft，如果把它嵌进我们的插件或分发，许可上要单独评估 `(推断：这不是法律意见)`

### 与 agent 的接线

源码里能数出**六类**接入机制（README 的图标矩阵只是其中一部分）：

| 方式 | 覆盖的 Agent | 出处 |
|---|---|---|
| **服务端 MCP（streamable HTTP，挂 `/mcp`）** | Claude Code / 任意 MCP 客户端；16 工具 | [mcp_endpoint.py:5-9](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/mcp_endpoint.py#L5)、[app.py:806-808](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/app.py#L806) |
| **各 harness hook 插件** | Claude Code、Codex、Cursor、TRAE、ZCode、Kimi Code、OpenCode、pi、Hermes、Open WebUI | [examples/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples) |
| **上下文引擎（contextEngine 槽）** | OpenClaw | [examples/openclaw-plugin/context-engine.ts:387](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/openclaw-plugin/context-engine.ts#L387) |
| **Agent Plugins 1.0 便携包** | 厂商中立的 `plugin.json` + `skills/` + `mcp.json`（5 个 skill） | [agent-plugins/README.md:5](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/agent-plugins/README.md#L5) |
| **SDK 三语言** | Python / TypeScript / Go | [sdk/](https://github.com/volcengine/OpenViking/tree/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/sdk) |
| **HTTP API + CLI + 其它** | `/api/v1/search/{find,search,recall,grep,glob}`、`/api/v1/sessions/{id}/{messages,commit,extract,context}`；LangChain / LangGraph；`ov` Rust CLI；VikingBot | [search.py:62](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/openviking/server/routers/search.py#L62) |

**stdio 是 Node 代理，不是服务端实现**：`agent-plugins/mcp.json` 里 MCP 类型为 `stdio`，命令是 `node servers/mcp-proxy.mjs`；README 解释了为什么不能直接声明 `streamable-http` → 出处：[mcp.json:3-8](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/agent-plugins/mcp.json#L3)、[agent-plugins/README.md:42](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/agent-plugins/README.md#L42)

#### DSH 插件——这一节对我们最重要

OpenViking 有一个正式的 DSH 插件 `examples/dsh-memory-plugin/`（npm 包 **`@openviking/dsh-memory-plugin`** v0.5.8），而且它**和我们做的是同一件事、在同一个平面上**：

- **它是 Cordis 进程内插件**，通过 `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 装配，`export const inject = ["agents", "sessions", "tools"]` → 出处：[package.json:32-36](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/package.json#L32)、[cordis.patch.yml:1-3](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/cordis.patch.yml#L1)、[index.mjs:9-10](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/index.mjs#L9)。文档明确 "插件以 Cordis 插件的形式跑在 DSH 进程内，而不是外挂 hook" → [17-dsh.md:60](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/docs/zh/agent-integrations/17-dsh.md#L60)
- **它挂在六个点**：session-start / **pre-step** / session event / flush / tools pre+post execute / MCP + skills 挂载 → 出处：[index.mjs:37,51,66,72,77-78,83-84](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/index.mjs#L37)
- **它注入召回的方式是 `agent/pre-step` waterfall 追加消息，而不是 system prompt**：

  ```js
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    const additions = [profile, recall].filter(Boolean);
    return additions.length > 0
      ? { kind: "enter", messages: [...decision.messages, ...additions] }
      : decision;
  }, { prepend: true });
  ```

  → 出处：[index.mjs:51-64](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/index.mjs#L51)
- **作者写下了"为什么刻意不进 system prompt"，这条我们必须读**：

  > "They are deliberately **not** added to the system prompt: a DSH preset whose persona declares `complete: true` (the stock `minimal` preset does) restores that persona as the sole prompt section after assembly, **silently discarding every other contribution**."

  → 出处：[README.md:111-114](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/README.md#L111)
- SessionStart 的 profile 走 `agent.inject(profile)` → 出处：[lifecycle.mjs:6](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/lifecycle.mjs#L6)
- **召回有三级降级**：server 端 context 组装 → `/recall` → 原始 `find` → 出处：[recall-core.mjs:712-714](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/memory-plugin-shared/lib/recall-core.mjs#L712)
- **它不直连服务端 `/mcp`，而是走自己的 stdio 代理**，理由写得很具体（`stateless_http=True` 下 `GET /mcp` 会挂一个空闲 SSE 流，MCP 客户端打开它之后就不再解析 POST 响应，`tools/list` 永远不返回）→ 出处：[README.md:124-128](https://github.com/volcengine/OpenViking/blob/af11ccb1d7fc9b65f6d77c966e65953c0ed6282b/examples/dsh-memory-plugin/README.md#L124)

> **对我们的意义（两条，都可执行）**：
> 1. **"不要注入 system prompt"这条经验要立刻验证**。我们目前的注入点是 `systemPrompt.context`（见 [DESIGN.md §2](./DESIGN.md)）。OpenViking 的作者在 DSH 上踩过"preset 的 persona 声明 `complete: true` 会把其他 prompt section 静默丢掉"这个坑，所以改用 `agent/pre-step` 追加消息。**我们的 web profile 用的不是 `minimal` preset，也可能没这个坑，但这是一条可验证的假设，值得花一次实验确认**：如果 `complete: true` 的 preset 会丢弃 `systemPrompt.context`，我们的记忆注入在某些 preset 下就是完全无效的——而且会静默无效。
> 2. **同一个 harness 里可能有三个同类插件同时注入**：`@zilliz/memsearch-dsh`、腾讯 Proxy（改 baseURL）、OpenViking 的 `@openviking/dsh-memory-plugin`。其中 OpenViking 和我们**共用 `agent/pre-step` 这个扩展点**，冲突面比 memsearch 更直接。而且 OpenViking 的 MCP 暴露 `remember` / `forget`——**模型可以自己写记忆**，这和我们的"模型不写"是相反的哲学。

---

## 三方对比表

对照的第四方 `memsearch` 事实取自本仓库已有的 [`docs/memsearch-notes.md`](./memsearch-notes.md)（其一手来源是 `zilliztech/memsearch` 仓库源码与文档）。

| 维度 | 腾讯 TencentDB-Agent-Memory | 字节 OpenViking | memsearch | 我们 dsh-jev-memory | 结论 |
|---|---|---|---|---|---|
| **定位** | 团队级记忆资产平台（Chat Memory/Skill/Wiki/CodeGraph） | 上下文数据库（`viking://` 虚拟文件系统） | 跨平台会话流水记忆 | 类型化、可审计的长期记忆判定层 | 只有我们和 memsearch 是"插件"，另两家是"系统" |
| **记忆分类** | L0 对话 / L1 原子（persona·episodic·instruction，work 模式 +4 类）/ L2 场景 / L3 画像 | Resource·Memory·Skill 三类型 × L0/L1/L2 三层；Memory 下 **11 个 YAML schema（9 启用）** | 无类型体系 | 7 类（constraint/pitfall/decision/preference/procedure/rejected/fact），可配置白名单 | 字节最细且可扩展；我们最可配置且最窄 |
| **"不要记"机制** | prompt"宁缺毋滥" + LLM 可判 `skip` + 运维 kill switch（`extraction.enabled`） | **LLM 侧没有"不记"输出位**；只有 9 个隔离类 skip code + prompt 软约束 + 默认关闭的正则 `captureFilters` | 无（全量落盘） | **代码里的确定性 `veto:*` 原因码，且写进台账** | 腾讯比字节强；我们最可追责 |
| **写入判定** | LLM 抽取（情境切分+提取一次调用）；**priority 阈值只在 prompt 里** | LLM 按 YAML schema 抽取；无 importance 分级 | **完全不判定**，每回合全量落盘（作者当卖点） | 确定性筛子 + Jev 判定 + 代码阈值闸门 | **只有我们同时有确定性筛和代码阈值** |
| **记忆正文来源** | LLM 生成（merge 时重写 `merged_content`） | LLM 按 schema 生成 | LLM 摘要成 2–10 条 bullet | **只能是用户原话或工具错误签名** | 我们是唯一"模型不写"的 |
| **去重/合并/冲突** | 4 动作 `store/update/merge/skip` + 跨类型 + 多目标；合并后 priority 可提升 | `merge_policy`：同 identity 才合并、原子事实守恒、超大则拆；**冲突时整批 `ConflictError` 拒绝** | 仅 session/turn 幂等 + chunk SHA-256 | Jev 判冲突概率 → 词重叠/模型配对 → **HITL 三选项** | 腾讯/字节合并能力强；**只有我们有 HITL** |
| **召回** | FTS5 BM25 ∥ 向量 + **RRF k=60**（或 TCVDB 服务端混合）；**无 rerank** | LLM 意图分析（0–5 TypedQuery）→ **目录范围下推为向量前置过滤** → dense(+可选 sparse，单权重 `sparse_weight` **默认 0**) → 递归 → **rerank**（`doubao-seed-rerank`，阈值 0.1，可回退） | Milvus 向量；Jev/Voyage 可选 rerank | **无向量、无模型**：类型配额 + importance×时间衰减 + 子串/token 匹配 | **三家融合方式都不同：RRF / 单权重 / 纯向量**；我们可解释性最高 |
| **注入位置** | L3/L2 → system prompt（可缓存）；L1 → user prompt 前缀；工具化 L0/L1 | **`agent/pre-step` 追加消息，刻意不进 system prompt**；L0→L1→L2 渐进披露 | `agent/pre-step` 注入（我们 README 记录口径） | `systemPrompt.context`，每步注入 Top-K | **OpenViking 在 DSH 上明确避开了 system prompt，理由值得我们验证** |
| **配额/预算** | `maxResults=5`、`scoreThreshold=0.3`、字符预算默认关闭、`timeoutMs=5000` | **按用途的硬配额**（coding: events 1/entities 2/preferences 1/experiences 1/resources 3/skills 2）+ 1600 token 预算 + 每类默认层级 + 单条上限=均分×2；**明确不用绝对分数阈值**（分数带只有 0.38–0.50） | 无命中零成本、仅 step 1 检索 | 类型配额（4/3/2）+ 600 token 预算 | **字节的配额制和我们同构**，且它给出了"为什么不用分数阈值"的量化理由 |
| **存储** | SQLite + localfs（默认）/ TCVDB / MongoDB / COS | RAGFS（Rust）+ 内嵌 C++/LevelDB 向量引擎，内容与索引分离 | markdown 为准 + Milvus 派生索引 | 本地 `memory.json` + `ledger.jsonl` | 我们零依赖最轻 |
| **外部依赖** | Node ≥22.16 + OpenAI-compatible LLM（BM25 无需 embedding） | Python ≥3.10 + cmake/maturin + Rust ≥1.91.1；**embedding 事实上必需**（默认自动用本地 GGUF，首启需联网下载）；VLM 可选有降级；**无纯 BM25 回退** | Python 3.10+ + milvus-lite + 558MB ONNX | **零依赖、零网络（无 key 时降级启发式）** | 我们的部署成本最低 |
| **公开评测** | **仓库内无任何评测代码/数据**；数字只在 README + 博客 | `benchmark/` 11 个子集 + 脚本，但**benchmark 下零结果文件**，10 个数字只在 3 行 README + 2 个 SVG | embedding 选型 + rerank 对比，4344 行 | 20 条标注候选集，可复跑 | 腾讯最弱；字节脚本最全但结果不可核 |
| **指标定义** | 未找到（只写"准确率/成功率"） | LoCoMo = LLM-judge CORRECT/WRONG（**解析失败记 WRONG**），**排除 category 5**；memory_organization = 2 个正交指标 + McNemar + **无 LLM 的确定性 grader** | Hit@K / Recall@K / MRR@10 / NDCG@10，**给了代码** | 写入 precision/recall/F1；Hit@K / Recall@K（待测） | memsearch 的定义最可复现；字节的统计最严谨 |
| **数据集来源** | PersonaMem（外链公开集）+ WideSearch/SWE-bench/AA-LCR（细节未找到） | LoCoMo（**自备** `locomo10.json`，下载源在同仓）、tau2-bench（外部 checkout，需钉 PR）、HotpotQA、5 个 RAG 集、**自建 fixture**、PersonaMem-v2（HF） | 12 个真实项目的记忆文件 + `gpt-5-mini` 生成查询 | 20 条人工标注（8 正 + 12 负，8 条取自真实误记） | 只有字节和 memsearch 的数据集可独立取得 |
| **对照基线** | 有（无插件 / 同一 LLM） | 有（原生记忆 / 无记忆 / Naive RAG / HippoRAG 2 / LightRAG / mem0 / supermemory…） | 有（冻结候选序） | 有（启发式 vs Jev 多阈值曲线） | 都做了基线 |
| **自证局限** | **未找到** | **有且具体**（旧 guided 产物"不得当证据"、诊断路径不得证据、cuVS 自称 preliminary、AML 自称非官方分、tau2 划定证据边界） | 有 4 条 | 有（漏判两条、假阳性更贵、多进程 last-write-wins） | 腾讯是唯一没有的 |
| **复现性** | 不可复现（无脚本） | **可复现但有坑**：issue #1258 第三方 7.66% → 承认默认值不够 → 调参后 83.44%；tau2 严格复现需本地生成 fixture；cuVS 需 H20 GPU | 可复现（给了脚本与数据构造方式） | 可复现（离线、20 条集） | 字节的"调参后才达标"是最重要的诚实信号 |
| **冲突/过期/遗忘** | merge/update；**无 TTL**；删除靠 API；面板只读+删（ROADMAP 承认无法编辑） | merge_policy + `ConflictError`；**无 TTL**（hotness 半衰期 7 天但默认关闭且只用于统计）；`forget` MCP 工具；`ov compile` 离线整理 | 无 | 冲突走 HITL；`memory_forget` 工具；`needs-review` 默认不注入 | **只有我们把"不确定"显式放进数据模型** |
| **人工介入（HITL）** | **未找到**（表单是会话初始化） | **未找到**（Studio 是事后编辑；无 pending/approve 状态） | 无 | **有**：冲突时三选项，超时延后重问，最多 3 次 | 我们的差异化能力 |
| **隔离** | 三维强隔离（team/user/agent/session），默认抛错；资产私有/团队/ACL 四级 | account→user→**peer** 三层；存储层强制 tenant filter；ROOT/ADMIN/USER；**开发模式默认 ROOT（有风险）**；无第三方遥测上报 | 无多租户设计 | cwd + 全局两档；子代理默认不学习 | 两家的多租户成熟得多；我们的粒度是"工作区" |
| **审计** | 生成溯源（Prompt ID/版本/哈希/输入输出引用），**不存 Prompt 正文** | **每次 commit 产出 `memory_diff.json`**（文件级 add/update/delete + `trace_id`） | 无 | **只追加台账，每次写入/跳过/召回/提问都记原因** | 三家粒度不同：腾讯=生成溯源，字节=文件级 diff，我们=逐判定原因码 |
| **许可** | MIT（LICENSE 正文；GitHub API 识别为 NOASSERTION） | **AGPL-3.0**（主项目，1281 文件；crates/examples 为 Apache-2.0） | MIT | 本项目自有 | AGPL 会影响嵌入分发 |
| **成熟度** | 27,453★ / 856 issue / 2026-04-07 创建 | 38,930★ / 686 issue / 2026-01-05 创建；**Alpha**，自述 early stage；795 测试文件 / 8411 测试 | 2,671★ / 263 issue | 本地插件，未发布 | 两家都是真产品，不是原型 |
| **DSH 接线** | OpenAI-compatible Proxy（改 baseURL） | **官方 `@openviking/dsh-memory-plugin` v0.5.8**，Cordis 进程内插件，挂 `agent/pre-step` + session-start 等 6 点 | 原生 `plugins/dsh` | 进程内插件（`file:` URL），`systemPrompt.context` | **三家都进 DSH，且 OpenViking 和我们共用 `agent/pre-step`** |

---

## 关于评测，我们能借鉴什么

这一节只写能落地的判断。

### 他们定义的指标，哪些能直接抄

**能抄（公式层面，抄了就能跑）**：

1. **memsearch 那套排序指标**——`Hit@K` / `Recall@K` / `MRR@10` / `NDCG@10` 四种，定义、macro-average 口径、多正例消歧例子、"gold 非空且候选 ID 唯一"的前置校验，都在它的评测文档里，且附了可抄的实现（[memsearch-notes §评测](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。我们 README 已经采纳了 Hit@K / Recall@K 的双定义。
2. **字节 `memory_organization` 的统计骨架**——不是它的题目，是它的**形式**：
   - 两个**正交**指标（一个测"动作对不对"，一个测"信息有没有丢/重复"），刻意让二者不相关；
   - **配对**重复采样（同一条件跑 N 次）而不是单次对比；
   - **双侧精确 McNemar** 报 p 值；
   - 明确写"一次有利样本不算证据"。
   这套结构可以直接平移到我们的"写入判定改动前后"对比上。
3. **两个数据卫生习惯**：
   - 字节 LoCoMo 统计**排除 adversarial 类目**并**单独统计 `is_valid` 子集**——即"把不可判/不该判的题排除，并公布排除了多少"；
   - 腾讯/字节都报 **token 与延迟**，不只报准确率。我们的台账已经有 `tokens` 字段，这个可以立刻补上。
4. **字节 tau2 README 的"证据纪律"**——"reproduction surface is intentionally narrow" + 明确列出哪些配置**不是证据**。这是文档层面就能抄的，成本为零。

**抄不了（不是定义问题，是评测台问题）**：

- **LoCoMo 式的端到端准确率**：需要"把长对话灌进记忆系统 → 让 agent 用记忆回答问题 → LLM judge 判分"，还要一个能跑被测 agent 的 harness 和 judge 预算。我们现在没有 agent 端到端评测台，也没有 LLM judge 的成本预算。
- **tau2-bench**：需要 tau2 环境和多次 LLM 采样（issue #1258 里用户单跑一个 sample 就花了 10,554 秒 QA 时间）。
- **PersonaMem 对照**：腾讯连脚本都没给，等于不可复现，不构成可对标基线。
- **字节的 memory_organization**：它的题目是**为它自己的 schema 重组协议**设计的（重复文件合并 / 混合文件拆分 / 别名合并），和我们的"这条用户原话该不该记"不是同一个任务。抄结构，不抄题。

### 他们踩过的坑，比指标更值钱（六条，逐条对我们有用）

这是本次调研里**最可复用**的部分——每一条都能在我们自己动手评测前就避开。

1. **发布数字和发布脚本是两件事**。OpenViking 有 11 个 benchmark 子集、176 个文件、一键脚本，但 `benchmark/` 下**零结果文件**（`.gitignore` 就是 `results/`），10 个公开数字只存在于 3 行 README 图片 alt 文本和 2 个 SVG。教训：**"我们给了脚本"不等于"我们的数字可核对"**。我们若报任何数字，必须连同结果文件一起进仓库。
2. **默认值不是评测值**。OpenViking 官方测试要达到 82% 需要把 `recallLimit` 从默认 10 调到 30、`recallScoreThreshold` 设 0.35、`recallMaxContentChars` 设 4000（[issue #1258](https://github.com/volcengine/OpenViking/issues/1258)）；tau2 的记忆召回也从默认 5 条/2000 字符改成 2 条/10000 字符，README 明说这是刻意的（"prefer fewer but longer"）。教训：**任何评测结论都必须写清"用的是哪套参数"，并且最好同时报默认参数下的数字**。我们的阈值 0.6 同理——报曲线，不报单点。
3. **同一份 benchmark，不同 arm 的判分口径可能不一致**。OpenViking 的 LoCoMo 有 7 个 arm，`openviking` 用 `label` 字段的 lenient/strict 模板，其余四臂用 mem0 风格的 `is_correct` 模板；连类别编号映射在仓库里都有**两套互斥定义**（`locomo_prompts.py` 说 1=multi-hop、4=single-hop；`mem0/README.md` 说 1=single-hop、4=world-knowledge）。教训：**跨条目/跨版本对比前先确认判分器是同一个**。我们将来若加对照实验，judge 必须锁版本、锁 prompt。
4. **判分链路的失败会被算成"答错"**。OpenViking 的 judge 在 JSON 解析失败或 API 异常时一律 `return False`（即 WRONG），而不是丢弃该题。教训：**我们的台账必须能区分"判定模型挂了"和"判定模型说不行"**——好消息是我们已经有 `kind:"degraded"` 和 `by:"heuristic"`，这个坑我们天然避开了。但**评测脚本本身也要遵守这一点**：我们 README 里已经记过一条同类教训——"评测绕过的规则等于没有的规则"。
5. **第三方复现的失败往往出在数据入库格式，不在算法**。issue #1258 的根因是 eval 的 ingest 把整个 session 当成一条 message、且没给时间戳，导致事件记忆根本没生效（7.66%）。维护者诊断后改成一键脚本才拿到 83.44%。**同一 issue 里还暴露了隔离问题**：导入数据落在 `conv-41` 用户下、旧脚本落在 `default` 下，直接检索不到。教训：**我们的评测脚本要用与生产完全同一条写入路径**（我们 README 已经为此收敛了 `screenSentence` 单一入口），并且**评测数据的 `cwd` 归属要和被评测的查询一致**——这正是我们 `cwd` 隔离会踩的同类坑。
6. **报告统计口径要写死，否则同一批数据能算出不同的数**。OpenViking 的 LoCoMo 是 micro 平均（全局一个数，`correct/(correct+wrong)`，排除 category 5 与 `is_invalid`），memsearch 是 macro-average over query rows。两者都合理，但**不可混用**。教训：我们的 Hit@K / Recall@K 必须写明是 macro 还是 micro、多正例怎么算（我们 README 已经写了消歧例子，这是对的）。

> **还有一条负面教训**：OpenViking 的 `cuvs` 结果自称 "preliminary… not a final performance claim"，AML 自称 "**local proxy results** rather than official leaderboard scores"，`memory_organization` 说旧 guided 产物 "must not be used as evidence"。**一个团队愿意写这些句子，说明它分得清"我们跑出来的数"和"能当证据的数"。** 这是文档层面最便宜、也最被低估的一项投入。

### 我们手里的数据够不够

我们的资产：**28 个历史会话、约 1000 条真实候选**、一个 20 条的人工标注集（8 正 + 12 负，其中 8 条取自真实误记）、以及只追加的台账。

按评测类型分别判断：

| 想做的评测 | 现有量够不够 | 判断 |
|---|---|---|
| **写入精确率**（该不该记） | **够，且是最该先做的** | 候选来自真实分布，标注单位是"一条候选"，成本低。从 20 → 100+ 条完全可行：1000 条候选里分层抽（按 `type` 与被 `skip` 的原因分层），标注工作量约半天。**这是我们的主场** |
| **召回 Hit@3 / Recall@3** | **勉强，是当前的瓶颈** | 指标需要的不是"候选"，而是**查询 + 该查询的正例集合**。28 个会话里能自然构造的查询有限 `(推断：按每会话 2–3 个真实提问算，约 55–85 个查询)`。这个量能出一版数字，但**不支持统计检验** |
| **阈值/提示词改动的 A/B** | **不够** | 配对检验（McNemar）要求"不一致对"足够多。80 个查询下，如果改动只影响 15% 的查询，不一致对只有约 12 对——p 值会随一两条翻动而剧烈变化。要在 80 查询上做出可信的配对比较，改动的影响面需要 ≥ 25% |
| **端到端任务成功率**（他们那种） | **差得远** | 需要 agent harness + LLM judge + 多次采样。且我们的插件不改变模型能力，端到端提升会更小、噪声更大，样本需求反而更高 |

**具体差在哪（三条）**：

1. **没有查询-正例标注**。写入侧有 20 条标注，召回侧一条都没有——README 里 Hit@K/Recall@K 至今写"待测"就是这个原因。
2. **没有 held-out 划分**。台账里所有数据都参与过调参（阈值 0.6、prompt 档位都是在这批数据上定的），所以在这批数据上报的任何提升都是**乐观偏差**。
3. **没有重复观测**。Jev 有随机性（温度/模型别名漂移），单次前后对比无法区分"改动生效"和"这次抽签好"。台账里记了 `model` 版本号，但没记同一输入的重复结果。

### 怎么补（按性价比排序）

1. **先把写入精确率做到 100+ 条并固化**。分层抽样 100 条真实候选（按 type / skip reason / 是否子代理会话分层），人工二标。产出：一张带置信区间的 precision/recall 表 + 从 0.3/0.5/0.6/0.7 的完整曲线。**这是唯一一项我们现在就有足够数据、且别人都没做的评测**（腾讯和字节都不报"写入精确率"）。
2. **召回评测从"真实提问"取查询，不构造查询**。每个会话里模型开始干活前用户的那句真话就是天然查询；正例 = 该会话后续被写入、且与该提问共享主题的记忆（用台账的 `source.sessionId` 定位）。目标是 **50 个查询起步、100 个封顶**。
3. **划分方式用"按会话切"而不是"按条目切"**。会话之间信息不重叠，按会话切能避免同一句话同时出现在训练与评测里——这是最低成本的 held-out。
4. **改动对比改用配对 bootstrap，而不是 McNemar**。McNemar 要求大样本；在 50–100 个查询上，对"同一批查询、改动前后各跑一次"做 **paired bootstrap 置信区间**更稳，也更符合我们"样本小、人工标注"的现实。
5. **把台账字段补齐，让评测能自动化**：现在缺的是"这次召回的每条是否被模型真实采用"（字节也没做这一项，见下节）。可以先退一步，只记"查询 → 召回 id 列表 → 各条分数"，让 Hit@K 可以直接从台账算。
6. **达到 100+ 查询之后，再考虑 MRR/NDCG**。在那之前报 MRR 是过度解读。

**一句话**：他们的**指标形式**能抄，**数据集**抄不了；我们唯一有把握做出可信结论的评测是**写入侧**，召回侧必须先补标注、先划 held-out，再谈对比。

---

## 明确的空白（他们都还没做 / 没说清）

**两家共有的空白**

1. **都不报"写入精确率 / 误记率"**。腾讯、字节、memsearch 报的都是端到端或任务成功率，没有一家给出"写进去的记忆里有多少条是错的"。**这是我们的主场，也是唯一可以直接立起来的差异点**。
2. **都不度量"错记的污染成本"**。一条错记会进入此后每个会话的提示——这个成本没有任何一家量化过 `(推断：三家仓库与博客均未找到相关指标)`。
3. **都不度量"召回的记忆是否真被模型用了"**。召回命中 ≠ 模型采用。字节的 LoCoMo accuracy 混在一起，腾讯同理。
4. **都没有时间衰减/TTL**。腾讯 L1-L3、OpenViking 记忆条目都没有 expire（腾讯只有 Skill 版本有 TTL）。我们至少有半衰期 180 天的排序衰减（但不是删除）。
5. **都没有面向记忆写入的 HITL**。OpenViking 的 Web Studio 是事后浏览编辑，腾讯的面板按 ROADMAP 连编辑都还没有。**只有我们把"我不确定"变成数据模型里的 `needs-review`**。
6. **都没有把"被拦下的候选"记成逐条可分析的数据**。腾讯是 `logger.debug`；OpenViking 有 8 个 `MemoryOperationSkipCode`（但只覆盖隔离/越权，不覆盖"不值得记"）和每次 commit 的文件级 `memory_diff.json`；memsearch 什么都没有。**只有我们的 `ledger.jsonl` 是"每一次写入/跳过/召回/提问都带原因码"的逐判定台账。**

**腾讯独有的空白**

7. **仓库内零评测**。连一个 eval 目录都没有，PersonaMem/WideSearch/SWE-bench/AA-LCR 四个数字全部不可复现。
8. **没有任何自证局限**。README 的"注意事项"只讲异步构建和私有仓库支持。
9. **没有任何自动遗忘/过期策略**，也没有 HITL；ROADMAP 自己承认面板"只能查看和删除，无法修正"。
10. **priority 是"只写不读"的字段**。prompt 里给了精细的打分档位，代码里没有任何地方拿它做闸门——等于让模型自己保证不写垃圾。

**OpenViking 独有的空白**

11. **LoCoMo 只报 accuracy，不报检索指标**（整个 `benchmark/` grep `ndcg|MRR` 零命中）。一个以"目录检索"为卖点的系统不公开检索质量指标，是最该补的一块。
12. **发布的是脚本，不是结果**。`benchmark/` 下零结果文件；10 个公开数字只存在于 3 行 README 图片 alt 文本 + 2 个 SVG。**没有一处可核对的结果文件。**
13. **无 TTL / 无过期 / 无自动遗忘**。唯一的时间衰减（hotness，半衰期 7 天）**默认关闭且只用于统计聚合**，不参与召回打分。
14. **无 HITL 审批**。提取在后台直接落盘，无 pending/approve 状态；Studio 只能事后编辑，且唯一的 confirm 是"停止任务"。
15. **公开数字依赖厂商闭源模型**（`doubao-embedding-vision-251215` + `doubao-seed-2-0-pro/code-preview` + `doubao-seed-rerank`），**不可在无 Ark API 的环境复现**。
16. **默认配置达不到文档数字**，且这一点是第三方在 issue 里逼出来的，官方文档本身没写"需要调参到 recallLimit=30"。
17. **"不要记这条"没有 LLM 侧的落点**。提取协议只允许写/改/删，系统级 skip code 全部关于隔离与越权；真正能表达"这条别记"的只有 prompt 软约束和一个**默认关闭**的正则过滤器。
18. **开发模式默认 ROOT**——未配 `root_api_key` 时所有请求都是 ROOT，这是文档里写了但容易被忽略的默认值。
19. **隐私配置只覆盖 Skill，不覆盖记忆**（`category` 目前只有 `skill`）；记忆没有 PII 检测。
20. **`TrieHI` 只存在于 README**。全仓源码未找到实现，`trie` 零命中。以它为卖点的"目录感知检索"在代码里的真身是两处范围下推逻辑，而不是论文里那个数据结构。
21. **文档与源码有可引用的偏差**：`05-storage.md` 的集合字段表列了源码里不存在的 `parent_uri`，漏列了实际存在的 `level`/`tags`/`search_tags`/`content`/`md5`/`account_id`/`owner_user_id`；`memory_config.py` 里 `eager_prefetch` 的默认值与自己的 description 矛盾。
22. **`RELEASE.md` / `RELEASE_CN.md` 不是版本历史**（是发版指南），README 的效果宣称绑在 0.3.22，changelog 已到 0.4.9，桌面包路径停在 0.0.19——**三处版本漂移**。

**验证成本层面的空白**

23. **没人公开"复现一次评测要花多少"**。从源码能读出的门槛：tau2 严格复现需要本地生成 fixture + 钉住上游 PR；cuVS 需要 H20 GPU；LoCoMo 单 sample 的 QA 就要约 3 小时（10,554 秒）；两轮实验之间硬编码 `sleep 9000`；构建期要 cmake/maturin/Rust 1.91.1。**这些成本没有一家在 README 里汇总过。**
24. **一处工程卫生问题**：`benchmark/locomo/openclaw/run_full_eval.sh:22` 里**提交了一个明文 OpenClaw GATEWAY_TOKEN**，而同一仓库的 README 又把它列为"需要自行设置"的变量。引用该脚本时不要照抄这个值。

---

## 未确认的点

以下都是**查不到**，不是"大概如此"。列出来是为了避免以后有人把它们当已确认事实引用。

**腾讯**

1. PersonaMem 评测的**具体口径**全部未找到：多少题、judge 是谁、几次采样、是否 held-out、48%/76% 的分母是什么。
2. WideSearch / SWE-bench / AA-LCR 的**版本、切分、评测设置**未找到（博客只给了一张结果表）。
3. "超长 session 评测"的 session 长度、任务类型、评分方式未找到。
4. 三个百分点的**采样次数与置信区间**未找到。
5. **L2 scene navigation 全量注入的 token 上限**未在代码中找到（注释说 "full injection, LLM decides relevance"，但没有 cap 常量）。
6. 各 LLM 调用点（抽取 / 冲突检测 / L2 / L3）的**具体模型与温度**未找到默认值。
7. TCVDB / COS / mongofs 的**数据实际落在哪个 region、是否出境**未找到明确声明。

**OpenViking**

8. LoCoMo 82.08% / 82.86% / 80.32% 的**采样次数**、**judge 模型版本**、以及用了 4 种 judge prompt 中的**哪一种**未找到（`judge.py` 支持 lenient/strict ± evidence 四种变体，博客未说明）。
9. 博客数字中 **category 5（adversarial）是否已排除**未找到（`stat_judge_result.py` 与 `judge.py` 都排除，但博客口径未说明它用的是哪一个统计脚本）。
10. tau2 的**精确任务条数**未找到——任务清单来自外部 tau2-bench checkout 的 `data/tau2/domains/<domain>/split_tasks.json`，不在本仓。
11. `openviking/eval/`（含 `ragas/`）与 `benchmark/` 的关系、是否为 RAGAS 内置评测未确认。
12. **记忆条目是否有任何分数/优先级字段**未找到（合并策略依赖 identity 与 atomic fact，不依赖分数）；Rerank 阶段的分数**是否回写存储**未确认。
13. `custom/`、`vectordb_perf/`、`retrieval/grep/` 三处的**指标定义与具体数字**只读到 README 与脚本层，未逐份读完 `(未找到，不是"没有")`。
14. **peer 记忆的实际启用面**未确认：schema 有 `peer_enabled`（`cases` 显式 false），但哪些类型在真实部署里开了 peer 写入，文档未给完整表。
15. **`sparse_weight` 在生产配置里的实际取值**未找到（默认 0.0；官方评测是否开了 sparse 未说明）——这直接影响"它到底算不算混合检索"。
16. **`benchmark/` 的 10 个公开数字对应哪个 commit / 哪个 tag** 未找到（README 写 0.3.22，仓库快照是 `af11ccb`，两者关系未确认）。

**方法学层面的未确认**

17. 两家博客与 README 的数字都是**特定模型 + 特定版本**下的结果，**换模型后是否成立**未验证。
18. 两家的评测都**没有公布 prompt/上下文预算与结果的联合曲线**（token 降了、准确率升了，但没给"再压一半 token 会掉多少"）。
19. 本笔记中的 star / fork / issue 数是 **2026-09-29 抓取的瞬时值**，会继续变化。
20. 我们无法核对**腾讯仓库文档与已发布产品行为是否一致**——文档写 v2.0.0，ROADMAP 写 v2.0.1-beta.1，默认分支是 `feat/server_team`，三者关系未确认。
21. **我们自己没有跑过这两个系统**。本文所有事实都来自源码阅读、官方文档、官方博客与第三方 issue，**没有一处来自实际部署验证** `(唯一的例外是 issue #1258 里第三方跑出的数字)`。因此"它能跑起来吗""它的召回在真实会话上什么样"这类问题，本文一概不能回答。

---

## 关于本文的取证方式（供复核）

因为两个仓库都很大（腾讯约 20 万行 TS + 9 千行 Python；OpenViking 约 1940 个 Python 文件 + Rust/C++/TS），本次采用**源码阅读 + 关键结论交叉验证**：

- 两个仓库都 `git clone --depth 1` 到 `/tmp` 后逐文件读，调研完成后**已删除 clone**。
- 本文的一部分源码事实来自**并行的源码级子调研**（同一份 clone、同一 commit），每条都带 `文件:行号`。
- **风险最高的几条我自己复核过**：LoCoMo 类别映射的两套互斥定义（`locomo_prompts.py:7` vs `mem0/README.md:34`）、judge 解析失败计为 WRONG（`judge.py:132-140`）、以及"10 个公开数字在仓库里只命中 3 行 README"（全仓 grep 验证）。
- 所有 `(推断)` 标记的地方是**我的推理**，不是仓库事实；所有"未找到"是**真的没找到**，不是"大概没有"。

---

## 引用文件清单（本次实际读取的一手来源）

**腾讯（`29bb8df`，clone 已清理）**

- `README_CN.md`、`ROADMAP_CN.md`、`LICENSE`
- `MemoryCore/README_CN.md`
- `MemoryCore/src/core/types.ts`、`record/l1-writer.ts`、`record/l1-dedup.ts`
- `MemoryCore/src/core/hooks/auto-capture.ts`、`hooks/auto-recall.ts`
- `MemoryCore/src/core/prompts/l1-extraction.ts`、`prompts/l1-dedup.ts`、`prompts/scene-extraction.ts`、`prompts/persona-generation.ts`
- `MemoryCore/src/core/persona/persona-trigger.ts`、`core/store/isolation.ts`、`core/tools/memory-search.ts`
- `MemoryCore/src/core/backend-selection/types.ts`、`src/config.ts`、`src/utils/pipeline-manager.ts`
- `MemoryCore/scripts/bench-l0-mongo/metrics.ts`、`report.ts`
- `MemoryProxy/README_CN.md`、`MemoryProxy/src/extraction-gate.ts`
- `MemoryKnowledge/README.md`、`src/mcp/tools.ts`
- `agents/dsh/README.md`、`MemoryPanel/README.md`
- 官方博客：<https://cloud.tencent.com/developer/article/2668579>
- GitHub API：<https://api.github.com/repos/TencentCloud/TencentDB-Agent-Memory>

**OpenViking（`af11ccb`，clone 已清理）**

- `README.md` / `README_CN.md` / `README_JA.md`、`RELEASE.md` / `RELEASE_CN.md`、`SECURITY.md`、`LICENSE`、`Cargo.toml`、`pyproject.toml`、`setup.py`、`docker-compose.yml`、`Dockerfile`、`Makefile`
- `docs/zh/concepts/02-context-types.md`、`03-context-layers.md`、`04-viking-uri.md`、`05-storage.md`、`06-extraction.md`、`07-retrieval.md`、`11-multi-tenant.md`、`13-privacy.md`、`15-acl.md`
- `docs/zh/context-compilation/06-memory-consolidation.md`、`docs/zh/agent-integrations/17-dsh.md`、`docs/en/about/01-about-us.md`、`docs/en/about/02-changelog.md`
- `openviking/core/context.py`、`core/namespace.py`、`core/directories.py`、`core/identifiers.py`
- `openviking/session/session.py`、`session/memory/extract_loop.py`、`dataclass.py`、`merge_policy.py`、`merge_op/base.py`、`memory_type_registry.py`、`memory_isolation_handler.py`、`memory_updater.py`、`streaming_memory_updater.py`、`consolidation_context_provider.py`、`agent_experience_context_provider.py`、`session_extract_context_provider.py`、`extraction_output_protocol/json_protocol.py`、`utils/memory_file_utils.py`、`tools.py`
- `openviking/prompts/templates/memory/*.yaml`（profile / preferences / entities / events / identity / soul / cases / trajectories / experiences / skills / tools）
- `openviking/retrieve/hierarchical_retriever.py`、`intent_analyzer.py`、`memory_lifecycle.py`、`context_assembler/{params,budget,recall_preset}.py`
- `openviking/storage/collection_schemas.py`、`viking_vector_index_backend.py`、`vectordb_adapters/{base,volcengine_adapter}.py`、`queuefs/semantic_processor.py`、`queuefs/semantic_queue.py`、`queuefs/session_commit_msg.py`、`viking_fs/{_access,_semantic,_grep,_ops}.py`、`stats_aggregator.py`
- `openviking/service/{search_service,session_service}.py`、`server/{app,config,mcp_endpoint}.py`、`server/routers/{search,sessions,stats}.py`
- `openviking_cli/utils/config/{memory_config,parser_config,retrieval_config,rerank_config,embedding_config,agfs_config,vectordb_config,telemetry_config}.py`、`openviking_cli/utils/ollama.py`、`openviking/models/embedder/local_embedders.py`
- `crates/ragfs/src/lib.rs`、`crates/ragfs/Cargo.toml`、`crates/ov_cli/src/config_wizard/store.rs`、`src/store/persist_store.cpp`
- `examples/dsh-memory-plugin/{index.mjs,lifecycle.mjs,README.md,package.json,cordis.patch.yml}`、`examples/memory-plugin-shared/lib/{input-filters,config-schema,recall-core}.mjs`
- `agent-plugins/{README.md,mcp.json,plugin.json}`、`agent-plugins/skills/openviking-memory/SKILL.md`
- `deploy/helm/openviking/values.yaml`
- `benchmark/locomo/README.md`、各 arm 的 `judge.py` / `stat_judge_result.py`、`locomo/openviking/{locomo_prompts.py,judge.py,stat_judge_result.py}`、`locomo/mem0/README.md`、`locomo_bad_case_questions.csv`
- `benchmark/tau2/llm/{README.md,config/*.yaml,config/scope_prompts/generic_memory_scope.md}`、`benchmark/tau2/vikingbot/README.md`
- `benchmark/memory_organization/{README.md,grader.py,autonomous_grader.py,report.py,report_autonomous.py,models.py,cases/*.json}`
- `benchmark/RAG/{README.md,src/core/metrics.py,src/core/judge_util.py,src/pipeline.py,scripts/download_dataset.py,config/locomo_config.yaml}`
- `benchmark/{aml,skillsbench,cuvs,longmemeval,retrieval,custom,vectordb_perf}/**`
- 官方博客：<https://blog.openviking.ai/post/openviking-benchmark-results/>
- issue #1258（含 34 条评论）：<https://github.com/volcengine/OpenViking/issues/1258>
- GitHub API：<https://api.github.com/repos/volcengine/OpenViking>


---

## 附录：L1 抽取提示词里"AI 输出"怎么处理（2026-10-02 读源码）

来源：`MemoryCore/src/core/prompts/l1-extraction.ts`（417 行，commit `29bb8dffa9b11617316d50f21d7a8af9f47240be`）

**喂给模型的格式**（`formatExtractionPrompt`，同文件 ~L398）：每条消息渲染成
`[id] [role] [timestamp]: content`，一次喂一批（【背景对话】+【待提取的新消息】）。
**role 是显式的**，所以模型分得清哪条是 user、哪条是 assistant。

**明确排除项**（"不应该提取的内容"）里有：**"AI助手自身的行为或输出"**。

**专门一条规则**：

> **7. AI / Agent 输出处理：**
> - 不要把 AI 的建议自动当成团队事实或团队决策。
> - 只有当人类成员采纳、确认，或 Agent 输出本身是明确的工具执行结果、交付物、实验结果时，才可以提取。
> - AI 生成的草案、方案、分析，如被明确作为后续工作资产使用，可提取为 work_artifact 或 work_method。

还有一条相关纪律："准确归因：某人提出的建议、担忧、判断，不等于团队决策。只有出现明确确认、拍板、采纳、执行安排时，才能写成确定结论。"

**但要注意它防的是哪种情况**：规则 7 说的是 **role=assistant 的消息**。用户把模型的输出**粘进自己的消息**之后，role 就是 user，**这条规则不会触发**——全文件里没有一条针对"用户消息内的粘贴/引用区间"的规则（grep `引用|他人的|第三方|转述|复制` 只命中一处，是 work_artifact 的定义里列了"引用"）。

**结论：两家都靠"角色 + 明确规则"，没有一家处理"用户把模型输出粘贴进自己的消息"。** 而这恰好是 round5 里 30 行 note 说的那种情况（其中 0 行标 1，今天仍有 24 行会被放行）。
