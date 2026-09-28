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
        writeSkipSubagents: true                 # 见下方"实测发现"
        writeTimeoutMs: 2500                     # 回合收尾的写入预算，超时放弃
        recall:
          maxTokens: 600
          quota: { constraint: 4, pitfall: 3, decision: 2 }
        jev:
          # apiKey: ...          # 或设环境变量 TYPESAFE_API_KEY
          model: jev-latest      # 台账会记录实际应答的版本号，便于发现别名漂移
```

没有 Jev key 时 `judge: auto` 自动退回启发式，**插件无需网络即可工作**。

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
| 写入精确率 / 误记率 | 人工抽查 `memory.json`；或看 `kind:"write"` 里 `by:"heuristic"` 的占比 | 两次真实误记后已各有回归测试守（见下） |
| **Hit@K** | 对每条标注查询 Q：前 K 条里**只要有 1 条**标注正例即记 1，最终 = 命中查询数 ÷ 查询数 | 待测 |
| **Recall@K** | 对每条 Q：前 K 条里的正例数 ÷ 该 Q 的**全部正例数**，再取平均 | 待测 |
| 注入 token 数 | 台账 `kind:"recall"` 的 `tokens` 字段（当前按会话内 id 集合去重后记账） | 4 条约 289–360 tokens |
| 被拦下的候选 | 台账 `kind:"skip"`，含 `reason`（`veto:task-instruction`、`duplicate`、`below-min-importance`、`subagent-session`） | 已可观测 |

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
- **Jev 线上路径尚未用真实 key 跑通**：契约按 `docs/jev-api.md`（对官方文档与 SDK 逐条核过）实现，但本机没有 `TYPESAFE_API_KEY`，所以现有全部实测都走的是启发式判定；
- 多进程同时写同一个 `memory.json` 是 last-write-wins，单进程是受支持场景（TODO：锁文件）；
- **代码改动仍需重启 harness 生效**：Cordis 的 HMR 能重挂载插件行、重读存储，但 ESM 缓存不会重新求值 `lib/*.ts`。`start` 台账里的 `version` 字段就是用来判断"跑的是哪份代码"的（换行名指向新文件可以强制换一套模块 URL，这正是本次从 `.js` 切到 `.ts` 时让修复生效的方式）；
- 同机还有一个同类插件 `@zilliz/memsearch-dsh`（见 `docs/memsearch-notes.md`）：它与本插件**正交**，但挂在同一 patch 层，**同 profile 共存未实测**（可能双份注入）。

## 目录

```
dsh/index.ts          插件入口：钩子、注入点、三个工具，以及本地结构类型
dsh/lib/signals.ts    确定性信号词表 + 候选筛查
dsh/lib/extract.ts    从回合事件里抽候选
dsh/lib/judge.ts      判定端口（Jev / 启发式）+ 确定性写入闸门
dsh/lib/jev.ts        Jev HTTP 客户端（重试、超时、解析）
dsh/lib/store.ts      memory.json + ledger.jsonl
dsh/lib/recall.ts     选哪些记忆、怎么渲染
dsh/lib/text.ts       文本工具（分句、估算 token、哈希）
tsconfig.json         noEmit + allowImportingTsExtensions（Node 擦除模式可直接跑）
docs/jev-api.md       Jev 调用契约调研（带出处链接）
docs/memsearch-notes.md  同类项目 memsearch 的源码级调研与逐项对比
docs/DESIGN.md        设计决策与实测记录
```
