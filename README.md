# dsh-jev-memory

**类型化、可审计的 DSH 长期记忆插件。** 一句话定位：

> `AGENTS.md` 是人手写的记忆；这个插件是**自己长出来、按需召回、逐条可审计**的记忆。

DSH 官方有会话持久化（JSONL）、会话检索（SQLite FTS）、compaction（压缩丢弃），但**跨会话的长期记忆**是空白：没有任何官方包回答"什么值得记住"和"这一轮该想起什么"。本插件补的就是这一层判断。

---

## 它做什么（当前已实现并实测）

| 环节 | 实现 | 位置 |
|---|---|---|
| **写入** | 挂在 `agent/turn-stopping`（serial + awaited，回合收尾前）抽取候选 → 判定 → 过确定性闸门 → 落盘 | `dsh/index.js` |
| **判定** | 端口式：**Jev**（TypeSafe 判定模型）为首选，**确定性信号**为离线兜底。判定层只出标签与概率，**不生成文本** | `dsh/lib/judge.ts`、`dsh/lib/jev.ts` |
| **存储** | 本地 `memory.json` + 只追加的 `ledger.jsonl`，原子写、内存索引（注入回调必须同步） | `dsh/lib/store.js` |
| **召回** | `systemPrompt.context` 每步注入当前工作区的 Top-K，带类型/id/日期标签 | `dsh/lib/recall.ts` |
| **工具** | `memory_search` / `memory_write` / `memory_forget`，模型可主动查、主动记、主动撤 | `dsh/index.js` |

三条纪律写进了代码，不是写在文档里：

1. **模型不写**——记忆正文只能是用户原话（逐字裁剪）或工具失败的确定性签名，判定层没有可以塞进新句子的字段；
2. **概率只排序，阈值归代码**——写入阈值是 `minImportance`，冲突判断用插件自己的 `conflictThreshold`，从不把 Noul 上调好的阈值搬到 Choice 上（官方 jaggedness 文档：P(q)+P(¬q) 未必等于 1）；
3. **fail-open**——判定失败降级到启发式，钩子超时直接放弃，写入路径的任何异常都被 catch，绝不让记忆成为会话失败的原因。

---

## 快速开始

### 方式一：开发期直接挂工作区（无需安装）

在 profile 的用户 patch 层 `~/.dsh/profiles/web/cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: jev-memory
      name: 'file:///absolute/path/to/dsh-jev-memory/dsh/index.ts'
```

行名由加载器用 `new URL(name, baseUrl)` 解析，所以 `file:` URL 与裸包名都可用。删掉这一行即完全卸载。

### 方式二：作为一个包安装进 profile

```sh
dsh plugin --profile web add /absolute/path/to/dsh-jev-memory
# 再把包名加进 profile package.json 的 dsh.profile.bundles
```

包根自带 `cordis.patch.yml`，`dsh.bundle.patch` 指向它。

### 配置

```yaml
- insert:
    - id: jev-memory
      name: 'file:///absolute/path/to/dsh-jev-memory/dsh/index.ts'
      config:
        types: [constraint, pitfall, decision]   # 只记这三类
        judge: auto                              # auto | jev | heuristic | off
        minImportance: 0.6                       # 确定性写入阈值
        minRemember: 0.6                         # Jev 的"值得记吗"阈值
        askOnConflict: true                      # 发现矛盾时问你一句（HITL）
        askOnConflictTimeoutMs: 600000           # 等你回答的预算（10 分钟）
        askOnConflictMaxAttempts: 3              # 超时后在下一次对话开始前重问，最多几次
        repeatFailuresToWrite: 2                 # 同一个错重复几次才算"坑"
        writeSkipSubagents: true                 # 见下方"实测发现"
        writeTimeoutMs: 2500                     # 回合收尾的写入预算，超时放弃
        recall:
          maxTokens: 600
          quota: { constraint: 4, pitfall: 3, decision: 2 }
        jev:
          apiKeyEnv: TYPESAFE_API_KEY   # 从下面三处按序解析，密钥不写在配置里
          model: jev-latest             # 台账会记录实际应答的版本号，便于发现别名漂移
```

**密钥放哪**：按序解析 **①** 宿主 `ctx.credentials` 服务的 `apiKeyEnv` 引用（存 `~/.dsh/.credentials.yaml`，权限 0600）→ **②** 直接读同一个凭据文档（服务在开机那一瞬可能还没就绪，这条兜底让"时机"不再决定判定方式）→ **③** 配置里的 `apiKey` / 进程环境变量。解析发生在**每次判定时**而不是挂载时，所以运行中新增或轮换 key，下一轮就生效、不必重启。台账的 `start` 行写明实际用了哪条路径（`service:file` / `file` / `config` / `env` / `none`）。没有 key 时 `judge: auto` 自动退回启发式，**插件无需网络即可工作**。

---

## 记忆互相矛盾时：问你一句（人机协作）

"这条值不值得记"是一回事，"它是不是和你之前说的冲突"是另一回事——后者机器不该自己拍板：

1. Jev 若判**存在冲突**（概率 ≥ 0.7）**且这条本身值得记**，先以"待确认"状态落盘（不注入、也不丢）；
2. 回合结束时**问你一句**——一条问题、三个选项：**用新的覆盖旧的 / 保留旧的那条 / 两条都留着**；
3. 你的选择决定结果：覆盖 → 旧的标成"已被取代"（留档，不再注入）；保留旧 → 新的丢弃；都留 → 两条都生效；
4. **没人应答 / 超时（默认 2 分钟）/ 出错** → 保持"待确认"：**宁可少记一条，也不猜你的意思**。

**为什么这和 DSH 原有的 HITL 不冲突**：DSH 有两种跟人打交道的通道——**审批**（沙箱/权限策略发起，"这个危险操作放不放行"）和**提问**（模型发起，"我缺一个信息"）。这里**复用第二种**，只是换成插件的判定规则来发起：不新增 UI、不新增权限模型、不新增打断渠道，问题会出现在你熟悉的那个提问卡片里。唯一的差别是"谁决定要问"。

台账会记 `conflict-ask`（问了什么、和哪条冲突、配对依据的共享词）与 `conflict-resolved`（你选了什么）——**这就是"自动判断靠不靠谱"的实测数据**。

**一次性失败不记**：工具报错要**同签名重复出现**（默认 2 次）才算"坑"。一次性的环境失败（沙箱拒绝、重定向被拦）不是教训；重复发生的才是。次数从台账里数，所以重启不丢。

---

## 实测发现：写入精确率 1/4（已修）

第一次在真实 GUI 里跑，台账 `ledger.jsonl` 立刻暴露了问题：

```json
{"kind":"write","type":"constraint","by":"heuristic","importance":0.96,
 "source":{"sessionId":"5883ea6a-…","seq":8,
 "quote":"调用 `memory_write`，参数：{\"text\": \"语言不要选 Java\", …} 3."},
 "signals":["/不要/u"]}
```

这些是**我写给 subagent 的任务指令**，被当成"硬约束"记了下来。根因不是阈值调错，而是：

> **在委派子会话里，`source.kind === 'user'` 的消息不是人类的话，是父代理的指令。**

核实方式是从磁盘读那条会话的 header：`{"delegationDepth":1,"agentPreset":"cordis"}` —— 确认是子会话。

修复分两层，都带回归测试（测试用例直接用上面这些真实句子）：

1. `writeSkipSubagents: true`（默认开）——深度 >0 的会话不再参与学习。子会话的回合对父会话的钩子同样可见，所以不丢信息；
2. `screenSentence()`——拒收**任务指令**（`按下面步骤`、`第 N 步`、`把…贴出来`、`不要改写` …）与**载荷**（`{"key":`、代码块）。刻意做窄：`不要改动 data/ 目录` 这类真约束必须活下来。

这条记录本身就是这个插件的价值主张：**误记是可以被逐条追责的**，因为每条记忆都带着来源会话、seq、原句和命中的信号。

---

## 指标（都能从台账算出来，不是估计）

| 指标 | 怎么算 | 当前 |
|---|---|---|
| 写入精确率 / 误记率 | 人工抽查 `memory.json`；或跑 `eval/write-precision.ts` | 启发式 **0.75 / 0.75**，**Jev 1.00 / 0.75**（阈值 0.6） |
| **Hit@K** | 对每条标注查询 Q：前 K 条里**只要有 1 条**标注正例即记 1，最终 = 命中查询数 ÷ 查询数 | 待测 |
| **Recall@K** | 对每条 Q：前 K 条里的正例数 ÷ 该 Q 的**全部正例数**，再取平均 | 待测 |
| 注入 token 数 | 台账 `kind:"recall"` 的 `tokens` 字段 | 1 条约 60 tokens（历史上 4 条时 289–360） |
| 被拦下的候选 | 台账 `kind:"skip"` 的 `reason` | `veto:secret` / `veto:task-instruction` / `veto:payload` / `duplicate` / `subagent-session` / `below-min-remember` / `below-min-importance` / `type-disabled:*` |
| 判定降级 | 台账 `kind:"degraded"` | `jev-missing-row`（候选超出单次请求上限时静默降级，现在会记账并告警） |

### 写入精确率是怎么量的

`eval/write-precision.ts` 是一套**带标注的候选集**（20 条 = 8 条该记 + 12 条不该记），其中 8 条"不该记"取自真实会话里插件**确实写过**的原句（子代理任务指令、一次性环境失败、用户提问、API key 本身）。

```sh
TYPESAFE_API_KEY=... node eval/write-precision.ts     # 无 key 时只跑确定性筛查 + 启发式
```

真实结果（`jev-1.13.0`，16 条候选一次请求，单次判定 0.56–0.68s）：

```
确定性筛查先行：20 条拦掉 3 条（密钥 + 2 条任务指令），正例 0 损失
启发式        precision=0.75 recall=0.75 F1=0.75
Jev @0.6      precision=1.00 recall=0.75 F1=0.86    ← 默认
Jev @0.5      precision=0.88 recall=0.88 F1=0.88
Jev @0.3      precision=0.89 recall=1.00 F1=0.94
```

默认取 `0.6` 而不是 F1 更高的 `0.3`：**假阳性比假阴性贵**——一条错记会进入此后每一个会话的提示。两个已知漏判也写在这里：`不要改动 data/ 目录下的任何文件。`（Jev 给 0.51，恰好压线）与 `sqlite 写入失败：EDQUOT...`（给 0.38——只看到一次，无从判断会不会复现；修法是"同签名重复 ≥N 次才落盘"，见 `docs/DESIGN.md` 路线图）。

> **为什么分开写 Hit@K 和 Recall@K**：多正例下两者会分叉（Hit@5=1 时 Recall@5 可能只有 1/3），只写"Top-3 命中"是不可复现的。这个教训来自 `zilliztech/memsearch` 公开的中英检索评测——它同时发布了两套定义，参见 `docs/memsearch-notes.md`。
>
> 指标分工也定了：**Jev 只用在写入判定，不用做召回重排**。memsearch 的公开评测里 Jev 作为 reranker 输给 Voyage rerank-3（Recall@5 0.7941 vs 0.8187、MRR@10 0.6884 vs 0.7754），作者据此拒绝把 Jev 设为默认——那是"给已有候选排序"这个位置上的负结果，和我们"写入判定"不是同一个任务，但**任何对外表述都必须承认这条公开数据**。

---

## 明确不做（避免和生态重复）

- **不做 UI / 面板**、不做向量库（类型化 + 少量记录不需要）；
- **不做**"从反复失败里长规则"（那是 `dsh-jev-forge` 的题目）、**不做** HITL 分诊；
- **不碰 `dsh-jev-tools` 已覆盖的四个节点**：工具输出精简、注入筛查、技能推荐、交付闸门；
- 不与 `AGENTS.md` 争优先级：**人工手写 > 自动记忆**；冲突条目落 `needs-review` 状态，默认不注入。

---

## 测试与验证

```sh
node --test test/*.test.ts      # 49 条，全离线，不联网、不启动 harness
pnpm run typecheck              # tsc --noEmit，零依赖包也能有真类型检查
```

包含一条完整的端到端闭环（用假 ctx 驱动真实代码）：写入 → 下一会话召回 → `memory_search` → `memory_forget`。

**为什么是 TypeScript 而不用构建**：Node 22.23 默认开启类型擦除（`process.features.typescript === 'strip'`），所以 `import('./dsh/index.ts')` 与 `node --test test/*.test.ts` 都能直接跑，**没有构建步骤，也就保住了"零运行时依赖 + 可被 `file:` URL 直接挂载"这个性质**。代价是只能用可擦除语法（无 enum / namespace / 参数属性 / 装饰器），相对导入必须写显式 `.ts` 扩展名。类型检查靠 devDependency 里的 `typescript`（与运行时无关）。

真实 harness 验证已做过一次（记录在 `docs/DESIGN.md` 的"实测记录"一节）：插件热挂进正在运行的 web profile，台账出现 `start`，一次子会话回合触发了 4 条写入，下一轮模型请求的系统提示里出现了 `## 长期记忆` 区块。

---

## 现状与未验证项（不编造）

- 离线全绿、真实进程内闭环已验证；
- **Jev 线上路径已用真实 key 跑通**：`POST https://api.typesafe.ai/v1/systemone` → `jev-1.13.0`，一次请求判 16 条、耗时 0.56–0.68s，`docs/jev-api.md` 里的请求/响应结构逐字段对上（含 `answers.<id>.noul / .choice / .score / .confidence`）；
- **但 GUI 里的 live 进程要重启一次才会用上 Jev**：当前进程跑的是 0.3.0（凭据集成之前），而实测确认**源码改动即使触发重新挂载也仍用 ESM 缓存**（详见下一条）。重启后台账的 `start` 行会多出 `jevReady: true` 与 `credential` 字段；
- 多进程同时写同一个 `memory.json` 是 last-write-wins，单进程是受支持场景（TODO：锁文件）；
- **代码改动必须重启 harness**：Cordis 的 HMR 能重挂载插件行、重读存储，但 ESM 缓存不会重新求值 `lib/*.ts`。这条是**实测**的，不是推测：一次语义变更触发的重挂载后，`start` 台账仍写着旧 `version`、也没有新字段。`start.version` 就是用来判断"跑的是哪份代码"的；换一个**文件路径**（如 `.js` → `.ts`）会强制换一套模块 URL，那是唯一不用重启的刷新方式；
- 同机还有一个同类插件 `@zilliz/memsearch-dsh`（见 `docs/memsearch-notes.md`）：它与本插件**正交**，但挂在同一 patch 层，**同 profile 共存未实测**（可能双份注入）。

## 目录

```
dsh/index.ts          插件入口：钩子、注入点、三个工具，以及本地结构类型
dsh/lib/signals.ts    确定性信号词表 + 候选筛查（含密钥/任务指令/载荷否决）
dsh/lib/extract.ts    从回合事件里抽候选
dsh/lib/judge.ts      判定端口（Jev / 启发式）+ 确定性写入闸门
dsh/lib/jev.ts        Jev HTTP 客户端（凭据解析、重试、超时、解析）
dsh/lib/store.ts      memory.json + ledger.jsonl
dsh/lib/recall.ts     选哪些记忆、怎么渲染
dsh/lib/text.ts       文本工具（分句、估算 token、哈希）
eval/write-precision.ts   带标注的写入精确率评测（可对标、可复现）
tsconfig.json         noEmit + allowImportingTsExtensions（Node 擦除模式可直接跑）
docs/jev-api.md       Jev 调用契约调研（带出处链接）
docs/memsearch-notes.md  同类项目 memsearch 的源码级调研与逐项对比
docs/DESIGN.md        设计决策与实测记录
```
