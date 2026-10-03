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
    "cwd": "/Users/rom/Documents/projectSDK/dsh-jev-memory",  // null = 全局
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
2. 用一个 subagent（新会话、同一宿主进程）调用 `memory_write` / `memory_search` → 两条都成功，工作目录就是本仓库所在目录。
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

### 接上真实 Jev 之后（同日，第一次线上判定）

拿到真 key 后第一次调用就通了（`POST /v1/systemone` → `jev-1.13.0`，16 条候选一次请求 0.56–0.68s），但**判定质量一开始是坏的**，而且错在设计而不在模型：

| 候选 | 第一版 importance | 结果 |
|---|---|---|
| `必须用 pnpm 管理依赖，不要用 npm。`（真该记） | 0.28 | 被阈值挡掉 |
| `请严格按下面步骤操作，不要做任何额外的事。`（垃圾） | 0.73 | **会写入** |

三个根因，逐个修掉：

1. **闸门压错了字段**。我把 `remember` 的 Noul 答案当成 `confidence` 丢掉了，却用 `importance`(Score) 去闸——等于用"排第几"回答"要不要"。现在 `JevRow.remember` 独立返回，`applyGate` 先看它（`minRemember=0.6`），没有它才退回 `importance`，启发式因此天然保持旧行为。
2. **state 里没有任何场景框架**。Jev 在真空里判，"必须用 pnpm"听起来就是通用常识。现在 `state` 带 `memory_system`（说明记忆会被注入到以后的新会话）与 `project`（工作目录），每个问题的 `instructions` 用官方推荐的 object 形态引用 `candidate`。
3. **重要性的打分档位本身是错的**。旧档位是"可以忽略/有用/重要/非常关键"——没有一个字提到未来会话，所以一次性指令也能拿高分。新档位每一档都写明参照系：`与未来会话无关 / 只对本次任务有用 / 对未来会话有点参考 / 对未来会话重要 / 以后必须遵守或反复用到`。

修完之后 `remember` 的分离度很干净：正例 0.68–0.86，负例最高 0.55。

**评测脚本抓出的两件事**（这就是它存在的意义）：

- **静默降级**：`maxCandidates` 默认 6，第 7 条起悄悄换成启发式判定，而当时台账里完全看不出来。现在会记 `kind:"degraded"` 并告警，`write` 台账也多带 `remember` 与 `note`；
- **问句漏进判定**：问句与寒暄的筛查原本在抽取器里，评测脚本走的是 `screenSentence`，于是"…难道只能用 js 写吗"被当成正例写入。现在**所有否决都收敛到 `screenSentence` 一个入口**（secret → 任务指令 → 载荷 → 寒暄 → 疑问），抽取器和评测脚本跑的是同一套规则——**评测绕过的规则等于没有的规则**。

**密钥筛查是被真实输入触发的**：用户把 API key 直接贴在一句普通中文里，而那句话满足除密钥外的所有条件。记忆会被注入到以后每一个会话，写进去就是永久泄漏，所以 `SECRET_PATTERNS` 是硬否决且排在最前。

**阈值不是拍的**：`eval/write-precision.ts` 上跑 0.3/0.5/0.6/0.7 四条曲线，F1 最高的是 0.3（0.94），默认却取 0.6（精确率 1.00 / 召回 0.75）——因为一条错记会污染此后每个会话，假阳性比假阴性贵。取舍和整条曲线都写在 README 里，谁不同意可以照着数据改。

### 冲突确认：两级配对 + 超时重问（同日）

设计上有三个决定值得写下来：

1. **先写后问**。冲突候选先以 `needs-review` 落盘，再拿去问人。这样"没人回答"的终态就是今天的现状——记录在、但不注入——而不是把用户说过的话丢掉。
2. **两级配对**。模型已经判过"存在冲突"，但没说和谁，而**说不清跟谁冲突的问题没法回答**。所以先让 Jev 在候选里挑一条（Choice，标签 `m0/m1…`，正文进 criteria 描述，另加 none-of-the-above）；模型不可用、报错、或明确说"都不是"时，退回本地词重叠。两级都要：词重叠看不懂换个说法，模型不在时又没人可问。台账记 `via` 与词重叠分数，模型配错也查得出来。
3. **超时不是丢弃，而是延后**。第一次问不到人，记录留在 `needs-review`，在**下一回合的第一步**（`agent/pre-step`，用户必然在场）重问，最多 `askOnConflictMaxAttempts` 次。这就是"把超时设长"之所以安全的原因。

两处实现细节是被测试逼出来的：

- **`askedCount` 必须同时更新内存**：重问的判据是"问过但没问够"，而这个计数从台账推导、只在启动时装载。只写台账不更新内存，同一进程里的重问会读到 0 而拒绝重问——测试一次就抓到了。
- **配不上也要留痕**：两级都配不上时记一条 `conflict-unpaired`。否则那条记忆会安静地从召回里消失，而台账什么都不说——"静默失败"正是这个项目一直在防的东西。

### 预设会静默关掉运行时上下文（已修，0.7.0）

**这是个真洞，而且是别人先发现的**：OpenViking 官方的 DSH 记忆插件刻意不走 system prompt。我在 DSH 源码里核对了机制，结论比它 README 写的更精确：

- `complete: true`（`minimal` 预设的 persona 段）**只收窄 `sections`**——`dsh-system-prompt/lib/index.js:355` 换成 `[completeSection]`，而 `:356` 的 `contexts` 原样保留。所以"声明 complete 就丢掉别的贡献"对 **section** 成立、对 **context** 不成立；
- 真正让我们的注入消失的是 **`includeRuntimeContext: false`**（`minimal/agent.cordis.yml:14`）→ `dsh-persona` 调 `suppressRuntimeContext()` → `:344` 直接 `contexts: runtimeContextSuppressed ? [] : …`。**注意 `:344` 是"抑制就不去遍历注册表"，所以我们的回调根本不会被调用**——插件既不报错、也不写台账，完全静默。
- 四个 preset 里只有 `minimal` 这么设；`standard`/`ptc`/`cordis` 都保留运行时上下文（所以此前看到的注入都是真的）。

修法是**检测 + 换一种投递方式**，而不是放弃 context：

1. **检测**：注册 `system-prompt/assemble`（官方描述为"专家级 waterfall，可读写装配结果"）。抑制只影响构建 contexts 数组，waterfall 照跑，所以在 `next()` 之后看自己的 context 名在不在，就是**证据**——而且它同时是那个"我确实有话要说"的探针（没内容可注入的会话不该被误判成坏了）。
2. **投递**：`agent/pre-step` 的 waterfall **可以替换进入这一步的消息**（`PreStepDecision = {kind:'reject'} | {kind:'enter', messages}`），所以在同一轮把召回块作为一条 `source: {kind:'plugin', plugin:'jev-memory', form:'recall'}` 的消息追加进去即可。`form:'recall'` 是宿主自己为这种情况定义的标记，而带插件来源这点是**关键**——否则这条记忆看起来就像用户说的话，下一轮会被自己重新记一遍。
3. 两条路共用同一个 `renderRecallFor()`（选择、渲染、计数、台账），`via` 字段区分投递方式；一轮只投一次（消息留在该轮历史里，后续步骤自然可见）；被别的监听器 `reject` 的步骤不追加（不复活不该跑的步骤）。

### 运行时坑（都在源码里留了注释）

- **Cordis HMR 能重挂载插件行，但不能让 ESM 重新求值 `lib/*.ts`**：改 `cordis.patch.yml` 的注释不改变解析后的 patch 列表（`entry.update` 等价 → 不重挂）；**给行加 `config` 这类语义变更会重挂，但入口模块仍从 ESM 缓存返回**——这条是实测的：一次语义变更后新起的 `start` 台账里 `version` 还是旧值、也没有新加字段。所以 `start` 台账里带 `version`，用来判断"跑的是哪份代码"。**换一个行名指向新文件路径可以强制换一整套模块 URL**（从 `.js` 迁到 `.ts` 就是这么让修复上线的）；否则要重启进程。
- 子代理的 user 消息不是人类的话（本插件最重要的一条领域知识）；
- 钩子在用户关键路径上：任何异常都必须被吞掉，且必须有 deadline。

## 6.5 语言选择：TS 在插件层，Python 只在引擎层

结论先写在这里，理由是可验证的：

- **插件那一层必须是 ESM 模块**。加载器对每一行做 `await import(new URL(name, baseUrl).href)`（`cordis-plugin-loader` 的 `import()`），契约是 `export const name/inject` + `apply(ctx, config)`。所以 composition 行不可能是 `.py`、也不能是 `.ts` 之外的别的东西——**但可以是 `.ts`**。
- **TypeScript 现在零成本**：Node 22.23 默认开启类型擦除（`process.features.typescript === 'strip'`）。实测：`.mjs` 里 `import('./probe.ts')` 成功、`node --test .scratch/probe.test.ts` 通过。因此插件可以直接以 `file:.../dsh/index.ts` 挂进 profile，**不需要构建步骤，也就保住了"零依赖、零安装"的性质**。代价是只能用可擦除语法（无 enum / namespace / 参数属性 / 装饰器），纯类型导入必须 `import type`。
- **Python 不当插件语言，但当引擎语言**。最有说服力的证据来自 memsearch 自己：它是 Python 为主的项目（879KB Python vs 81KB TS），可它的 **DSH 插件是纯 ESM JS、明确"no build step"**，Python 只活在子进程 CLI 后面（`docs/memsearch-notes.md` §多语言/工程栈事实）。代价也写在它身上：Python 3.10+、milvus-lite、558MB ONNX 模型、**每次检索 fork 一个 CLI 进程**——它的 issue 里孤儿进程与 Windows 兼容问题正来源于此。
- 所以分界线是**位置**而不是语言强弱：钩子（`agent/turn-stopping`）与注入（`systemPrompt.context` 是同步回调）在用户关键路径上，必须进程内；只有"语义检索 / embedding / rerank / 评测统计"才值得跨进程，而且**必须是常驻 sidecar，不能每次 fork**。

## 7. 下一步（按价值排序）

1. **重启一次 harness**，让 0.4.0 的凭据集成进到 GUI 进程里（`start` 台账应出现 `jevReady: true`）——在此之前 live 判定仍是启发式；
2. **工具失败的重复计数门槛**：同签名（工具 + 错误码）出现 ≥N 次才落盘。现在一次性的环境失败（沙箱拒绝、重定向被拦）也会被记成"长期的坑"，价值很低；评测集里那条 `sqlite 写入失败：EDQUOT…` 正是因为"只看到一次"被 Jev 判 0.38，说明这条规则该由确定性代码来补，而不是让模型去猜会不会复现；
3. **冲突处理闭环**：`needs-review` 目前只是不注入，应该用一次 `ask_user` 问"这条要不要覆盖旧的"（这才是 triage 的核心，也是把它做成 HITL 的入口）；
4. **召回指标 harness**：`Hit@3` / `Recall@3` 两套定义（见 README）+ 人工标 50 条查询；同时把"注入内容与当前 query 无关时不重复注入"的**抑制次数**记进台账，用真实长会话数据决定是否从"每步注入"改成更省的策略——memsearch 选了"仅 step 1 注入、无命中零成本"，我们不照抄，但要拿数据说话；
5. **召回/检索失败也进台账**：现在只有 `logger.warn`，而 memsearch 的 issue 表明"静默失败"是最难查的一类问题；
6. **把评测集扩到 50+ 条并固化**：现在是 20 条、含 8 条真实误记；再加 30 条真实候选后，阈值和 prompt 的每次改动都能跑回归；
7. 只读导出 `memory.md`（从 `memory.json` 生成、不反向解析），拿到人可读的收益而不承担双写 bug 面；
8. 存储换到官方 `storageDomain`（如果愿意接受 zod 依赖），拿到 `domain/changed` 事件与并发保护；
9. 客户端半（`dsh/client.js`）：一个只读的台账面板，给人看"它记住了什么、从哪来、被召回几次"。

### 生态定位（2026-09-28 核实）

`zilliztech/memsearch` 已经**原生支持 DSH**（`plugins/dsh/`，npm `@zilliz/memsearch-dsh`，同一个 patch 层、同样的 `agent/pre-step` 注入点）。所以"官方没有 memory 包"仍然成立，但生态里的位置已经有人占了。它和我们是**正交而非替代**：它解决"记得多"（每回合全量落盘、LLM 摘要、Milvus 语义检索），我们解决"记得准"（写入门槛、类型、冲突、逐条可审计、可撤销）。它的设计里**没有** type / importance / conflict / 召回计数 / 台账——不是没做，是它明确把"写入不判定"当卖点。细节见 `docs/memsearch-notes.md`。

---

## 8. 身份、去重与规范化：设计决定（2026-09-29，待实现）

### 8.1 已确认的事实（不靠推断）

| 事实 | 出处 |
|---|---|
| Jev 的 API 只有 `noul` / `choice` / `score` 三种原语，**无法输出文本** | `docs/jev-api.md` |
| 宿主有完整的 `llm` 服务：`stream({provider, model, messages, system, signal, maxTokens})` | `ctx.get('llm')`（Cordis Inspect：Service `llm`） |
| 路由不必硬编码：`agentDefaultModel.currentSelection()` 返回默认模型选择，"independently of any Host or transport" | Service `agentDefaultModel` |
| memsearch 的 DSH 插件**不是原文落盘**：每回合渲染成 transcript（≤6000 字，工具输出省略）→ LLM 摘要成 **2–10 条第三人称 bullet** → 追加进按日 markdown；原文靠 L1/L2/L3 渐进展开可回查 | `docs/memsearch-notes.md`（2026-09-29 修正） |
| OpenViking 把话语抽进**类型化 schema 文件**（11 个 YAML / 9 启用），字段带 `merge_op`（patch/replace/sum/immutable），profile 每条 bullet 带 `(as of YYYY-MM-DD)`，preferences 用 `user`+`topic` 当**不可变身份键** | `docs/industry-memory-notes.md` §写入路径 |

### 8.2 现在的问题（都被实测过）

1. **`<n>` 归一化让"只差数字"的两句同 id** → 第二条被 `store.has()` 判为 duplicate **静默丢弃**。合成例子成立（"端口固定 8000，不要改" vs "9000"），但**真实语料 912 个签名里 0 组冲突** —— 潜在风险，不是正在发生的 bug。
2. **签名认不出改写** → "不要用 npm" 与 "不能用 npm 装包" 各存一条，召回重复注入。
3. **原句照搬的弊端**（使用者的观察，成立）：错别字、口水话、表达差会原样进入注入文本。

根因：**一个键干了两件事** —— ①记忆的身份 ②同一个机器失败的重复计数。第二件事需要数字归一化，第一件事最怕它。

### 8.3 决定：三件事各归其位

| 角色 | 由谁承担 |
|---|---|
| 预筛与重复计数 | 归一化签名（现状不变，`<n>` 归一化保留） |
| 身份（是不是同一条） | **模型**：只在确定性失败处提问（见 8.4） |
| 注入文本 | **规范形式**（模型规范化）+ 原句永远保留可查 |

### 8.4 第一步：写入操作只问在确定性失败处

- **触发条件**（确定性预筛）：候选签名与已有记录相同；或 BM25/embedding 取到 top-1 且分数 ≥ 阈值。
- **问一个问题**（`choice`）：`same-update`（是同一件事，新说法更新它）/ `same-duplicate`（完全同义，丢掉新的）/ `different`（不同的规矩，各自保留）。问题里带上**那一条**已有记忆的原文 —— 一次只给一个配对，避免 20 标签的 choice。
- **落地**：`update` → `supersede` 旧记录 + 写新记录 + 记 `supersedes`；`duplicate` → 记 `duplicate`（现状）；`different` → 新增（现状）。
- **回退**：无模型 / 超时 / 无配对 → 完全退回今天的行为。
- **顺带**：`conflict-suspected` 的台账口径不变，两者可交叉验证。

### 8.5 第二步：规范形式（两层记忆）

- **证据层**：原句，永不被模型改写；台账、`source.quote`、`memory_search` 都指向它。
- **规范层**：用宿主的 `llm`（provider/model 取自 `agentDefaultModel.currentSelection()`，可被配置覆盖）把原句规范成第三人称、修正错别字、去口水话的一句陈述。**硬约束：不得新增任何事实**；做不到就返回原句。
- **注入用规范层**，但原句随时可查（等价于 memsearch 的 L2/L3）。
- **默认先只记录不注入**：规范化结果先写台账，注入仍用原句，看过样例再打开。

### 8.6 验收方式（避免"模型改写"变成不可控）

1. 规范化前后"该不该记"在**全部已标注句子上**（当前 178 句）**不得翻转**（标注针对主张，不针对措辞）——可自动跑。**这笔账目前只还了一半**：`eval/normalize-samples.ts` 量的是"规范化结果被接受/拒绝的分布 + 长度比 + 词元重合度"，**没有逐句比对筛子判定是否翻转**。后者是欠的，写在 `docs/DESIGN.md` 这里是提醒；
2. 抽查"是否引入原句没有的信息"（第二个模型或人工）；
3. 操作选择的准确率用真实冲突/重复样本核对；
4. 任何一步失败都退回今天的行为（fail-open），行为不变。

### 8.7 判决层该读原句还是读规范层？——已量，读原句（2026-10-02）

§8.6 第 1 条欠的账，先还了最要紧的一半：**"把句子弄干净之后，判定层会不会判得更准？"**
实验在 `eval/judge-rendering.ts`，配对设计（同一句、同一模型、同一次运行，只换渲染），
round5 的 40 条（18 条该记 + 22 条不该记）：

| 判定层读到的 | 该记中位分 | 不该记中位分 | AUC | 该记里 ≥0.12 的 |
|---|---|---|---|---|
| **原句** | 0.26 | 0.22 | **0.62** | **15 / 18** |
| 规范化后（第三人称） | 0.27 | 0.15 | 0.61 | 12 / 18 |

**排名能力没有变化（AUC 0.62 vs 0.61），而在线上阈值上抓到的正例更少（15 → 12）。**
逐条看原因很清楚：规范化会把第一人称的要求改写成第三人称转述——

- `首先我明确一下，语言不要选java…` → `用户明确表示语言不要选 Java…`：0.52 → **0.27**
- `git仓库链接也带上去，简历中不要带 memory.json…` → `用户要求把 git 仓库链接也带上…`：0.31 → **0.20**

判定层读到"**用户要求 X**"时，判的是"这句话在描述一个要求"，而不是"这是要求本身"，分数就掉下来。

**结论：判定层读原句。** 规范层只用于注入可读性，且默认不注入。

**同时发现一个真的越界**（§8.6 第 2 条人工抽查命中）：

- 原句 `@dsh-jev-memory/ 阅读一下这个项目…`（**一个请求**）
- 规范后 `我阅读了 @dsh-jev-memory/ 这个项目…`（**一个已发生的事实**）

**它凭空造了一个事实**，而词元重合度闸门（0.25）放行了——因为用词几乎一样，变的是时态和施事。
确定性闸门防不住这一类。所以：`normalize.inject` 保持关闭；要开，得先解决"改写不能改变言语行为"这件事。

### 8.8 写入路径的第二条：一次调用全判（已量，默认关，2026-10-03）

§8.7 量的是"给判定层读什么"。这一节量的是更上层的问题：**这套流水线本身该不该由一次调用取代。**

先量后写，`eval/one-call-judge.ts`，在 120 条还能还原出窗口的标注行上（同一批行、同一窗口、同一模型、同一标注）：

| | 精确率 | 召回率 | F1 | TP / FP / FN |
|---|---|---|---|---|
| **一次调用** | **56%** | **90%** | **0.69** | 18 / 14 / 2 |
| 流水线（分段 → 抽取 → 判定 → 闸门） | 27% | 60% | 0.37 | 12 / 32 / 8 |

差别不在"有没有模型"——判定层 F1 0.33，和免模型的规则打平。差别在**可见范围**（窗口）、**判断标准写进了提示词**，
以及**问题有界**（每段回答值不值得记 + 哪种记忆），而不是给孤立句子打分。

**强制项**：`text` 必须逐字出现在它声称的那条消息里，位置由我们在代码里 `indexOf` 定位（`dsh/lib/modelwrite.ts`）。
这条规则是量出来的，不是保险：同一思路**不要求逐字**时 F1 只有 0.37，且 22% 的返回不是任何人的原话，
其中一处把"集成"写成"继承"——**结论被改了还挂在你名下**。

**故意没绕过的**（列出来是为了防止以后有人"顺手"绕）：

1. **确定性筛句仍先跑**（密钥 / 粘贴块 / 任务指令 / 代码 / 提问）。注意 **0.69 与筛句的成绩不可相加**——
   那 120 行本身就是筛句活下来的行，筛句在更早池子上是 19% / 100%。
2. **模型回声筛仍跑**。
3. **重复 / 矛盾仍问判定层**（另一个问题：这段文字 vs 库里那条），所以 **Jev 在写入侧只剩这一件事**。

**被跳过的只有本地类型+分数闸门**（`applyModelGate`）。依据是标注的结构性缺陷，不是偏好：
21 条正例里 8 条死在类型白名单上，机制是关键词——`顺便我觉得这个配置流程应该再简化一下。` 因"流程"被判 `procedure`，
而 `procedure` 不是记忆类型。测试把这个对照钉住：同一句话 `pipeline` 拒（台账 `type-disabled:procedure`）、
`model` 记成 `constraint` 并出现在检索里。

**代价（默认关闭的原因）**：一次调用中位 **1233ms**、最慢 **3701ms**、**16/49 超 1600ms 预算**；
分段调用是 851ms / 1271ms / 1/11。最慢那次比整个 2500ms 预算还长。因此：

- 失败（超时 / 答案被拒）**退回标点切句 + 本地闸门，且不再调分段**——两次往返必然撑爆预算，整轮写入归零。
- 每轮写 `write-path` 行；`worth - kept` 是类型白名单还在拒的"值得记"的句子数。
- 若 `ok` 占比长期偏低，正确的动作是**把它挪到后台异步**，不是把预算调大。

### 8.9 模型答过的消息归它管（2026-10-03，实现 8.8 时发现的旧 bug）

§8.8 落地时发现抽取器里有个**比新路径更早、一直存在**的漏洞：
"这段是谁写的"只在**混着你自己的话的消息**上生效。

`ExtractOptions.units` 是"模型给出的句子"。原来的判断是**这条消息有没有 `user` 片段**，没有就退回标点切句——
听起来是稳健的回退，实际是把"模型说这条消息里没有你的话"和"模型没回答过这条消息"混成一件事：

- **整条都是粘贴块**的消息没有 `user` 片段 → 退回切句 → 粘贴内容照样能被记成你的要求。
  这正是分段功能要防的那件事，只有在**整条全粘贴**时才走得到，所以"混着粘贴块"的那个测试抓不到它。
- 在 `writeMode: 'model'` 上更直接：模型答 `[]`（没有值得记的）会退回**本地类型+分数闸门**，
  把刚被它否掉的句子写进去。而 8.8 量的是"有被接受且覆盖该行的项才写"（F1 0.69）——
  宽松读法会让上线的东西**不是那个 0.69 描述的东西**。

**改法**：`units` 非 `null` 即权威，按消息生效；调用失败 / 超时 / 被拒时传 `null`（不是 `[]`），
切句仍然拥有那些情况。两个测试钉住两个方向，并已确认它们在改回宽松判断时**确实失败**——
第一个测试是同一句话的两个分支（模型答过 → 不记；没有模型参与 → 本地规则照记），
少了后一半，一个"什么都不写"的坏插件也能通过。

### 8.10 结构化调用必须关掉思考（2026-10-03，量出来的线上故障）

§8.8 落地前翻台账，发现两个功能**从来没有成功过**：`segment` 5/5 `unparsable`，
`normalize` 12 条里 `ok` 为零。两个词都指向提示词，所以**先查错了方向**。

真因（用返回里原先被丢掉的两个字段看出）：**线上路由是会思考的模型，思考 token 和正文共用一个
`max_tokens`**。400 预算的规范化调用把 400 token 全花在思考上、正文 0 字符；
真实 5 条窗口的分段调用在 1200 预算下思考 356 + 正文 1621 被截断 → `unparsable`；
把预算提到 3000 **更糟**（思考 3000，正文 0，12.5 秒）。**加大预算只让它想得更久。**

修法：三个结构化调用都传 `reasoningEffort: 'off'`（DSH 自己的标题调用就是这么做的），
并把 `finish_reason` 读出来——预算耗尽现在记 `truncated`，不再和"答案读不懂"共用 `unparsable`。

| 调用 | 开着思考 | 关掉思考 |
|---|---|---|
| 分段（6 个真实窗口，两次运行） | 2/6、2/6 通过，中位 4467 / 5996ms | 4/6、4/6 通过，中位 860 / 824ms，最慢 5061ms |
| 规范化（4 句话） | 3/4 有输出，中位 1878–2026ms | 4/4，中位 638–730ms |
| 一次写入调用（6–7 个真实窗口） | 0–1 条可写，中位 3623 / 6614ms，2/6–7 截断 | 1–2 条可写，中位 596 / 686ms，0 截断 |

（`eval/thinking-budget.ts` 可重跑；**中位可复现，尾部不可复现**：关掉思考后分段仍有单个窗口 5061ms。）

**留一个缺口，不装作补上了**：§8.8 的 0.69 是在 `deepseek-chat` 上量的（不思考），线上是
`deepseek-flash`。这条路径现在能解析、能进预算，但**它在这条路由上的准确率没量过**，
所以 `writeMode` 默认仍是 `pipeline`。
