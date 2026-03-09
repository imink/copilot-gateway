import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { copilotFetch, type CopilotFetchOptions } from "../lib/copilot.ts";
import { getEnv, getGithubTokenAsync } from "../middleware/auth.ts";
import { modelSupportsEndpoint } from "../lib/models-cache.ts";
import type { ResponsesPayload } from "../lib/responses-types.ts";
import type { AnthropicResponse } from "../lib/anthropic-types.ts";
import {
  translateResponsesToAnthropicPayload,
  translateAnthropicToResponsesResult,
} from "../lib/translate-responses.ts";
import {
  createAnthropicToResponsesStreamState,
  translateAnthropicEventToResponsesEvents,
} from "../lib/translate-anthropic-to-responses-stream.ts";
import { parseSSEStream } from "../lib/sse.ts";

function hasVision(payload: Record<string, unknown>): boolean {
  const input = payload.input;
  if (!Array.isArray(input)) return false;
  return input.some((item: Record<string, unknown>) =>
    item.type === "message" && Array.isArray(item.content) &&
    item.content.some((block: Record<string, unknown>) => block.type === "input_image" || block.type === "image")
  );
}

function getInitiator(payload: Record<string, unknown>): "user" | "agent" {
  const input = payload.input;
  if (!Array.isArray(input)) return "user";
  const lastItem = input[input.length - 1] as Record<string, unknown> | undefined;
  return lastItem?.type === "function_call_output" ? "agent" : "user";
}

/**
 * XXX: Workaround for Copilot API not supporting "custom" tool type.
 * Codex CLI sends apply_patch as { type: "custom", name: "apply_patch" },
 * but Copilot only understands "function" tools.
 */
function fixApplyPatchTools(payload: Record<string, unknown>): void {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] as Record<string, unknown>;
    if (t.type === "custom" && t.name === "apply_patch") {
      tools[i] = {
        type: "function",
        name: "apply_patch",
        description: "Use the `apply_patch` tool to edit files",
        parameters: {
          type: "object",
          properties: { patch: { type: "string", description: "The patch to apply" } },
          required: ["patch"],
          additionalProperties: false,
        },
        strict: false,
      };
    }
  }
}

/**
 * Fix Copilot API inconsistency: item IDs may differ between
 * response.output_item.added and response.output_item.done events.
 */
interface StreamIdTracker {
  outputItemIds: Map<number, string>;
}

function fixStreamIds(data: string, event: string | undefined, tracker: StreamIdTracker): string {
  if (event !== "response.output_item.added" && event !== "response.output_item.done") return data;

  try {
    const parsed = JSON.parse(data);
    const outputIndex = parsed.output_index;
    if (typeof outputIndex !== "number" || !parsed.item?.id) return data;

    if (event === "response.output_item.added") {
      tracker.outputItemIds.set(outputIndex, parsed.item.id);
      return data;
    }

    const originalId = tracker.outputItemIds.get(outputIndex);
    if (originalId && parsed.item.id !== originalId) {
      parsed.item.id = originalId;
      return JSON.stringify(parsed);
    }
    return data;
  } catch {
    return data;
  }
}

export const responses = async (c: Context) => {
  try {
    const payload = await c.req.json<Record<string, unknown>>();
    const githubToken = await getGithubTokenAsync();
    const accountType = getEnv("ACCOUNT_TYPE");
    const model = payload.model as string;

    const supportsResponses = await modelSupportsEndpoint(model, "/responses", githubToken, accountType);
    if (supportsResponses) {
      return await handleDirectResponses(c, payload, githubToken, accountType);
    }

    const supportsMessages = await modelSupportsEndpoint(model, "/v1/messages", githubToken, accountType);
    if (supportsMessages) {
      return await handleViaMessages(c, payload, githubToken, accountType);
    }

    return c.json({
      error: { message: `Model ${model} does not support the /responses endpoint.`, type: "invalid_request_error" },
    }, 400);
  } catch (e: unknown) {
    return c.json({ error: { message: e instanceof Error ? e.message : String(e), type: "api_error" } }, 502);
  }
};

async function handleDirectResponses(
  c: Context,
  payload: Record<string, unknown>,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  fixApplyPatchTools(payload);

  const resp = await copilotFetch(
    "/responses",
    { method: "POST", body: JSON.stringify(payload) },
    githubToken, accountType,
    { vision: hasVision(payload), initiator: getInitiator(payload) },
  );

  if (!resp.ok) {
    const text = await resp.text();
    return c.json(
      { error: { message: `Copilot API error: ${resp.status} ${text}`, type: "api_error" } },
      resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
    );
  }

  const contentType = resp.headers.get("content-type") ?? "application/json";
  if (!contentType.includes("text/event-stream") && payload.stream !== true) {
    return c.json(await resp.json());
  }

  if (!resp.body) {
    return c.json({ error: { message: "No response body from upstream", type: "api_error" } }, 502);
  }

  return streamSSE(c, async (stream) => {
    const idTracker: StreamIdTracker = { outputItemIds: new Map() };
    try {
      for await (const { event, data } of parseSSEStream(resp.body!)) {
        const fixedData = fixStreamIds(data, event || undefined, idTracker);
        await stream.writeSSE({ event: event || undefined, data: fixedData });
      }
    } catch (e) {
      console.error("Responses stream error:", e);
    }
  });
}

async function handleViaMessages(
  c: Context,
  payload: Record<string, unknown>,
  githubToken: string,
  accountType: string,
): Promise<Response> {
  fixApplyPatchTools(payload);

  const anthropicPayload = translateResponsesToAnthropicPayload(payload as unknown as ResponsesPayload);
  const fetchOptions: CopilotFetchOptions = {
    vision: hasVision(payload),
    initiator: getInitiator(payload),
  };

  const resp = await copilotFetch(
    "/v1/messages",
    { method: "POST", body: JSON.stringify(anthropicPayload) },
    githubToken, accountType, fetchOptions,
  );

  if (!resp.ok) {
    const text = await resp.text();
    return c.json(
      { error: { message: `Copilot API error: ${resp.status} ${text}`, type: "api_error" } },
      resp.status as 400 | 401 | 403 | 404 | 429 | 500 | 502 | 503,
    );
  }

  if (!anthropicPayload.stream) {
    return c.json(translateAnthropicToResponsesResult(await resp.json() as AnthropicResponse));
  }

  if (!resp.body) {
    return c.json({ error: { message: "No response body from upstream", type: "api_error" } }, 502);
  }

  return streamSSE(c, async (stream) => {
    const responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const state = createAnthropicToResponsesStreamState(responseId, anthropicPayload.model);

    try {
      for await (const { event: eventName, data } of parseSSEStream(resp.body!)) {
        const trimmed = data.trim();
        if (!trimmed) continue;

        // deno-lint-ignore no-explicit-any
        let parsed: any;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        if (eventName && !parsed.type) parsed.type = eventName;

        for (const event of translateAnthropicEventToResponsesEvents(parsed, state)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }

        if (state.completed) break;
      }
    } catch (e) {
      console.error("Responses→Messages reverse translation stream error:", e);
    }
  });
}
