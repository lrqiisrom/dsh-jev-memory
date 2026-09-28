# memsearch 调研笔记（对照 dsh-jev-memory）

调研对象：`zilliztech/memsearch`。一手来源为 GitHub 仓库源码与官方文档（`git clone --depth 1` 到 `/tmp` 后逐文件核对，clone 已清理）。
仓库快照：commit `2a4652fa086fbd45e92bfd8da7781ebe1642baa7`（`release: prepare v0.4.21 (#765)`，2026-09-24）。元数据抓取时间：2026-09-28。

---

## 结论摘要

1. memsearch 是**给编码 agent 用的跨平台"会话流水记忆"**，不是"该不该记"的判定层：它把每个完成回合交给 LLM 摘要成 2–10 条第三人称 bullet，追加进 markdown，再建向量索引供事后检索（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)、[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）。
2. **存储是 markdown 为准 + Milvus 为派生影子索引**；没有类型体系、没有 importance、没有冲突处理、**没有召回计数器**——后者已对 `src/` 与 `plugins/dsh/` 全量 grep 验证无命中（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)，详见"它是什么 / 存储与数据模型"）。
3. **写入路径没有"什么值得记"的判断**：每个回合全量落盘，唯一去重是 `session/turn` 锚点幂等（防重放）与 chunk 级 SHA-256（防重复 embedding）。作者自己把这点写成卖点（"no LLM curation on the write path"，[comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md)）。
4. **Jev 只用在召回排序的最后一步**，是可选 reranker，只调用 `noul` 原语，**只排序、不设阈值、不参与写入**（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。这与我们"Jev 用在写入判定"是完全不同的位置。
5. **评测可信度中等偏上**：中英各 2172 查询共 4344 行，指标定义写得足以复现，且作者主动列出 4 条自证局限（标注非人工穷举、非 untouched held-out、英文复用中文候选、正例缺失导致 Recall@10 三者相同）（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。
6. **数字对我们不利**：在它自己的评测里 Jev 输给 Voyage rerank-3（Overall Recall@5 0.7941 vs 0.8187，MRR@10 0.6884 vs 0.7754），作者因此**明确拒绝把 Jev 设为默认**（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。
7. **它已经原生支持 DSH**（`plugins/dsh/`，npm 包 `@zilliz/memsearch-dsh`），并且在同一个扩展点生态里工作：`agent/pre-step` 注入、`ctx.skills.register` 注册技能（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。**它是我们在 DSH 内的直接同类竞品，优先级应高于"远方的开源项目"这一层理解。**
8. **没有 MCP server**，也刻意不做：官方文档写"no MCP servers, no sidecar services"。对 agent 暴露的是 **hook + 原生 skill**，不是 MCP 工具（[plugins/claude-code/README.md](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md)）。
9. **成熟度**：2671 star、263 open issue、非 archived、0.4.21（仍是 0.x）、MIT、Python 为主，约 2–4 周一个 release。功能面很宽，但 open issue 集中在 Windows 兼容、孤儿进程、hook 静默失败——**工程稳定性是它的短板，不是能力短板**。
10. **对 DSH 是硬成本**：它要求 Python 3.10+ 工具链、`milvus-lite` 与 558MB ONNX 模型，每次搜索/索引都 fork 一个 CLI 进程（[installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md)、[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。我们是零依赖纯 Node、进程内。
11. **可抄的**：评测方法学（Hit@K / Recall@K 双定义 + 自我局限声明）、markdown 为准 + 派生索引的可重建性、"仅 step 1 检索、无命中零成本"的省 token 守卫、失败必须有可见留痕而非静默降级。
12. **不该抄的**：全量落盘（无写入判定）、向量库与 Milvus 依赖、用"每次 fork CLI"做进程内钩子、无类型/无审计的设计——这四条正是我们插件的价值主张所在。

---

## 它是什么 / 存储与数据模型

### 定位与目标用户

- 一句话定位：**"Cross-platform semantic memory for AI coding agents."**（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)）
- 仓库描述更完整：**"A persistent, unified memory layer for all your AI agents (e.g. Claude Code, Codex, DSH), backed by Markdown and Milvus."**（[GitHub API `repos/zilliztech/memsearch`](https://api.github.com/repos/zilliztech/memsearch)）
- 两类目标用户，README 用两级标题显式分开（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)）：
  - **For Agent Users**——装插件、零配置，靠自动捕获 + 语义召回；
  - **For Agent Developers**——用 CLI / Python API 把记忆能力接进自己的 agent。
- 官方文档站的标题与副标一致，并强调"不用学命令、不用手动保存"（[docs/index.md](https://github.com/zilliztech/memsearch/blob/main/docs/index.md)）。

### 成熟度（抓取于 2026-09-28）

| 事实 | 值 | 来源 |
|---|---|---|
| Star | 2671 | [GitHub API](https://api.github.com/repos/zilliztech/memsearch) |
| Fork | 260 | 同上 |
| Open issues | 263 | 同上 |
| Archived / disabled | `false` / `false` | 同上 |
| 创建时间 | 2026-02-09 | 同上 |
| 最近提交 | 2026-09-24（`v0.4.21`） | 同上 + `git log -1` |
| 最新版本 | `0.4.21`（**仍是 0.x**） | [pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml) |
| release 节奏 | v0.4.16(07-23) → 17(07-31) → 18(08-19) → 19(08-23) → 20(09-12) → 21(09-24) | [GitHub releases API](https://api.github.com/repos/zilliztech/memsearch/releases) |
| License | MIT | [LICENSE](https://github.com/zilliztech/memsearch/blob/main/LICENSE) |
| 主语言 | Python | [GitHub languages API](https://api.github.com/repos/zilliztech/memsearch/languages) |

`263` 个 open issue 对 2671 star 的项目而言偏高；抽样 41 条 open issue 的主题分布见 §9。

> 二手来源（未能抓取正文，仅供交叉参考，勿当事实）：Zilliz 官方博客 [Persistent Memory for Claude Code: memsearch](https://blog.milvus.io/zh/blog/adding-persistent-memory-to-claude-code-with-the-lightweight-memsearch-plugin.md)（抓取遇重定向循环）与新闻稿 [Zilliz Open-Sources Memsearch](https://www.tmcnet.com/usubmit/2026/03/12/10347103.htm)（HTTP 403）。两者都指向"2026 年 3 月前后开源"这一时间线，与仓库创建时间 2026-02-09 相符 (推断)。

### 存储形态：markdown 为准，向量库为派生

核心原则写在设计文档第一句：**"markdown files are the canonical data store"**，Milvus 是**可以随时丢弃重建**的派生索引（[design-philosophy.md](https://github.com/zilliztech/memsearch/blob/main/docs/design-philosophy.md)、[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）。

**目录结构**（[docs/platforms/claude-code/how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/claude-code/how-it-works.md)）：

```
your-project/
├── .memsearch/
│   ├── .watch.pid            # 单例 watcher 的 PID 文件
│   └── memory/
│       ├── 2026-02-07.md     # 每日记忆日志
│       ├── 2026-02-08.md
│       └── 2026-02-09.md
└── ... (你的项目文件)
```

DSH 插件默认也用 `<project>/.memsearch`，可用 `MEMSEARCH_DIR` 显式改成全局位置（[docs/platforms/dsh/how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）。

启用高级维护后还会出现 `.memsearch/PROJECT.md`、`.memsearch/USER.md`、`.memsearch/skill-candidates/`（git 跟踪）与 `.memsearch/.maintenance-state.json`（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)、[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）。

**一条记忆的实际形态**——不是结构化记录，而是"markdown bullet + HTML 注释锚点"（[docs/platforms/claude-code/how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/claude-code/how-it-works.md)）：

```markdown
## Session 14:30

### 14:30
<!-- session:abc123def turn:ghi789jkl transcript:/home/user/.claude/projects/.../abc123def.jsonl -->
- User asked about N+1 query performance in order-service
- Agent identified selectinload as the fix and applied it to get_orders()
- Added index on order.user_id for the new query pattern
```

DSH 的锚点把 `transcript:` 换成 `db:`，指向 DSH 会话库（[issue #716](https://github.com/zilliztech/memsearch/issues/716) 正文里可见 `db:/root/.dsh/sessions/.../session.jsonl.zstd`）。

**因此"一条记忆的字段"这个问题在这里没有对象**：记忆正文没有 type / importance / confidence / source-seq / recall-count 字段。锚点里只有 `session` / `turn` / `transcript|db` 三个标识符 (推断：这正是我们"每条记忆可逐条追责"的差异点——它有会话定位，但没有判定元数据与召回台账)。

**向量层的数据模型**则是显式 schema（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）：

| 字段 | 类型 | 用途 |
|---|---|---|
| `chunk_hash` | `VARCHAR(64)` | **主键**，复合 SHA-256 chunk ID |
| `embedding` | `FLOAT_VECTOR` | 稠密向量 |
| `content` | `VARCHAR(65535)` | chunk 原文（同时经 Milvus Function 喂给 BM25） |
| `sparse_vector` | `SPARSE_FLOAT_VECTOR` | 由 Milvus BM25 Function 自动生成的稀疏向量 |
| `source` / `heading` / `heading_level` / `start_line` / `end_line` | — | 溯源元数据 |

复合 chunk ID 格式对齐 OpenClaw：`hash(markdown:source:startLine:endLine:contentHash:model)`（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）。

> **已核实"没有"的东西**（对 `src/` 与 `plugins/dsh/` 全量 grep `recall_count|recalls|times_recalled|hit_count|access_count|usage_count` 无命中）：**没有召回计数器**，也没有"这条记忆被注入过几次"的台账。这一点上我们比它多一层可观测性。

---

## 写入与召回链路

标注约定：`[确定性]` = 纯代码决定；`[模型]` = LLM 决定；`[向量]` = 向量库/检索引擎内部。

### 写入路径（DSH 为例）

1. `[确定性]` **触发**：插件监听 DSH `session/event`，识别"回合完成"（`turn/end`），拿 `session.header.cwd` 作为项目目录——刻意不用 `process.cwd()`，因为长驻 web 进程的 boot 目录未必是会话目录（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)、[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）。
2. `[确定性]` **幂等闸门**：`captureExists(memoryDir, sessionId, turn)` 在所有 `YYYY-MM-DD.md` 里搜锚点 `<!-- session:<id> turn:<n> `，命中则跳过。这是**防事件重放的幂等**，不是语义去重（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。
3. `[确定性]` **渲染**：把该回合的 user / assistant / 工具活动渲染成有上限的 transcript（`CAPTURE_MAX_CHARS = 6000`），工具原始输出被有意省略（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)、[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）。
4. `[模型]` **摘要**：把 transcript 交给摘要器，输出 **2–10 条 `- ` 开头的第三人称 bullet，语言跟随 `[User]` 文本**（prompt 全文见 [plugins/dsh/prompts/summarize.txt](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/prompts/summarize.txt)）。后端三选一（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）：
   - `dsh-headless`（默认）：起一个 one-shot headless DSH agent，stdin 立即 EOF，并用环境变量禁用 MemSearch 自身防止递归捕获；
   - `custom-llm`：走 memsearch 配置里的 `[llm.providers.*]`；
   - 失败时**不静默降级**，而是写入一条 "Memory summary unavailable: ..." 说明并保留 transcript 锚点（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）——这条行为在真实使用中触发了 [issue #716](https://github.com/zilliztech/memsearch/issues/716)。
5. `[确定性]` **落盘**：追加到 `.memsearch/memory/YYYY-MM-DD.md`，写 `### HH:MM` 标题 + `<!-- session:… turn:… db:… -->` 锚点。捕获任务通过 promise 链串行化，摘要调用不重叠（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。
6. `[确定性]` **索引**：以 detached + unref 的子进程跑 `memsearch index`，这样 DSH 进程退出后索引仍能完成；`MEMSEARCH_NO_WATCH=1`（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。
7. `[向量]` **chunk 级去重**：按标题切 chunk → 内容 SHA-256（截断 16 hex）→ 复合 chunk ID → 只在 Milvus 里不存在时才 embedding + upsert；消失的 chunk 顺手删除（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）。**这是索引去重，不是记忆去重。**

**关键否定事实**：整条写入链路上**没有任何"这条值得长期记住吗"的判断**——没有阈值、没有类型白名单、没有冲突检测、没有合并。作者把它当卖点：**"Append-only writes, no LLM curation on the write path"**（[comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md)）。代价由用户承担：[issue #523](https://github.com/zilliztech/memsearch/issues/523) 正是抱怨日记变成 append-only 流水账、产生"document rot"，请求增加 dreaming 式精炼。

### 召回路径

**通用三段式（progressive disclosure）**（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)、[design-philosophy.md](https://github.com/zilliztech/memsearch/blob/main/docs/design-philosophy.md)）：

| 层 | 命令 | 返回 | 成本 |
|---|---|---|---|
| L1 Search | `memsearch search` | Top-K chunk 片段 | 低 |
| L2 Expand | `memsearch expand <chunk_hash>` | 该 chunk 所在的完整 markdown 章节 + 锚点元数据 | 中 |
| L3 Transcript | `memsearch transcript` / 平台解析脚本 | 原始对话逐字 | 高 |

**L1 内部检索链**（[store.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/store.py)、[core.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py)）：

1. `[模型]` 把 query embed 成向量；
2. `[向量]` 在 Milvus 内做 **hybrid_search**：稠密 cosine 请求 + BM25 稀疏请求；
3. `[向量]` 用 **`RRFRanker(k=60)`** 融合两个有序列表；
4. `[确定性]` 把 RRF 分数归一化到 [0,1]：`score / (len(reqs) / (k + 1))`，即除以 `2/61`（[store.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/store.py)）；
5. `[确定性]` 若配了 reranker：先取 `fetch_k = top_k * 3`，再重排回 `top_k`；**未配 reranker 时直接取 `top_k`**（[core.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py)）；
6. `[模型]`（可选）reranker 重排——本地 ONNX/PyTorch cross-encoder，或远程 Jev（见 §4）。

**注入回模型的方式（DSH）**（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）：

- 扩展点：`ctx.on('agent/pre-step', handler, { prepend: true })`——**不是** `systemPrompt.context`；
- 守卫：`decision.kind === 'reject'` 或 `signal.aborted` 直接放行；**`step !== 1` 直接放行**（只在每个回合的第一步检索）；
- query 取自 decision 消息里第一条非空文本，长度 < 3 直接放行；
- 先检查 memory 目录是否有 `YYYY-MM-DD.md`，没有就放行；
- 执行 `memsearch search '<query>' --top-k 5 --json-output --default-collection '<collection>'`，超时 15s（`SEARCH_TIMEOUT_MS`）；
- **只有拿到 chunks 才注入**，否则原样返回 decision（"zero context cost"）；
- 注入内容：每条截断到 180 字符（`INJECT_SNIPPET_CHARS`），形如
  ```
  [memsearch] Retrieved memory context attached.

  Retrieved memory candidates from past sessions:
  1. [<source>] <180 字片段>
  ```
- 注入载体是**一条 role='user' 的消息**，`source = { kind:'plugin', plugin:'memsearch', form:'snapshot' }`，通过 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造；该模块不可达时退回手工构造同形对象（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）；
- 官方明确说明：模型仍需自行判断每个片段是否相关（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）。

**Claude Code 额外还有两条注入**（DSH 没有）（[docs/platforms/claude-code/how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/claude-code/how-it-works.md)）：

- `SessionStart` **冷启动注入**：读取最近 2 个日记文件各最多 40 行，作为 `additionalContext` 返回——因为 skill 只在模型"知道有历史"时才会触发；
- `UserPromptSubmit` **能力提示**：只返回 `[memsearch] Recall available if needed` 的 systemMessage，不做检索（<10 字符的 prompt 跳过）。

**它不用 AGENTS.md / CLAUDE.md 回写**：全仓库没有任何"把记忆写回 AGENTS.md/CLAUDE.md"的机制 (推断：与我们的"不与 AGENTS.md 争优先级"是同一结论，但走的是不同路径)。

---

## Jev 的具体用法

### 唯一落点

Jev 在 memsearch 里**只有一处实现**：`src/memsearch/jev_reranker.py`，由 `src/memsearch/reranker.py` 在模型名以 `jev:` 为前缀时分发（[reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/reranker.py)）：

```python
if model_name.startswith("jev:"):
    from .jev_reranker import JevReranker
    return JevReranker(model=model_name.removeprefix("jev:")).rerank(query, results, top_k=top_k)
```

对全 `src/` 做 grep，`jev`/`TYPESAFE` 仅出现在 `jev_reranker.py`、`reranker.py` 的分发处、`core.py` 的 `to_thread` 分支三处——**写入路径完全没有 Jev**（[core.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py)）。

### 用的原语与判定问题

- **原语：只有 `noul`**。没有 `choice`、没有 `score`（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。
- **一次请求问全部候选**：`POST https://api.typesafe.ai/v1/systemone`，`questions` 为 `{d0: {...}, d1: {...}, ...}`，每个候选一个独立 question（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。这与官方 cookbook 的"一对一发请求"不同，也**不是** joint listwise ranking——评测文档明确写了这一点（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。
- **state 放 query，候选正文放各自 question 的 instructions**（`INSTRUCTIONS + "\nCandidate passage:\n" + doc`）——与官方 cookbook 相反（cookbook 是 query 在 question、正文在 state），这是作者为记忆检索任务改写的（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)、[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。
- **判定的问题是**（原文，[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）：

  ```text
  INSTRUCTIONS: The query asks about information recorded in project memory. Could the
  candidate passage be a source for the answer — does it state the specific fact, decision,
  procedure, or event the query asks about?

  true:  The candidate passage states or establishes the specific information needed to
         answer the query, or a necessary supporting fact for a query requiring multiple passages.
  false: The candidate passage is merely on a similar topic or project; it does not supply
         the specific information the query requires.
  ```

### 排序还是阈值？

- **纯排序**。`rerank()` 按 `-score` 降序排，并列时保留原 RRF 顺序：`ranked.sort(key=lambda r: -r["score"])`（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。
- **没有阈值过滤**。评测文档原话：**"No input truncation or threshold filtering."**（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）
- **没有截断**：候选正文全文进 prompt（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。
- **响应强校验**：answers 的 key 必须**恰好等于** `{d0..d(n-1)}`，type 必须是 `noul`，值必须是 [0,1] 内有限数，否则抛错（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。
- **失败不降级**：docstring 明确 "an unsuccessful request never silently becomes an unreranked result"；`rerank()` 把异常抛给调用方（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)）。

> 对比我们的三条纪律：memsearch 的 Jev 用法**天然不违反**"概率只排序"，因为它只排序；但它也**完全没有**"阈值归代码"这一层，因为它不做写入判定。两者在 Jev 上的用法是正交的，不构成互相替代。

### 开启方式与安全约束

```bash
export TYPESAFE_API_KEY="your-key"
memsearch config set reranker.model jev:jev-latest
```

- 默认关闭（`reranker.model = ""`）；`jev-latest` 跟随最新稳定版，对齐官方 SDK 默认；要锁定版本用 `jev:jev-1.13.0`（[docs/home/configuration.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/configuration.md)）。
- **项目本地配置不能启用这个远程 provider**（`Project-local config cannot enable this remote provider`），必须写进可信的全局配置——因为 query 与 chunk 正文都会发到 TypeSafe（[docs/home/configuration.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/configuration.md)）。
- 切到 Jev 不需要重新 embedding，也不改 embedding provider（同上）。
- 超时 60s（`JevReranker(timeout=60.0)`），远端调用通过 `asyncio.to_thread` 放到线程池，不阻塞事件循环（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)、[core.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py)）。
- README 的 "What's New" 把 "Optional Jev reranking" 列为第一条更新（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)）。

---

## 评测：方法与数字

memsearch 有两套公开评测：**embedding provider 选型**与**reranking 对比**。后者是 Jev 相关的重点。

### A. Embedding provider 评测（背景）

- **数据集构造**（[evaluation/README.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/README.md)）：从 **12 个真实项目**的 `.memsearch/memory/*.md` 采集 → 用 `chunk_markdown()` 按标题切 → 清洗（去 HTML 注释、去 <50 字符 chunk、脱敏路径/IP/token）→ 用 **`gpt-5-mini` 生成查询** → 中文翻英文。
- **规模**：**955 chunks × 2172 queries**（955 simple + 926 complex + 291 multi-hop），中英各一份（[evaluation/README.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/README.md)）。
- **查询分类定义**（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）：
  - **Simple**：可由单个 chunk 回答的事实性问题；
  - **Complex**：需要解释/推理/综合、但仍可由单个 chunk 回答；生成器只考虑 ≥150 字符的 chunk，**长度是准入门槛不是难度度量**；
  - **Multi-hop**：有多个正例 chunk，由按"项目+日期"分组的关联笔记生成。
- **评测了 12+2 个模型**（openai small/large、bge-m3 PyTorch、MiniLM、multilingual-e5 small/base、Qwen3-Embedding-0.6B、两个 paraphrase 模型、ollama nomic/mxbai/Qwen3-8B-Q5、bge-m3 ONNX fp32/int8 变体）。
- **指标**：Recall@K (K=1,5,10)、MRR、NDCG@10；**Recall@5 为主要指标**，因为插件用户通常只看 top 3–5（[evaluation/README.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/README.md)）。
- **结论数字**（按中文 R@5 排序，[evaluation/README.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/README.md)）：

  | 排名 | 模型 | 大小 | zh R@5 | en R@5 | zh MRR |
  |---|---|---|---|---|---|
  | 1 | BAAI/bge-m3 (PyTorch) | 1.7GB | **0.783** | **0.815** | 0.637 |
  | 2 | bge-m3 ONNX int8 | 558MB | 0.776 | 0.814 | 0.642 |
  | 3 | openai/text-embedding-3-large | API | 0.750 | 0.797 | 0.603 |
  | 4 | Qwen3-Embedding-0.6B | ~1.2GB | 0.739 | 0.733 | 0.588 |
  | 5 | openai/text-embedding-3-small | API | 0.717 | 0.767 | 0.574 |
  | 12 | all-MiniLM-L6-v2 | 91MB | 0.203 | 0.651 | 0.129 |
  | 13 | Qwen3-Embedding-8B (Q5) | 5.4GB | 0.201 | 0.230 | 0.140 |

  ONNX int8 相对 PyTorch fp32 只掉 1.1%，体积从 2.2GB 降到 558MB，直接促成默认 provider 从 OpenAI 切到本地 ONNX（[evaluation/README.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/README.md)）。

### B. Reranking 评测（Jev 的重点）

**设计**（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）：

- **做什么**：比较"冻结的检索候选顺序"与 Jev、Voyage rerank-3 的重排质量。**测的是 reranking，不是完整问答系统**。
- **候选池**：每个 query **复用历史上 Chinese BGE-M3 检索跑的 10 个候选 ID 及其顺序**。英文侧用的是**这些同一批 query 与候选 chunk 的译文**，**不重新生成英文 embedding、不重新检索英文候选**——目的是在两种语言间固定候选集。
- **规模**：语言 × query 共 **4344 行**（中文 2172 + 英文 2172）。作者特别强调：这是 4,344 个 *language-query rows*，**不是 4,344 个独立问题**。
- **baseline**：**冻结的 BGE-M3 候选顺序**（不加任何 reranking）。
- **对手**：`jev-1.13.0`（锁定版本）；`Voyage rerank-3`（评测时为 Preview），`top_k=10`、`truncation=false`、原 query 不加指令。
- **Jev 配置**：每个 query 一次请求，每个候选一个独立 Noul question，无截断、无阈值过滤。prompt 从官方 [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe) 从"法律引用匹配"改写到"记忆检索"（prompt 全文已在 §4 抄录）。

#### 指标定义（可复现）

评测文档同时公布了两套定义，因为要和历史 embedding 表衔接（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）：

| 指标 | 定义 | 与历史脚本的关系 |
|---|---|---|
| **Hit@K** | 前 K 个结果里**存在任一所标注正例**则为 1，否则 0 | **完全等于**历史脚本里被标为 `Recall@K` 的指标 |
| **Recall@K** | 前 K 个结果里命中的正例数 **÷ 全部已标注正例数** | 单正例 query 上与 Hit@K 相同；多正例 query 上不同 |
| **MRR@10** | 10 个候选内第一个正例的**倒数排名**，没有则为 0 | 与历史 MRR 同公式（因 top-10 检索） |
| **NDCG@10** | **二元相关性**，理想排序由**全部已标注正例**构成 | 与历史脚本同公式 |

文档给了消歧例子：**"检索到 3 个正例中的 1 个且排在前 5" → Hit@5 = 1，Recall@5 = 1/3。**

**实现**（可直接对标，[evaluation/rerank_evaluate.py](https://github.com/zilliztech/memsearch/blob/main/evaluation/rerank_evaluate.py)）：

```python
def metrics(ids, positives):
    gold = set(positives)
    hits = [int(cid in gold) for cid in ids[:10]]
    ideal = sum(1 / math.log2(i + 2) for i in range(min(10, len(gold))))
    return {
        "hit_at_1": float(any(hits[:1])),
        "hit_at_5": float(any(hits[:5])),
        "hit_at_10": float(any(hits)),
        "recall_at_1": sum(hits[:1]) / len(gold),
        "recall_at_5": sum(hits[:5]) / len(gold),
        "recall_at_10": sum(hits) / len(gold),
        "mrr_at_10": next((1 / (i + 1) for i, hit in enumerate(hits) if hit), 0.0),
        "ndcg_at_10": sum(hit / math.log2(i + 2) for i, hit in enumerate(hits)) / ideal,
    }
```

- 指标按 query 行做 **macro-average**（文档："Metrics are macro-averaged over query rows"）；总表对每个 query 等权，不对每个类别等权；中英行数相等（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。
- 前置校验：`gold` 非空，且候选 ID 必须唯一（[rerank_evaluate.py](https://github.com/zilliztech/memsearch/blob/main/evaluation/rerank_evaluate.py)）。

#### 主结果（2026-09-20 全量，4344 行全部成功）

| Language | Method | Queries | Recall@5 | MRR@10 | NDCG@10 | Recall@10 |
|---|---|---:|---:|---:|---:|---:|
| Overall | Frozen order | 4344 | 0.7471 | 0.6372 | 0.6728 | 0.8350 |
| Overall | **Jev 1.13.0** | 4344 | **0.7941** | **0.6884** | **0.7114** | 0.8350 |
| Overall | Voyage rerank-3 | 4344 | **0.8187** | **0.7754** | **0.7755** | 0.8350 |
| Chinese | Frozen order | 2172 | 0.7471 | 0.6372 | 0.6728 | 0.8350 |
| Chinese | Jev 1.13.0 | 2172 | 0.7930 | 0.6885 | 0.7119 | 0.8350 |
| Chinese | Voyage rerank-3 | 2172 | 0.8211 | 0.7766 | 0.7768 | 0.8350 |
| English | Frozen order | 2172 | 0.7471 | 0.6372 | 0.6728 | 0.8350 |
| English | Jev 1.13.0 | 2172 | 0.7952 | 0.6883 | 0.7110 | 0.8350 |
| English | Voyage rerank-3 | 2172 | 0.8164 | 0.7743 | 0.7743 | 0.8350 |

（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）

**历史口径 Hit@5**（= 旧脚本的 Recall@5）：

| Language | Method | Hit@5 | Recall@5 |
|---|---|---:|---:|
| Overall | Frozen order | 0.7827 | 0.7471 |
| Overall | Jev 1.13.0 | 0.8303 | 0.7941 |
| Overall | Voyage rerank-3 | 0.8531 | 0.8187 |
| Chinese | Jev 1.13.0 | 0.8297 | 0.7930 |
| English | Jev 1.13.0 | 0.8310 | 0.7952 |

**分查询类别（Recall@5 / MRR@10）**：

| Language | Category | Queries | Frozen R@5 | Jev R@5 | Voyage R@5 | Frozen MRR@10 | Jev MRR@10 | Voyage MRR@10 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Overall | simple | 1910 | 0.7675 | 0.8272 | 0.8398 | 0.6256 | 0.6956 | 0.7606 |
| Overall | complex | 1852 | 0.7657 | 0.8072 | 0.8396 | 0.6217 | 0.6571 | 0.7699 |
| Overall | multi_hop | 582 | 0.6212 | 0.6436 | 0.6831 | 0.7243 | 0.7646 | 0.8419 |

**成本与延迟**：

| Language | Provider | Requests | Billable tokens | Estimated USD | Mean request s |
|---|---|---:|---:|---:|---:|
| Chinese | Jev 1.13.0 | 2172 | 9,565,342 | $0.4017 | 1.225 |
| English | Jev 1.13.0 | 2172 | 8,156,231 | $0.3426 | 0.863 |
| Chinese | Voyage rerank-3 | 2172 | 5,222,825 | $0.2611 | 0.875 |
| English | Voyage rerank-3 | 2172 | 5,228,292 | $0.2614 | 0.603 |

- 单价口径：**Jev 输入 $0.042 / 百万 token**，Voyage rerank-3 $0.05 / 百万 token，账号抵扣前（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。
- 换算：**约 $0.171 / 1000 queries（Jev） vs $0.120 / 1000 queries（Voyage）**（同上）。
- 延迟包含网络、并发（8 workers）与重试时间，作者声明**不是受控吞吐或纯模型速度基准**（同上）。

**解读**：Jev 相对冻结顺序 Recall@5 **+4.70pp**；Voyage 再加 **+2.46pp**，且 MRR@10 优势更大（0.7754 vs 0.6884）。Jev 的中英 MRR 几乎相同（0.6885 / 0.6883）。作者结论：**支持 Jev 作为可选 provider，而不作为新默认**（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。

#### 作者自证的局限（很重要，决定我们能不能对标）

评测文档和结果 JSON 的 `limitations` 字段列了这些（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)、[reranking-results.json](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-results.json)）：

1. **标注是生成的，不是人工穷举**——被 reranker 判为有用的段落可能确实相关，但不在记录的正例 ID 里（正例召回率是下界）。
2. **正例缺失保持缺失**，不往候选池里注入 gold doc → 三个方法的 **Recall@10 完全相同（0.8350）**，这是设计后果不是成绩。
3. **不是 untouched held-out set**——早期子集被用来调 prompt 与 API 形状。
4. **英文行复用中文候选 ID**，而旧英文 embedding 榜是真英文检索 → **两者不能拼成同一张榜**。
5. 与正常 `MemSearch.search()` 不同：真实搜索会先取 `3 * top_k` 再 rerank（[core.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/core.py)）。
6. **原始语料与逐 query 输出是私有的，不在仓库里**——只有聚合指标与 input SHA-256 公开，**复现精确数字需要授权的数据副本**。
7. 本地 cross-encoder pilot 只有 30 query，未纳入全量对比。
8. 作者明确不给强结论：*"It does not establish that Jev is generally weaker at reranking"*，只说明"这一次 Noul prompt + 生成式记忆查询 + 固定候选池"的结果。

**复现方式**（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）：

```bash
uv sync --locked
export TYPESAFE_API_KEY="your-key"
export VOYAGE_API_KEY="your-key"
uv run python evaluation/rerank_evaluate.py \
  --data-dir /path/to/data \
  --candidates /path/to/details_local_BAAI_bge-m3_zh.json \
  --output /path/to/private-results \
  --workers 8
```

需要 `corpus_zh/en.jsonl`（`chunk_id` + `content`）、`queries_zh/en.jsonl`（`query_id` + `query` + `query_type` + 非空 `positive_chunk_ids`）、候选 JSON（`query_id` + **恰好 10 个**唯一 `retrieved_ids`）。`--preflight` 可在不调 API 的情况下校验输入并估算成本；结果按完整请求 payload 的 hash 缓存，支持断点续跑；**任何请求失败就不输出聚合结果，且不回退到 baseline 排序**（同上）。

### 对我们的意义（这节是判断，不是事实）

- **它的指标定义可以直接对标**，且已经替我们把"Hit@K vs Recall@K"这个坑标出来了——我们 README 里写的"Top-3 命中"目前**没有定义是 Hit@3 还是 Recall@3**，在多正例场景下两者不同（[我们的 README](../README.md)）。
- 但**它的数字不能直接与我们的"召回命中率"比**：它的数据是生成式查询 + 私有语料 + 10 候选固定池；我们的是人工标 50 条查询 + 真实召回链路 + 无固定候选池 (推断)。要对标必须先把我们的指标定义写成同样精确的形式。
- **它的 Jev 结论对我们不利但不同题**：它测的是"用 Noul 给已有候选排序"，我们用的是"用 Noul/Choice/Score 做写入判定"。同一个厂商模型、不同的任务与不同的原语组合，**它的负向结果不构成我们 Jev 路线的反证**；但它是目前唯一可引用的公开 Jev 横向数据，任何对外表述都必须承认"Jev 在这份 reranking 评测里输给 Voyage rerank-3"。

---

## 接口面（CLI / MCP / 工具）

### CLI

入口 `memsearch`（`pyproject.toml` 的 `[project.scripts]`），命令清单来自 [cli.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/cli.py) 与 [docs/cli.md](https://github.com/zilliztech/memsearch/blob/main/docs/cli.md)：

| 命令 | 语义 |
|---|---|
| `memsearch index <paths...>` | 索引 markdown；`--force` 全量重嵌；`--ignore-file .gitignore` |
| `memsearch search <query>` | 混合检索（dense + BM25 + RRF）；`--top-k`、`--source-prefix`、`--reranker-model`、`--json-output` |
| `memsearch expand <chunk_hash>` | L2：展开 chunk 所在的完整 markdown 章节，并解析锚点暴露 transcript 路径 |
| `memsearch transcript <path>` | L3：读原始对话（`--turn`、`--context`、`--json-output`） |
| `memsearch watch <paths...>` | 文件监听自动重索引（1500ms debounce） |
| `memsearch compact` | LLM 压缩已索引 chunk，追加回 `memory/YYYY-MM-DD.md`（形成闭环） |
| `memsearch summarize <plugin> <agent_name>` | 供各平台 hook 调用的摘要子命令 |
| `memsearch stats` | 已索引 chunk 数 |
| `memsearch reset --yes` | 删除全部索引数据（不动 markdown） |
| `memsearch config init/set/get/list` | 配置向导与读写 |
| `memsearch skills distill/add/list/status/install` | 把记忆蒸馏成可安装 skill |

`search` 的完整 flag（[cli.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/cli.py)）：`--top-k/-k`、`--source-prefix`、`--reranker-model`（空串=关闭）、`--json-output/-j`，加上公共的 `--provider/--model/--batch-size/--base-url/--api-key/--collection/--default-collection/--milvus-uri/--milvus-token`。**`--json-output` 是 DSH 插件与它通信的接口**（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。

### Python API

```python
from memsearch import MemSearch
mem = MemSearch(paths=["./memory"])
await mem.index()
results = await mem.search("Redis config", top_k=3, source_prefix="./memory/product")
```

（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)）

### MCP

**没有 MCP server。** 官方明确写：*"Built on Claude Code's native Hooks, Skills, and CLI — **no MCP servers, no sidecar services**."*（[plugins/claude-code/README.md](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md)）

对照表里 memsearch 的 "Generic MCP" 一行标为 `—`，而 qmd / MemPalace / mem0 标 ✅（[docs/home/comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md)）。作者还把"不用 MCP"写成相对 claude-mem 的优势：**MCP 工具定义会永久占用上下文 token，而 skill 在 forked subagent 里跑不占**（[plugins/claude-code/README.md](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md)）。

> 唯一出现 `mcp` 字样的地方是各平台 `maintenance-runner.py` 里给 `claude` 子进程传 `--strict-mcp-config`——那是**给维护子 agent 收紧权限**用的（并配合 `--tools ""`），不是 memsearch 自己提供 MCP（[plugins/dsh/scripts/maintenance-runner.py](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/scripts/maintenance-runner.py)）。

### 对 agent 暴露的工具（DSH）

**DSH 上它没有注册任何模型工具**——这是与我们最大的接口差异。它暴露的是三件东西（[plugins/dsh/index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)、[docs/platforms/dsh/how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）：

1. **自动注入**（非工具）：`agent/pre-step` 在 step 1 追加一条 role=`user` 的记忆消息；
2. **三个原生 skill**，通过 `ctx.skills.register(...)` 注册，`invocation: { modelInvocable: true, userInvocable: true }`：

| skill 名 | 语义 | 来源 |
|---|---|---|
| `memory-recall` | 检索持久记忆："Search memsearch persistent memory for context relevant to the user's question." | [SKILL.md](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/skills/memory-recall/SKILL.md) |
| `memory-config` | 诊断与配置 MemSearch 行为（配置、摘要路由、PROJECT/USER 维护、目录、索引健康、provider 路由、prompt 文件、迁移/兼容问题） | [index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js) |
| `memory-to-skill` | 把记忆里的工作流蒸馏成可复用 skill，审查/安装候选 | [index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js) |

3. **客户端 UI**（web profile）：composer 上方的 MemSearch capsule，内含 skill 候选审查 + `.memsearch` 只读浏览（渲染 markdown）/只读、拒绝路径与符号链接逃逸、预览上限 256KB（[client.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/client.js)、[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）。

**skill 的实现是"让模型自己跑 shell"**：`memory-recall` 的正文就是三步 bash 指令——`memsearch search ... --json-output` → `memsearch expand <chunk_hash>` → `python3 scripts/parse-transcript.py --db <path> --turn N`（[SKILL.md](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/skills/memory-recall/SKILL.md)）。它**没有** `memory_write` / `memory_forget` 这类写入/撤销工具——因为写入是全自动的，用户不参与 (推断：这正是我们"用户撤不掉的记忆比没有记忆更糟"的对照面)。

---

## 与 agent 集成的方式（官方接线步骤）

五个平台，全部是 **hook / plugin / skill**，没有一个是 MCP（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)、[docs/platforms/index.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/index.md)）：

| 平台 | 安装 | 机制 | 来源 |
|---|---|---|---|
| **Claude Code** | `/plugin marketplace add zilliztech/memsearch` → `/plugin install memsearch` → 重启 | 4 个 shell hook + 1 个 `context: fork` subagent skill + watch 进程 | [README](https://github.com/zilliztech/memsearch/blob/main/README.md)、[plugins/claude-code/README.md](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md) |
| **Codex** | `git clone --depth 1 …` → `bash memsearch/plugins/codex/scripts/install.sh` → `codex --yolo` | Stop hook + 原生 skill | [README](https://github.com/zilliztech/memsearch/blob/main/README.md) |
| **DeepSeek Harness** | `uv tool install "memsearch[onnx]"` → `dsh plugin --profile web add @zilliz/memsearch-dsh` → 重启 profile | Cordis 插件（`session/event` + `agent/pre-step` + `ctx.skills.register`） | [docs/platforms/dsh/installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md) |
| **OpenClaw** | `openclaw plugins install --force clawhub:memsearch` + 两个 `hooks.allow*` 配置 + gateway 重启 | `agent_end` 钩子 + skill | [README](https://github.com/zilliztech/memsearch/blob/main/README.md) |
| **OpenCode** | `~/.config/opencode/opencode.json` 里加 `{"plugin": ["@zilliz/memsearch-opencode"]}` | 后台 daemon 捕获 | [README](https://github.com/zilliztech/memsearch/blob/main/README.md) |

**DSH 的官方接线细节**（[docs/platforms/dsh/installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md)）：

- 前置：Python 3.10+、**Node.js 22.19 或更新**（DSH 要求）、一个 DSH profile、`dsh` 在 PATH；
- 从源码装：`dsh plugin --profile web add /absolute/path/to/memsearch/plugins/dsh`；插件是**无构建步骤的纯 ESM**，改完源码重启 profile；
- 插件声明了 `export const inject = ['agents', 'skills', 'sessionPersistence']`（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）；
- profile 内可调的行为只有 4 个：`captureEnabled`、`injectEnabled`、`summarizeEnabled`、`summarizeMode`（默认 `auto`）——**embedding / Milvus / provider 全部走 memsearch 自己的配置**，旧版插件内的 `summarizeProvider` 等字段已废弃并会告警（[installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md)、[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）；
- 卸载：`dsh plugin --profile web remove @zilliz/memsearch-dsh`，**不会删除 `.memsearch` markdown 或 Milvus 索引**（[installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md)）。

> 注：`plugins/dsh/cordis.patch.yml` 是它的 bundle 层插入声明（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)），机制与我们 `cordis.patch.yml` 的同名文件一致——**两者会在同一个 profile patch 层里共存**。

---

## 它的已知限制 / TODO

### 作者自己写下的限制

- **Windows**：Milvus Lite 3.x 虽可用，但**"has not received one-to-one native Windows validation … not part of the formal support matrix"**；推荐 Milvus Server / Zilliz Cloud / WSL2（[docs/faq.md](https://github.com/zilliztech/memsearch/blob/main/docs/faq.md)、[docs/troubleshooting.md](https://github.com/zilliztech/memsearch/blob/main/docs/troubleshooting.md)）。
- **冷索引慢**：本地 provider 下成本 ≈ `chunk 数 × 模型速度`（bge-m3 ONNX 在 CPU 上约 10 texts/s）；**换 embedding 模型会一次性全量重嵌**（模型名是 chunk ID 的一部分），且维度变化会导致 collection 不兼容、必须 `reset` 重建（[docs/architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)、[docs/faq.md](https://github.com/zilliztech/memsearch/blob/main/docs/faq.md)）。
- **Milvus Lite 3.x 不能自动迁移 2.x 的 `.db`**，必须手工移走旧文件再重建（[docs/troubleshooting.md](https://github.com/zilliztech/memsearch/blob/main/docs/troubleshooting.md)）。
- **collection "released" 状态**：跨进程调用（先 `index` 再 `search`）可能打开成 released 状态，需要显式 `load()`（[docs/faq.md](https://github.com/zilliztech/memsearch/blob/main/docs/faq.md)）。
- **没有 LLM 策展的写入**被当作设计选择，但也意味着没有去重/合并/精炼（[docs/home/comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md)）。
- **本地 reranker 在依赖缺失时会静默跳过**：`logger.warning(... skipping reranking)` 后原样返回——注意这与 Jev 的"失败即抛错"策略**不同**（[reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/reranker.py)）(推断：这是个不一致点，远程怕静默降级、本地却静默降级)。

### open issue 里反复出现的抱怨（抽样 41 条 open issue）

主题计数（抓取自 [GitHub issues API](https://api.github.com/repos/zilliztech/memsearch/issues?state=open)，仅按标题关键词粗分）：`memory` 13、`hook` 11、`windows` 7、`watch` 5、`index` 5、`summar*` 5、`search` 5、`orphan` 4、`dsh` 3。典型条目：

| Issue | 抱怨 | 性质 |
|---|---|---|
| [#527](https://github.com/zilliztech/memsearch/issues/527) | Stop hook 把 Anthropic 限流错误字符串当成记忆摘要写进日记，永久污染向量检索与 L1→L3 链路（只挡了空响应，没挡"看起来像报错"） | **写入路径缺校验** |
| [#716](https://github.com/zilliztech/memsearch/issues/716) | DSH headless 摘要超时 → 日记里只留下 `Memory summary unavailable: dsh headless summarization timed out` | **DSH 写入质量** |
| [#631](https://github.com/zilliztech/memsearch/issues/631) | 不在 git 仓库里时 Claude 与 Codex 解析出的项目根不同 → **记忆被分叉成两份** | 作用域/项目根解析 |
| [#600](https://github.com/zilliztech/memsearch/issues/600) / [#658](https://github.com/zilliztech/memsearch/issues/658) / [#708](https://github.com/zilliztech/memsearch/issues/708) / [#692](https://github.com/zilliztech/memsearch/issues/692) | 孤儿 watch/index 进程无法回收，无限累积（Windows Git Bash、macOS Seatbelt 沙箱、git worktree 场景） | **进程生命周期** |
| [#740](https://github.com/zilliztech/memsearch/issues/740) | `stop.sh` 因未绑定变量静默退出 → **捕获永久失效且无可见错误** | 静默失败 |
| [#523](https://github.com/zilliztech/memsearch/issues/523) | 日记变成 append-only 流水账，"document rot"；请求 dreaming 式精炼与 knowledge wiki | **无策展的直接后果** |
| [#102](https://github.com/zilliztech/memsearch/issues/102) | CJK 分词与 markdown 解析缺陷导致中文 BM25 召回差、chunk 切得糊 | 中文检索 |
| [#676](https://github.com/zilliztech/memsearch/issues/676) | SessionStart hook 每次 `--version` 都是一次完整 CLI 启动，仍有 10s 超时问题 | 启动开销 |
| [#547](https://github.com/zilliztech/memsearch/issues/547) | 请求支持 pi-mono coding agent | 平台诉求 |

**归纳**：它的短板不是"能力不够"，而是**大量跨进程 shell 编排带来的生命周期与静默失败问题**，以及**无策展写入的长期腐化**。这两条恰好是我们架构上避开的（进程内钩子、判定闸门 + 台账）(推断)。

---

## 多语言 / 工程栈事实

| 项 | 事实 | 来源 |
|---|---|---|
| 语言占比（字节） | Python 879,824；JavaScript 187,219；Shell 124,887；TypeScript 81,400 | [GitHub languages API](https://api.github.com/repos/zilliztech/memsearch/languages) |
| 代码规模 | `git ls-files` 共 315 个文件 | `git ls-files \| wc -l` |
| Python 版本 | `requires-python = ">=3.10"` | [pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml) |
| **必需依赖** | `pymilvus>=2.5.0`、**`milvus-lite>=2.5.0`**、`click`、`watchdog`、`pathspec`、`setuptools`、`tomli_w`、`openai>=1.0` | [pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml) |
| 可选 extras | `onnx`（onnxruntime+tokenizers+huggingface-hub）、`local`、`ollama`、`openai`、`google`、`voyage`、`jina`、`mistral`、`anthropic`、`all` | [pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml) |
| DSH 插件运行时 | Node.js 22.19+；纯 ESM、无构建步骤 | [docs/platforms/dsh/installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md)、[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js) |

### 是否必须 Milvus / Zilliz 云？是否支持纯本地？

- **Milvus 是硬依赖，Zilliz 云不是。** `pymilvus` 与 `milvus-lite` 都在**核心** `dependencies` 里，不是 extra（[pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml)）→ **没有"不用向量库"的运行模式**。
- 但 **Milvus Lite 是本地单文件**（默认 `~/.memsearch/milvus.db`），所以**纯本地可用、无需任何账号**（[docs/architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)、[docs/getting-started.md](https://github.com/zilliztech/memsearch/blob/main/docs/getting-started.md)）。
- 三档部署靠**只改一个 `milvus_uri`** 切换（[docs/architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）：
  - Milvus Lite（默认，本地 `.db`，零配置）；
  - Milvus Server（`http://localhost:19530`，需 Docker/K8s）；
  - Zilliz Cloud（`https://….zillizcloud.com`，**README 里标为 "recommended"**，带免费的注册推广链接）。
- **数据出门的条件**：只有显式选择远程组件时才会（远程 vector store / 远程 embedding / 远程 compact LLM）。全本地配置下数据不出机器（[docs/architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)）。**启用 Jev reranking 属于"显式远程"，会把 query 与候选正文发到 TypeSafe**（[docs/home/configuration.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/configuration.md)）。
- **跑起来需要什么**（DSH 路径）：Python 3.10+ 与 `memsearch[onnx]`（首次使用会从 HuggingFace 下 **~558MB** 的 bge-m3 int8，缓存到 `~/.cache/huggingface/hub/`），加磁盘上的 `milvus.db`；**不需要 Docker、不需要云账号**（[docs/platforms/dsh/installation.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/installation.md)、[docs/troubleshooting.md](https://github.com/zilliztech/memsearch/blob/main/docs/troubleshooting.md)）。

---

## 与 dsh-jev-memory 的逐项对比

| 维度 | memsearch | 我们（dsh-jev-memory） | 结论 |
|---|---|---|---|
| **定位** | 会话流水记忆：跨平台统一、事后语义检索（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)） | 类型化长期记忆：判定"什么值得记" + 每步按工作区召回（[我们的 README](../README.md)） | **正交，非替代**。它解决"记得多"，我们解决"记得准"。 |
| **写入触发** | 每个完成回合，全自动（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)） | `agent/turn-stopping`（serial + awaited）抽候选 → 判定 → 闸门（[我们的 README](../README.md)） | 同为钩子；我们在关键路径上，因此必须 fail-open + deadline，它有 fire-and-forget 的余裕 |
| **"什么值得记"** | **无判断**——全量落盘，作者当卖点（[comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md)） | 判定层出 `type`/`importance`/`conflict` + `applyGate()`（[DESIGN.md](../docs/DESIGN.md)） | **这是我们最核心的差异，必须保住** |
| **记忆正文谁写** | LLM 摘要（2–10 bullet，第三人称）（[summarize.txt](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/prompts/summarize.txt)） | 只能是用户原话/工具失败的确定性签名，判定层不生成文本（[DESIGN.md](../docs/DESIGN.md)） | 我们换来"误记可追责"，代价是正文形态不如 bullet 整齐 |
| **类型体系** | **无**（markdown bullet，无 type/tag）（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/claude-code/how-it-works.md)） | 7 类 + 白名单 + 每类召回配额（[README](../README.md)） | 无类型 → 无法做类型配额，也无法按类审计 |
| **存储** | markdown 为准 + Milvus 派生索引（[design-philosophy.md](https://github.com/zilliztech/memsearch/blob/main/docs/design-philosophy.md)） | `memory.json` + 只追加 `ledger.jsonl`（[DESIGN.md](../docs/DESIGN.md)） | 它 markdown 可读可 diff 是优势；我们台账可审计是优势。两者都"可重建" |
| **索引/检索** | Milvus hybrid：dense + BM25 + RRF(k=60)（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)） | 无向量库；子串 + 词重叠（[DESIGN.md](../docs/DESIGN.md)） | 规模化召回它强；但引入 Milvus + Python + 558MB 模型，**对 DSH 插件是重依赖** |
| **召回打分** | RRF 融合后归一化；reranker 只排序（[store.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/store.py)） | `importance*0.85 + 半衰期 180 天衰减*0.15` + 类型配额 + token 预算（[DESIGN.md](../docs/DESIGN.md)） | **我们独有的是"陈旧但重要不会被新近琐事挤掉"**；它没有时间维度与重要性概念 |
| **注入时机** | DSH：`agent/pre-step`，**仅 step 1**，无命中就零成本（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)） | `systemPrompt.context`，**每步**重新求值（[DESIGN.md](../docs/DESIGN.md)） | 它在"省 token"上更激进；我们需要 step 1 之外也召回（会话中途话题漂移）——**这一点值得重新审视** |
| **注入载体** | 追加一条 role=`user` 的消息，带 marker（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)） | `systemPrompt.context` 的运行时上下文区块（[DESIGN.md](../docs/DESIGN.md)） | 语义不同：它的记忆看起来像"用户刚说的话"，我们的明确是"系统注入的上下文" |
| **作用域** | 按项目派生 collection + `<project>/.memsearch`（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)） | 绑定会话创建时 cwd，cwd=null 为全局，跨工作区不合并（[DESIGN.md](../docs/DESIGN.md)） | 同思路；它有 issue #631 证明"项目根解析不一致会把记忆分叉"——**我们应把 cwd 的作用域写进回归测试** |
| **模型工具** | **无工具**；三件套是自动注入 + 3 个 skill（`memory-recall`/`memory-config`/`memory-to-skill`），skill 内部跑 shell CLI（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)） | `memory_search` / `memory_write` / `memory_forget`（[README](../README.md)） | 它没有"撤销"入口——自动写 + 不可撤；**我们的 `memory_forget` 是明确优势** |
| **Jev 位置** | 召回最后一步的可选 reranker，只用 `noul`，只排序不设阈值，默认关闭（[jev_reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/jev_reranker.py)） | 写入判定层首选（noul/choice/score 三种原语），概率只排序、阈值归代码（[DESIGN.md](../docs/DESIGN.md)） | **同一个模型、完全不同的用法**。它的公开数据不能替我们背书，也不是反证 |
| **失败策略** | Jev 失败即抛错不降级；本地 reranker 依赖缺失则**静默跳过**；摘要失败写 unavailable 说明不静默降级（[reranker.py](https://github.com/zilliztech/memsearch/blob/main/src/memsearch/reranker.py)、[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)） | 全链路 fail-open，判定失败降级启发式，超时放弃（[README](../README.md)） | 我们的策略更适合关键路径；**但它"摘要失败要留痕而不是丢内容"值得借鉴** |
| **可观测性** | 无召回计数、无台账；靠 markdown 本身与 `stats`（grep 验证） | `ledger.jsonl` 记 write/skip/recall/forget/hook-error（[DESIGN.md](../docs/DESIGN.md)） | **我们强**。它的误记（#527）只能靠用户手动发现 |
| **评测** | 中英各 2172 query 共 4344 行，指标定义完整，含 4 条自证局限（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)） | 写入精确率 1/4→已修；召回命中率**待测**；指标未定义 Hit vs Recall（[README](../README.md)） | **这是我们要补的短板**，且它给了可直接对标的定义 |
| **依赖与运行成本** | Python 3.10+ / milvus-lite / 558MB 模型 / 每次检索 fork CLI 子进程（[pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml)、[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)） | 零依赖纯 Node，进程内调用（[DESIGN.md](../docs/DESIGN.md)） | **我们强**。它的 `command string + execFile('bash', …)` 模式正是 issue 里孤儿进程的温床 |
| **成熟度** | 2671 star / 263 open issue / v0.4.21 / 5 平台 / MIT | 未发布，48 条离线测试 | 它在"广度与曝光"上远超；我们在"判定与可审计"上更靠前 |

---

## 我们可以抄什么 / 不该抄什么

### MVP 现在就该抄

1. **把召回指标定义写死成 Hit@K 与 Recall@K 两个名字，并声明我们报的是哪个。**
   理由：memsearch 已经证明"命中"这个词在单/多正例下会分叉（Hit@5=1 而 Recall@5=1/3），并且它专门发布了两套定义做衔接（[reranking-evaluation.md](https://github.com/zilliztech/memsearch/blob/main/evaluation/reranking-evaluation.md)）。我们 README 现在只写"Top-3 命中"，**不可复现**（[我们的 README](../README.md)）。改法：在 README 的指标表里把"召回命中率"拆成 `Hit@3` 与 `Recall@3` 两行，并给出公式。

2. **`agent/pre-step` 的"仅在 step 1 检索 + 无命中零成本"模式，作为我们每步注入的降级路径。**
   理由：它的守卫写得很干净——`step !== 1` 直接放行、query < 3 字符放行、memory 目录为空放行、search 返回空放行（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)）。我们目前每步都重新求值并注入（[DESIGN.md](../docs/DESIGN.md)），**每步都在付 token**。建议：保留每步注入（我们按工作区、按类型，话题漂移时需要），但加一条"上一轮注入内容与当前 query 无关时不重复注入"的抑制规则，并把抑制次数记进台账。

3. **把"检索/记忆读取失败"作为一条显式台账事件。**
   理由：它有 `logger.warn('[memsearch] search failed: …')` 后继续（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)），但用户看不见；它的 issue 里大量问题是**静默失败**（#740 捕获永久失效无可见错误、#708 沙箱下回收静默失败）。我们已有 `kind:"hook-error"`，应该把 recall/search 路径的失败也记成同类事件，而不是只 warn。

4. **在文档里显式列出"已知局限"清单（自证式）。**
   理由：memsearch 的评测文档用 4 条 bullet 主动削弱自己的结论（标注非穷举、非 held-out、英文复用中文候选、Recall@10 三者相同），这是**可信度的来源**，也让别人无法用这些点攻击它。我们的 `docs/DESIGN.md` 已有雏形（Jev 线上未跑通），可以提成独立小节。

### 以后再说（现在抄会付不成比例的代价）

5. **Vector / hybrid / BM25 / RRF 检索。**
   理由：它的检索质量确实来自这套（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)），但硬依赖 `pymilvus` + `milvus-lite` + 558MB ONNX 模型（[pyproject.toml](https://github.com/zilliztech/memsearch/blob/main/pyproject.toml)），并且要跑一个 Python 工具链。我们当前记录量级（几十条类型化记忆）不需要它；**等"记忆条目数 > 数百且子串召回明显漏改写"再考虑**。届时按我们 `DESIGN.md` 已定的方向走 Jev 排序，而不是引向量库（[DESIGN.md](../docs/DESIGN.md)）。

6. **Markdown 作为主存储 + 派生索引。**
   理由：markdown 可读、可 diff、可 git 追踪是真实优势（[design-philosophy.md](https://github.com/zilliztech/memsearch/blob/main/docs/design-philosophy.md)），我们的 `memory.json` 做不到。但我们的**硬需求是"逐条可审计 + 可原子更新 + 召回计数递增"**，JSON 更直接；而且 `ledger.jsonl` 已经是只追加、可 diff 的形式。折中建议：以后加一个**只读导出** `memory.md`（从 `memory.json` 生成，不反向解析），拿到"人可读"的收益而不承担双向同步的 bug 面。

7. **L1/L2/L3 渐进披露。**
   理由：设计很好（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)），但它成立的前提是"记忆是对话片段、需要逐层下钻到 transcript"。我们的记忆是**一句结论**，没有下钻空间；我们已经有 `source.quote` + `source.sessionId/seq` 作为溯源，等价于"L2 直达原文"。**不抄。**

8. **把记忆蒸馏成 skill（procedural memory）。**
   理由：功能确实漂亮（[README](https://github.com/zilliztech/memsearch/blob/main/README.md)），但它需要"反复工作流挖掘 + 候选审查 + 安装"整条流水线，且我们 README 已明确把"从反复失败里长规则"划给 `dsh-jev-forge`（[我们的 README](../README.md)）。**职责冲突，不抄。**

9. **跨平台共享记忆（5 个 agent 共用一份记忆）。**
   理由：这是它的核心卖点也是它最大的复杂度来源（[architecture.md](https://github.com/zilliztech/memsearch/blob/main/docs/architecture.md)），但我们是 DSH 宿主插件，跨平台是另一个产品问题；而且它为此付出的代价写在 issue 里（#631 项目根解析不一致导致记忆分叉）。**不抄。**

### 明确不该抄

10. **无判定的全量落盘。**
    理由：作者自己把它当卖点（[comparison.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/comparison.md)），但它的 issue #523 就是这条设计的账单：append-only 流水账 → document rot → 用户要求 dreaming 式精炼（[issue #523](https://github.com/zilliztech/memsearch/issues/523)）。我们插件的全部价值在于"判定层"，抄这条等于自我否定。

11. **让 LLM 生成记忆正文。**
    理由：它的 #527 是这个模式的典型失败——限流错误字符串被当成摘要正文写进日记，**永久污染检索**（[issue #527](https://github.com/zilliztech/memsearch/issues/527)）。我们的"判定层没有可以写句子的字段"是结构性防御，比"在写入前加一个校验正则"更可靠（[DESIGN.md](../docs/DESIGN.md)）。

12. **命令字符串 + fork shell 的进程编排。**
    理由：它的 DSH 插件用 `execFile('bash', ['-c', command])` 拼命令并跑 `memsearch` CLI（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)），带来成堆的孤儿进程 issue（#600/#658/#692/#708）。我们进程内直调，天然没有这一整类问题。**不要为了复用它的检索能力而引入子进程。**

13. **MCP 工具面。**
    理由：它自己刻意不做 MCP，并在文档里论证"MCP 工具定义永久占用上下文，skill 不占"（[plugins/claude-code/README.md](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md)）。我们在 DSH 上已有原生 `ctx.tools.register`，比 MCP 更直接。**结论：不引入 MCP，方向一致。**

### 一个需要重新审视的既有决策

14. **我们"每步注入"是否应改成"仅 step 1 + 每步可查"。**
    理由：它实测下来选择只在 step 1 注入，并明确写"keeps routine turns lightweight"（[how-it-works.md](https://github.com/zilliztech/memsearch/blob/main/docs/platforms/dsh/how-it-works.md)）；而我们是每步注入、每次约 289–360 tokens（[我们的 README](../README.md)）。我们每步注入的正当理由是"话题漂移时也要想起约束"，但 memsearch 的反例说明**这个收益可能小于 token 成本**。建议：不立刻改，但**把注入 token 数按会话累计记进台账**，用一个真实长会话的数据来判断——这比现在拍脑袋决定更站得住。

---

## 未确认的点

- **它的 Jev reranking 在真实 DSH 会话里的端到端效果**：评测是离线固定候选池，仓库里**没有**"开了 Jev 之后 agent 表现提升"的任何数据。未找到。
- **`memsearch search` 是否在 DSH 插件路径上真的会走 Jev**：插件调用 CLI 时不传 `--reranker-model`（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)），所以是否用到 Jev **完全取决于 `~/.memsearch/config.toml` 的 `reranker.model`**。我确认了配置读取路径存在（[configuration.md](https://github.com/zilliztech/memsearch/blob/main/docs/home/configuration.md)），但**没有实机验证** DSH 插件 + Jev 的组合能跑通。未验证。
- **它的 top-k 与注入 token 的真实开销**：`SEARCH_TOP_K = 5`、`INJECT_SNIPPET_CHARS = 180` 是常数（[index.js](https://github.com/zilliztech/memsearch/blob/main/plugins/dsh/index.js)），但**注入块的实际 token 数没有公开数据**，只有我按 5×180 字符的估算 ≈ 900 字符 (推断)。
- **`263` 个 open issue 里有多少是重复/已修未关**：未逐一核对。抽样 41 条中 `hook` 类 11 条已能说明工程稳定性问题，但具体比例未知。
- **官方博客正文**：`blog.milvus.io` 抓取遇到重定向循环、TMCnet 新闻稿 403，**两者的原文我都没有读到**；本笔记对它们只做了"存在与时间线相符"的引用（见 §它是什么）。
- **中文 tokenizer 问题的实际影响面**：issue #102 描述 BM25 在中文上表现差（[issue #102](https://github.com/zilliztech/memsearch/issues/102)），但**没有官方修复状态或量化数据**。未找到。
- **它的 `compact` 与 skill 蒸馏是否真的在用户侧长期使用**：无遥测、无公开数据。未找到。
- **它的记忆是否会被写回 `AGENTS.md` / `CLAUDE.md`**：全仓库无此机制 (推断为"否")，但未找到作者对此的显式声明。
- **与我们插件的实际共存行为**：两者都往 DSH profile 的 cordis patch 层插行（它的 `plugins/dsh/cordis.patch.yml` vs 我们的 `cordis.patch.yml`），理论上可共存，但在同一 profile 同时启用会产生**双份注入 + 双份写入**。我**没有实机验证**共存时的行为，建议单独测一次。

---

### 引用文件清单（本次实际读取的一手来源）

- `README.md`、`CLAUDE.md`、`pyproject.toml`、`CONTRIBUTING.md`、`LICENSE`、`.claude-plugin/marketplace.json`
- `docs/architecture.md`、`docs/design-philosophy.md`、`docs/faq.md`、`docs/troubleshooting.md`、`docs/index.md`、`docs/cli.md`、`docs/getting-started.md`
- `docs/home/comparison.md`、`docs/home/configuration.md`
- `docs/platforms/dsh/{index,installation,how-it-works}.md`、`docs/platforms/claude-code/how-it-works.md`
- `evaluation/{README,reranking-evaluation}.md`、`evaluation/rerank_evaluate.py`、`evaluation/reranking-results.json`
- `src/memsearch/{core,store,reranker,jev_reranker,cli}.py`
- `plugins/dsh/{index.js,client.js,README.md}`、`plugins/dsh/skills/memory-recall/SKILL.md`、`plugins/dsh/prompts/summarize.txt`、`plugins/dsh/scripts/maintenance-runner.py`
- `plugins/claude-code/README.md`
- GitHub API：`repos/zilliztech/memsearch`、`/languages`、`/releases`、`/issues?state=open`
