# 设计说明

本文记录**为什么这样实现**，以及一次真实运行里发生的事。要"做什么"看 README。

---

## 1. 为什么是宿主平面

长期记忆必须跨会话、跨工作区存在，并且要能被任何会话读到——这是宿主的定义（一个进程一份），不是某个会话的贡献。

因此它不放进 agent preset：
- preset 是"一个会话往注册表里贡献什么"，随会话卸载；记忆不能随会话消失；
- 记忆的消费者在会话之外（注入发生在每次模型请求的组装阶段，会话可能还没建立）。

对应地，它的三个注册点都是全局层：`ctx.tools.register`、`ctx.systemPrompt.context`、`ctx.on('agent/turn-stopping')`。

## 2. 扩展点是怎么选的（都以真实代码为准）

| 需求 | 候选 | 选择与理由 |
|---|---|---|
| 回合结束时学习 | `agent/pre-step`(waterfall) / `session/event` / `agent/turn-stopping`(serial, awaited) | **turn-stopping**。它"在回合边界提交之前被 await"，所以写入是持久的而不是尽力而为；官方 `dsh-hooks-codex` 的 Stop 钩子也在这里。代价是判定会进入用户的关键路径 → 因此有硬 deadline + fail-open。 |
| 读这一回合的消息 | 自己订阅事件维护缓冲 / 投影缓存 / `agent.session.eventAt(seq)` | **从 `session.seq - 1` 向前走到 `turn/start`**（官方 `dsh-user-approval` 用的同一个 fold）。不需要额外订阅，进程重启后也不需要预热缓冲。 |
| 注入记忆 | `systemPrompt.section` / `systemPrompt.context` | **context**：它是"运行时上下文"，每步重新求值，适合"随会话变化"的内容；`context` 回调的 `AssembleContext` 运行时带 `agent`，所以能按会话取 cwd——官方 `dsh-user-approval` 正是这么读 `context.agent` 的。 |
| 存储 | `ctx.storageDomain`（官方 schema 校验 KV）/ 自己写 JSON | **自己写**，见下。 |

### 为什么不用 `ctx.storageDomain`

它确实是"产品数据"的正解：schema 校验、原子写、`domain/changed` 事件。但它用 **zod** 声明表结构，而这个插件刻意做成**零依赖**——零依赖才能让开发期的插件用 `file:` URL 直接从工作区挂进 profile，不需要 install、不需要解析 `@deepseek-ai/*` 是否可见。

存储被放在一个小端口后面（`put`/`all`/`remove`/`has`），换实现不动调用方。代价写在源码注释里：多进程 last-write-wins，需要锁文件。

### 为什么写入是断言"用户原话"

每条记忆的正文 = 用户消息里切出的一句话（逐字，仅在超长时裁剪），或一条工具失败的确定性签名（`工具名 失败：首行`，数字/路径在**去重键**里归一化，正文保持可读）。

这让"记错"变成可追责的问题：不需要相信判定层没有幻觉，因为它**没有可以写句子的字段**。判定层只回 `type` / `importance` / `conflict`。

## 3. 数据模型

```jsonc
// ~/.dsh/jev-memory/memory.json
{
  "version": 1,
  "records": [{
    "id": "sha1(签名归一化后的正文)",   // 同时是去重键
    "type": "constraint|pitfall|decision|preference|procedure|rejected|fact",
    "text": "必须用 pnpm 管理依赖。",     // 逐字
    "cwd": "/Users/rom/Documents/projectSDK",  // null = 全局
    "importance": 0.9,
    "status": "active|needs-review",     // needs-review = 疑似与旧记忆冲突，默认不注入
    "source": { "sessionId": "…", "seq": 8, "quote": "…", "at": 1790584176299 },
    "createdAt": 0, "updatedAt": 0,
    "recalls": 0, "lastRecalledAt": null,
    "judge": { "kind": "jev|heuristic|explicit", "confidence": 0.81, "conflict": "no", "mode": "auto", "model": "jev-1.13.0" }
  }]
}
```

```jsonc
// ~/.dsh/jev-memory/ledger.jsonl —— 只追加，永不重写
{"t":…,"kind":"start","version":"0.2.0","judge":"heuristic","loaded":0}
{"t":…,"kind":"write","id":"…","type":"constraint","importance":0.9,"by":"heuristic","cwd":"…","source":{…},"signals":["/必须/u"]}
{"t":…,"kind":"skip","reason":"veto:task-instruction","quote":"…"}
{"t":…,"kind":"skip","reason":"subagent-session","sessionId":"…"}
{"t":…,"kind":"recall","sessionId":"…","ids":["…"],"tokens":289}
{"t":…,"kind":"forget","id":"…","by":"tool|manual-cleanup"}
{"t":…,"kind":"hook-error","turn":3,"error":"…"}
```

台账是**唯一可信的运行事实来源**：误记率、注入 token、被拦下的候选、跑的是哪份代码（`start.version`）都从这里读，而不是靠日志措辞。

## 4. 判定层

```
候选 ──► judge.judge() ──► { rows, model, degraded }
             │
             ├─ Jev 可用：一次 POST /v1/systemone
             │     每个候选 4 个 typed question：
             │       noul  "这条值得长期记住吗"   → 只作为 confidence 记录
             │       choice "属于哪一类"（+ none-of-the-above） → type
             │       score  "重要性"（5 档有序 rubric） → importance = score/(档数-1)
             │       noul  "与已有记忆冲突或被取代吗" → conflict（与 conflictThreshold 比）
             └─ 否则/失败：启发式（信号词表直接给 type，抽取分数给 importance）
                          │
                          ▼
                 applyGate()：types 白名单 + minImportance + 冲突 → needs-review
```

几个刻意的选择：

- **一次请求问全部候选**（官方 fan-out 推荐），`state` 只放已知记忆、候选正文放在各自的 question 里——官方 jaggedness 文档明确说 state 里的无关内容会掉准确率（context rot）；
- **Choice 一定带 `none-of-the-above`**（官方建议），`type` 落到它身上时退回信号提示的类型；
- **任何候选缺答案就退回启发式**，不因为一次部分应答放弃整回合；
- **重试共享同一个 deadline**（默认 2.5s 总预算、1 次重试），这是与官方 JS SDK 默认（每次 10s、无总预算）刻意相反的选择，因为它在回合边界里；
- 台账记录**实际应答的模型版本号**，这样 `jev-latest` 这类别名漂移会留下痕迹，而不是静默改变判定行为。

## 5. 作用域与召回

- 记忆绑定**会话创建时的 cwd**；`cwd: null` 的是全局记忆；
- 召回只取当前 cwd + 全局，**跨工作区不合并**——把一个项目的约定注进另一个项目正是要避免的错；
- 每个类型有配额（默认 constraint 4 / pitfall 3 / decision 2），另有总 token 预算（默认 600）；打分 = `importance*0.85 + 半衰期180天的衰减*0.15`，所以**陈旧但重要的约束不会被新近的琐事挤掉**；
- 子代理默认不注入（它继承父会话的上下文，再付一次 token 不划算）；
- 注入块带类型、id、日期，并附一句"可用 `memory_forget` 撤销"——用户撤不掉的记忆比没有记忆更糟。

## 6. 实测记录（2026-09-28）

1. 把插件作为一行挂进 `~/.dsh/profiles/web/cordis.patch.yml`（`file:` URL），**正在运行的 GUI 立即挂载**：`~/.dsh/jev-memory/ledger.jsonl` 出现 `{"kind":"start","judge":"heuristic","loaded":0}`。
2. 用一个 subagent（新会话、同一宿主进程）调用 `memory_write` / `memory_search` → 两条都成功，工作目录 `projectSDK`。
3. 下一轮模型请求的运行时上下文里出现注入块：

   ```
   ## 长期记忆（自动积累，按会话工作区召回）
   - [constraint] 语言不要选 Java：DSH 的 Java Native 插件方案不考虑 (…, 2026-09-28)
   ```

4. **同一轮里暴露 bug**：注入块里有 3 条是那个 subagent 的"用户消息"（= 我写给它的任务指令）被当成 `constraint` 记下。写入精确率 1/4。
5. 从 `ledger.jsonl` 定位来源会话与 seq，再从磁盘读该会话 header：`delegationDepth: 1` → 确认是委派子会话。
6. 修复：`writeSkipSubagents` + `screenSentence`（任务指令/载荷筛查），回归测试直接用这 3 句原文。
7. 清理：备份 `memory.json` 后删掉 5 条非人工记录（清理过程中另一个 subagent 又贡献了 2 条，正好再次证明问题真实），台账追加 `kind:"forget","by":"manual-cleanup"`；随后注入块只剩正确的那条。

### 第二次误记（同一天，同类问题）

用户在中文里提问——句子以 URL 开头、以「吗」结尾、**没有问号**——被记成了一条 `constraint`。

修法：`looksInterrogative()` 补上中文的真实书写习惯——句尾语气词（吗/嗎/呢）与「难道 / 是不是 / 要不要 / 有没有」都算疑问；回归测试直接用那句真实提问。

两次误记的教训是同一条：**"这句是不是疑问句 / 是不是任务指令"必须由确定性规则回答，而且规则必须按中文实际写法来写**，不能按英文标点习惯推。

### TypeScript 迁移（同日，行为不变）

`dsh/**` 与 `test/**` 全部从 JS+JSDoc 迁到 TS，`version` 升到 `0.3.0`。

验证方式（三层，缺一层都不算过）：

1. 迁移前的 49 条离线测试全绿；
2. `tsc --noEmit` 零错误（`strict` + `verbatimModuleSyntax` + `allowImportingTsExtensions`）；
3. **差分比对**：把旧 `.js` 与新 `.ts` 并排跑，对 `resolveConfig` 全输入矩阵、各模块全部导出、store 生命周期与损坏文档恢复、judge 各失败分支、Jev 的重试/超时/非 JSON 响应、以及用假 ctx 挂载后驱动钩子与三个工具的完整链路，逐值比对 **602 项全部一致**（唯一差异是预期的 version）。

差分测试抓到的两处"看着该改、其实会改变行为"的地方，都保留了原语义并留了注释：`resolveConfig` 的对象 spread 对**畸形配置**的字面展开语义；`normalizeRecord` 对 `sessionId`/`judge.kind` 等字段**原样透传而不做 typeof 归一化**（手改过的 `memory.json` 里数字型 sessionId 原本会原样保留）。这条经验值得记住：**"顺手把它规范化一下"就是一次静默的行为变更**。

另外，`package.json` 的 `exports["."]` 也随之指向 `./dsh/index.ts`——因为 `cordis.patch.yml` 里用的是裸包名 `dsh-jev-memory`，走的正是 exports。

### 运行时坑（都在源码里留了注释）

- **Cordis HMR 能重挂载插件行，但不能让 ESM 重新求值 `lib/*.ts`**：改 `cordis.patch.yml` 的注释不改变解析后的 patch 列表（`entry.update` 等价 → 不重挂）；改成语义变更（例如给行加 `config`）会重挂，但入口模块从 ESM 缓存返回，仍是旧代码。所以 `start` 台账里带 `version`，用来判断"跑的是哪份代码"。**换一个行名指向新文件路径，可以强制换一整套模块 URL**——这正是从 `.js` 迁到 `.ts` 时让修复代码真正上线的办法；否则要重启进程。
- 子代理的 user 消息不是人类的话（本插件最重要的一条领域知识）；
- 钩子在用户关键路径上：任何异常都必须被吞掉，且必须有 deadline。

## 6.5 语言选择：TS 在插件层，Python 只在引擎层

结论先写在这里，理由是可验证的：

- **插件那一层必须是 ESM 模块**。加载器对每一行做 `await import(new URL(name, baseUrl).href)`（`cordis-plugin-loader` 的 `import()`），契约是 `export const name/inject` + `apply(ctx, config)`。所以 composition 行不可能是 `.py`、也不能是 `.ts` 之外的别的东西——**但可以是 `.ts`**。
- **TypeScript 现在零成本**：Node 22.23 默认开启类型擦除（`process.features.typescript === 'strip'`）。实测：`.mjs` 里 `import('./probe.ts')` 成功、`node --test .scratch/probe.test.ts` 通过。因此插件可以直接以 `file:.../dsh/index.ts` 挂进 profile，**不需要构建步骤，也就保住了"零依赖、零安装"的性质**。代价是只能用可擦除语法（无 enum / namespace / 参数属性 / 装饰器），纯类型导入必须 `import type`。
- **Python 不当插件语言，但当引擎语言**。最有说服力的证据来自 memsearch 自己：它是 Python 为主的项目（879KB Python vs 81KB TS），可它的 **DSH 插件是纯 ESM JS、明确"no build step"**，Python 只活在子进程 CLI 后面（`docs/memsearch-notes.md` §多语言/工程栈事实）。代价也写在它身上：Python 3.10+、milvus-lite、558MB ONNX 模型、**每次检索 fork 一个 CLI 进程**——它的 issue 里孤儿进程与 Windows 兼容问题正来源于此。
- 所以分界线是**位置**而不是语言强弱：钩子（`agent/turn-stopping`）与注入（`systemPrompt.context` 是同步回调）在用户关键路径上，必须进程内；只有"语义检索 / embedding / rerank / 评测统计"才值得跨进程，而且**必须是常驻 sidecar，不能每次 fork**。

## 7. 下一步（按价值排序）

1. **用真实 Jev key 跑一遍线上路径**，把这批启发式判定换成 Jev 判定，量一次 before/after 的写入精确率；
2. **冲突处理闭环**：`needs-review` 目前只是不注入，应该用一次 `ask_user` 问"这条要不要覆盖旧的"（这才是 triage 的核心，也是把它做成 HITL 的入口）；
3. **补齐指标 harness**：`Hit@3` / `Recall@3` 两套定义（见 README）+ 人工标 50 条查询；同时把"注入内容与当前 query 无关时不重复注入"的**抑制次数**记进台账，用真实长会话数据决定是否从"每步注入"改成更省的策略——memsearch 选了"仅 step 1 注入、无命中零成本"，我们不照抄，但要拿数据说话；
4. **工具失败的重复计数门槛**：同签名（工具 + 错误码）出现 ≥N 次才落盘。现在一次性的环境失败（沙箱拒绝、重定向被拦）也会被记成"长期的坑"，价值很低；
5. **召回/检索失败也进台账**：现在只有 `logger.warn`，而 memsearch 的 issue 表明"静默失败"是最难查的一类问题；
6. 只读导出 `memory.md`（从 `memory.json` 生成、不反向解析），拿到人可读的收益而不承担双写 bug 面；
7. 存储换到官方 `storageDomain`（如果愿意接受 zod 依赖），拿到 `domain/changed` 事件与并发保护；
8. 客户端半（`dsh/client.js`）：一个只读的台账面板，给人看"它记住了什么、从哪来、被召回几次"。

### 生态定位（2026-09-28 核实）

`zilliztech/memsearch` 已经**原生支持 DSH**（`plugins/dsh/`，npm `@zilliz/memsearch-dsh`，同一个 patch 层、同样的 `agent/pre-step` 注入点）。所以"官方没有 memory 包"仍然成立，但生态里的位置已经有人占了。它和我们是**正交而非替代**：它解决"记得多"（每回合全量落盘、LLM 摘要、Milvus 语义检索），我们解决"记得准"（写入门槛、类型、冲突、逐条可审计、可撤销）。它的设计里**没有** type / importance / conflict / 召回计数 / 台账——不是没做，是它明确把"写入不判定"当卖点。细节见 `docs/memsearch-notes.md`。

