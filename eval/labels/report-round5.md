# 评测报告：写入侧

生成时间 2026-10-01T18:28:34.247Z｜批次 round5.csv｜已标注 **147** 句（另有 0 行未标）

## 每批的语料快照

| 批次 | 生成时间 | 规则指纹 | 人类消息 | 日志代数 | 通过筛子的候选 | 被筛 |
|---|---|---|---|---|---|---|
| round5.csv | 2026-09-29 18:13 | `a2d52e64d11d` | 1440 | v0×8 v3×40 | 3050 | 4253 |

## 标注的构成

| 任务类 | 已定 1 | 已定 0 | 该记比例 | 拿不准 `?` |
|---|---|---|---|---|
| `coding` | 18 | 122 | 13% | 7 |
| **合计** | 18 | 122 | **13%** | 7 |

拿不准的 7 行占已标 5%——它们是标准本身有歧义的地方，**不参与任何阈值计算**。

## 三种判定的对照

| 判定 | 精确率 | 召回率 | F1 | TP | FP | FN | TN |
|---|---|---|---|---|---|---|---|
| 只过筛子（当前规则） | **19%** | 100% | 0.32 | 18 | 75 | 0 | 47 |
| 只过筛子（当时） | **16%** | 100% | 0.28 | 18 | 92 | 0 | 30 |
| 规则判定 | **26%** | 50% | 0.34 | 9 | 26 | 9 | 96 |
| Jev 判定 | **23%** | 17% | 0.19 | 3 | 10 | 15 | 112 |

- **只过筛子（当前规则）**：用当前工作区的筛子重跑同一个句子
- **只过筛子（当时）**：确定性筛子（密钥/任务指令/载荷/噪音/问句/转录）
- **规则判定**：离线判定：类型 ∈ {constraint, pitfall, decision} 且 分数 ≥ 0.6
- **Jev 判定**：模型判定：remember ≥ 0.6，每次最多 6 个候选，跑 3 次

**两次筛子判定不同的行：18**（当时放行、现在拒掉 18 行；当时拒掉、现在放行 0 行）。差异来自抽这批之后加的筛子，所以两行"只过筛子"指的是两个不同版本的插件。


> 这里的"召回率"是**写入侧召回**：在你标为该记的句子里，插件写了几条。它和 **Hit@K / Recall@K 无关**，后者需要标注过的查询，目前**没有数据、没有测量**。

## 按任务类拆开

| 任务类 | 已定行数 | 只过筛子（当前规则） | 只过筛子（当时） | 规则判定 | Jev 判定 |
|---|---|---|---|---|---|
| `coding` | 140 | 19% / 100% | 16% / 100% | 26% / 50% | 23% / 17% |

（每格是 **精确率 / 召回率**。编码类才是主指标：学习类是复习问答，办公类是文档工作。）

## 按分层拆开

| 分层 | 已定行数 | 批次 | 该记比例 |
|---|---|---|---|
| `coding-plain` | 55 | round5.csv | 13% |
| `coding-signal` | 36 | round5.csv | 25% |
| `question` | 19 | round5.csv | 11% |
| `vetoed` | 30 | round5.csv | 0% |

**筛子误杀（按当前规则）**：47 行会被筛子挡下，其中 0 行你标了"该记"（0%）。

## 不一致的条目（人 vs 判定）

### 只过筛子（当前规则）：75 行不一致

- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜如果第一个问题他确实是我想的那样，那么我又有个疑问：既然这样为什么不能在界面上继承多个agent让用户自己选具体要用哪个agent呢，如果把
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜所以加载时用 不要 探一句，切不开就自动退回 bigram 你觉得需要这个防线吗，我感觉不需要 别的记忆组件没有分词吗 接着做： P0-2（
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜简历:为 DSH 实现 HITL 分诊插件:人被打断次数 ↓N% 且漏问率不升(可 A/B),分诊一致率 X%(台账实测),fail-ope
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜你之前还说选一个场景呢： 方案 A：定位成 B2B API 产品客服（改动最小） 换掉 KnowledgeBase._load_defaul
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Confirm intended scope. - Run `git status -sb` and inspect the diff be
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜1. \item \textbf{可暂停续跑的人工确认（HITL）}：拿不准的输入会让处理\textbf{停在耗时阶段之前}等人确认，答复后
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜改成"一条消息 → 一串任务"
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜可暂停续跑的人工确认（HITL）：拿不准的术语会让处理\textbf{停在耗时阶段之前}等人确认，答复后只补跑剩余阶段（状态用 CAS 认领
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜实现按类型配额的分层召回注入，按硬约束、踩过的坑、已定决策分配名额，叠加长度预算与时间衰减加权排序 这句话能不能详细说说
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜现在整个流程基本能跑通，但是还存在几个小问题： 1.在我创建完汇率之后，显示创建成功，链上确实也能查到数据，但是前端界面这个汇率列表这块并不
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜而且它不是没看懂 —— 它把 8 条类型全判对了（constraint/decision），只是 remember 只给 0.07–0.28
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜把 remember 的提问改成"这条要求以后还适用吗"（针对祈使句） 你这里说的remember是啥意思
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Once the intent is clear, route to the specialist skill immediately an
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜还是会报错，依旧是只有前端报错
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜我实测过直接放宽会误杀你标 1 的 2 条真实要求，所以要按"出现疑问标记 且 没有任何类型信号命中"这个保守合取来改，并且先在 38 条标
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜这个是咋实现的，特别是这个cas 认领防重复 是啥意思，能不能说点人话 2.
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜上传完简历之后，需要刷新界面，对话那边才能选择最新的简历，不然显示不出来
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜很棒，问题修复了，但是现在能不能再加一个功能，在我点击如图所示，红框标记的交易ID时，能否使他跳转到如图所示的区块链浏览器中对应的记录
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜请修改 此外，在跨境支付管理的界面还是会报错
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜对话这边好像不能上传文件，拖动文件到会话框也不行
- …另有 55 行

### 只过筛子（当时）：92 行不一致

- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜如果第一个问题他确实是我想的那样，那么我又有个疑问：既然这样为什么不能在界面上继承多个agent让用户自己选具体要用哪个agent呢，如果把
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜所以加载时用 不要 探一句，切不开就自动退回 bigram 你觉得需要这个防线吗，我感觉不需要 别的记忆组件没有分词吗 接着做： P0-2（
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜简历:为 DSH 实现 HITL 分诊插件:人被打断次数 ↓N% 且漏问率不升(可 A/B),分诊一致率 X%(台账实测),fail-ope
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜你之前还说选一个场景呢： 方案 A：定位成 B2B API 产品客服（改动最小） 换掉 KnowledgeBase._load_defaul
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Confirm intended scope. - Run `git status -sb` and inspect the diff be
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜1. \item \textbf{可暂停续跑的人工确认（HITL）}：拿不准的输入会让处理\textbf{停在耗时阶段之前}等人确认，答复后
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜改成"一条消息 → 一串任务"
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜可暂停续跑的人工确认（HITL）：拿不准的术语会让处理\textbf{停在耗时阶段之前}等人确认，答复后只补跑剩余阶段（状态用 CAS 认领
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜实现按类型配额的分层召回注入，按硬约束、踩过的坑、已定决策分配名额，叠加长度预算与时间衰减加权排序 这句话能不能详细说说
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜现在整个流程基本能跑通，但是还存在几个小问题： 1.在我创建完汇率之后，显示创建成功，链上确实也能查到数据，但是前端界面这个汇率列表这块并不
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜而且它不是没看懂 —— 它把 8 条类型全判对了（constraint/decision），只是 remember 只给 0.07–0.28
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜把 remember 的提问改成"这条要求以后还适用吗"（针对祈使句） 你这里说的remember是啥意思
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Once the intent is clear, route to the specialist skill immediately an
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜还是会报错，依旧是只有前端报错
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜我实测过直接放宽会误杀你标 1 的 2 条真实要求，所以要按"出现疑问标记 且 没有任何类型信号命中"这个保守合取来改，并且先在 38 条标
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜这个是咋实现的，特别是这个cas 认领防重复 是啥意思，能不能说点人话 2.
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜上传完简历之后，需要刷新界面，对话那边才能选择最新的简历，不然显示不出来
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜很棒，问题修复了，但是现在能不能再加一个功能，在我点击如图所示，红框标记的交易ID时，能否使他跳转到如图所示的区块链浏览器中对应的记录
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜请修改 此外，在跨境支付管理的界面还是会报错
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜对话这边好像不能上传文件，拖动文件到会话框也不行
- …另有 72 行

### 规则判定：35 行不一致

- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜如果第一个问题他确实是我想的那样，那么我又有个疑问：既然这样为什么不能在界面上继承多个agent让用户自己选具体要用哪个agent呢，如果把
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜所以加载时用 不要 探一句，切不开就自动退回 bigram 你觉得需要这个防线吗，我感觉不需要 别的记忆组件没有分词吗 接着做： P0-2（
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜简历:为 DSH 实现 HITL 分诊插件:人被打断次数 ↓N% 且漏问率不升(可 A/B),分诊一致率 X%(台账实测),fail-ope
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜你之前还说选一个场景呢： 方案 A：定位成 B2B API 产品客服（改动最小） 换掉 KnowledgeBase._load_defaul
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Confirm intended scope. - Run `git status -sb` and inspect the diff be
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜1. \item \textbf{可暂停续跑的人工确认（HITL）}：拿不准的输入会让处理\textbf{停在耗时阶段之前}等人确认，答复后
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜改成"一条消息 → 一串任务"
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜可暂停续跑的人工确认（HITL）：拿不准的术语会让处理\textbf{停在耗时阶段之前}等人确认，答复后只补跑剩余阶段（状态用 CAS 认领
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜实现按类型配额的分层召回注入，按硬约束、踩过的坑、已定决策分配名额，叠加长度预算与时间衰减加权排序 这句话能不能详细说说
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜现在整个流程基本能跑通，但是还存在几个小问题： 1.在我创建完汇率之后，显示创建成功，链上确实也能查到数据，但是前端界面这个汇率列表这块并不
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜而且它不是没看懂 —— 它把 8 条类型全判对了（constraint/decision），只是 remember 只给 0.07–0.28
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜把 remember 的提问改成"这条要求以后还适用吗"（针对祈使句） 你这里说的remember是啥意思
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Once the intent is clear, route to the specialist skill immediately an
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜还是会报错，依旧是只有前端报错
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜我实测过直接放宽会误杀你标 1 的 2 条真实要求，所以要按"出现疑问标记 且 没有任何类型信号命中"这个保守合取来改，并且先在 38 条标
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜这个是咋实现的，特别是这个cas 认领防重复 是啥意思，能不能说点人话 2.
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜上传完简历之后，需要刷新界面，对话那边才能选择最新的简历，不然显示不出来
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜很棒，问题修复了，但是现在能不能再加一个功能，在我点击如图所示，红框标记的交易ID时，能否使他跳转到如图所示的区块链浏览器中对应的记录
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜请修改 此外，在跨境支付管理的界面还是会报错
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜对话这边好像不能上传文件，拖动文件到会话框也不行
- …另有 15 行

### Jev 判定：25 行不一致

- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜这个HITL还是不友好，你不能学一下你自己这个deepseek harness是怎么做的吗，选项里没有的在选项框里给用户自己填，不要一下子展
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜我觉得我需要明确一下，我们这个功能主推是对话，所以简历应该在对话栏这边可以选择哪个简历，然后应该也可以选择哪次的面试场次 需要注意的是，这个
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Confirm intended scope. - Run `git status -sb` and inspect the diff be
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜1. \item \textbf{可暂停续跑的人工确认（HITL）}：拿不准的输入会让处理\textbf{停在耗时阶段之前}等人确认，答复后
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜可暂停续跑的人工确认（HITL）：拿不准的术语会让处理\textbf{停在耗时阶段之前}等人确认，答复后只补跑剩余阶段（状态用 CAS 认领
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜这个对话我希望能够展示历史对话 现在不能
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜简历上原本这么写的应该可以优化吧，你觉得怎么写简历好点，请你一定要根据代码事实来，不要凭空捏造
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜git仓库链接也带上去，简历中不要带有memory.json 这种自定义的文件名称，不要出现这种“写入钩子带硬 deadline 且全程 f
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Once the intent is clear, route to the specialist skill immediately an
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜是一个风格和精简程度，并且尽量不要改原本的描述，除了“支持退款、支付异常、崩溃报错、转人工等业务细分类” 这个确实嗷改，新增的也要简洁
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜我觉得该用模型的地方就用模型吧，还有openviking还有什么memsearch插件把用户提示词转换成什么样子的，总不能和我们一样是原文处
- **漏记（该记没记）**｜`round5.csv` coding-signal/coding｜我们有这么多意图吗，待确认怎么也算意图呢，HITL不应该是模型思考过程中又拿不准的让用户决策然后再续跑
- **误记（不该记却记了）**｜`round5.csv` coding-signal/coding｜Summarize the result with branch name, commit, PR target, validation, 
- **误记（不该记却记了）**｜`round5.csv` coding-plain/coding｜存储相关的测试写到操作系统给的临时目录，测完删掉。
- **误记（不该记却记了）**｜`round5.csv` coding-plain/coding｜所以最终只上线了逐条测过、零误杀的四条（代码注释开头、行尾分号、代码关键字开头、markdown 结构开头），并把故意不加的两条写成测试钉住
- **漏记（该记没记）**｜`round5.csv` coding-plain/coding｜我觉得原文处理的话还是有弊端的，比如说用户打错字了，或者用户的表达很差等等情况，这些我觉得都可以看看别人是怎么实现的
- **误记（不该记却记了）**｜`round5.csv` coding-plain/coding｜它与 dsh-jev-tools 的分工是:那个管"内容进上下文之前"(裁剪/注入/技能/交付核对),这个管"从一堆东西里按意思找出来"。
- **漏记（该记没记）**｜`round5.csv` coding-plain/coding｜前端中有很多涉及到技术实现的提示描述，这个不合理，前端展示的应该是用户角度的，就比如什么“这是「越用越准」的机制 管线遇到无法判断的形态会放
- **误记（不该记却记了）**｜`round5.csv` coding-plain/coding｜设计\textbf{三层纠错漏斗}（词典规则 $\rightarrow$ 模型纠错 $\rightarrow$ 对抗复核 $\rightar
- **漏记（该记没记）**｜`round5.csv` coding-plain/coding｜@dsh-jev-memory/ 阅读一下这个项目，这个是dsh插件，由 @工作区长期记忆DSH插件 这个会话vibe出来的，所以具体实现我
- …另有 5 行

## 模型判定的稳定性

3 次重复：**4/147** 行的判定结果不一致，**100/147** 行的分数有波动。

这一次的每一跑：23%/17%、23%/17%、17%/11%（精确率/召回率）——**模型判定的数字必须带上这个区间读**。

所以 Jev 那一栏必须连同这个数字一起读：单次运行的精确率会随这些行上下浮动。

## 线上超时预算

75 次请求（每次 ≤6 个候选）：中位 602ms，最慢 922ms；其中 0 次超过线上 1800ms 的预算。

超过预算的请求在线上会降级为规则判定（台账记 `kind:"degraded"`），所以这条线决定了模型判定实际覆盖多少候选。

## 阈值扫描

| minRemember / minImportance | Jev 精确率 | Jev 召回率 | Jev 写入数 | 规则判定 精确率 | 规则判定 召回率 |
|---|---|---|---|---|---|
| 0.20 | 24% | 56% | 42/140 | 26% | 50% |
| 0.30 | 25% | 56% | 40/140 | 26% | 50% |
| 0.40 | 21% | 33% | 29/140 | 26% | 50% |
| 0.50 | 24% | 28% | 21/140 | 26% | 50% |
| 0.55 | 18% | 17% | 17/140 | 26% | 50% |
| 0.60 ← 线上 | 23% | 17% | 13/140 | 26% | 50% |
| 0.70 | 0% | 0% | 5/140 | 27% | 50% |

（阈值是配置，不是模型能力：同一批评分在低阈值下召回更高、精确率更低。这一次扫描有 140 行已定标注，其中**该记只有 18 句**——低阈值那几个点的召回率是由很小的分母撑起来的，所以看的是整条曲线的形状，不是单点。）

## 被漏记的句子，判定层怎么看

| 句子 | Jev `remember`（3 次区间） | 类型 | 规则判定分数 |
|---|---|---|---|
| 这个HITL还是不友好，你不能学一下你自己这个deepseek harness是怎么做的 | 0.49–0.52 | constraint | 0.85 |
| 我觉得我需要明确一下，我们这个功能主推是对话，所以简历应该在对话栏这边可以选择哪个简历， | 0.47–0.49 | decision | 0.80 |
| 这个对话我希望能够展示历史对话 现在不能 | 0.11–0.14 | constraint | 0.72 |
| 简历上原本这么写的应该可以优化吧，你觉得怎么写简历好点，请你一定要根据代码事实来，不要凭 | 0.30–0.32 | constraint | 0.76 |
| git仓库链接也带上去，简历中不要带有memory.json 这种自定义的文件名称，不要 | 0.45–0.51 | constraint | 0.90 |
| 是一个风格和精简程度，并且尽量不要改原本的描述，除了“支持退款、支付异常、崩溃报错、转人 | 0.36–0.39 | constraint | 0.78 |
| 我觉得该用模型的地方就用模型吧，还有openviking还有什么memsearch插件把 | 0.37–0.37 | constraint | 0.79 |
| 我们有这么多意图吗，待确认怎么也算意图呢，HITL不应该是模型思考过程中又拿不准的让用户 | 0.39–0.42 | constraint | 0.76 |
| 我觉得原文处理的话还是有弊端的，比如说用户打错字了，或者用户的表达很差等等情况，这些我觉 | 0.19–0.20 | fact | 0.42 |
| 前端中有很多涉及到技术实现的提示描述，这个不合理，前端展示的应该是用户角度的，就比如什么 | 0.51–0.56 | fact | 0.44 |
| @dsh-jev-memory/ 阅读一下这个项目，这个是dsh插件，由 @工作区长期记 | 0.26–0.26 | fact | 0.44 |
| 不局限于求职这个场景吧，你多参考参考 | 0.12–0.13 | fact | 0.37 |

## 方法与局限

- 分数来源：98 行来自 CSV 里记录的抽取器分数，49 行是按当前公式复算的（旧批次没有这一列）。
- 模型判定按每次 ≤6 个候选分批，与线上 `jev.maxCandidates` 一致；一次请求塞全部候选会绕过这个上限，测的是没人跑的配置。
- 线上判定超时 1800ms，本报告用 20s：先量准判定质量，超时覆盖率单独报。
- 句子是**插件当时看到的正文**（可能已按 240 字裁剪），判定臂读的就是它，所以三者输入一致。
- 分层抽样按配额，各层比例不等于语料比例；比较不同来源时要看上面的池子大小。
- 未测：**Hit@K / Recall@K**（需要标注查询）、多轮对话里的重复写入、以及记忆被读回后对回答质量的影响。

