import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  UnconfiguredProvider,
  type ChatClient,
  type MessagesClient,
  type ToolSpec,
} from "./providers";

const tool: ToolSpec = {
  name: "submit_refund_assessment",
  description: "Submit it",
  parameters: { type: "object", properties: { reasoning: { type: "string" } }, required: ["reasoning"], additionalProperties: false },
};
const request = { system: "SYSTEM", user: "USER", tool };

function chat(message: Partial<OpenAI.Chat.ChatCompletionMessage>, finish_reason = "tool_calls") {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason, logprobs: null, message: { role: "assistant", content: null, refusal: null, ...message } }],
  } as unknown as OpenAI.Chat.ChatCompletion;
}

const toolCall = (name: string, args: string) => ({
  tool_calls: [{ id: "call_1", type: "function" as const, function: { name, arguments: args } }],
});

function openai(respond: () => Promise<OpenAI.Chat.ChatCompletion>, nativeOpenAI = true) {
  const create = vi.fn<ChatClient["chat"]["completions"]["create"]>(respond);
  const provider = new OpenAICompatibleProvider(
    { chat: { completions: { create } } },
    { name: nativeOpenAI ? "openai" : "gemini", model: "test-model", nativeOpenAI },
  );
  return { provider, create };
}

describe("OpenAICompatibleProvider", () => {
  it("sends system + user messages and the tool as a function, and returns the parsed arguments", async () => {
    const { provider, create } = openai(async () => chat(toolCall(tool.name, '{"reasoning":"ok"}')));
    expect(await provider.assess(request)).toEqual({ toolInput: { reasoning: "ok" } });

    const params = create.mock.calls[0][0];
    expect(params).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "USER" },
      ],
      tools: [{ type: "function", function: { name: tool.name, parameters: tool.parameters, strict: true } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    });
  });

  it("uses tool_choice auto and no strict flag for other OpenAI-compatible APIs", async () => {
    const { provider, create } = openai(async () => chat(toolCall(tool.name, "{}")), false);
    await provider.assess(request);
    const params = create.mock.calls[0][0];
    expect(params.tool_choice).toBe("auto");
    expect(params.tools?.[0]).not.toHaveProperty("function.strict");
  });

  it.each([
    ["no tool call", () => chat({ content: "I think it's fine" }, "stop"), "ai_no_assessment"],
    ["a different tool", () => chat(toolCall("other_tool", "{}")), "ai_no_assessment"],
    ["invalid JSON arguments", () => chat(toolCall(tool.name, "{not json")), "ai_invalid_assessment"],
    ["a refusal", () => chat({ refusal: "I can't help with that" }, "stop"), "ai_refused"],
    ["a content filter stop", () => chat({}, "content_filter"), "ai_refused"],
    ["truncation", () => chat({}, "length"), "ai_truncated"],
    ["no choices", () => ({ ...chat({}), choices: [] }) as unknown as OpenAI.Chat.ChatCompletion, "ai_no_assessment"],
  ])("reports %s as an error code", async (_label, respond, error) => {
    const { provider } = openai(async () => respond());
    expect(await provider.assess(request)).toMatchObject({ error });
  });

  it("maps API errors to their status", async () => {
    const { provider } = openai(async () => {
      throw new OpenAI.RateLimitError(429, undefined, "slow down", new Headers());
    });
    expect(await provider.assess(request)).toMatchObject({ error: "ai_api_error_429" });
  });

  it("maps other client failures (e.g. network, bad config) to ai_client_error", async () => {
    const { provider } = openai(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await provider.assess(request)).toEqual({ error: "ai_client_error", detail: "fetch failed" });
  });
});

describe("AnthropicProvider", () => {
  it("maps the tool to Anthropic's format and returns the tool_use input", async () => {
    const create = vi.fn<MessagesClient["beta"]["messages"]["create"]>(async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t", name: tool.name, input: { reasoning: "ok" } }],
    }) as unknown as Anthropic.Beta.BetaMessage);
    const provider = new AnthropicProvider({ beta: { messages: { create } } }, "claude-test");

    expect(await provider.assess(request)).toEqual({ toolInput: { reasoning: "ok" } });
    expect(create.mock.calls[0][0]).toMatchObject({
      model: "claude-test",
      system: "SYSTEM",
      messages: [{ role: "user", content: "USER" }],
      tools: [{ name: tool.name, strict: true, input_schema: tool.parameters }],
    });
  });
});

describe("UnconfiguredProvider", () => {
  it("reports ai_not_configured with the reason", async () => {
    expect(await new UnconfiguredProvider("No AI API key configured").assess()).toEqual({
      error: "ai_not_configured",
      detail: "No AI API key configured",
    });
  });
});
