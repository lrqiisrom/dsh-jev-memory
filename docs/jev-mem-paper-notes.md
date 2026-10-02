# 论文笔记：Jev-Mem — System-One-Controlled Agentic Memory

> Dongming Jiang, Yi Li, Bingzhe Li（UT Dallas）｜*Jev-Mem: System-One-Controlled Agentic Memory for Efficient AI Agents*｜PDF 16 页
> 全文正文提取于 `/tmp/jevmem.txt`（用 pypdf，本机没有 pdftotext）。
> 代码：https://github.com/libingzheren/Jev-Mem

## 先说结论：和我们是同一个想法

**它用的 Jev 就是我们用的那个 Jev。** 论文的核心抽象是一个"带类型的 System-One 控制器 `J(S,Q)`"，
`S` 是结构化状态、`Q` 是一批**显式的判定问题**；控制器"对独立命题输出概率，或对互斥选项输出分布"
（§3.1）。这正是 TypeSafe Jev 的 `noul`（命题概率）+ `choice`（选项分布）+ `score`。

它给出的理由和我们写进代码注释的理由逐字对应：

> "This interface is intentionally different from free-form LLM prompting. Each decision exposes
> a small, known output space, allowing Jev-Mem to represent memory control directly as
> probabilities rather than generating intermediate natural-language reasoning and subsequently
> parsing it."（§3.1）

> "many memory-control operations are **semantic but not generative**… Using an autoregressive
> LLM for such high-frequency decisions is therefore unnecessarily expensive: even simple
> judgments require token-by-token generation, formatting, and parsing. Because these operations
> repeatedly appear on the memory critical path, their overhead can accumulate quickly."（§2.2）

**我们的独立结论**：Jev "只能回答 noul/choice/score，输出不了文本"，所以规范化那一步它做不了、必须
走宿主 LLM；而"该不该记"这一步正好落在它的输出空间里。同一个判断，论文写成了体系结构。

**它还和我们撞了一个具体做法**：候选发现与关系判定分离——先用确定性检索（向量 + 词面 + 共享实体 +
时间邻近）取至多 `Kw` 个候选，**再**让控制器只看这些对（§3.2 式 8）。我们的 `rankPartners`
（BM25/embedding 取窗口 → 只对 ≤6 条问 Jev）是同一个模式。

## 三件它比我们做得好、而且正好打在我们的伤口上的事

### 1. 它不在写入时做"存还是丢"

> "Jev-Mem creates one canonical memory node for each valid observation… The current design
> **preserves observations rather than making an irreversible learned store-or-discard decision
> at ingestion time**. This prevents information that appears unimportant initially from being
> permanently lost before a future query reveals its relevance. Selectivity is instead
> introduced when memory structure is constructed and later when memory is retrieved."（§3.2）

**这和我们的写法是相反的。** 我们有一道硬闸门（筛子 + 判定阈值），在**摄入时**决定丢弃。代价是我们
自己量出来的：写入侧写对率 24%、该记覆盖率 50%；而**自动注入覆盖率只有 2/36（6%）**。
如果按它的设计，那 50% 漏掉的句子不会丢，只是排在后面——读取侧还有机会。

这不代表它对：它的假设是"检索能选出好的"，而我们的读取侧刚测出来**自动注入根本不看查询**。
两件事凑一起才是它那个设计的成立条件：**延迟选择 + 读取侧真的会选**。我们缺的是后半句。

### 2. 检索是闭环控制，不是一次 top-k

它的读取路径（§3.3）：

- 控制器先预测**每个关系视图**对当前查询的相关度 `p_g(q)`，`p_g(q) ≥ θ_act` 的视图同时激活（多视图，
  不是单选一个意图）；
- 给定总图扩展预算 `B`，按 `w_g ∝ p_g^γ` 分配到各激活视图（式 13–14）；
- 多跳需求 `h(q)` 决定遍历深度 `D(q)`（式 15）；
- **锚点检索**：向量与词面两路排名用 **RRF（κ=60）** 融合（式 16）；
- **证据引导的扩展**：每一轮用控制器估 `s_d`（证据是否充分）、`u_d`（继续检索的期望收益）、
  `m_d`（缺哪些必需证据）、`c_d`（未解决的矛盾），满足
  `s_d ≥ θ_suff ∧ m_d < θ_cont ∧ c_d < θ_cont` 就停（式 21），或 `u_d < θ_cont` 也停（式 22）；
- 候选打分 = 嵌入相似度 + 查询相关度 + 视图相关度 + 新颖度 + 证据支持度 的加权和（式 23），
  时间戳可用时再叠一个查询相关的时效预测。

**对照我们**：自动注入按"重要度 ×0.85 + 时间衰减 ×0.15"+ 固定类型配额（硬约束 4 / 坑 3 / 决策 2）
挑 9 条，**完全不看查询**。它这套里的"路由 + 预算 + 停止条件"正是我们 6% 那个数字缺的东西。

顺带修正一条我自己的结论：我在读取侧报告里测出 **RRF 融合（0.83）不如纯 embedding（0.90）**，
所以没有采纳 RRF。论文用的是 RRF——但**它把 RRF 当召回阶段的锚点，后面还有控制器逐候选重排**。
我们把 RRF 当**最终**排序，测的其实是另一件事。这两个结论不冲突，是我的实验设计少了一层。

### 3. 多关系图 + 多标签类型

- 类型是**四个重叠的分数** `t(v) = (episodic, semantic, procedural, preference)`，"标注节点而不是
  归到单一互斥类别"（§3.2）。我们是单标签（constraint / pitfall / decision / fact）。
- 关系包括语义相关、**有向因果**、同情节、实体等价，以及时序（`before/after/during/contains`）。
  我们是扁平存储 + 一个 `supersedes` 链。
- 能用结构化信息就直接用，不做无谓的模型推断：时间戳顺序直接建时序边，共享标识符直接建实体边
  （§3.2）——这条和我们"确定性优先"的纪律一致。

## 评估：两边量的根本不是一回事

| | Jev-Mem | 我们 |
|---|---|---|
| 数据 | LoCoMo（超长多会话对话） | 你自己标的 round5（147 行）+ 36 个探针 |
| 指标 | LLM-as-a-Judge **端到端答案分** | 写入侧写对率/覆盖率/AUC；读取侧 Hit@K/MRR |
| 数字 | 总分 **0.777**，比最强基线相对 +11.0%；构建 **158s**（比最快基线 6.6× 加速）；查询延迟 **0.93s**（−36.7%） | Jev 写对率 24~26%、该记覆盖率 50%、AUC 0.75；检索 MRR 0.71（BM25）/0.90（embedding） |
| 基线 | Full Context、A-MEM、Nemori、MemoryOS、MAGMA | 旧子串匹配、纯 BM25、embedding、RRF |
| 没报的东西 | **完全没有报写入判定的精确率/召回率** | 报的就是这个 |

**它证明"少用 LLM 更快"（6.6×），我们证明"判定本身判得准不准"（AUC/逐条对错）。**
两件事都需要，但它们不能互相替代：它的 0.777 是答案层面的分数，里面混着答案模型的能力；
我们的 AUC 0.75 是判定层面的，但只覆盖编码类、而且是单相关口径。

一个直接可用的推论：**它的评测方式我们也能做，而且补上它缺的那一半。** LoCoMo 是公开数据集，
但我们的语料是你自己的会话——只要加上"端到端"这一层（写入 → 召回 → 能不能答对），
我们就能同时报"判定准不准"和"最终答得对不对"。

## 可以直接拿来用的三条

1. **把"丢弃"改成"降权"**（它最核心的一条）。写入侧不再是一道二元闸门，而是给每条一个可注入的
   分数/层级；读取侧再按查询和预算选。前提是先做第 2 条，否则等于把噪音原样注入。
2. **读取侧加上查询路由 + 预算 + 停止条件**。我们已有 Jev 通道和 BM25/embedding 两路召回，
   缺的是"这次要花多少预算、够了没有"这几个判定——而这些恰好都是 `noul` 能回答的。
3. **候选融合用 RRF，最终排序不要用 RRF**。锚点阶段融合两路召回（它就是这么做的），
   然后逐候选用控制器重排（我们还没做这一步）。

## 我们的做法里它没有的东西

- **人工标注的判定级基准**（147 行 + 逐条理由），以及**阈值无关的判定质量指标**（AUC）。
  这让我们能说出"问法改一个字，AUC 0.67 → 0.75、交叉验证 F1 0.21 → 0.32"，
  以及"学习类 AUC 0.31，可能是工程语域"——论文里没有对应的能力。
- **发现自己的判定不如一个免模型的规则**：我们用 Jev 的 `remember ≥ 0.6` 时覆盖率只有 11%，
  离线规则判定是 50%。论文通篇没有报这个数。
- **成本可见**：每次判定的延迟、降级、token 都进台账（我们的 `degraded`/`tokens` 字段）。
