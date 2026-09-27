/**
 * LLM provider adapters. Each one sends the same system prompt, user message
 * and tool definition, and returns the raw tool-call input (validated by the
 * AI layer) or an error code. Nothing here makes decisions: providers only
 * transport the request and report what came back.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

/** Provider-neutral function/tool definition (JSON Schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AssessRequest {
  system: string;
  user: string;
  tool: ToolSpec;
}

/**
 * `toolInput` is unvalidated model output. Error codes become review flags,
 * e.g. ai_api_error_429, ai_refused, ai_no_assessment, ai_not_configured.
 */
export type ProviderOutcome = { toolInput: unknown } | { error: string; detail?: string };

export interface AssessmentProvider {
  /** e.g. "anthropic", "openai", "gemini", "openai-compatible", "none". */
  readonly name: string;
  readonly model: string;
  assess(request: AssessRequest): Promise<ProviderOutcome>;
}

const detailOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Anthropic (Claude)
// ---------------------------------------------------------------------------

/** The one Anthropic SDK call used; injectable so tests can fake it. */
export interface MessagesClient {
  beta: {
    messages: {
      create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Beta.BetaMessage>;
    };
  };
}

export class AnthropicProvider implements AssessmentProvider {
  readonly name = "anthropic";

  constructor(
    private readonly client: MessagesClient,
    readonly model: string,
  ) {}

  async assess({ system, user, tool }: AssessRequest): Promise<ProviderOutcome> {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // Re-runs a safety-declined request on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      tools: [
        {
          name: tool.name,
          description: tool.description,
          strict: true,
          input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
        },
      ],
      // Forced tool_choice is incompatible with thinking; the prompt requires the
      // call, and a missing call is reported as ai_no_assessment.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: user }],
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(params);
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        return { error: `ai_api_error_${err.status ?? "network"}`, detail: err.message };
      }
      return { error: "ai_client_error", detail: detailOf(err) };
    }

    if (response.stop_reason === "refusal") return { error: "ai_refused" };
    if (response.stop_reason === "max_tokens") return { error: "ai_truncated" };

    const call = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === tool.name,
    );
    return call ? { toolInput: call.input } : { error: "ai_no_assessment" };
  }
}

// ---------------------------------------------------------------------------
// OpenAI and OpenAI-compatible APIs (Gemini, Groq, Mistral, DeepSeek,
// OpenRouter, Together, Ollama, LM Studio, ...)
// ---------------------------------------------------------------------------

/** The one OpenAI SDK call used; injectable so tests can fake it. */
export interface ChatClient {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      ): PromiseLike<OpenAI.Chat.ChatCompletion>;
    };
  };
}

export interface OpenAICompatibleOptions {
  /** Provider label for logs and the reasoning trace. */
  name: string;
  model: string;
  /**
   * OpenAI's own API supports strict schemas and forcing a specific function.
   * Compatible APIs vary, so for them the tool is offered with
   * tool_choice "auto" and no strict flag; a missing call is still caught.
   */
  nativeOpenAI: boolean;
}

export class OpenAICompatibleProvider implements AssessmentProvider {
  readonly name: string;
  readonly model: string;
  private readonly nativeOpenAI: boolean;

  constructor(
    private readonly client: ChatClient,
    options: OpenAICompatibleOptions,
  ) {
    this.name = options.name;
    this.model = options.model;
    this.nativeOpenAI = options.nativeOpenAI;
  }

  async assess({ system, user, tool }: AssessRequest): Promise<ProviderOutcome> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            ...(this.nativeOpenAI ? { strict: true } : {}),
          },
        },
      ],
      tool_choice: this.nativeOpenAI ? { type: "function", function: { name: tool.name } } : "auto",
    };

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(params);
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        return { error: `ai_api_error_${err.status ?? "network"}`, detail: err.message };
      }
      return { error: "ai_client_error", detail: detailOf(err) };
    }

    const choice = response.choices?.[0];
    if (!choice) return { error: "ai_no_assessment" };
    if (choice.message?.refusal || choice.finish_reason === "content_filter") return { error: "ai_refused" };
    if (choice.finish_reason === "length") return { error: "ai_truncated" };

    const call = choice.message?.tool_calls?.find(
      (c) => c.type === "function" && c.function.name === tool.name,
    );
    if (!call || call.type !== "function") return { error: "ai_no_assessment" };

    try {
      return { toolInput: JSON.parse(call.function.arguments) };
    } catch {
      return { error: "ai_invalid_assessment", detail: "Tool arguments were not valid JSON" };
    }
  }
}

// ---------------------------------------------------------------------------
// No provider configured
// ---------------------------------------------------------------------------

/** Used when no API key is set: every consultation reports ai_not_configured. */
export class UnconfiguredProvider implements AssessmentProvider {
  readonly name = "none";
  readonly model = "";

  constructor(readonly reason: string) {}

  async assess(): Promise<ProviderOutcome> {
    return { error: "ai_not_configured", detail: this.reason };
  }
}
