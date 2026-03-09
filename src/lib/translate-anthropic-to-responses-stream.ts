import type { AnthropicStreamEventData, AnthropicResponse } from "./anthropic-types.ts";
import { THINKING_PLACEHOLDER } from "./anthropic-types.ts";
import type {
  ResponseStreamEvent,
  ResponsesResult,
  ResponseOutputItem,
  ResponseOutputFunctionCall,
  ResponseOutputMessage,
  ResponseOutputReasoning,
} from "./responses-types.ts";

type OutputBlockInfo =
  | { type: "thinking"; outputIndex: number; thinkingText: string; signature: string }
  | { type: "text"; outputIndex: number; contentIndex: number }
  | { type: "tool_use"; outputIndex: number; toolCallId: string; toolName: string; toolArguments: string };

export interface AnthropicToResponsesStreamState {
  responseId: string;
  model: string;
  responseCreated: boolean;
  outputIndex: number;
  blockMap: Map<number, OutputBlockInfo>;
  accumulatedText: string;
  completedItems: ResponseOutputItem[];
  completed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

export function createAnthropicToResponsesStreamState(
  responseId: string,
  model: string,
): AnthropicToResponsesStreamState {
  return {
    responseId,
    model,
    responseCreated: false,
    outputIndex: 0,
    blockMap: new Map(),
    accumulatedText: "",
    completedItems: [],
    completed: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: undefined,
  };
}

export function translateAnthropicEventToResponsesEvents(
  event: AnthropicStreamEventData,
  state: AnthropicToResponsesStreamState,
): ResponseStreamEvent[] {
  if (state.completed) return [];

  switch (event.type) {
    case "message_start": return handleMessageStart(event, state);
    case "content_block_start": return handleContentBlockStart(event, state);
    case "content_block_delta": return handleContentBlockDelta(event, state);
    case "content_block_stop": return handleContentBlockStop(event, state);
    case "message_delta": return handleMessageDelta(event, state);
    case "message_stop": return handleMessageStop(state);
    case "ping": return [{ type: "ping" }];
    case "error": return handleError(event, state);
    default: return [];
  }
}

// deno-lint-ignore no-explicit-any
function handleMessageStart(event: any, state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  const message = event.message as AnthropicResponse;
  state.inputTokens = message.usage?.input_tokens ?? 0;
  state.cacheReadInputTokens = message.usage?.cache_read_input_tokens;

  if (state.responseCreated) return [];
  state.responseCreated = true;

  return [{
    type: "response.created",
    response: buildResult(state, "in_progress"),
  }];
}

// deno-lint-ignore no-explicit-any
function handleContentBlockStart(event: any, state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  const index: number = event.index;
  const contentBlock = event.content_block;
  const outputIdx = state.outputIndex++;

  if (contentBlock.type === "thinking") {
    state.blockMap.set(index, { type: "thinking", outputIndex: outputIdx, thinkingText: "", signature: "" });
    return [{
      type: "response.output_item.added",
      output_index: outputIdx,
      item: { type: "reasoning", id: `rs_${outputIdx}`, summary: [], encrypted_content: undefined } as ResponseOutputReasoning,
    }];
  }

  if (contentBlock.type === "text") {
    state.blockMap.set(index, { type: "text", outputIndex: outputIdx, contentIndex: 0 });
    return [{
      type: "response.output_item.added",
      output_index: outputIdx,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] } as ResponseOutputMessage,
    }];
  }

  if (contentBlock.type === "tool_use") {
    state.blockMap.set(index, { type: "tool_use", outputIndex: outputIdx, toolCallId: contentBlock.id, toolName: contentBlock.name, toolArguments: "" });
    return [{
      type: "response.output_item.added",
      output_index: outputIdx,
      item: { type: "function_call", call_id: contentBlock.id, name: contentBlock.name, arguments: "", status: "in_progress" } as ResponseOutputFunctionCall,
    }];
  }

  return [];
}

// deno-lint-ignore no-explicit-any
function handleContentBlockDelta(event: any, state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  const info = state.blockMap.get(event.index as number);
  if (!info) return [];
  const delta = event.delta;

  if (delta.type === "thinking_delta" && info.type === "thinking") {
    info.thinkingText += delta.thinking;
    return [{
      type: "response.reasoning_summary_text.delta",
      output_index: info.outputIndex,
      summary_index: 0,
      delta: delta.thinking,
    }];
  }

  if (delta.type === "signature_delta" && info.type === "thinking") {
    info.signature += delta.signature;
    return []; // signature is sent with output_item.done, not streamed
  }

  if (delta.type === "text_delta" && info.type === "text") {
    state.accumulatedText += delta.text;
    return [{
      type: "response.output_text.delta",
      output_index: info.outputIndex,
      content_index: info.contentIndex,
      delta: delta.text,
    }];
  }

  if (delta.type === "input_json_delta" && info.type === "tool_use") {
    info.toolArguments += delta.partial_json;
    return [{
      type: "response.function_call_arguments.delta",
      output_index: info.outputIndex,
      delta: delta.partial_json,
    }];
  }

  return [];
}

// deno-lint-ignore no-explicit-any
function handleContentBlockStop(event: any, state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  const info = state.blockMap.get(event.index as number);
  if (!info) return [];
  state.blockMap.delete(event.index as number);

  const events: ResponseStreamEvent[] = [];

  if (info.type === "thinking") {
    // Parse signature: native Claude has no "@", Responses-origin has "encrypted@id"
    const encryptedContent = info.signature.includes("@") ? info.signature.split("@")[0] : info.signature;
    const reasoningId = info.signature.includes("@") ? info.signature.split("@")[1] : `rs_${info.outputIndex}`;
    const summaryText = info.thinkingText === THINKING_PLACEHOLDER ? "" : info.thinkingText;

    if (summaryText) {
      events.push({ type: "response.reasoning_summary_text.done", output_index: info.outputIndex, summary_index: 0, text: summaryText });
    }
    const item: ResponseOutputReasoning = {
      type: "reasoning", id: reasoningId,
      summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
      encrypted_content: encryptedContent || undefined,
    };
    state.completedItems.push(item);
    events.push({ type: "response.output_item.done", output_index: info.outputIndex, item });
  } else if (info.type === "text") {
    events.push({ type: "response.output_text.done", output_index: info.outputIndex, content_index: info.contentIndex, text: state.accumulatedText });
    const item: ResponseOutputMessage = { type: "message", role: "assistant", content: [{ type: "output_text", text: state.accumulatedText }] };
    state.completedItems.push(item);
    events.push({ type: "response.output_item.done", output_index: info.outputIndex, item });
  } else if (info.type === "tool_use") {
    events.push({ type: "response.function_call_arguments.done", output_index: info.outputIndex, arguments: info.toolArguments });
    const item: ResponseOutputFunctionCall = { type: "function_call", call_id: info.toolCallId, name: info.toolName, arguments: info.toolArguments, status: "completed" };
    state.completedItems.push(item);
    events.push({ type: "response.output_item.done", output_index: info.outputIndex, item });
  }

  return events;
}

// deno-lint-ignore no-explicit-any
function handleMessageDelta(event: any, state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  // Save usage from message_delta for the final response.completed event
  if (event.usage?.output_tokens != null) {
    state.outputTokens = event.usage.output_tokens;
  }
  return [];
}

function handleMessageStop(state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  if (state.completed) return [];
  state.completed = true;
  return [{ type: "response.completed", response: buildResult(state, "completed") }];
}

// deno-lint-ignore no-explicit-any
function handleError(event: any, state: AnthropicToResponsesStreamState): ResponseStreamEvent[] {
  state.completed = true;
  return [{ type: "error", message: event.error?.message ?? "An unexpected error occurred.", code: event.error?.type }];
}

function buildResult(state: AnthropicToResponsesStreamState, status: ResponsesResult["status"]): ResponsesResult {
  const totalInputTokens = state.inputTokens + (state.cacheReadInputTokens ?? 0);
  return {
    id: state.responseId,
    object: "response",
    model: state.model,
    output: state.completedItems,
    output_text: state.accumulatedText,
    status,
    usage: {
      input_tokens: totalInputTokens,
      output_tokens: state.outputTokens,
      total_tokens: totalInputTokens + state.outputTokens,
      ...(state.cacheReadInputTokens !== undefined && {
        input_tokens_details: { cached_tokens: state.cacheReadInputTokens },
      }),
    },
  };
}
