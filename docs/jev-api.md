# Jev（TypeSafe System One）线上调用契约参考

> 调研对象：TypeSafe AI 的 **Jev** 判定模型（System One）。
> 调研时间：本文所述内容以 2026-09 前后的官方文档与 `@typesafe-ai/sdk@0.6.0` 实际包内容为准。
> 约定：每条结论后附出处链接；凡是从 SDK 源码/类型声明推断而非官方文档明写的，标注 **(推断)**。
> 本文件只做调研记录，不含客户端实现代码。

---

## 结论摘要

1. 调用是**单次同步 HTTP POST**：`POST https://api.typesafe.ai/v1/systemone`，无流式、无生成文本。[官方](https://docs.typesafe.ai/api)
2. 鉴权用 `Authorization: Bearer <API_KEY>`，另有 `Content-Type: application/json`；**没有 org id / project id 概念**。[官方](https://docs.typesafe.ai/api)
3. 请求体三个必填字段：`state`（string|object|array）、`model`、`questions`（map<string, Question>）。[官方](https://docs.typesafe.ai/api)
4. 三个原语确认无误：`noul`（是/否概率）、`choice`（枚举选一+全分布）、`score`（有序 rubric 打分）。[官方](https://docs.typesafe.ai/primitives)
5. 一次请求可问任意多个问题（同一 `state`，并行评估），把整棵决策树的问题都塞进去是官方推荐做法。[官方](https://docs.typesafe.ai/patterns/fan-out)
6. 响应把答案放在 `answers` 下、用你给的 question key 回填；`noul` 回答直接是 0..1 浮点数，`choice`/`score` 还带 `confidence` 与 `probabilities`。[官方](https://docs.typesafe.ai/api)
7. JS 包 `@typesafe-ai/sdk`（当前 latest **0.6.0**，Node ≥ 20，零运行时依赖）；Python 包 `typesafe-sdk`（当前 **0.7.2**，Python ≥ 3.10）。[npm](https://www.npmjs.com/package/@typesafe-ai/sdk) / [PyPI](https://pypi.org/project/typesafe-sdk/)
8. 模型别名 `jev-latest` → 版本化 id `jev-1.13.0`；Vercel AI Gateway 上叫 `typesafe-ai/jev`。[官方](https://docs.typesafe.ai/models) / [Vercel](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
9. 硬上限：context 64k tokens/请求（`state` + 最长单问 ≤ 32k）；Choice 最多 255 个选项；Score 2–10 档。[官方](https://docs.typesafe.ai/models) / [官方](https://docs.typesafe.ai/api)
10. 延迟量级约 **114ms/次**（官方 8 问 rubric 基准的实测均值），计费只算 input token，$42 / Btok（$0.042 / Mtok），output 免费。[官方](https://docs.typesafe.ai/models)

---

## HTTP 契约

### 端点

| 项 | 值 | 出处 |
| --- | --- | --- |
| Base URL | `https://api.typesafe.ai` | [官方 API reference](https://docs.typesafe.ai/api) |
| Endpoint | `POST /v1/systemone` | [官方 API reference](https://docs.typesafe.ai/api) |
| Method | `POST` | [官方 API reference](https://docs.typesafe.ai/api) |
| 列模型端点 | `GET /v1/models`（返回该账号可用的模型名 + 描述 + 发布日期） | [官方 Models](https://docs.typesafe.ai/models) |

官方给出的完整请求头形态（**官方文档示例**）：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

除文档列出的这两个头之外，官方 JS SDK 实际还会发送以下头（**从 SDK 源码推断**，非文档要求，自己手写 HTTP 客户端时**不必**发送）：

| Header | 值 | 出处 |
| --- | --- | --- |
| `Authorization` | `Bearer ${apiKey}` | **(推断)** [SDK 编译产物 index.mjs](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts) |
| `Accept` | `application/json` | **(推断)** 同上 |
| `User-Agent` | `typesafe-sdk/0.6.0` | **(推断)** 同上 |
| `X-TypeSafe-SDK` | `typesafe-sdk/0.6.0` | **(推断)** 同上 |
| `X-TypeSafe-Runtime` | 运行时名/版本/平台 | **(推断)** 同上 |
| `Content-Type` | `application/json`（仅在带 body 时设置） | **(推断)** 同上 |
| `X-TypeSafe-Retry-Count` | 重试次数（重试时才有） | **(推断)** 同上 |

SDK 会从响应头读 `x-typesafe-request-id` 作为 request id，建议自己写客户端时也记录下来便于排障。[SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/api-promise.ts) **(推断)**

### 请求体 JSON 结构

顶层三个字段（**官方字段定义**，示例为官方文档示例）：[官方 API reference](https://docs.typesafe.ai/api)

- `state`（必填）`string | object | array`：被评估的内容。字符串用于纯文本；object/array 用于对话记录、业务记录、应用状态等结构化上下文。[官方 State](https://docs.typesafe.ai/concepts/state)
- `model`（必填）`string`：如 `"jev-latest"`。[官方 Models](https://docs.typesafe.ai/models)
- `questions`（必填）`map<string, Question>`：你自己起的 key。**这个 key 不会发给模型、不参与推理**，只用于把答案带回来。[官方 API reference](https://docs.typesafe.ai/api)

三种 Question 的字段：

| 类型 | `type` | `instructions` | `criteria` | 出处 |
| --- | --- | --- | --- | --- |
| Noul | `"noul"` | string \| object \| array | 可选：`{ "true": ..., "false": ... }` | [官方 API reference](https://docs.typesafe.ai/api) |
| Choice | `"choice"` | string \| object \| array | **必填**：`{ "<label>": <描述或 null> }`，最多 **255** 个选项 | [官方 API reference](https://docs.typesafe.ai/api) |
| Score | `"score"` | string \| object \| array | **必填**：有序数组，**2–10** 档 | [官方 API reference](https://docs.typesafe.ai/api) |

`instructions` 可以是 object/array：官方推荐把问题放一个字段、它需要引用的数据放其他字段，然后在问题里用反引号按名引用。**官方文档示例**：[官方 API reference](https://docs.typesafe.ai/api)

```json
"instructions": {
  "potential_duplicate": {
    "name": "John Smith",
    "location": "Oakland, California",
    "last_employer": "Google"
  },
  "question": "Is the resume for the same person as `potential_duplicate`?"
}
```

> 注意：SDK 类型声明把 `instructions` 标为可选（`instructions?: EntryType`），而 API reference 的字段表把它写成 required。**以文档为准 `instructions` 是必填**；SDK 允许省略是类型层面的宽松。**(推断)** 出处：[SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts) / [官方 API reference](https://docs.typesafe.ai/api)

### 完整可复制示例（请求）

以下请求为**官方文档示例的组合**（`state`/`model`/`questions` 结构、三个原语、`criteria` 写法均来自官方；把三问合并进同一次请求是官方 fan-out 推荐用法）：

```json
{
  "state": {
    "ticket": {
      "subject": "Duplicate charge",
      "messages": [
        { "from": "customer", "text": "I was charged twice for order A-104. Please refund the duplicate." },
        { "from": "support", "text": "We are checking the charges." }
      ]
    },
    "order": {
      "id": "A-104",
      "charges": [
        { "amount_usd": 49, "status": "captured" },
        { "amount_usd": 49, "status": "captured" }
      ]
    }
  },
  "model": "jev-latest",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": {
        "true": "Explicitly time-sensitive",
        "false": "No urgency expressed"
      }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

出处：[官方 API reference](https://docs.typesafe.ai/api)（`state` 对象形态来自[官方 State](https://docs.typesafe.ai/concepts/state)）

### 完整可复制示例（响应）

**官方文档示例**（字段与取值形态来自官方；三个 answer 合并呈现）：[官方 API reference](https://docs.typesafe.ai/api)

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": {
      "type": "noul",
      "noul": 0.95
    },
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
      "confidence": 0.81
    },
    "frustration": {
      "type": "score",
      "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.92
    }
  },
  "usage": { "input_tokens": 296, "output_tokens": 20 }
}
```

### 响应字段语义

| 字段 | 类型 | 语义 | 出处 |
| --- | --- | --- | --- |
| `model` | string | **实际应答的版本化 id**（如 `jev-1.13.0`），不是别名 | [官方 Models](https://docs.typesafe.ai/models) |
| `answers` | map<string, Answer> | 按你给的 question key 回填，一对一 | [官方 API reference](https://docs.typesafe.ai/api) |
| `answers.<id>.type` | `"noul" \| "choice" \| "score"` | 与问题类型一致 | [官方 API reference](https://docs.typesafe.ai/api) |
| Noul → `noul` | number 0..1 | 回答“是”的概率 | [官方 API reference](https://docs.typesafe.ai/api) |
| Choice → `choice` | string | 概率最高的那个 label | [官方 API reference](https://docs.typesafe.ai/api) |
| Choice → `probabilities` | map<label, number> | 每个选项的概率，**和为 1** | [官方 API reference](https://docs.typesafe.ai/api) |
| Choice → `confidence` | number 0..1 | 由概率分布派生的“果断程度” | [官方 Confidence](https://docs.typesafe.ai/confidence) |
| Score → `score` | number | 概率加权后的期望分，**可以落在档位之间**（示例 1.05） | [官方 API reference](https://docs.typesafe.ai/api) |
| Score → `legend` | map<string, string> | 档位序号（字符串 key）→ 你的档位描述 | [官方 API reference](https://docs.typesafe.ai/api) |
| Score → `probabilities` | map<string, number> | 每个档位的概率，key 是**字符串数字** | [官方 API reference](https://docs.typesafe.ai/api) |
| `usage.input_tokens` | integer | 输入 token 数（计费依据） | [官方 API reference](https://docs.typesafe.ai/api) |
| `usage.output_tokens` | integer | 输出 token 数（免费，但会返回） | [官方 Models](https://docs.typesafe.ai/models) |

> **没有 logprobs 字段**：Jev 的“置信度”是 `confidence`（Choice/Score 才有），不是 OpenAI 风格的 logprobs；Noul 答案除 `noul` 概率外**没有**独立的 confidence 字段。[官方 API reference](https://docs.typesafe.ai/api) / [官方 Confidence](https://docs.typesafe.ai/confidence)

### 一次问多个 / 批量候选

- **一次问多个问题**：支持，且是官方推荐。`questions` 里放多少个都行，所有问题**并行评估同一个 `state`**，加问题“通常对响应时间几乎没有影响”。[官方 fan-out](https://docs.typesafe.ai/patterns/fan-out)
- **一次判多条候选 / 批量**：**未找到官方说明**有原生 batch 数组字段。官方的做法是**把候选放进 `state`，然后每个候选起一个问题**，最后在代码里汇总。官方计数 cookbook 就是这个模式：对 `items[i]` 逐个问 Noul，再在代码里求和。[官方 jaggedness - Counting](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- **`none-of-the-above` / `other` 约束**：没有内建的特殊选项，但官方**建议你显式加一个 `other` 或 `none of the above` 选项**，以免输入不在你给的枚举里时被迫硬选。[官方 how-to-build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- **上限**：Choice 最多 255 个选项；Score 2–10 档。超 255 个候选需要分两次请求（官方给出了两阶段检索的写法）。[官方 how-to-build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)

### 错误响应

官方只给了状态码语义表，**未给出错误 JSON body 的具体字段名**：[官方 API reference](https://docs.typesafe.ai/api)

| 状态码 | 含义 | 出处 |
| --- | --- | --- |
| `400` | 请求无效（SDK 映射为 `BadRequestError`） | **(推断)** [SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/errors.ts) |
| `401` | API key 缺失或无效，检查 `Authorization` 头 | [官方 API reference](https://docs.typesafe.ai/api) |
| `403` | 无权限（SDK 映射为 `PermissionDeniedError`） | **(推断)** [SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/errors.ts) |
| `404` | 资源不存在（SDK 映射为 `NotFoundError`） | **(推断)** 同上 |
| `422` | 请求体校验失败（如缺必填字段、question 畸形）；**body 会指出出错字段** | [官方 API reference](https://docs.typesafe.ai/api) |
| `429` | 超限流，退避后重试 | [官方 API reference](https://docs.typesafe.ai/api) |
| `500–599` | 服务端失败（SDK 映射为 `InternalServerError`） | **(推断)** [SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/errors.ts) |
| `529` | TypeSafe 暂时过载，短暂延迟后重试 | [官方 API reference](https://docs.typesafe.ai/api) |

**从 SDK 源码推断**的错误 body 解析行为：按 `content-type` 判断，是 JSON 就 `JSON.parse`，否则返回原始文本；空 body 则 `undefined`。SDK 还把 `x-typesafe-request-id` 挂到错误对象上。[SDK 编译产物 index.mjs](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/errors.ts) **(推断)**

---

## 官方 SDK

### JavaScript / TypeScript

| 项 | 值 | 出处 |
| --- | --- | --- |
| 包名 | `@typesafe-ai/sdk` | [npm](https://www.npmjs.com/package/@typesafe-ai/sdk) |
| 当前版本 | **0.6.0**（`dist-tags.latest`；已发布版本 3 个；`v0.5.7` 是首个公开版） | [npm](https://www.npmjs.com/package/@typesafe-ai/sdk) / [官方 changelog](https://docs.typesafe.ai/sdk/javascript/changelog) |
| 运行时要求 | Node.js **≥ 20** | [官方 JS SDK](https://docs.typesafe.ai/sdk/javascript) / [package.json `engines`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/package.json) |
| 依赖 | **零运行时依赖**（`deps: none`）；自带 ESM + CJS + `.d.ts` | [npm](https://www.npmjs.com/package/@typesafe-ai/sdk) |
| 许可证 | MIT | [npm](https://www.npmjs.com/package/@typesafe-ai/sdk) |
| 仓库 | `github.com/typesafe-ai/typesafe-sdk-js` | [GitHub](https://github.com/typesafe-ai/typesafe-sdk-js) |

最小可用调用（**官方文档 + 官方 README 原样**，函数名 `choice` / `noul` / `score` 与客户端方法 `systemOne` 均来自真实包）：[官方 JS SDK](https://docs.typesafe.ai/sdk/javascript) / [官方 README](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/README.md)

```js
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // 读环境变量 TYPESAFE_API_KEY
const response = await client.systemOne({
  state: { document: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null,
      technical: null,
      other: null,
    }),
  },
});

console.log(response.answers.category.choice);
```

`noul` 与 `score` 的签名（来自包内 `.d.ts`，非臆造）：[SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/questions.ts)

- `noul(instructions?, criteria?)` → `NoulQuestion`
- `choice(instructions, criteria)` → `ChoiceQuestion`
- `score(instructions, criteria)` → `ScoreQuestion`（`criteria` 是有序数组，≥2 项）

客户端配置（都可用环境变量，显式传参优先）：[SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 无（必填） | API key |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | API root |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | 默认模型 |
| `TYPESAFE_LOG_LEVEL` | `warn` | 日志级别 |

> **0.6.0 是 breaking change**：`Score.criteria` 从“以整数为 key 的字典”改成了**有序数组**。用旧写法会失败。[官方 changelog](https://docs.typesafe.ai/sdk/javascript/changelog)

### Python

| 项 | 值 | 出处 |
| --- | --- | --- |
| 包名 | `typesafe-sdk` | [PyPI](https://pypi.org/project/typesafe-sdk/) |
| 当前版本 | **0.7.2** | [PyPI](https://pypi.org/project/typesafe-sdk/) |
| Python 要求 | **≥ 3.10** | [PyPI](https://pypi.org/project/typesafe-sdk/) |
| 可选 extra | `typesafe-sdk[http2]` 启用 HTTP/2 | [官方 Python SDK](https://docs.typesafe.ai/sdk/python) |
| 仓库 | `github.com/typesafe-ai/typesafe-sdk-python` | [GitHub](https://github.com/typesafe-ai/typesafe-sdk-python) |

官方同步最小示例（**官方文档原样**）：[官方 quickstart](https://docs.typesafe.ai/introduction/quickstart)

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

client = TypeSafeClient()  # 读 TYPESAFE_API_KEY，默认 jev-latest

response = client.system_one(
    state=ticket,
    questions={
        "department": Choice(instructions="...", criteria={"billing": "..."}),
        "frustration": Score(instructions="...", criteria=["Calm", "Frustrated"]),
        "is_urgent": Noul(instructions="..."),
    },
)

print(response.answers["department"].choice)
```

> 注意 Python 侧响应对象同时提供**按类型分组**的便捷访问器 `response.nouls[...]` / `response.choices[...]` / `response.scores[...]`，也有统一的 `response.answers[...]`。两种写法在官方文档中都出现过。[官方 Python SDK](https://docs.typesafe.ai/sdk/python) / [官方 quickstart](https://docs.typesafe.ai/introduction/quickstart)

---

## 模型 id / 网关

### 直连 TypeSafe

| 项 | 值 | 出处 |
| --- | --- | --- |
| 当前版本 | **Jev 1.13**（版本化 id `jev-1.13.0`） | [官方 Models](https://docs.typesafe.ai/models) |
| 别名 `jev-latest` | → `jev-1.13.0`（最新稳定版，各 SDK 默认值） | [官方 Models](https://docs.typesafe.ai/models) |
| 别名 `jev-preview` | → `jev-1.13.0`（当前与 latest 相同，暂无 preview 构建） | [官方 Models](https://docs.typesafe.ai/models) |
| 请求里的 `model` | 别名或版本化 id 都接受 | [官方 Models](https://docs.typesafe.ai/models) |

> 官方明确提醒：**别名会随新版本发布而移动，答案可能在你不改代码的情况下变化**。响应里的 `model` 字段会回报实际应答的版本化 id，建议记录；如果阈值是针对某个版本调好的，就**钉住版本化 id**。[官方 Models](https://docs.typesafe.ai/models)

### Vercel AI Gateway

| 项 | 值 | 出处 |
| --- | --- | --- |
| 模型 id | **`typesafe-ai/jev`** | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) |
| TypeSafe 兼容 API base URL | `https://ai-gateway.vercel.sh/typesafe` | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) |
| 兼容端点 | `POST /typesafe/v1/systemone`、`GET /typesafe/v1/models` | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) |
| 原生 evaluation 端点 | `POST https://ai-gateway.vercel.sh/v1/evaluate` | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/modalities/evaluation) |
| 鉴权 | 同一个 `Authorization: Bearer <token>` 头；可用 AI Gateway API key 或 Vercel OIDC token | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) |
| AI SDK 要求 | 走 AI SDK 需要 **AI SDK 7+**，用 `experimental_evaluate` | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/modalities/evaluation) |

Vercel 侧有两种形态，**字段名不同，别混用**：

1. **TypeSafe 兼容 API**（`/typesafe/v1/systemone`）：请求/响应**沿用 TypeSafe 字段名**（`type: "noul"` → 回答 `noul`）。迁移只需换 base URL 和 API key。[Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
2. **原生 `/v1/evaluate` + AI SDK**：boolean 类型叫 **`boolean`**，回答字段是 **`probability`** 而不是 `noul`；usage 是驼峰 `inputTokens`/`outputTokens`，且多一个 `providerMetadata`（含路由与成本）。[Vercel 官方文档](https://vercel.com/docs/ai-gateway/modalities/evaluation)

```js
// 官方 Vercel 文档示例：把已有 TypeSafe client 指向网关
import { TypeSafeClient } from '@typesafe-ai/sdk';

const client = new TypeSafeClient({
  apiKey: process.env.AI_GATEWAY_API_KEY,
  baseURL: 'https://ai-gateway.vercel.sh/typesafe',
});
```

出处：[Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)

**未找到官方说明**：`typesafe-ai/jev` 在网关上对应的**具体版本号**（是否等于 `jev-1.13.0`）。Vercel 文档只给 slug，未给版本映射。

---

## 限制与运维

### 计费

| 项 | 值 | 出处 |
| --- | --- | --- |
| 价格 | **$42 / Btok**（= **$0.042 / Mtok**） | [官方 Models](https://docs.typesafe.ai/models) |
| 计费口径 | **按 input token 计费，output token 免费** | [官方 Models](https://docs.typesafe.ai/models) |
| 单次示例成本 | 约 `$0.00001155`（Vercel 网关回报值，对应 ~275 input tokens） | [Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) |
| 免费额度 | **未找到官方说明** | — |
| 自定义 / 企业档 | 更高限额需联系 `sales@typesafe.ai` | [官方 Models](https://docs.typesafe.ai/models) |

### 速率限制

| 项 | 值 | 出处 |
| --- | --- | --- |
| 速率限制 | **250,000 tokens/秒** 且 **1,200 请求/分钟** | [官方 Models](https://docs.typesafe.ai/models) |
| 超限表现 | `429 Too Many Requests` | [官方 Models](https://docs.typesafe.ai/models) |
| 官方提醒 | **限额在动态调整中**，需求量大，可能随时变化 | [官方 Models](https://docs.typesafe.ai/models) |

### 上下文与容量上限

| 项 | 值 | 出处 |
| --- | --- | --- |
| 单请求 context | **64k tokens**（`state` + 所有问题合计） | [官方 Models](https://docs.typesafe.ai/models) |
| 单问题预算 | `state` + **最长单个问题** ≤ **32k tokens** | [官方 Models](https://docs.typesafe.ai/models) |
| Choice 选项数 | 最多 **255** | [官方 API reference](https://docs.typesafe.ai/api) |
| Score 档位数 | **2–10** | [官方 API reference](https://docs.typesafe.ai/api) |
| 输入模态 | **仅文本**。string / JSON object / array of text。不支持图像、音频、视频 | [官方 Models](https://docs.typesafe.ai/models) |
| 语言 | 英文为主训语言、准确率最好；其他语言（含 CJK）**可用但更差**，需自测 | [官方 Models](https://docs.typesafe.ai/models) |

### 延迟量级

- 官方基准实测：`typesafe_choice`（**一次 8 问 rubric 调用**）平均往返 **114ms**；同基准下 GPT/Claude 系列为 826ms–13.0s。[官方 cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)
- 官方表述为“fast, structured decisions”，所有问题并行评估，**增加问题通常对响应时间影响很小**。[官方 fan-out](https://docs.typesafe.ai/patterns/fan-out)

### 超时建议

- **官方 JS SDK 默认**：`timeout` = **10000ms（10 秒）/每次尝试**，且**没有总重试预算**（即总耗时可能超过 10s）。[SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)
- 官方 Python 示例里多处显式写 `timeout=120.0`（120 秒）。[官方 cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)
- **(推断)** 考虑到 114ms 的典型延迟，10s 的 SDK 默认对绝大多数请求足够宽裕；若一次塞入极多问题导致 input 很大，建议按 Python 示例思路放宽到 30–120s。

### 重试策略（官方 JS SDK 默认值，可直接照抄）

| 项 | 默认值 | 出处 |
| --- | --- | --- |
| `maxRetries` | **2**（首次尝试之外的重试次数；`0` 关闭） | [SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts) |
| `backoffInitialMs` | **500**，每次翻倍 | 同上 |
| `backoffMaxMs` | **5000** | 同上 |
| `backoffJitter` | **0.25**（每个退避延迟随机扣减的比例） | 同上 |
| 触发重试的 HTTP 状态 | **408, 429, 500–599** | 同上 |
| `respectRetryAfter` | **true**，尊重 `Retry-After` 与 `retry-after-ms` | 同上 |
| `maxRetryAfterMs` | **60000**（服务端给的更长延迟则改用退避） | 同上 |
| `apiConnectionError` | true（重试连接失败，含响应体中断） | 同上 |
| `apiTimeoutError` | true（重试超时） | 同上 |

> 官方明确要求：遇到 `429` 或 `529` **用指数退避重试，不要立即重试**；用官方 SDK 则默认已处理。[官方 API reference](https://docs.typesafe.ai/api)

### 其他运维事实

- 数据不留存训练：**Jev 不用客户请求/响应做训练**；企业客户可谈 zero data retention (ZDR)。[官方 Models](https://docs.typesafe.ai/models)
- 不做微调/LoRA：**同一个权重服务所有账号**，靠请求里的 `state` + `instructions`/`criteria` 塑造行为。[官方 Models](https://docs.typesafe.ai/models)
- 直连 API 目前是 **early access（需 waitlist）**；Vercel 网关路径无需 waitlist。**(推断)** 该“early access / waitlist”说法来自第三方文章，非 TypeSafe 官方文档，请以 console 实际状态为准。[第三方 apidog](https://apidog.com/blog/jev-api-key/)

---

## 失败模式与官方建议

官方专门有一页 **"Jev 1.13 jaggedness"**，定义是：*"Jev isn't perfect. Here are some jagged edges we are aware of with jev-1.13."* —— 即**官方自曝的已知能力短板/不稳定边界**，不是随机 bug，而是模型特性。该页标注 **Applies to `jev-1.13`，最后审阅 2026-09-17**。[官方 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

总体定性：`jev-1.13` 快、概率校准好、常识判断强、**一致性极高**（语义相近输入给数量级相近的输出），但在需要**多层间接推理**和**数值精度**的任务上会退化，且**理解相当字面**。[官方 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

九类失败模式与官方推荐的应对：

| # | 失败模式 | 具体表现 | 官方建议 |
| --- | --- | --- | --- |
| 1 | **字面阅读 (Literal reading)** | 它回答你**写下的**问题，不是你**想表达的**。限定词、否定、隐含条件都按字面读 | 在 `instructions` 里写出确切条件；把边界情况写进 `criteria`；难以消歧时拆成两个字面问题再用代码组合 |
| 2 | **数学与数字 (Math and Numbers)** | 不是计算器。**计数不可靠**（字数、出现次数、长列表项数），错误随规模增长；语义表示优于数值表示（十六进制颜色、汇编、二进制都差） | **算术全部放代码里**。计数就让代码遍历候选、逐个问 Noul 再自己求和。**不要用 score 的期望值反推档位之间的精确数值** |
| 3 | **日期时间比较 (Date and time comparison)** | 把日期当文本而非有序量；比较先后、间隔、是否落在窗口内都不可靠，混合格式/相对引用/季度边界更糟 | 拆开：**抽取是判断，交给模型；算术不是，留在代码**。把日期的每个部件变成对枚举集合的 Choice（12 个月、31 天），并**显式提供 “not stated” 选项**；拼装真实日期及之后的一切由代码负责 |
| 4 | **间接推理 (Indirection)** | 双重否定、复杂间接、“属性的属性”这类多跳推理准确率下降 | 指令写得尽量直接；**尽可能按名字指出 `state` 里相关的部分** |
| 5 | **大 state 含无关细节 (Large state)** | 准确率随无关内容增长而下降；无关细节是干扰项，也让错误归因变难。官方称 Jev 有 **context rot** | **先在代码里检索/过滤**，只发问题需要的字段；实在不能过滤时，可以先用一个 Noul 做相关性筛选 |
| 6 | **对抗性内容 (Adversarial content)** | `state` 是**数据**，Jev 默认**不当作敌意输入**。注入指令、误导性框架、自我辩护文本都可能改变答案 | 在 `criteria` 里写得明确；**大规模部署前充分测试边界情况** |
| 7 | **指令与 criteria 矛盾** | `instructions` 和 `criteria` 要求不一致时会困惑。例如 Noul 里 `true` 描述成“否”、`false` 描述成“是”，表现更差 | 把 criteria 当作 instruction 的延伸，**两者用清晰精确的语言对齐**；以普通人能读懂为标准 |
| 8 | **常识性结构不变式 (Structural invariants)** | **不要假设结构恒等式成立**。同一问题用 Noul 与 yes/no Choice 问，结果不可直接互换；同一问题与其否定的两个 Noul，概率之和**不为 1**（官方示例：0.72 + 0.47 = 1.19） | 别依赖预期的结构不变性；**不要把一个在 Noul 上调好的阈值搬到 Choice 上**；别用算术恒等式约束不同问题。Choice 是**相对**的（选哪个），每个 Noul 是**绝对**的（可能全都很低） |
| 9 | **生成 (Generation)** | **Jev 不是为生成文本训练的**。靠串联 choice 硬逼它生成效果差且极慢 | 答案空间有界时，把抽取变成**对选项的 Choice**，而不是直接要值；真需要生成文本就用别的模型 |

官方在页末重申的“避免清单”：

- 不要让模型做**代码能精确计算**的事；
- 不要把**多个判断藏进一个问题**；
- 不要给它 **System Two 任务**（更多层间接推理）；
- **不要给超过问题所需的 `state` 上下文**（context rot 会损失准确率）。

出处：[官方 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

---

## 未确认的点

以下内容我**没有找到官方说明**，属于诚实标注的未知项，不要当作事实使用：

1. **API key 的前缀/形态**：官方文档只写 `<API_KEY>` 和从 [console.typesafe.ai/keys](https://console.typesafe.ai/keys) 获取，**未说明前缀**。第三方文章称形如 `ts_...`，但我在 TypeSafe 官方文档中**未找到佐证**，故不作为事实。[第三方 apidog](https://apidog.com/blog/jev-api-key/)（非官方）
2. **是否需要 org id / project id**：官方请求头与请求体里**都没有** org/project 字段，SDK 配置项也没有。因此推断**不需要**，但官方没有一句显式声明“不需要”。**(推断)**：[官方 API reference](https://docs.typesafe.ai/api) / [SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts)
3. **错误响应的 JSON body 具体结构（字段名）**：官方只给了状态码语义表，**没有给出错误 body 的 schema**（只提到 422 的 body "details the offending field"）。[官方 API reference](https://docs.typesafe.ai/api)
4. **免费额度 / 试用 credits**：官方 Models 页**未提及**免费额度；我只看到价格和“企业档联系 sales”。[官方 Models](https://docs.typesafe.ai/models)
5. **Vercel 网关 `typesafe-ai/jev` 对应的具体版本号**：Vercel 文档只给 slug，没有版本映射说明。[Vercel 官方文档](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
6. **原生批量（batch）请求字段**：**未找到**任何“一次请求提交多条独立候选并分别返回”的原生字段。官方模式是候选进 `state` + 每候选一个问题。[官方 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
7. **官方对超时值的书面建议**：没有专门的“建议 timeout”文档。可参考的只有 SDK 默认值（JS 10s）和官方示例里写的 120.0。[SDK 类型声明](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts) / [官方 cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)
8. **流式 / 异步任务 / webhook**：官方契约里**没有**任何流式或异步回调机制，全部是同步请求-响应。**(推断)** 基于文档未提及。
9. **`instructions` 到底必填还是可选**：文档字段表写 required，SDK 类型写可选，两者冲突，**未找到官方裁决**。见上文“请求体 JSON 结构”的注释。
10. **直连 API 当前是否仍需 waitlist**：TypeSafe 官方文档未提 waitlist；该说法来自第三方文章。[第三方 apidog](https://apidog.com/blog/jev-api-key/)（非官方）

---

## 来源汇总

- [TypeSafe API reference](https://docs.typesafe.ai/api) — 端点、请求/响应字段、错误码（最权威）
- [TypeSafe Models](https://docs.typesafe.ai/models) — 版本号、价格、限流、context 上限、别名
- [TypeSafe State](https://docs.typesafe.ai/concepts/state) — `state` 三种形态
- [TypeSafe Primitives](https://docs.typesafe.ai/primitives) / [Choice](https://docs.typesafe.ai/primitives/choice) / [Score](https://docs.typesafe.ai/primitives/score) / [Noul](https://docs.typesafe.ai/primitives/noul)
- [TypeSafe Confidence](https://docs.typesafe.ai/confidence) — probability 与 confidence 的区别
- [TypeSafe Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out) — 一次问多个问题
- [TypeSafe Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) — 失败模式（关键）
- [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart) — cURL / Python 最小示例
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) + [changelog](https://docs.typesafe.ai/sdk/javascript/changelog)
- [TypeSafe Python SDK](https://docs.typesafe.ai/sdk/python)
- [npm @typesafe-ai/sdk](https://www.npmjs.com/package/@typesafe-ai/sdk) — 版本 0.6.0、零依赖
- [GitHub typesafe-ai/typesafe-sdk-js](https://github.com/typesafe-ai/typesafe-sdk-js) — `.d.ts` 类型声明与 client 源码
- [PyPI typesafe-sdk](https://pypi.org/project/typesafe-sdk/) — 版本 0.7.2
- [Vercel: TypeSafe API with AI Gateway](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe) — `typesafe-ai/jev`、base URL、兼容端点
- [Vercel: Evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation) — `/v1/evaluate`、`boolean`/`probability`、AI SDK 7
- [Vercel changelog: AI Gateway supports TypeSafe clients and HTTP API for Jev](https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev)
