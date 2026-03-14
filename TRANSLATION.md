# Chat Completions ↔ Anthropic Messages 翻译

## 背景

GitHub Copilot 上游对 Claude 模型的 Chat Completions → Messages 内置转换存在 bug：
1. 多 content block（text + tool_use）被拆成多个 `choices`
2. content 和 tool_calls 顺序错乱

本模块自行实现完整翻译：收到 Chat Completions 请求 → 转成 Anthropic Messages → 调 Copilot `/v1/messages` → 转回 Chat Completions 响应。

## 路由判断

通过模型的 `vendor` 字段判断是否走翻译路径：

```
vendor 包含 "anthropic" → 走 Messages API 翻译
否则 → 透传 /chat/completions（原有行为）
```

当 models 缓存不可用时，退回检查 `model.startsWith("claude")`。

---

## 请求翻译：Chat Completions → Anthropic Messages

文件：`translate-request.ts`，函数 `translateChatToMessages()`

### 消息分组

Chat Completions 的消息序列是扁平的，Anthropic 要求严格的 user/assistant 交替。转换规则：

| Chat Completions role | 处理方式 |
|---|---|
| `system` / `developer` | 提取到 Anthropic `system` 字段（多条用 `\n\n` 拼接） |
| `user` | 转为 Anthropic user message。如果前一条也是 user，合并 |
| `assistant` | 转为 Anthropic assistant message（见下方 content 组装） |
| `tool` | 转为 `tool_result` block 插入 user message。如果前一条是 user 则追加，否则新建 user message |

Tool 消息合并示例：
```
Chat Completions:  assistant(tool_calls) → tool → tool → user("thanks")
Anthropic:         assistant(tool_use blocks) → user([tool_result, tool_result, text("thanks")])
```

### Assistant content block 组装顺序

**严格按 thinking → text → tool_use 顺序**，修复上游乱序 bug。

```
1. thinking / redacted_thinking（如果有 reasoning 字段）
2. text（从 content 字段提取）
3. tool_use（从 tool_calls 字段转换）
```

### Thinking / Redacted Thinking 判定

根据 `reasoning_text` 和 `reasoning_opaque` 的有无区分：

| reasoning_text | reasoning_opaque | 生成的 block |
|---|---|---|
| 有 | 有 | `{ type: "thinking", thinking: text, signature: opaque }` |
| 有 | 无 | `{ type: "thinking", thinking: text }` |
| 无 | 有 | `{ type: "redacted_thinking", data: opaque }` |
| 无 | 无 | 不生成 thinking block |

### 其他字段映射

| Chat Completions | Anthropic Messages |
|---|---|
| `max_tokens`（缺省 8192） | `max_tokens` |
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `stop`（string 或 array） | `stop_sequences`（array） |
| `thinking_budget` | `thinking.budget_tokens`（设 `type: "enabled"`） |
| `tools` | `tools`（`function.parameters` → `input_schema`） |
| `tool_choice: "auto"` | `{ type: "auto" }` |
| `tool_choice: "none"` | `{ type: "none" }` |
| `tool_choice: "required"` | `{ type: "any" }` |
| `tool_choice: { function: { name } }` | `{ type: "tool", name }` |
| `stream_options` 等 | 丢弃（Anthropic 不需要） |

### 图片处理

User message 的 `content` 如果是 `ContentPart[]` 且含 `image_url`：
- `text` part → `{ type: "text", text }` block
- `image_url` part → 解析 `data:mediaType;base64,data` URL → `{ type: "image", source: { type: "base64", media_type, data } }` block

---

## 非流式响应翻译：Anthropic Messages → Chat Completions

文件：`translate-response.ts`，函数 `translateMessagesToChatCompletion()`

### Content blocks 拆解

从 Anthropic 响应的 `content` 数组中提取：

| Anthropic block | Chat Completions 字段 |
|---|---|
| `text` blocks | `message.content`（所有 text 拼接） |
| `tool_use` blocks | `message.tool_calls` |
| 第一个 `thinking` block | `message.reasoning_text` = thinking, `message.reasoning_opaque` = signature |
| 第一个 `redacted_thinking` block（无 thinking 时） | `message.reasoning_opaque` = data |

每次响应最多一个 thinking/redacted_thinking block（interleaved thinking 是跨 API 调用的，每次调用只有一个），所以不需要拼接。

### stop_reason 映射

| Anthropic | Chat Completions |
|---|---|
| `end_turn` | `stop` |
| `max_tokens` | `length` |
| `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |
| `pause_turn` | `stop` |
| `refusal` | `stop` |

### usage 映射

| Anthropic | Chat Completions |
|---|---|
| `input_tokens` + `cache_read_input_tokens` | `prompt_tokens` |
| `output_tokens` | `completion_tokens` |
| 两者之和 | `total_tokens` |
| `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |

---

## 流式翻译：Anthropic SSE → Chat Completions chunks

文件：`translate-stream.ts`

Chat Completions 流式格式：裸 `data:` 行（无 `event:` 字段），以 `data: [DONE]` 结束。

### 事件映射

| Anthropic 事件 | Chat Completions 输出 |
|---|---|
| `message_start` | 首个 chunk：`delta: { role: "assistant" }` |
| `content_block_start (thinking)` | 无输出（等 delta） |
| `content_block_start (redacted_thinking)` | `delta: { reasoning_opaque: data }`（整块发出，无后续 delta） |
| `content_block_start (text)` | 无输出（等 delta） |
| `content_block_start (tool_use)` | `delta: { tool_calls: [{ index, id, type, function: { name, arguments: "" } }] }` |
| `content_block_delta (thinking_delta)` | `delta: { reasoning_text: "..." }` |
| `content_block_delta (signature_delta)` | `delta: { reasoning_opaque: "..." }` |
| `content_block_delta (text_delta)` | `delta: { content: "..." }` |
| `content_block_delta (input_json_delta)` | `delta: { tool_calls: [{ index, function: { arguments: "..." } }] }` |
| `content_block_stop` | 无输出 |
| `message_delta` | `finish_reason` 设为映射值（+ usage 如果有） |
| `message_stop` | handler 层写 `data: [DONE]` |
| `ping` / `error` | 无输出 |

### 流式状态

```ts
interface ChatStreamState {
  messageId: string          // 从 message_start 获取
  model: string              // 从 message_start 获取
  created: number            // 时间戳
  toolCallIndex: number      // tool call 计数器（从 -1 开始）
  currentBlockType: string   // 当前 block 类型
  currentToolCallId: string  // 当前 tool call id
  currentToolCallName: string // 当前 tool call name
}
```

---

## Thinking Round-Trip 保障

核心原则：每次 API 响应最多一个 thinking block，不需要拼接或 JSON 序列化。

### 正常 thinking

```
响应: { type: "thinking", thinking: "...", signature: "abc" }
  ↓ 翻译
Chat Completions: { reasoning_text: "...", reasoning_opaque: "abc" }
  ↓ 客户端原样回传
Chat Completions 请求: { reasoning_text: "...", reasoning_opaque: "abc" }
  ↓ 翻译
Anthropic: { type: "thinking", thinking: "...", signature: "abc" }
```

### Redacted thinking

```
响应: { type: "redacted_thinking", data: "xyz" }
  ↓ 翻译
Chat Completions: { reasoning_opaque: "xyz" }  (无 reasoning_text)
  ↓ 客户端原样回传
Chat Completions 请求: { reasoning_opaque: "xyz" }  (无 reasoning_text)
  ↓ 翻译
Anthropic: { type: "redacted_thinking", data: "xyz" }
```

### Interleaved thinking（工具调用循环）

Interleaved thinking 跨多次 API 调用，每次调用产生一条 assistant message，天然拆分：

```
调用 1 → 响应: [thinking₁, tool_use₁]
  → Chat Completions msg: { reasoning_text: t₁, reasoning_opaque: s₁, tool_calls: [...] }

调用 2 → 响应: [thinking₂, tool_use₂]
  → Chat Completions msg: { reasoning_text: t₂, reasoning_opaque: s₂, tool_calls: [...] }

调用 3 → 响应: [thinking₃, text]
  → Chat Completions msg: { reasoning_text: t₃, reasoning_opaque: s₃, content: "..." }
```

### Thinking 开关

客户端控制。不设 `thinking_budget` 则不启用 thinking。Anthropic API 会自动处理历史消息中的 thinking blocks（graceful degradation），不需要代理层过滤。

---

## 文件清单

| 文件 | 职责 |
|---|---|
| `src/routes/chat-completions/handler.ts` | 路由判断 + 调用翻译 + 调用 Copilot API |
| `src/routes/chat-completions/translate-request.ts` | Chat Completions → Anthropic Messages |
| `src/routes/chat-completions/translate-response.ts` | Anthropic Messages → Chat Completions（非流式） |
| `src/routes/chat-completions/translate-stream.ts` | Anthropic SSE → Chat Completions chunks（流式） |
| `src/services/copilot/create-messages.ts` | 调用 Copilot `/v1/messages` 端点 |
| `src/routes/messages/anthropic-types.ts` | Anthropic API 类型定义 |
diff --git a/bun.lock b/bun.lock
index 20e895e..9ece875 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,5 +1,6 @@
 {
   "lockfileVersion": 1,
+  "configVersion": 0,
   "workspaces": {
     "": {
       "name": "copilot-api",
diff --git a/src/routes/chat-completions/handler.ts b/src/routes/chat-completions/handler.ts
index 04a5ae9..da5ae18 100644
--- a/src/routes/chat-completions/handler.ts
+++ b/src/routes/chat-completions/handler.ts
@@ -3,6 +3,12 @@ import type { Context } from "hono"
 import consola from "consola"
 import { streamSSE, type SSEMessage } from "hono/streaming"
 
+import type {
+  AnthropicResponse,
+  AnthropicStreamEventData,
+} from "~/routes/messages/anthropic-types"
+import type { Model } from "~/services/copilot/get-models"
+
 import { awaitApproval } from "~/lib/approval"
 import { checkRateLimit } from "~/lib/rate-limit"
 import { state } from "~/lib/state"
@@ -13,11 +19,19 @@ import {
   type ChatCompletionResponse,
   type ChatCompletionsPayload,
 } from "~/services/copilot/create-chat-completions"
+import { createMessages } from "~/services/copilot/create-messages"
+
+import { translateChatToMessages } from "./translate-request"
+import { translateMessagesToChatCompletion } from "./translate-response"
+import {
+  createChatStreamState,
+  translateAnthropicEventToChatChunks,
+} from "./translate-stream"
 
 export async function handleCompletion(c: Context) {
   await checkRateLimit(state)
 
-  let payload = await c.req.json<ChatCompletionsPayload>()
+  const payload = await c.req.json<ChatCompletionsPayload>()
   consola.debug("Request payload:", JSON.stringify(payload).slice(-400))
 
   // Find the selected model
@@ -39,15 +53,106 @@ export async function handleCompletion(c: Context) {
 
   if (state.manualApprove) await awaitApproval()
 
-  if (isNullish(payload.max_tokens)) {
-    payload = {
-      ...payload,
-      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
+  // Route Claude models through the Messages API
+  if (modelSupportsMessages(payload.model)) {
+    return await handleViaMessagesApi(c, payload)
+  }
+
+  // Non-Claude models: transparent proxy
+  return await handleViaCompletionsApi(c, payload, selectedModel)
+}
+
+function modelSupportsMessages(modelId: string): boolean {
+  const model = state.models?.data.find((m) => m.id === modelId)
+  if (model) {
+    return model.vendor.toLowerCase().includes("anthropic")
+  }
+  // Fallback when models cache is unavailable
+  return modelId.startsWith("claude")
+}
+
+async function handleViaMessagesApi(
+  c: Context,
+  payload: ChatCompletionsPayload,
+) {
+  const anthropicPayload = translateChatToMessages(payload)
+  consola.debug(
+    "Translated Anthropic request:",
+    JSON.stringify(anthropicPayload).slice(-400),
+  )
+
+  const response = await createMessages(anthropicPayload)
+
+  // Non-streaming
+  if (!payload.stream) {
+    const anthropicResponse = response as AnthropicResponse
+    consola.debug(
+      "Non-streaming Anthropic response:",
+      JSON.stringify(anthropicResponse).slice(-400),
+    )
+    const chatResponse = translateMessagesToChatCompletion(anthropicResponse)
+    consola.debug(
+      "Translated Chat Completions response:",
+      JSON.stringify(chatResponse).slice(-400),
+    )
+    return c.json(chatResponse)
+  }
+
+  // Streaming
+  consola.debug("Streaming Anthropic response")
+  const streamResponse = response as AsyncGenerator<{
+    data?: string
+    event?: string
+  }>
+
+  return streamSSE(c, async (stream) => {
+    const streamState = createChatStreamState()
+
+    for await (const rawEvent of streamResponse) {
+      if (!rawEvent.data) continue
+
+      consola.debug("Anthropic stream event:", JSON.stringify(rawEvent))
+
+      let eventData: AnthropicStreamEventData
+      try {
+        eventData = JSON.parse(rawEvent.data) as AnthropicStreamEventData
+      } catch {
+        continue
+      }
+
+      const result = translateAnthropicEventToChatChunks(eventData, streamState)
+
+      if (result === "DONE") {
+        await stream.writeSSE({ data: "[DONE]" })
+        break
+      }
+
+      for (const chunk of result) {
+        consola.debug("Chat Completions chunk:", JSON.stringify(chunk))
+        await stream.writeSSE({ data: JSON.stringify(chunk) })
+      }
     }
-    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
+  })
+}
+
+async function handleViaCompletionsApi(
+  c: Context,
+  payload: ChatCompletionsPayload,
+  selectedModel: Model | undefined,
+) {
+  const finalPayload =
+    isNullish(payload.max_tokens) ?
+      {
+        ...payload,
+        max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
+      }
+    : payload
+
+  if (finalPayload.max_tokens !== payload.max_tokens) {
+    consola.debug("Set max_tokens to:", JSON.stringify(finalPayload.max_tokens))
   }
 
-  const response = await createChatCompletions(payload)
+  const response = await createChatCompletions(finalPayload)
 
   if (isNonStreaming(response)) {
     consola.debug("Non-streaming response:", JSON.stringify(response))
diff --git a/src/routes/messages/anthropic-types.ts b/src/routes/messages/anthropic-types.ts
index 881fffc..082e862 100644
--- a/src/routes/messages/anthropic-types.ts
+++ b/src/routes/messages/anthropic-types.ts
@@ -56,6 +56,12 @@ export interface AnthropicToolUseBlock {
 export interface AnthropicThinkingBlock {
   type: "thinking"
   thinking: string
+  signature?: string
+}
+
+export interface AnthropicRedactedThinkingBlock {
+  type: "redacted_thinking"
+  data: string
 }
 
 export type AnthropicUserContentBlock =
@@ -67,6 +73,7 @@ export type AnthropicAssistantContentBlock =
   | AnthropicTextBlock
   | AnthropicToolUseBlock
   | AnthropicThinkingBlock
+  | AnthropicRedactedThinkingBlock
 
 export interface AnthropicUserMessage {
   role: "user"
@@ -134,6 +141,7 @@ export interface AnthropicContentBlockStartEvent {
         input: Record<string, unknown>
       })
     | { type: "thinking"; thinking: string }
+    | { type: "redacted_thinking"; data: string }
 }
 
 export interface AnthropicContentBlockDeltaEvent {
diff --git a/src/services/copilot/create-chat-completions.ts b/src/services/copilot/create-chat-completions.ts
index 8534151..1159c0a 100644
--- a/src/services/copilot/create-chat-completions.ts
+++ b/src/services/copilot/create-chat-completions.ts
@@ -72,6 +72,8 @@ export interface ChatCompletionChunk {
 interface Delta {
   content?: string | null
   role?: "user" | "assistant" | "system" | "tool"
+  reasoning_text?: string
+  reasoning_opaque?: string
   tool_calls?: Array<{
     index: number
     id?: string
@@ -113,6 +115,8 @@ interface ResponseMessage {
   role: "assistant"
   content: string | null
   tool_calls?: Array<ToolCall>
+  reasoning_text?: string
+  reasoning_opaque?: string
 }
 
 interface ChoiceNonStreaming {
@@ -148,6 +152,7 @@ export interface ChatCompletionsPayload {
     | { type: "function"; function: { name: string } }
     | null
   user?: string | null
+  thinking_budget?: number | null
 }
 
 export interface Tool {
@@ -166,6 +171,8 @@ export interface Message {
   name?: string
   tool_calls?: Array<ToolCall>
   tool_call_id?: string
+  reasoning_text?: string
+  reasoning_opaque?: string
 }
 
 export interface ToolCall {
