# dsh-jev-memory

DSH 的长期记忆插件。回合结束时从最近几轮对话里挑出值得长期保留的内容，按工作区存下来，之后需要的时候自动注入上下文。

DSH 自带会话持久化、会话检索和上下文压缩，但没有跨会话的长期记忆：没有官方包回答"什么值得记住"和"这一轮该想起哪几条"。这个插件补的就是这一层判断。

## 安装

两种方式任选一种。

**开发期直接挂工作区。** 在 profile 的用户 patch 层（`~/.dsh/profiles/web/cordis.patch.yml`）加一行：

```yaml
- insert:
    - id: jev-memory
      name: 'file:///absolute/path/to/dsh-jev-memory/dsh/index.ts'
```

行名由加载器按 URL 解析，所以 `file:` URL 和裸包名都可以。删掉这一行即完全卸载。

**作为包安装：**

```sh
dsh plugin --profile web add /absolute/path/to/dsh-jev-memory
# 再把包名加进 profile package.json 的 dsh.profile.bundles
```

包根自带 `cordis.patch.yml`，`dsh.bundle.patch` 指向它。

## 配置

```yaml
- insert:
    - id: jev-memory
      name: 'file:///absolute/path/to/dsh-jev-memory/dsh/index.ts'
      config:
        types: [constraint, pitfall, decision]
        judge: auto
        minRemember: 0.12
        conversationWindow:
          rounds: 3
          answerChars: 200
          recentAnswerChars: 1500
        recall:
          maxTokens: 600
          queryMessages: 3
          quota: { constraint: 4, pitfall: 3, decision: 2 }
        jev:
          apiKeyEnv: TYPESAFE_API_KEY
```

常用的几项：

| 选项 | 默认 | 含义 |
|---|---|---|
| `judge` | `auto` | `auto` 在配了 Jev key 时用判定模型，否则退回本地启发式；也可固定成 `jev` / `heuristic` / `off` |
| `writeMode` | `model` | `model` 是一次调用读完整个窗口再判；`pipeline` 是另一套独立方案（分段、抽取、判定、闸门），用于复现旧基线，不是降级路径 |
| `types` | 三类 | 写入白名单，只收 `constraint` / `pitfall` / `decision` |
| `minRemember` | `0.12` | 判定模型"值得记吗"的概率阈值，低于它不写 |
| `minImportance` | `0.6` | 确定性闸门用的阈值，与上一项是两个不同的问题 |
| `conversationWindow.rounds` | `3` | 模型读最近几轮。一轮指一条用户消息加它得到的最终回答 |
| `conversationWindow.answerChars` | `200` | 较早轮次里回答的截断长度；用户的话从不截断 |
| `conversationWindow.recentAnswerChars` | `1500` | 最近一条回答的截断长度。放宽是因为人经常引用刚读到的那段 |
| `askOnConflict` | `true` | 两条记忆像是同一件事时问用户一句 |
| `askOnConflictTimeoutMs` | `0` | `0` 表示不设截止，与 DSH 自己的提问通道一致 |
| `writeSkipSubagents` | `true` | 子会话里的"用户消息"其实是父代理的指令，不参与学习 |
| `repeatFailuresToWrite` | `2` | 同一个工具错误重复几次才算"坑" |
| `writeTimeoutMs` | `12000` | 回合收尾的写入预算 |
| `recall.relevanceWeight` | `0.8` | 注入排序里相关度与重要度的配比 |

**密钥放哪：** 按序解析 ① 宿主凭据服务里的 `apiKeyEnv` 引用（存在 `~/.dsh/.credentials.yaml`）→ ② 直接读同一个凭据文档（服务开机那一瞬可能还没就绪）→ ③ 配置里的 `apiKey` 或进程环境变量。解析发生在每次判定时而不是挂载时，所以运行中换 key 下一轮就生效。台账的 `start` 行会写明实际走了哪条路径。没有 key 时插件不需要网络也能工作。

## 工作方式

### 写入

挂在 `agent/turn-stopping`（回合收尾前，串行并等待）。做一次模型调用：读最近几轮对话，对每条候选回答四件事，这话是谁说的、值不值得长期记住、属于哪一类、以及一句第三人称总结加它所依据的原话片段。存下来的是那句总结，原话片段作为出处一并保留。

写入前按顺序过这几道：

1. **防抄**：原话片段如果基本是助手自己早先说过的内容，不进库。判据是词元重合，读本地存档，不额外调用模型。
2. **密钥与载荷**：命中特征的一律不进库。
3. **类型白名单**：只收配置里列出的类型。
4. **总结漂移检查**：总结里用到的标识符和数字必须出现在它引用的原话里，否则拒收。这条拦的是模型把"集成"写成"继承"那类改写。
5. **概率阈值**：判定模型给出的"值得记"概率低于 `minRemember` 就不写。
6. **冲突配对**：和这个工作区已有的条目比对，见下一节。

模型调用失败或返回无法解析时，这一轮不写记忆，台账记下失败原因。不会悄悄换成另一套抽取逻辑。

### 判定

判定层只产出标签和概率，不生成任何文本。首选是 Jev（TypeSafe 的判定模型），没有 key、超时或解析失败时退回本地启发式。确定性闸门读的是本地类型与分数，不把判定模型在一个问题上调好的概率阈值搬到另一个问题上用。

### 召回

每步把当前工作区的 Top-K 注入系统提示的运行时上下文，带类型、日期和 id 标签。排序是本地全文打分（BM25）加标识符精确命中加成，重要度只用于打破同分，另有按类型的名额配额和 token 预算。查询用最近几条用户消息，这样"刚才在说什么"会参与排序。

如果 preset 关掉了运行时上下文注入，插件改走一条带插件来源的消息投递，并在台账标记，避免出现完全不注入却不留痕迹的情况。

### 两条记忆像是同一件事时

一条新记忆和库里某条可能是同一件事，机器不自己拍板：

1. 判定模型给出关系概率（同一条规矩的新说法 / 完全同义 / 不同的规矩）；
2. 只有出现动作分歧时才问人。概率既有一部分落在"不同的规矩"，又有相当一部分落在"同一条的新说法"，落在哪边都会做出不同的动作；
3. 触发时这条先以"待确认"落盘，既不注入也不丢弃，然后在回合结束时弹一张卡片，一条问题、三个选项；
4. 用户的选择决定结果。没人应答就保持"待确认"，宁可少记一条也不猜；
5. 卡片上两边的话逐字引用并带日期，内部 id 不上卡片。

这道通道复用 DSH 原有的提问机制，不新增 UI、不新增权限模型。

### 存储与审计

本地 `memory.json` 加只追加的 `ledger.jsonl`，原子写，内存索引（注入回调必须同步）。每条记忆带来源会话、序号、原话片段、命中的信号和判定依据，所以任何一条误记都能回溯到它从哪句话、哪一轮来的。台账还记录每次跳过、每次询问和用户的答复。

## 指标

每条记忆都带来源，所以指标可以从台账和标注复算，不是估计。在人工标注的真实会话语料上（编码类会话），写入的误记率 22%、漏记率 3%。标注口径、报表脚本与复现方式在 `eval/` 下。

## 测试

```sh
node --test test/*.test.ts      # 全离线，不联网、不启动 harness
pnpm run typecheck              # tsc --noEmit
```

其中包含一条端到端闭环：用假宿主驱动真实代码，走完写入、下一会话召回、`memory_search`、`memory_forget`。




## 目录

```
dsh/index.ts            插件入口：钩子、注入点、三个工具与配置
dsh/lib/window.ts       回合窗口：几轮、每轮回答留多长、按什么顺序读
dsh/lib/modelwrite.ts   写入调用：提示词、解析、总结漂移检查
dsh/lib/segment.ts      分段调用（pipeline 模式用）
dsh/lib/extract.ts      从回合事件里抽候选（pipeline 模式用）
dsh/lib/signals.ts      确定性信号词表与候选筛查
dsh/lib/judge.ts        判定端口（Jev / 启发式）与确定性闸门
dsh/lib/jev.ts          Jev HTTP 客户端：凭据解析、重试、超时
dsh/lib/echo.ts         防抄检查：这段话是不是助手自己早先说过的
dsh/lib/conflict.ts     冲突配对、三选项卡片、答案映射
dsh/lib/recall.ts       选哪些记忆、怎么渲染注入
dsh/lib/embedding.ts    可选的向量检索路径（默认关闭）
dsh/lib/store.ts        memory.json + ledger.jsonl
dsh/lib/credentials.ts  直读凭据文档的兜底路径
dsh/lib/text.ts         文本工具：分句、估算 token、哈希
test/                   离线测试，plugin.test.ts 用假宿主驱动完整闭环
eval/                   评测脚本：写入口径、判定对照、读取侧基线、提示词打印
```


