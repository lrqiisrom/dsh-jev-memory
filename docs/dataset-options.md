# 公开长期记忆评测基准调研：哪些能用、怎么用、多少钱

调研日期 2026-09-29。目的：为 `dsh-jev-memory`（编码 agent 的类型化长期记忆）找**能真正接上**的公开评测资产。

**方法**：起点是 [XiaomingX/awesome-ai-memory 的基准清单](https://github.com/XiaomingX/awesome-ai-memory/blob/main/docs/memory-evaluation-benchmarks.md)（Apache-2.0，最后更新 2026-09-20，本次 `git clone` 核验），再对**每个**候选回到一手来源（论文 / ACL Anthology / ICML 会场页 / 官方仓库 / 数据集卡）核对：一手能 clone 的一律 clone 到 `/tmp` 实看目录、`LICENSE`、数据文件大小、评测脚本里的 judge 与解析逻辑（看完已清理）。**凡是搜索摘要或综述转述的内容都标为二手**；查不到的写"未找到"，不用常识补。

**证据等级标记**：本机 `huggingface.co` 直连不可达，HF 数据集卡（许可 / 语言 / 是否 gated / 文件大小）由子任务经 hf-mirror 镜像或代理读取，下文凡此类一律注明「HF 经镜像/代理核验」。其余（arXiv、ACL Anthology、GitHub clone、GitHub API、官方 PDF）均为本机直连一手核验。

---

## 结论摘要

1. **公开数据里没有任何一个用中文写的编码 agent 记忆基准，也没有一个中文的端到端 QA 式长期记忆基准。** 确认含中文的只有：PerLTQA（唯一有论文的专门中文长期记忆数据集）、CloneMem（中英双语，但场景是非对话数字痕迹）、Mem-PAL（中文原始，user–agent 个性化）、MemoryBench 中文法律子集、CUE-Mem（论文未发布）、locomo-zh-500（只有中文查询、非 QA）、touchstone（个人社区 repo）；其余主流基准全部 `language: en`。
2. **最该用的是 Memora**：唯一公开逐轮 `share_memory` 标注的语料，正好补我们缺的两个洞——「该不该记」的公开标注，和「闲聊不该记」的非编码语料；Apache-2.0，数据随仓库分发，标签可逐条导出，不跑评测也能用。
3. **要报一个能对标竞品的召回数字，用 LongMemEval（V1，oracle 档）**：MIT，500 题带 query + gold answer + evidence turn，官方 judge prompt 可逐字照抄，oracle 档约 $30–70。
4. **HaluMem 的三段拆解（抽取 / 更新 / 问答）可以照搬成我们的报表结构**，它的 gold memory point 与 FMR（假记忆抵抗率）是公开数据里离我们「写入精确率」最近的东西；但它**CC BY-NC-ND 4.0（禁商用 + 禁演绎）**，当指标定义参照可以，做子集改造/再分发不行。
5. **明确别碰 Memoria-Bench / MemoryArena / BEAM**：前两个拿不到或没有许可证，BEAM 的 10M 档按 token 算要 $25k+ 且与 LongMemEval 信号重复。
6. **LoCoMo 不要当主指标**：CC BY-NC 4.0、论文口径 7,512 题 vs 公开文件 1,986 题、adversarial 类没有 gold answer、类别映射有两套互斥定义，坑太密（见卫生清单）。
7. 我们真正的缺口**没有任何公开数据能补**：中文编码会话、带类型的坑/约定、以及「记住之后有没有用上」的反事实证据——这三样只能自己标（见末节）。

---

## 候选清单

> 「用途」列对应任务的四项：**a** = 当非编码对话语料；**b** = 能否导出「该记/不该记」标注；**c** = 能否给出召回指标（query + 正解）；**d** = 是否覆盖代码/agent 经验。
> 语言列中「中文」指**数据本身**有中文会话，不是作者是中国人。

| 基准 | 年份/会议 | 规模 | 语言 | 测什么 | 标注来源 | 能否拿到 | 复现成本 | 用途 a/b/c/d |
|---|---|---|---|---|---|---|---|---|
| **LoCoMo** | [ACL 2024 / arXiv 2402.17753](https://arxiv.org/abs/2402.17753) | 公开文件 10 段对话 / 1,986 QA（论文口径 7,512 QA，50 段）【实测计数】 | 纯英文（[`locomo10.json`](https://github.com/snap-research/locomo/blob/main/data/locomo10.json) 全文件 CJK 字符 = 0） | 端到端 QA + 事件摘要 + 多模态对话生成 | 人工编写 + 每题的 `evidence` dialog id（1,982/1,986 有） | [repo](https://github.com/snap-research/locomo) 有；`LICENSE.txt` = **CC BY-NC 4.0**（禁商用） | 官方脚本是 **F1/BLEU/ROUGE/BERTScore 字符串指标**，非 LLM judge；约 $100–250（估算） | a 中（闲聊比例不明）/ b **好**（evidence turn = 该记内容，但我们实测只有 24.4% 的轮次被标）/ c 好 / d 无 |
| **LongMemEval V1** | [ICLR 2025 / arXiv 2410.10813](https://arxiv.org/abs/2410.10813) | 500 题；oracle 15.4MB / S 277MB / M 2.7GB【实测】；历史 115k–1.5M token | 英文（合成） | 信息抽取、多会话推理、时序推理、**知识更新**、**拒答** | 合成 + LLM judge（[gpt-4o 5 套模板](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py#L24-L43)） | [repo](https://github.com/xiaowu0162/LongMemEval)（**MIT**，不含数据）；数据 [HF `longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)（HF 经镜像核验） | oracle $30–70，S $400–900，M $2k–6k+（估算）；**有脚本无结果文件** | a 中 / b 部分（更新+拒答题）/ **c 好** / d 低 |
| **LongMemEval-V2** | [arXiv 2605.12493](https://arxiv.org/abs/2605.12493)（工作论文，CC BY 4.0） | 451 题（全人工）+ 1,870 条轨迹；Small 100 条/25.6M token，Medium ~498 条/114.8M token | 英文（HF 卡 `language: en`，HF 经镜像核验） | **环境经验**：静态状态、动态状态、**workflow 知识**、**environment gotchas**、**premise awareness** | 人工 curation；结构化答案确定性打分，gotchas/拒答走 GPT-5.2 judge | [项目页](https://xiaowu0162.github.io/longmemeval-v2/)、[repo](https://github.com/xiaowu0162/LongMemEval-V2)、[HF 数据](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2)（apache-2.0，未 gated） | 需 A100 起 Qwen3.5-9B reader + Codex 基线；**有脚本无结果**；GPU 小时级 + 数十美元（估算） | a 无 / b 弱 / c 有（context gathering）/ **d 概念最接近** |
| **MemoryAgentBench** | [ICLR 2026 / arXiv 2507.05257](https://arxiv.org/abs/2507.05257) | 2,071 题；上下文 103K–1.44M token；数据 4 个 parquet 共 ~76.6MB【实测】 | 英文（HF 卡 `language: en`） | 四能力：精确检索 / 测试时学习 / 长程理解 / **冲突解决**（论文写 Selective Forgetting，见卫生清单） | 重组已有数据集 + 自建 EventQA / FactConsolidation；judge 逐字复用 LongMemEval 的 prompt | [repo](https://github.com/HUST-AI-HYZ/MemoryAgentBench) **MIT**；[HF 数据](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench)（MIT，自动下载） | 依赖重（hipporag 要求 `openai==1.58.1`）；$300–800/系统（估算）；**有脚本无结果** | a 无 / b 中（`has_answer` 标记）/ c 好 / d 无 |
| **MemoryArena** | [ICML 2026 / arXiv 2602.16313](https://arxiv.org/abs/2602.16313)｜[ICML 页](https://icml.cc/virtual/2026/poster/64842) | 701 组任务、平均 6.9 个相互依赖子任务、57 步、>40k token/轨迹（论文口径；LongMemEval-V2 转述为 766 题，见卫生清单） | 英文 | **memory-driven action**：多会话 Memory-Agent-Environment 闭环 | 人工构造任务与子任务答案 | [repo](https://github.com/ZexueHe/MemoryArena) **根目录无 LICENSE**；数据 [HF](https://huggingface.co/datasets/ZexueHe/memoryarena)（CC-BY-4.0，HF 经镜像核验）；子模块 `MemActBench` **clone 失败（需鉴权，不可得）** | 需 4 套环境服务 + 6 类 API key；README 自述 "preview version"；**有脚本无结果**；成本无法可靠估算 | a 无 / b 无 / c 弱 / d 中（工具选择） |
| **Memoria-Bench** | [ICML 2026 PDF](https://palm.seu.edu.cn/zhangml/files/ICML%2726a.pdf)（**无 arXiv 版本**） | Pro 58,164 轨迹 / 58,422 QA / 492M 字符；Code 域 12,044 轨迹 / 4,405 QA / 45M 字符；Flash 为轻量版 | 论文 Table 1 自述 ZH✔EN✔，但**全文抽不出一个 CJK 字符，且数据不可得**（无法核验） | 三类 anti-summarization QA：时序聚合 / 多跳 / 长程状态跟踪；episodic·semantic·procedural 只是**分析标签**，不是任务族 | LLM + 规则双验证取一致；含 evidence spans；judge = LLM 判 YES/NO | **代码链接 `github.com/zjxx/Memoria` 实测 HTTP 404**；未找到数据集入口；未找到 LICENSE | **数据拿不到 → 无法复现** | a 无 / b 无 / c 弱 / d **形似神不似**（见下） |
| **AMA-Bench** | [ICML 2026 / arXiv 2602.22769](https://arxiv.org/abs/2602.22769) | 2,496 QA（真实子集），平均 57K token/episode，**单轨迹** | 英文 | recall / 因果推理 / 状态更新 / 状态抽象 | 研究生级专家标注 + 合成集规则生成 + needle QA 绑 turn id；judge = Qwen3-32B，人机一致 92.67% | [repo](https://github.com/AMA-Bench/AMA-Bench) **MIT**；[HF](https://huggingface.co/datasets/AMA-bench/AMA-bench)（MIT，`open_end_qa_set.jsonl` ~50MB）；**未 gated** | 需 vLLM GPU 或 API；**有脚本无结果**（日志在 Google Drive）；数十美元级（估算） | a 无 / b 无 / c 中 / d 中（支持 `--method codex`/`claude_code`） |
| **HaluMem** | [EMNLP 2026 Main / arXiv 2511.03506](https://arxiv.org/abs/2511.03506) | Medium：20 用户 / 30,073 轮 / ~160k token / **14,948 memory point** / 3,467 QA；Long：53,516 轮 / ~1M token（HF 文件 33.5MB + 106.5MB，HF 经代理核验） | 英文（HF 卡 `language: en`） | **操作级**：记忆抽取 / 记忆更新 / 记忆问答 三段解耦 | 六阶段 LLM 流水线自动生成 gold memory point + 更新对 + 带 evidence 的 QA；8 名标注员复核 >50% | [repo](https://github.com/MemTensor/HaluMem)（`LICENSE.txt` = **CC BY-NC-ND 4.0**，禁商用**禁演绎**）；[HF](https://huggingface.co/datasets/IAAR-Shanghai/HaluMem) | 6 个现成系统适配器；$200–500/数据集/系统（估算）；**有脚本无结果** | a 无 / **b 好**（gold memory set + distractor）/ c 中 / d 无 |
| **Mem-Gallery** | [ACL 2026](https://aclanthology.org/2026.acl-long.1892/) | 240 sessions / 3,962 rounds / 1,003 图；1,711 QA（每个带 evidence clues） | 未见中文 | 多模态长程记忆：抽取与测试时适应 / 推理 / 知识管理 | 人工 + LLM 生成；LLM judge 0–1 五档 | [repo](https://github.com/YuanchenBei/Mem-Gallery) MIT；数据 HF `Ethan-Bei/Mem-Gallery`（许可未验证；HF 不可达） | 需 MLLM 权重 + GME 编码器 + vLLM；**有脚本无结果** | a 无 / b 弱 / c 中 / d 无 |
| **Mem2ActBench** | [ACL 2026](https://aclanthology.org/2026.acl-long.370/) | 2,029 session / 6.57M token；**400** 个 tool-use 任务 | 数据源全英文（实测 2,029 session 仅 190 轮含 CJK，0.7%，OASST1 多语残留） | **记忆驱动行动**：工具选择 + 参数落地 | 反向生成 + 人工验证；**无 LLM judge**（参数级 F1 / BLEU-1 / Tool Accuracy） | [repo](https://github.com/Cantaloupe-M/Mem2ActBench)（**无 LICENSE 文件**，仅 README 写 MIT）数据在 repo 内 | 只需 OpenAI 兼容 API；但**缺评测 harness**；**有脚本无结果** | a 无 / b 无 / c 中 / **d 好**（工具调用，但领域是通用 API 非代码） |
| **EverMemBench** | [arXiv 2602.01313](https://arxiv.org/abs/2602.01313)（CC BY 4.0） | 5 批 × ~1M token；2,400 QA；均 10,204 轮/批 | 仓库零 CJK（全英文 prompt） | 多方职场对话：细粒度召回 / 记忆意识（constraint·proactivity·update）/ 用户画像 | LLM judge（`prompts.yaml` 明确 "be generous"、±1 天可接受） | [repo](https://github.com/EverMind-AI/EverMemBench)（**无 LICENSE 文件、无任何许可声明**）；数据 HF `EverMind-AI/EverMemBench-Dynamic`（未验证） | 需 OpenRouter + 5 个第三方记忆系统账号（部分付费）；**有脚本无结果** | a 中（职场闲聊）/ b 弱 / c 中 / d 无 |
| **Memora** | [ACL 2026 Findings / arXiv 2604.20006](https://arxiv.org/abs/2604.20006) | 10 persona × 3 时间尺度；weekly 163 / monthly 628 / quarterly 1,974 sessions【实测】；600 题，6,415 条子判据【实测】 | **英文** | 记住 / 推理 / 推荐 三类任务，**并显式惩罚使用过期记忆** | 模拟器生成的 memory trace 直接产题；5% 人工抽检；三模型多数投票 judge（88.3% 与人工一致，κ 0.86–0.90） | [repo](https://github.com/geniesinc/Memora) **Apache-2.0，数据随仓库分发（156MB / 27,644 个 json）** | Track1 单模型 $150–250；6 agent 全扫 $1k+（估算）；**有脚本无结果文件** | **a 好 / b 最好 / c 好** / d 弱（有 software_engineer persona 但非编码任务） |
| **MemoryBench**（清华 THUIR） | [arXiv 2510.17281](https://arxiv.org/abs/2510.17281) | 11 个公开数据集 → 28 配置，约 20k cases | **含中文**（`src/dataset/JuDGE.py` 中文判决书 prompt、`bert-base-chinese`；LexEval 等中文法律数据） | 记忆 + **持续学习**（从显式/隐式用户反馈学习） | 各数据集原生指标；多指标用 LLM-as-judge 归并 | [repo](https://github.com/THUIR/MemoryBench) **MIT**；数据 HF `THUIR/MemoryBench`（未验证） | 需 vLLM + 用户模拟器；**✅ 有结果文件**（`configs/final_evaluate_summary_wo_details.json` + HF `MemoryBench-Results`） | a 中 / b 中 / c 中 / d 弱 |
| **BEAM** | [arXiv 2510.27246](https://arxiv.org/abs/2510.27246) | 100 conversations / **2,000 题**；128K–10M 四档；`chats/` 实测 3.4GB | 英文（抽样 CJK = 0） | 10 类记忆能力（拒答 / 矛盾消解 / 事件排序 / 指令遵循 / 知识更新 …） | 每题带 `rubric` + `ideal_response`；LLM judge 0/0.5/1.0 nugget | [repo](https://github.com/mohammadtavakoli78/BEAM)（代码 MIT，**数据 CC BY-SA 4.0**，两者不一致）；[HF](https://huggingface.co/datasets/Mohammadta/BEAM) | ≤1M 档 $80–250；**10M 档 $25k+（不可行）**（估算）；**有脚本无结果** | a 中 / b 中（rubric）/ c 好 / d 无 |
| **PersonaMem** | [COLM 2025 / arXiv 2504.14225](https://arxiv.org/abs/2504.14225) | 180+ 画像 × ≤60 sessions；32k 589 题 / 128k 2,727 题 / 1M 2,674 题【实测】 | 英文（字段名即 "Total English letters"） | 画像内化 / 偏好演化跟踪 / 个性化回复（多选） | 人工标注（repo 内含 `qa_annotation/` 标注产物） | [repo](https://github.com/bowen-upenn/PersonaMem) **MIT**；数据 HF `bowen-upenn/PersonaMem`（现解析为 `-v1`，MIT） | **无 LLM judge**（选项精确匹配）；32k $19 / 128k $440（估算）；**有脚本无结果** | a 中 / b 中 / c 好 / d 无 |
| **MSC（Multi-Session Chat）** | [arXiv 2107.07567](https://arxiv.org/abs/2107.07567) | 5 会话 × ≤14 utterances；session1 8,939 episodes | 英文（论文明示） | 长期开放域对话（下一句生成 / 摘要回忆） | **无 QA、无 evidence span**；只有 crowdworker 的 persona summary | ParlAI 代码 MIT；数据 [msc_v0.1.tar.gz](https://parl.ai/downloads/msc/msc_v0.1.tar.gz) 实测 HTTP 200 / 51,116,516 B（**数据本身无独立许可声明**） | 成本低（`parlai display_data -t msc`） | a 好 / **b 差（无逐条标注）** / c 无 / d 无 |
| **tau-bench / τ² / τ³** | [arXiv 2406.12045](https://arxiv.org/abs/2406.12045)｜[tau-bench](https://github.com/sierra-research/tau-bench)｜[tau2-bench](https://github.com/sierra-research/tau2-bench) | airline / retail / telecom / banking_knowledge | 英文（未找到中文 locale） | **纯工具调用 + 策略遵循**，无记忆组件、无多会话 | 标注 goal state + DB 终态自动判分 | 两仓均 **MIT**，数据在仓内 | 双 LLM（agent + user sim）× trials；**✅ 有结果文件**（tau2 `data/tau2/results/final/*.json` ~25 个） | a 无 / b 无 / c 无 / **d 无关（不是记忆基准）** |
| **PerLTQA**（含**中文版**） | [SIGHAN-10 2024](https://aclanthology.org/2024.sighan-1.18/) / [arXiv 2402.16288](https://arxiv.org/abs/2402.16288) | 141 画像 / 1,339 关系 / 4,501 事件 / 3,409 对话 / 8,593 QA（论文口径）；**中文版实测 32 角色 / 1,905 QA** | ✅ **中文**（`Dataset/zh/`，实测 CJK 密集）+ 英文 `/en`、`/en_v2` | 记忆分类 / 记忆检索 / 记忆融合（语义 + 情景记忆） | GPT-3.5 生成 + 3 名中英双语研究者人工校对（约 200 小时/人） | [repo](https://github.com/Elvin-Yiming-Du/PerLTQA)，`LICENSE.txt` = **CC BY-NC 4.0**（禁商用）；数据随仓库分发 | 需要写适配器；语料可直接用；**有脚本无结果** | **a 好（中文非编码）/ b 中 / c 好（中文 query + Reference Memory）/ d 无** |
| **DialSim** | [arXiv 2406.13144](https://arxiv.org/abs/2406.13144) | >1,300 sessions；总 >352,000 token | 英文（TV 剧本） | 多会话多说话人长对话理解 | 结构化题规则判分 + 开放题 gpt-4o-mini judge | [repo](https://github.com/jiho283/DialSim)（**无 LICENSE 文件**）；数据在 Google Drive | 中等；**✅ 有结果文件**（`results/results-*.json`） | a 中 / b 弱 / c 中 / d 无 |
| **MemoryBank / SiliconFriend** | [arXiv 2305.10250](https://arxiv.org/abs/2305.10250) | 未核验规模（MemoryAgentBench 表记为 194 题，二手） | 论文称双语（中英）——**未核验** | 长期记忆 + 艾宾浩斯遗忘曲线式更新 | 未核验 | 二手指向 [zhongwanjun/MemoryBank-SiliconFriend](https://github.com/zhongwanjun/MemoryBank-SiliconFriend)（本次仅二手来源，**未一手核验**） | 未核验 | a ？ / b ？ / c ？ / d 无（**待核验**） |
| **MemDaily / MemSim** | [arXiv 2409.20163](https://arxiv.org/abs/2409.20163) | 未核验 | 未找到 | 日常场景记忆机制；贝叶斯模拟器自动出题 | 模拟器自动生成 | repo `nuster1128/MemSim`（未核验） | 未核验 | 未核验 |
| **RHELM** | [arXiv 2605.31086](https://arxiv.org/abs/2605.31086)（MSRA） | 7 类 inquiry × 27 项记忆特征；异构源 + 时间演化 | 摘要未声明语言 → 未找到 | 真实/异构/演化长期记忆 | 未核验 | 数据 `microsoft/RHELM`（HF 不可达，**未验证**） | 未核验 | 未核验 |
| **CloneMem** | [ACL 2026](https://aclanthology.org/2026.acl-long.1549/) | 10 persona / 1,183 题（Table 2；摘要称约 5,000 QA）；1–3 年跨度的日记·社媒·邮件 | ✅ **中英双语** | AI Clone 的长期记忆：跨异构数字痕迹合成 | 人工构造（细节未核验） | 论文声明数据公开（repo/HF 入口未核验） | 未核验 | a 中（非对话）/ b 中 / c 中 / d 无 |
| **Mem-PAL / PAL-Set** | [AAAI 2026 Oral](https://ojs.aaai.org/index.php/AAAI/article/view/40385)｜[repo](https://github.com/hzp3517/Mem-PAL) | 100 用户；日志 + 多轮对话；隐式需求 | ✅ **中文为原始语言**（README 明写 "ZH version (Original)"，英文是 LLM 机翻） | 长期 user–agent 个性化对话助手 | 未核验 | repo 有；许可未核验 | 未核验 | a 好（中文个性化对话）/ b 中 / c 中 / d 无 |
| **CUE-Mem** | 无正式论文（repo 标 "arXiv Coming Soon"） | 2,674 题 / 4 类任务；中文全模态（文本·图像·音频） | ✅ **中文** | 全模态长期用户记忆 | 未核验 | [repo](https://github.com/yulinlp/CUE-MEM)；许可未核验 | 未核验 | a 中 / b 弱 / c 中 / d 无 |
| **locomo-zh-500** | 单一 OSS 项目自建（**非同行评审**） | 500 条中文查询 / 567 条证据 turn；基于 LoCoMo | 查询中文、原语料英文 | **关键词级检索**（作者自述「非 QA」） | 由 LoCoMo 的 evidence turn 派生 | [repo](https://github.com/FuRongJun-1999/dsh-memory/tree/main/data/benchmarks/locomo-zh-500)，CC-BY-NC-4.0 | 极低（纯本地计算）；`answer` 恒为空 | a 无 / b 弱 / **c 中（只给中文 query + 正确 turn，不给答案）** / d 无 |
| `touchstone-longmemeval` | 个人社区 repo（**非同行评审**） | 100 题 / 6 维度；**22 sessions / 46 轮 / 35 天** | ✅ **中文**（代谢健康场景） | 单事实 / 多会话 / 时序 / 信念冲突 / 诚实拒答 / 规则遵循 | 人工手写 100 题 + 中文 judge prompt（PASS/FAIL 规则） | [repo](https://github.com/qishengdong/touchstone-longmemeval) MIT，数据随仓库分发 | 10 分钟、几美元；**✅ 有结果文件**（3 次独立 run 原始回复 + judge 判定） | a 弱（1 个 fixture）/ b 弱 / c 中 / d 无 |
| *（工具）* **mem0ai/memory-benchmarks** | [repo](https://github.com/mem0ai/memory-benchmarks) | 覆盖 LoCoMo + LongMemEval + BEAM | 英文 | 统一跑 Ingest→Search→Evaluate 三阶段 | judge 默认 **gpt-5**（README 写 gpt-4o 是过期文档） | **Apache-2.0**；数据不随仓库分发（gitignore） | 现成 harness；**✅ 13 个 `results/*.json`（本次核验中唯一开箱带逐题结果的记忆评测仓库）** | 不是语料，是**对照口径的参照系**（但注意它公布的 92.5% 与文件里的 91.56% 不一致，见卫生清单第 14 条） |

### 关于用途 (d)：Memoria-Bench 的代码任务与 LongMemEval-V2 的「环境经验」离我们有多近

**Memoria-Bench：形似而神不似。** 它的 Code 域确实来自真实软件工程轨迹（SWE-Gym / OpenHands-SFT-Trajectories + 用于漏洞分析的 Claude Code 执行轨迹），论文也强调 "long-term procedural memory and cross-turn consistency"。但**这些轨迹只被当成超长上下文来出 anti-summarization QA**：正确答案是轨迹里某个可精确核验的细节。论文自己的例子（Code Agent / Claude-Sonnet-4.5）是**数出轨迹里 `KeyError` 出现几次**，以及**答案正确但没遵守「只输出数字」**（[ICML 2026 PDF](https://palm.seu.edu.cn/zhangml/files/ICML%2726a.pdf)）。episodic/semantic 的标注规则是机械的（有无显式时间锚点），**procedural 只是论文解释「代码域为什么难」的分析标签，没有被实例化成一类任务**。它测的是「能否在百万 token 噪声里精确复现细节」，不是「能否把踩过的坑抽象成下次可复用的前置条件」——**没有 constraint / pitfall / decision / rejected 任何字段，也没有「下次执行是否遵守」的闭环**。加上代码仓库 404、数据未公开，对我们只有参考价值。

**LongMemEval-V2：概念上最接近，领域不同。** 五个能力里三个几乎同构：**workflow knowledge ≈ procedure**、**environment gotchas ≈ pitfall**（原文："aware of common recurring issues in the current environment and can avoid environment-specific failures"）、**premise awareness ≈ 前提/约束**（"recognize assumptions that are valid in another environment but wrong in the current one"）。gotchas 的题型是「一个没经验的新同事发来截图提问」，判据允许「命中任一 insight 且不矛盾即 1」——**这套题面和判分口径可以直接借来标注中文 pitfall**。差距有四点：(1) 领域是 Web/ServiceNow 界面，不是代码仓库与构建系统；(2) 产物是「一段紧凑证据 + 一个答案」，不是「写入一条带类型、可被后续任务检索并遵守的记忆」；(3) 没有 constraint / decision / rejected 的位置；(4) 成功信号仍是 QA 对错，而非「违反约束导致任务失败」。另外它的 AgentRunbook-C 把记忆做成「文件 + 编码 agent 上工具检索」，**形态与 coding agent 的类型化记忆同构**（论文把 Codex 直接当 memory controller 做基线，69.3% vs 自研 72.5%），这一点值得抄。

---

## 三个最值得用的，以及具体怎么接

### 1. Memora —— 补「该不该记」的标注与非编码语料（性价比最高）

**为什么是它。** 它是本次核验里唯一同时满足三件事的：① **逐轮 `share_memory` 布尔标注**（[`data/README.md`](https://github.com/geniesinc/Memora/blob/main/data/README.md)：「`true` = this turn carries new memory the agent should retain」）；② 每个 persona 都有大量 **`session_type: "no_memory"`** 的纯闲聊会话（实测 weekly 53 / monthly 246 / quarterly 799 场，约占 32–40%）；③ **Apache-2.0，数据随仓库分发**，不需要申请、不需要 HF 账号。

**数据从哪下。**
```sh
git clone --depth 1 https://github.com/geniesinc/Memora.git   # 约 200MB，data/ 156MB
# data/{weekly,monthly,quarterly}/<persona>/conversations/session_NNNN.json
# data/{weekly,monthly,quarterly}/<persona>/evaluation_questions_<persona>.json
```
10 个 persona、3 个时间尺度。实测规模：weekly 163 sessions / 2,636 轮 / 164 个 `share_memory=true` 轮；monthly 628 / 9,881 / 614；quarterly 1,974 / 30,989 / 1,727。

**要写什么适配器。** 两件事，**第一件不需要任何模型调用**：

- **适配器 A（半天到 1 天，先做这个）**：把 `share_memory=true` 的轮次当**正例**、把 `no_memory` 会话里的轮次当**负例**，导出成与我们 `eval/labels/round1.csv` **同构**的两列（文本 + 0/1），直接喂给 `eval/write-precision.ts` 的那套判定链路，得到英文的写入精确率/召回率。这样我们就有了一个**外部**标注集来对照自建的 240 行中文标注，且能回答「闲聊会不会被记成项目知识」——只是语料是英文。
- **适配器 B（3–5 天）**：把每个 session 的 `conversation[]` 按时间顺序重放进插件的 `agent/turn-stopping` 路径（或直接调用 `extract.ts` + `judge.ts`），落出我们自己的 `memory.json`；再对每题用我们的召回（类型配额 + 重要性×衰减 + 关键词）取 Top-K，拼进 prompt 交给一个 reader（gpt-4o-mini 足够），最后用仓库自带的 `evaluation.evaluation_questions[]` 逐条判 yes/no。

**指标怎么算。** 照抄 FAMA，公式与实现都是公开的（[`model_based_evaluator.py:92-115`](https://github.com/geniesinc/Memora/blob/main/evals/model_eval/model_based_evaluator.py#L92-L115)）：

```
FAMA = max(0, MPA − λ·(1 − FAA))
MPA = memory_presence 判据通过率，FAA = forgetting_absence 判据通过率
λ   = N_forget / (N_presence + N_forget)     # 逐题算，∈[0,1]
```

这条公式**正好是我们要的第二套报表口径**：它把「用了过期记忆」显式扣分，而不像 Hit@K 那样只看命中。我们可以在自己的中文台账上直接实现它（把 `needs-review` / 被取代的记录当 forgetting 判据）。

**预计工作量与成本。** 适配器 A：**1 天，$0**（纯确定性，只有可选的 Jev 判定调用）。适配器 B：3–5 天，Track 1 是「无记忆的裸模型」基线；真正要跑我们的插件属于 Track 2（agent eval），参考 README 的 `run_all_agents.sh`，单模型约 $150–250（估算），全 persona 全时间尺度是上千美元级。**建议只做 weekly 档 + 适配器 A。**

**注意。** 数据是**英文**；judge 需要 `OPENROUTER_API_KEY`（三模型多数投票）；仓库**不附带任何结果文件**（`eval_results/<run_id>/` 是运行时生成的），README 里那张 Table 3 是论文数字的 HTML 表，不是可复现的数据文件。

---

### 2. LongMemEval V1（oracle 档）—— 报一个能和竞品同口径的召回数字

**为什么是它。** 它是生态里被引用最多的长期记忆 QA 基准（Mem0、Zep、MemoryAgentBench 都在用它的 judge prompt），**MIT 许可**，数据可直接下，题目自带 `answer` 与 `answer_session_ids`，判分脚本是现成的、prompt 可逐字照抄。我们要的「query + 正解」它给得最干净。

**数据从哪下。**
```sh
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json   # 15.4MB，500 题【实测】
# 还有 longmemeval_s_cleaned.json (277MB) 与 longmemeval_m_cleaned.json (2.7GB)
```
**先跑 oracle**：oracle 档只包含证据 session（948 个），是唯一「便宜到可以当回归测试跑」的档位。实测 oracle 的题型分布：temporal-reasoning 133 / multi-session 133 / knowledge-update 78 / single-session-user 70 / single-session-assistant 56 / single-session-preference 30，其中 `_abs` 结尾的拒答题 30。

**要写什么适配器。**
- 每题建一个临时 memory 空间，把该题的 `haystack_sessions` 灌进我们的存储（可以直接构造 `memory.json`，不必重放对话）；
- 我们的召回产出 Top-K 后交给 reader 生成回答，写成官方要求的 `{"question_id", "hypothesis"}` 逐行 JSONL；
- 复用官方的 [5 套 judge 模板](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py#L24-L43)（`single-session-*`/`multi-session` 共一套，`temporal-reasoning` 加「不罚差一天」，`knowledge-update` 加「新旧并存但新答案对就算对」，`single-session-preference` 用 rubric，外加 abstention 版）。

**指标怎么算。** 按 6 个题型分别报准确率 + 总体准确率；**同时必须报三样东西**，否则数字不可信：judge 模型名（官方白名单是 `gpt-4o-2024-08-06` / `gpt-4o-mini-2024-07-18`）、**judge 返回无法解析的条数**（官方代码是 `label = 'yes' in eval_response.lower()`，见卫生清单）、以及我们自己的 token 预算。另外官方 [`print_qa_metrics.py:14`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_qa_metrics.py#L14) 有一句**硬断言** `autoeval_label['model'] == 'gpt-4o-2024-08-06'`，换 judge 模型跑完统计脚本会直接 AssertionError——我们要么照用这个模型，要么自己写统计。

**预计工作量与成本。** 适配器 2–4 天。oracle 档约 $30–70（500 题 × 生成 + judge，估算）。**建议同时报 `oracle` 与 `s` 两档**：oracle 反映「记忆里有没有」，`s`（115k token 历史、$400–900 估算）反映「能不能在噪声里找到」——后者才是我们和竞品真正的差距所在，也大概率会暴露「关键词召回打不过向量检索」这件事，而这本身是有价值的负结果。

---

### 3. HaluMem —— 把「三段拆解」照搬成我们的报表结构

**为什么是它。** 我们自己的台账（`ledger.jsonl`）已经天然分了三段：`write` / `skip`（抽取）、`conflict-*`（更新）、`recall`（问答）。HaluMem 是唯一把这些段**各自定义了 gold 与指标**的公开基准，而且指标定义写到了可以直接实现的程度（[arXiv 2511.03506](https://arxiv.org/abs/2511.03506) §5）：

| HaluMem 指标 | 定义 | 落到我们身上 |
|---|---|---|
| Memory Recall（+Weighted） | 该抽的抽到了多少（importance 加权，`sᵢ∈{1,0.5,0}`） | `write` 数 ÷ 人工标注的「该记」数 —— **正是我们 240 行标注要算的召回率** |
| Memory Accuracy / Target Precision | 抽出来的有多少是对的 | 写入精确率（我们 README 已有） |
| **FMR**（False Memory Resistance） | 面对「AI 提过但用户没确认」的干扰记忆，忽略掉的比例 | **`veto:*` / `skip` 台账可以直接算**：被筛子挡下的候选 ÷ 干扰候选总数 |
| Memory Update Accuracy | `old → new` 更新对做对的比例 | `conflict-resolved` 台账（我们已经在记用户选了什么） |
| QA 的 C / H / O | 端到端正确 / 幻觉 / 遗漏 | `recall` + 回答质量 |

**它最值得抄的一点**：HaluMem 把「**干扰记忆**」定义成「AI 自然地说了、但用户从未确认」的内容（论文 Stage 5 的 adversarial content injection），并单独给了一个指标 FMR。这正好量化了我们 README 里那个真实 bug——**委派子会话里父代理写给我的任务指令被当成了用户的约束**——那就是一条典型的 distractor。

**要写什么适配器。** 分两步：
- **第一步（1–2 天，纯本地，不需要下载数据、不需要网络）**：写一个 `eval/report-halumem.ts`，从 `memory.json` + `ledger.jsonl` 直接算上面五个指标，输出我们自己的报表。这一步不依赖 HaluMem 的数据，只依赖它的**指标定义**（定义是思想，不受许可限制）。
- **第二步（可选，1 周 + $200–500）**：实现它要求的三个 API（Add Dialogue / Get Dialogue Memory / Retrieve Memory），把 HaluMem-Medium 喂进插件跑一遍。仓库里有 6 个现成系统适配器（`eval/eval_mem0.py` 等）可当契约参考。

**成本与红线。** 第一步几乎零成本。第二步 Medium 档 $200–500 / 数据集 / 系统（估算）。

> ⚠️ **许可证是这里最硬的约束**：`LICENSE.txt` = **CC BY-NC-ND 4.0**——禁用商用，且**禁止演绎**。所以「拿它的数据做子集/改写/翻译」在法律上站不住；**照搬指标定义与三段结构没问题（思想不受版权保护），但不要分发任何基于它数据的改造物**，内部跑之前也建议先跟法务确认。

---

### 并列第四（中文补充）：PerLTQA-zh + MemoryBench + Touchstone

中文不能靠 Memora/LongMemEval/HaluMem——它们全是英文。本次核验到的中文资产只有三条，都需要打折使用：

- **PerLTQA 中文版**（[repo](https://github.com/Elvin-Yiming-Du/PerLTQA)，**CC BY-NC 4.0**）：`Dataset/zh/perltqa.json` + `perltmem.json`，实测 **32 个角色 / 1,905 条中文 QA**，字段是 `Question / Answer / Reference Memory / Memory Anchors`。**这是唯一专门的中文长期记忆数据集**。但要诚实看待它：`profile` 那 357 题基本是字段查表（"张小红的性别是什么？"），**只有 `events` 628 + `dialogues` 626 + `social_relationship` 294 这 1,548 题配得上「记忆」二字**。它可以当**中文 query + 正解**的召回集，也可以当**中文非编码语料**；缺点是合成语料、`Memory Anchors` 大量是 `[-1,-1]`（无效偏移），且非商用。
- **MemoryBench**（[清华 THUIR](https://github.com/THUIR/MemoryBench)，**MIT**）：含中文法律数据（LexEval/JuDGE），而且**是少数带结果文件的仓库**。但它是「记忆 + 持续学习」框架，不是为长期记忆设计的，适配成本高。
- **CloneMem**（[ACL 2026](https://aclanthology.org/2026.acl-long.1549/)）：**中英双语**的 AI Clone 长期记忆基准，1–3 年跨度的日记/社媒/邮件等**非对话数字痕迹**，10 个 persona、论文 Table 2 记 1,183 题（摘要说约 5,000 QA 对）。**这是给「长期记忆」做中文标注的第二个公开来源**，但它不是会话语料，与我们的场景（会话里冒出来的约定/坑）不同。
- **Mem-PAL / PAL-Set**（[AAAI 2026 Oral，repo](https://github.com/hzp3517/Mem-PAL)）：100 个用户的长期 user–agent 交互数据（日志 + 多轮对话 + 隐式需求）。**README 明确写「ZH version (Original)」，英文版是 LLM 机翻且未经充分人工复核**——也就是**中文才是原始语言**。适合当「中文用户长期偏好/隐式需求」语料。
- **CUE-Mem**（[repo](https://github.com/yulinlp/CUE-MEM)）：中文全模态（文本/图像/音频）长期用户记忆基准，2,674 题、4 类任务；**论文标注 "arXiv Coming Soon"，未见正式发表**，只能当社区资源。
- **locomo-zh-500**（[FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory/tree/main/data/benchmarks/locomo-zh-500)，CC-BY-NC-4.0）：LoCoMo 的中文派生集，500 条**中文查询** + 567 条证据 turn，但它自己的 `VERSION.json` 就写着 `"task": "retrieval（关键词级检索，非 QA）"`、`answer` 恒为空串，README 明确警告「**不是 QA 评测集 … 不能当作端到端记忆能力分数**」。**只能当"中文关键词查询能不能命中正确 turn"的检索集用**，恰好对应我们 README 里那个还空着的 Hit@K —— 但它是单一 OSS 项目自建、非同行评审，**只能当自查，不能对外当基准**。
- **CLongEval 中文子集**：有人在 [mem0ai/memory-benchmarks#28](https://github.com/mem0ai/memory-benchmarks/issues/28)（open、未合并、0 评论）提议加入「70 段中文对话 / 358 题」，并自报 Mem0 OSS 在 DeepSeek / Qwen / 智谱上 80.7% / 78.2% / 74.9% @Top50。**未合并、成绩为提交者自报**；我**未能核实**它是否就是同名 ACL Findings 2024 论文（那是长上下文理解基准）的同一份数据。
- **touchstone-longmemeval**（[repo](https://github.com/qishengdong/touchstone-longmemeval)，MIT，**个人社区项目，非同行评审**）：22 sessions / 46 轮 / 100 道中文题，6 个维度里有 **T4 信念冲突**和 **T6 规则遵循（"训练铁律"）**，后者几乎就是我们的 constraint 类型；还带中文 judge prompt 与 3 次 run 的完整结果。**规模太小不能当基准**，但当「中文链路的 10 分钟冒烟测试」很合适。它自己也承认「**Sivon was tuned on this fixture during development**」——**在自己调过的 fixture 上自评 92/100，不能当可比数字**。

> **中文侧的总结论**：**不存在一个中文的、端到端 QA 形式、公开可复现、且带权威判分的长期记忆基准。** PerLTQA 是唯一有论文的专门中文长期记忆数据集（口径是三子任务而非统一 judge 的 QA），CloneMem 是双语但场景不同，Mem-PAL 是 user–agent 个性化而非双人对话，CUE-Mem 论文未发布，locomo-zh-500 与 touchstone 都不是权威 QA 基准。**要么打折使用，要么自己标。**

---

## 三个明确不该用的，理由

### 1. Memoria-Bench —— 论文写得很对我们的胃口，但**拿不到**

论文自述 "The code is publicly available at https://github.com/zjxx/Memoria"，我实测该 URL **HTTP 404**（`git clone` 直接索要凭据，说明是私有或不存在）；也没找到任何 HF 数据集入口、没有 arXiv 版本、没有 LICENSE 文件（[ICML 2026 PDF](https://palm.seu.edu.cn/zhangml/files/ICML%2726a.pdf)）。**拿不到的东西不能进评测计划**——哪怕它的「程序性记忆」叙事和我们的 procedure 类型最像。另外它 Table 1 自述覆盖中文（ZH ✔），但**全文抽取后 CJK 字符数为 0，数据又不可得，这条覆盖声明我们无法核验**，不能写进任何对外材料。

### 2. MemoryArena —— 没有许可证，而且**关键数据是私有子模块**

三个独立的否决理由：① **仓库根目录没有 LICENSE 文件**（唯一的 LICENSE 在 vendored 的 MemoRAG 子目录里），数据 HF 卡也没有 license tag，法律状态最不清晰；② `.gitmodules` 声明的子模块 `wangyu-ustc/MemActBench` **clone 失败（需要鉴权）**，也就是**部分任务数据根本拿不到**；③ 复现要 4 套环境服务（WebShop / TravelPlanner / BrowseComp-Plus / 形式推理）+ 6 类 API key（含 Letta / Mirix / Mem0 的付费 key），README 自述还是 "preview version"，且**有脚本无结果**。最根本的是：它测的是**任务成功率**，不是记忆质量——我们要报的写入精确率/召回率它一个都给不了。

### 3. BEAM —— 经济学上不成立，信号又与 LongMemEval 重复

10M 档每道题要灌 10M token 的输入。按 200 题 × 10M token、gpt-4o 输入 $2.5/M 估算，**单档就要 $25k+，单题一轮就 $25**（估算）——这不是「跑一次」的量级。而 ≤1M 的三档（$80–250 估算）测的是「长上下文里的记忆能力」，与 LongMemEval-S 高度重叠，但题目、判据、judge 都不一样，**多花十倍钱换来一个不可比的数字**。它还有两个额外的坑：仓库代码 MIT 而 HF 数据 CC BY-SA 4.0（**许可不一致**），以及**有脚本无结果文件**。

> 顺带明确两个**不是记忆基准**、不要被名字带偏的：**tau-bench / τ²-bench**（纯工具调用 + 策略遵循，没有记忆组件、没有多会话，本次实测两仓文件树里没有任何记忆模块）与 **MSC**（2021 年的下一句生成数据集，**没有 QA、没有 evidence span**，无法导出「该记/不该记」标注）。

---

## 数据卫生问题清单

按「会不会坑到我们」排序。**来源标注**：第 1、2、4、5、7、8、9、10、11、14 条的**数据/仓库部分**是在本地 `git clone` 后实测的；第 3、6、15、16、17 条来自**官方 issue 与论文一手文本**（其中厂商互相指控的部分未独立复算，已就地标注为「厂商自述」）；**第 12、13 条是二手**。凡未一手核实的都已写明。

1. **LoCoMo 的类别映射不止两套，至少四套互斥定义；而且论文自身、数据集标签、作者代码三者互相矛盾（实测）。** 公开文件 `locomo10.json` 里类别是数字 1–5，分布 `{1:282, 2:321, 3:96, 4:841, 5:446}`，但**数字到名字的映射不是论文列举的顺序**。正确映射是 **1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial**，证据有四条：(a) 官方评分器 [`evaluation.py:209-217`](https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py#L209-L217) 把 category 1 走「multi-hop 拆子答案算部分 F1」、2/3/4 一起走普通 F1、5 走 adversarial；(b) 官方评分器第 203 行单独处理 `category == 3` 的 `answer.split(';')[0]`，与 open-domain 题多答案的特征吻合；(c) 逐类抽样——cat 2 全是 "When did…"（时序）、cat 3 全是 "Would … likely…"（世界知识）、cat 4 全是 "What did the charity race raise awareness for?"（单跳）；(d) 按 `evidence` 里涉及的不同 session 数统计，**cat 1 平均 2.68 个 session、cat 4 恰好 1.00 个**——多跳的客观特征只在 cat 1 上成立（一路子任务实测）。而**论文 §4.1 的枚举顺序是 (1) Single-hop → (2) Multi-hop → (3) Temporal → (4) Open-domain → (5) Adversarial**，照这个顺序当映射，841 题会被标成 open-domain（实际 single-hop），而论文 Table 5 自己说 open-domain 只占 3.9%。
   **公开的四套互斥映射**：① 论文枚举顺序（1=single-hop）；② 数据集真实标签 + 作者代码（1=multi-hop）；③ Mem0 联创在 [mem0#2609](https://github.com/mem0ai/mem0/issues/2609#issuecomment-2846494304) 给的回复（"Category 1: Single Hop / Category 2: Temporal / Category 3: Multi Hop / Category 4: Open Domain"）——**与论文、与数据集、与 Mem0 自己现在的代码三者都不一致**；④ Mem0 现行评测仓库 [`benchmarks/locomo/prompts.py`](https://github.com/mem0ai/memory-benchmarks/blob/main/benchmarks/locomo/prompts.py)（1=multi-hop (282) / 2=temporal (321) / 3=open-domain (96) / 4=single-hop (841) / 5=adversarial，与真值一致）。
   **最强的一条是 OpenViking 同一个仓库里两套互相矛盾的映射**：`benchmark/locomo/mem0/eval.py` 写 `{1:"single-hop", 2:"multi-hop", 3:"temporal", 4:"world-knowledge"}`，而 `benchmark/locomo/openviking/locomo_prompts.py` 与两个 `stat_judge_result.py` 写 `{1:"multi-hop", 2:"temporal", 3:"open-domain", 4:"single-hop"}`；更要命的是 mem0 那份 README 的分项成绩是 `multi-hop 120/321`、`single-hop 98/282`、`temporal 28/96`、`world-knowledge 266/841`——**分母与真值完全对得上，标签整体错位**（[benchmark/locomo](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo)）。一个下载量 459 的 HF 重制版 `PerceNa/locomo-mc10` 也把 `question_type` 映射成 `{single_hop:282, multi_hop:321, temporal_reasoning:96, open_domain:841}`（经代理下载 229MB 数据后逐行解析，本机不可直连 HF）。
   → **对我们的直接后果**：任何「LoCoMo 分类型成绩」在不注明映射来源的情况下都不可比；我们自己若要用，必须写死 `{1:multi-hop, 2:temporal, 3:open-domain, 4:single-hop, 5:adversarial}` 并注明依据是官方评分器而非论文措辞。
2. **LoCoMo 的 adversarial 类没有标准答案，而官方评分器会读它（实测）。** 446 道 category 5 题里，**444 道没有 `answer` 字段**（只有 `adversarial_answer`）。官方 `eval_question_answering()` 在第 200 行无条件执行 `answer = line['answer']`，**直接拿这个文件跑官方脚本会对这 444 题抛 KeyError**。而且它的判分是**字面子串匹配**：回答里出现 `'no information available'` 或 `'not mentioned'` 才算对（[`evaluation.py:217-221`](https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py#L217-L221)）——**中文回答、或换个说法（"无法回答"/"没有提到"）一律记 0**。这条对我们这种中文语料的项目是致命的。
3. **「解析失败 / 空答案」被静默记成答错——多处实证，且已经污染了已发布数字。** (a) LongMemEval 与 MemoryAgentBench 用同一行代码：`label = 'yes' in eval_response.lower()`（[LongMemEval](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py#L113)），`max_tokens=10`——judge 返回任何不含 "yes" 的东西都算错。(b) OpenViking 的裁判脚本在 JSON 解析失败时直接 `return False`（[`benchmark/locomo/openclaw/judge.py`](https://github.com/volcengine/OpenViking/blob/main/benchmark/locomo/openclaw/judge.py)）——**这正是我们已知的那个「judge 把解析失败记成答错」的根因，而且是代码级的**。(c) 最严重的是 Mem0 自己的 harness：[memory-benchmarks#23](https://github.com/mem0ai/memory-benchmarks/issues/23) 指出 `message.content` 因 token 预算被推理耗尽而返回 `None`、重试后返回 `""`，**「judge 随后给它 0.0 分，与答错无法区分」，且「空答案在每一次 run 中占全部题目的 5–15%」，issue 作者并注明「包括 README 里的数字在内，很可能都受影响」**。→ 我们照抄任何 judge 都必须把「解析失败/空响应」单独计数并排除，否则报出来的数会把 judge 的错算成我们的错。
4. **LongMemEval 有「原始版」和「cleaned 版」两代数据，跨代不可比。** README 的 2025/09 更新写着「further cleaned up the history sessions to prevent interference on answer correctness」，并要求下载 `*_cleaned.json`——**HF 上 `longmemeval_s.json` / `longmemeval_m.json` 已经不存在了**，只剩 `_cleaned`。任何引用 2024–2025 上半年 LongMemEval 分数的论文，用的都是**另一份数据**。
5. **同一个基准的规模口径不一致：LoCoMo 论文 7,512 题 vs 公开文件 1,986 题。** 论文 Table 5 写总题数 7,512（single-hop 2,705 / multi-hop 1,104 / temporal 1,547 / open-domain 285 / adversarial 1,871），那是 **50 段对话**的整版；[repo README](https://github.com/snap-research/locomo) 明说「This release is a subset… We sampled a subset of the data to retain the longest conversations」，实测 `locomo10.json` 只有 **10 段对话 / 1,986 题**。LongMemEval-V2 与 HaluMem 的对比表都照抄了 7,512 这个数，**它们和用公开文件跑出来的分数不是一个口径**。
6. **同一批答案在不同 judge prompt 下可以差 56 个百分点——「同一基准不同 arm 判分口径不一致」有量化证据。** [memory-benchmarks#29](https://github.com/mem0ai/memory-benchmarks/issues/29)（提问方已披露是竞品 Mnemoverse.AI 创始人）：把 Mem0 自己发布的 1,539 条 LoCoMo 答案重新判分，**用 Mem0 的 prompt 得 91.0%（与它公布的 92.5% 相差 1.5 分），换一套更严格的 prompt 得 35.0%**，用未经修改的 LongMemEval rubric 得 81.7%；**两套 prompt 在 863 条答案上判断相反、且方向单一**。[memory-benchmarks#30](https://github.com/mem0ai/memory-benchmarks/issues/30) 进一步指出，Mem0 现行的宽松条款（「日期相差 14 天内算对」「时长差 50% 内算对」「gold 是列表时命中任一项就算对」）是**在发布结果文件的那次提交 `edcd6f1` 里同时加进去的**。而 Mem0 现行 judge 的 `_EVIDENCE_RULE` 甚至写着「证据能支持答案就判对——**证据只用来接受答案，绝不用来更严格地拒绝**」。同一张对比表里，Mem0 用 lenient judge、LongMemEval 官方用 gpt-4o 分题型 rubric、MemoryAgentBench 的摘要 judge 写死 `gpt-4o-2024-05-13`、Memora 用三模型多数投票、OpenViking 另起一套「be generous」——**但 OpenViking 的答案生成 prompt 又是抄 Mem0 的**（`locomo_prompts.py` 首行注释自认 "aligned with the mem0 benchmark runner"）：**同一篇论文的 arm 之间，答案 prompt 同源而 judge 不同源。**
7. **「有脚本没结果」是常态，有结果文件的是少数（实测）。** 本次逐个 `git clone` 后确认：**LoCoMo、LongMemEval、MemoryAgentBench、HaluMem、Memora、BEAM、MemoryArena、AMA-Bench、EverMemBench、PerLTQA 全部没有结果文件**；真正带结果文件的只有 **mem0ai/memory-benchmarks（13 个逐题 JSON）**、**MemoryBench（THUIR）**、**DialSim**、**tau2-bench（~25 个）**，以及那个社区小 repo `touchstone-longmemeval`。这条直接决定了「能不能先拿别人的数字当对照」。
8. **同一基准的题数在不同论文里对不上：MemoryArena 701 vs 766。** 论文自身 Table 1/2 记 **701** 组任务（[arXiv 2602.16313](https://arxiv.org/abs/2602.16313)），而 LongMemEval-V2 的对比表把它记成 **766 题 / 7 sessions**（[arXiv 2605.12493](https://arxiv.org/abs/2605.12493)）。两处都是论文自述，未找到作者说明。
9. **MemoryAgentBench 的第四个能力有两套名字。** 论文写 **Selective Forgetting**，而 GitHub README 与 HF 的 split 名写 **Conflict Resolution (CR)**（实测两处都在）。**我们调研的起点 `awesome-ai-memory` 把它写成了「选择性遗忘」，但同时把它的另外三项也简化了**——这份清单可以作为候选池，但**不能当作事实来源**（它还漏掉了 PerLTQA、DialSim、MemoryBank、RHELM）。
10. **Memoria-Bench 的中文覆盖声明无法核验。** 论文 Table 1 把 ZH 和 EN 都打了 ✔，但全文抽不出 CJK 字符（对比：LoCoMo 在同一张表里是 ZH✘EN✔，与它实际纯英文一致，说明这张表的语言列本身是可信的）——**而 Memoria-Bench 的数据不可得，所以这条声明只能挂起**。
11. **许可证红线（逐条实测，直接影响能不能用）**：LoCoMo **CC BY-NC 4.0**（禁商用，且 arXiv 页显示 CC BY-NC-SA，两处不一致）；HaluMem **CC BY-NC-ND 4.0**（禁商用 + **禁演绎**）；PerLTQA **CC BY-NC 4.0**；MemoryArena **无 LICENSE**；Mem2ActBench / EverMemBench / DialSim **repo 里没有 LICENSE 文件**；BEAM **代码 MIT / 数据 CC BY-SA 4.0 不一致**；MSC **数据本身没有许可声明**。可以放心用的：LongMemEval、MemoryAgentBench、mem0 memory-benchmarks、Memora、AMA-Bench、PersonaMem、BEAM 代码、tau-bench 系、PerLTQA 代码仓、touchstone（MIT/Apache）。
12. **报告口径冲突（二手也要标）**：Mem-Gallery 的 ACL 版摘要写 "twelve memory systems"、arXiv v1 写 "thirteen"；Mem2ActBench 顶层 README 是 L1–L4，数据集 README 与正文是 L1–L3；PersonaMem 32k 档的类型名与 128k/1M 档不一致（聚合前要归一）。
13. **厂商数字：腾讯 PersonaMem 48%→76% 找不到第三方来源。** 腾讯云文档自述「基于 PersonaMem 数据集准确率从 48% 提升至 76%」；48% 与 **PersonaMem-v2**（[arXiv 2512.06688](https://arxiv.org/abs/2512.06688)，自述 "37-48%"）对得上，而 **v1 的公开最好成绩是 ~52%**；**76% 未见于 PersonaMem 任何论文**，v2 论文自述的 agentic memory 只有 55%。引用时只能写成「腾讯云自述」。
14. **已发布的结果文件本身是「失败题重跑后合并」的产物，且与 README 数字不符（实测）。** Mem0 的 `results/platform/locomo_results.json` 的 `metadata.merged_from_questions` 列了 **156 个 question id**。实测复算：全量 1410/1540 = **91.56%**（与其文件里的 `top_200.accuracy` 一致）；这 156 道「合并题」正确率仅 **26/156 = 16.67%**，其余 1384 道**全部为 CORRECT（100%）**，反推原始一轮约 **89.87%**；而该仓库 README 公布的是 **92.5% (1425/1540)**。三个数字互不相等，issue #30 追问此事**至今 0 条回复**。→ 教训：**「仓库里有结果文件」不等于「结果文件可信」**，用之前要读它的 `metadata`。
15. **同一基准上的公开数字争议已经是公开事件（双方均为厂商自述，我未独立复算）。** Zep 在 LoCoMo 上先后出现 **84% → 58.44% → 75.14%** 三个数字，外加 Mem0 论文里报的 Zep **65.99%**：Zep 博客指控 Mem0 对 Zep 的实现有三处错误（用户模型、时间戳、串行 vs 并行检索）并称实测 75.14%±0.17（[blog.getzep.com](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)）；Mem0 CTO 在 [getzep/zep-papers#5](https://github.com/getzep/zep-papers/issues/5) 反称 Zep 的 84% **把 category 5 的答对数算进分子、却把 category 5 从分母里排除**，「虚高约 25.56 个百分点（84% vs 实际 58.44%）」。另有 Letta（MemGPT）作者公开指控（HN 转述，X 原文未读到）与多个复现失败 issue：[mem0#2800](https://github.com/mem0ai/mem0/issues/2800)（OSS 版分数显著低于论文，官方答「平台上做了改进」，社区追问指标口径无果；另有评论指论文写 `m=10,s=10` 而脚本是 `batch_size=2, topk=30`）、[mem0#3944](https://github.com/mem0ai/mem0/issues/3944)（记忆把 2023 年事件写成 "early January 2026"）、[mem0#5141](https://github.com/mem0ai/mem0/issues/5141)（第三方平台报 LongMemEval 32.4% / LoCoMo 0.0%，而「无记忆的 GPT-4o-mini 有 57.6%」，官方回复 "Closed since not relevant."）。第三方审计另记 EverMemOS claimed 92.32% vs reproduced **38.38%**（[EverMemOS#73](https://github.com/EverMind-AI/EverMemOS/issues/73)）。
16. **OpenViking issue #1258 的完整归因（一手 issue，34 条评论）**：第三方用官方脚本在完整 LoCoMo 上只得 **7.66%（118/1540）**，分类型 10.28% / 4.98% / 16.67% / 6.78%。维护者归因两条：**① ingest 把「整个 session 当成一条 message」上传**（新版事件提取逻辑依赖 message 下标），**② session 上传没有提供发生时间**；并说「把一个 session 对话放到一个 message 上传是和真实场景不符合的」。官方随后自报 **83.44%**，配置是 **`recallLimit: 30`（明说「现在默认 6」）** 与 `recallMaxContentChars: 4000`（默认 500），理由是「category 4 的题目侧重完整性、推理性，默认检索值较低会导致这些题目普遍得分较低」。提问者改了 ingest 之后单跑 sample2 从「30 多」升到 **61.18%**，但**最终没有跑全量**，所以 **83.44% 至今没有任何第三方全量复现**；仓库 `benchmark/` 下也没有结果文件（`benchmark/.gitignore` 首行就是 `results/`）。→ 这和我们已记录的结论一致，但现在有了更精确的因果链：**「入库格式」和「默认检索配额」是两个能单独把分数从 7% 抬到 80% 的变量**。
17. **两篇方法学论文直接质疑「把力气花在写入判定上」——但要注意它们的 caveat。** [MemDelta](https://arxiv.org/abs/2606.29914)（单作者，13 页，载体是 LongMemEval-S）的摘要给出四个混杂：① 基线与模型族交互（同一比较换个模型就反转排序）；② **只换 embedding 模型就能让准确率动 +6.2pp（n=500, p=0.004），并让 Mem0 从「赢 MiniLM-RAG 11pp」变成「输给 cloud-RAG 1.2pp」——一个变量翻转结论**；③ agent 自记忆（42%）弱于朴素检索（47%）；④ 增益很窄且成本未计入（2/6 题型打平却花 **50 倍成本**），建议「比较时固定 embedding 模型、按模型族分层、在归因架构前先报写入路径成本」。[Diagnosing Retrieval vs. Utilization](https://arxiv.org/abs/2603.02473)（ICLR 2026 MemAgents Workshop，正文 v2）在 **LoCoMo 的 1,540 道非对抗题、k=5** 上给出：检索方法之间准确率跨 **14–23 个点**（Table 1 里 cos/BM25/hybrid 三列），而写入策略之间只跨 **3–8 个点**；**「零次 LLM 调用的 raw 3-turn 分块」在 hybrid 检索下拿到 81.1%，反而高于 Mem0 式抽取事实的 77.3% 与 MemGPT 式摘要的 73.3%**；Precision@5 与准确率相关 r=0.98。**作者自陈的 caveat 必须一起引用**：单一 backbone（GPT-5-mini）、单一 benchmark（LoCoMo）、固定 k=5、写入策略是 prompt 级重实现而非完整系统、答案对错依赖 LLM judge；且摘要说跨度「20 点」而 Figure 2 说明写「14–23 点」，**论文自身口径也不一致**。→ 对我们的意义：**这两条不足以否定「写入判定」的价值（它们测的是 QA 准确率，不是误记率，而误记的代价是污染此后每个会话的提示），但足以要求我们在报写入指标时同时报检索侧、并固定 embedding/judge 口径**。

---

## 我们仍需自己做的部分

公开数据能给的到此为止。以下五件事**没有任何一个基准能替我们做**，只能人工：

1. **中文编码语料的「该不该记」标注。** 这就是正在进行的 `eval/labels/round1.csv`。公开数据里没有中文编码会话——Memora 是英文个人助理，PerLTQA 是中文虚构人物生平，CloneMem 是非对话数字痕迹，Mem-PAL 是 user–agent 个性化，Touchstone 是中文代谢健康。我们的分层抽样（`coding-signal` / `coding-plain` / `control` / `vetoed`）在公开数据里**没有对应物**，尤其 `vetoed` 那一层（量误杀率）是别人根本没做的。
2. **带类型的 pitfall / procedure / rejected。** LoCoMo 的 evidence turn 只告诉你「答案在哪一轮」，不告诉你「这是什么类型的教训」；Memora 的 `share_memory` 只是一个布尔；HaluMem 的 memory point 类型是 persona/event/relationship，与工程无关。**「工具 X 的第 N 次同签名失败才算坑」这条规则，公开数据里一个字都没有。**
3. **「前提」（precondition）这一类的正例与负例。** LongMemEval-V2 的 premise awareness 概念上是我们的约束/前提，但它的题面全是 Web/ServiceNow 界面。**「在当前部署成立、换一个环境就不成立的前提」这类中文样本只能自己攒。**
4. **召回侧的 query + 正解（中文）。** 我们 README 里 Hit@K / Recall@K 都还写着「待测」，就是因为缺这个。公开的中文 query 集只有 PerLTQA（合成、偏查表）、locomo-zh-500（**有 query 和正确 turn，但答案字段恒空、只是检索集**）与 Touchstone（100 题、单 fixture），**要么打折使用，要么就从真实使用里攒**——后者更贵但更有说服力。
5. **（建议加进计划的）「记住了之后有没有用上」的反事实证据。** 所有公开基准测的都是「答对没有」，只有 Memora 的 FAMA 沾到了「有没有误用过期记忆」的边。对我们来说更关键的是：「这条 pitfall 写进记忆之后，模型下一次还会不会重复犯同一个错」——**这个闭环公开数据一个都没有**，LongMemEval-V2 也只是 QA 对错。

---

## 未确认的点

1. **MemoryBank / SiliconFriend 是否真有中文语料**：论文摘要提到双语，但官方 repo 路径 `zjunlp/MemoryBank` clone 失败，本次只在二手来源里看到 `zhongwanjun/MemoryBank-SiliconFriend`。**未一手核验。**
2. **MemoryBench（THUIR）里中文实际占多大比例**：只核到代码里有中文 prompt 与 `bert-base-chinese`，**没有统计过数据里中文 case 的条数**。
3. **Memoria-Bench 的中文覆盖**：论文 Table 1 打了 ZH ✔，但数据拿不到，**无法核验**。
4. **所有 HF 数据集卡的许可/语言/gated 状态**：本机 `huggingface.co` 直连不可达，相关结论来自 hf-mirror 镜像或代理（已在正文逐处标注）。**若要写进对外材料，建议在能直连 HF 的环境复核这几处**：MemoryAgentBench、AMA-Bench、MemoryArena、LongMemEval-V2、`PerceNa/locomo-mc10`。
5. **各基准的美元估算**：全部标了「（估算）」，依据是公开单价 × 题数 × token 量级，**不是实跑账单**；HaluMem / MemoryArena / Memoria-Bench 的成本尤其粗。
6. **MemDelta 与 "Retrieval vs Utilization" 两篇的结论强度**：已核到**摘要与正文的部分章节**（Retrieval 那篇读到 Table 1 与 Limitations），但**未读全文**、未复算其数字；Retrieval 那篇的 judge prompt 原文未读到，因此**无法判断它的 77–81% 是否可与其它 arm 直接比**。
7. **`tau-bench-V`**：**未找到任何一手或二手来源**。唯一名称相近的是 τ-Voice（语音全双工），**推测是名称混淆，未证实**。
8. **MSC 数据本身的许可证**：ParlAI 代码是 MIT，但 `msc_v0.1.tar.gz` 的独立许可**未找到明确声明**。
9. **HaluMem 的 FMR 在我们场景下的可迁移性**：它的 distractor 是「AI 说了、用户没确认」，我们的干扰源还有「子代理的任务指令」（README 实测过的真实误记）——**这个映射是我（推断），未在任何论文里得到验证**。
10. **MemoryBank / MemDaily(MemSim) / RHELM / DialSim / CloneMem / Mem-PAL / CUE-Mem 的规模与许可**：均为未核验或仅二手，列在表里只为「候选池完整性」，**不可当作已核实事实引用**。其中 MemoryBank 的官方 repo 路径 `zjunlp/MemoryBank` clone 失败，只在二手里看到 `zhongwanjun/MemoryBank-SiliconFriend`。
11. **Mem0 vs Zep 争议的双方数字**：84% / 58.44% / 75.14% / 65.99% **一个都没有独立复算**，「篡改 prompt」「实现错误」均为对方指控；「863 条分歧全部单向」是第三方（竞品创始人）自述，其预印本我未拿到（issue 里 arXiv 号待补）。Mem0 官方 92.5% 用的是哪个 judge 模型/快照，**issue 里问了、无回复**。
12. **Zenodo 记录 `zenodo.org/records/20140856`**（"Per-question outcomes for M3 Memory on LongMemEval-M (n=500)"）：本环境**不可达**（解析为非公网 IP），其上传者、许可、文件清单、以及它和 LongMemEval-M（500 sessions）的口径关系，**一律未核实**。据此推出的任何结论都不要写。
13. **CLongEval 中文子集**：只核到 [mem0#28](https://github.com/mem0ai/memory-benchmarks/issues/28) 这个**未合并 PR** 的描述（70 段中文对话 / 358 题），**未核实**它是否就是同名 ACL Findings 2024 论文（长上下文理解基准）的同一份数据，也**未核实**任何成绩。
14. **LoCoMo 的 50 段对话原版**：README 说现版本是采样后的子集，**原版从未公开**，其类别分布与是否含非英语内容**无法核验**。
15. **`PerceNa/locomo-mc10` 的类别映射**：由一路子任务经代理下载 229MB 数据后逐行解析得出（本机不可直连 HF），另一路子任务因 HF 不可达未能复核；而**其数据卡片本身的措辞**也未直接读到。这条我倾向采信（与官方评分器、与 `evidence` 的 session 数特征一致），但**若要对外引用，请在能直连 HF 的环境复核一次**。另外注意：**这条映射错误并不是我们判定的唯一依据**——即便不看 mc10，论文枚举顺序 / 数据集真实标签 / Mem0 旧 issue / Mem0 现行代码 / OpenViking 仓库内部这五处已经互相矛盾。
