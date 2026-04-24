// Vercel AI Gateway-backed InferFn compatible with createAgent.
// Routes every completion through the Gateway, which proxies
// `<provider>/<model>` ids to the configured upstream — no client-side
// dispatch table. Auth is a standard `Authorization: Bearer` header.
//
// The terminal render adapter (`render-adapter.ts`) has already folded
// fragments into a provider-ready `ProviderContext` before we see it;
// the work here is translating that context into AI SDK
// `ModelMessage[]` and handing it to `generateText`.

import {
  createGateway,
  generateText,
  jsonSchema,
  type AssistantModelMessage,
  type JSONSchema7,
  type ModelMessage,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolSet,
} from "ai";

import type {
  InferFn,
  InferResponse,
  ProviderContentChunk,
  ProviderContext,
  ProviderOptions,
  ProviderMessage,
  ToolDefinition,
} from "../types";

// Per-call usage breakdown. Cache metrics surface when the upstream
// provider reports them and the Gateway forwards them through the
// response (Anthropic, OpenAI, etc.).
export interface AiGatewayUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AiGatewayOptions {
  apiKey: string;
  // Canonical AI Gateway `<provider>/<model>` id. Any string the
  // Gateway accepts works — e.g. `openai/gpt-5-mini`,
  // `anthropic/claude-opus-4.7`, `google/gemini-2.5-flash-lite`.
  model: string;
  providerOptions?: ProviderOptions;
  temperature?: number;
  maxTokens?: number;
  spend?: { usd: number };
  costPer1k?: { input: number; output: number };
  onUsage?: (usage: AiGatewayUsage) => void;
  // Retry when a response comes back with empty content AND no tool
  // calls — some providers occasionally return a blank choice on
  // well-formed requests.
  retryOnEmpty?: { maxAttempts: number };
  // Custom fetch for testing / request interception.
  fetch?: typeof fetch;
}

const DEFAULT_COST_PER_1K = { input: 0.00025, output: 0.002 };

// Flatten ProviderContentChunks to plain text parts. Cache-control
// markers from `ProviderContentChunk.cacheControl` are dropped on this
// path — the AI SDK's `providerOptions` type is strict and the Gateway
// routes cache hints differently per upstream anyway. When caching
// across the Gateway becomes load-bearing we'll add a proper
// per-provider mapping here; for now OpenAI's automatic prefix caching
// on gpt-5.x handles the common case at zero setup.
function chunksToParts(
  content: string | ReadonlyArray<ProviderContentChunk>,
): string | Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content;
  return content.map((c) => ({ type: "text" as const, text: c.text }));
}

function messageToModel(msg: ProviderMessage): ModelMessage {
  if (msg.role === "user") {
    const content = chunksToParts(msg.content);
    return { role: "user", content: typeof content === "string" ? content : content };
  }
  if (msg.role === "assistant") {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: Exclude<AssistantModelMessage["content"], string> = [];
      const textContent = chunksToParts(msg.content);
      if (typeof textContent === "string") {
        if (textContent.length > 0) parts.push({ type: "text", text: textContent });
      } else {
        for (const p of textContent) parts.push(p);
      }
      for (const tc of msg.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }
        const call: ToolCallPart = {
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input,
        };
        parts.push(call);
      }
      return { role: "assistant", content: parts };
    }
    const content = chunksToParts(msg.content);
    return { role: "assistant", content };
  }
  // tool
  const toolText =
    typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.text).join("");
  const toolMsg: ToolModelMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: msg.toolCallId,
        toolName: "",
        output: { type: "text", value: toolText },
      },
    ],
  };
  return toolMsg;
}

function contextToModelMessages(context: ProviderContext): ModelMessage[] {
  return context.messages.map(messageToModel);
}

function systemToString(
  system: ProviderContext["system"],
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  const joined = system.map((c) => c.text).join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

function toolsToSet(tools: ReadonlyArray<ToolDefinition>): ToolSet | undefined {
  if (tools.length === 0) return undefined;
  const out: ToolSet = {};
  for (const t of tools) {
    out[t.name] = {
      type: "dynamic",
      description: t.description,
      inputSchema: jsonSchema(t.parameters as JSONSchema7),
    };
  }
  return out;
}

function isEmptyResponse(r: InferResponse): boolean {
  const hasContent = r.content.length > 0;
  const hasToolCalls = !!r.tool_calls && r.tool_calls.length > 0;
  return !hasContent && !hasToolCalls;
}

export function createAiGatewayInfer(opts: AiGatewayOptions): InferFn {
  const {
    apiKey,
    model,
    providerOptions,
    // Leave temperature + maxTokens unset by default. Newer OpenAI
    // models (gpt-5.x) reject any non-default temperature AND reject
    // `max_tokens` in favor of `max_completion_tokens`; letting the
    // provider pick its own defaults sidesteps both.
    temperature,
    maxTokens,
    spend,
    costPer1k = DEFAULT_COST_PER_1K,
    onUsage,
    retryOnEmpty = { maxAttempts: 2 },
  } = opts;
  const maxAttempts = Math.max(1, retryOnEmpty.maxAttempts);
  void maxTokens;

  const gateway = createGateway({
    apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const languageModel = gateway(model);

  return async (context): Promise<InferResponse> => {
    const system = systemToString(context.system);
    const messages = contextToModelMessages(context);
    const toolSet = toolsToSet(context.tools);

    let last: InferResponse = { content: "" };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await generateText({
        model: languageModel,
        ...(system !== undefined ? { system } : {}),
        messages,
        ...(providerOptions ? { providerOptions } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        tools: toolSet,
      });

      const usage = res.usage;
      const promptTok = usage.inputTokens ?? 0;
      const outTok = usage.outputTokens ?? 0;
      const cacheRead = usage.cachedInputTokens ?? 0;
      const cacheWrite = 0;
      const nonCachedInput = Math.max(0, promptTok - cacheRead);
      if (spend) {
        spend.usd +=
          (nonCachedInput / 1000) * costPer1k.input +
          (cacheRead / 1000) * costPer1k.input * 0.1 +
          (cacheWrite / 1000) * costPer1k.input * 1.25 +
          (outTok / 1000) * costPer1k.output;
      }
      if (onUsage) {
        onUsage({ input: nonCachedInput, output: outTok, cacheRead, cacheWrite });
      }

      const toolCalls =
        res.toolCalls && res.toolCalls.length > 0
          ? res.toolCalls.map((tc) => ({
              id: tc.toolCallId,
              type: "function" as const,
              function: {
                name: tc.toolName,
                arguments: JSON.stringify(tc.input ?? {}),
              },
            }))
          : undefined;

      last = {
        content: res.text ?? "",
        tool_calls: toolCalls,
      };

      if (!isEmptyResponse(last)) return last;
    }
    return last;
  };
}
