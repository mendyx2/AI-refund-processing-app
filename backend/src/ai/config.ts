/**
 * Chooses the LLM provider from environment variables, so any supported API
 * key can be plugged in. See README "Environment variables" and .env.example.
 *
 * Resolution order:
 *   1. AI_PROVIDER, if set, picks the provider explicitly.
 *   2. Otherwise the first provider-specific key found wins:
 *      ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY / GOOGLE_API_KEY.
 *   3. Otherwise AI_API_KEY is used: with AI_BASE_URL it is an OpenAI-compatible
 *      API; without, the provider is inferred from the key's prefix.
 * AI_MODEL overrides the provider's default model; AI_BASE_URL overrides the
 * endpoint of OpenAI-style providers.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  UnconfiguredProvider,
  type AssessmentProvider,
} from "./providers";

export const PROVIDERS = ["anthropic", "openai", "gemini", "openai-compatible"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/**
 * Defaults when AI_MODEL is not set. Models are retired over time; if a
 * default is unavailable to your account, set AI_MODEL to a current model that
 * supports tool/function calling.
 */
export const DEFAULT_MODELS: Record<Exclude<ProviderName, "openai-compatible">, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-4.1",
  gemini: "gemini-2.5-flash",
};

/** Google's OpenAI-compatible endpoint for Gemini. */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export type AiConfig =
  | { provider: ProviderName; apiKey: string; model: string; baseUrl?: string }
  | { provider: "none"; reason: string };

type Env = Record<string, string | undefined>;

/** Treats unset and blank values alike (compose passes `VAR=` for unset vars). */
const get = (env: Env, key: string) => {
  const v = env[key]?.trim();
  return v ? v : undefined;
};

/** Best-effort provider guess from a key's format. */
export function providerFromKey(key: string): Exclude<ProviderName, "openai-compatible"> | null {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("AIza")) return "gemini";
  if (key.startsWith("sk-")) return "openai";
  return null;
}

const KEY_VARS: Record<Exclude<ProviderName, "openai-compatible">, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function keyFor(env: Env, provider: ProviderName): string | undefined {
  const specific = provider === "openai-compatible" ? [] : KEY_VARS[provider];
  for (const name of [...specific, "AI_API_KEY"]) {
    const v = get(env, name);
    if (v) return v;
  }
  return undefined;
}

function build(env: Env, provider: ProviderName): AiConfig {
  const apiKey = keyFor(env, provider);
  const model = get(env, "AI_MODEL") ?? (provider === "openai-compatible" ? undefined : DEFAULT_MODELS[provider]);
  const baseUrl = get(env, "AI_BASE_URL") ?? (provider === "gemini" ? GEMINI_BASE_URL : undefined);

  if (provider === "openai-compatible") {
    if (!baseUrl) return { provider: "none", reason: "AI_PROVIDER=openai-compatible needs AI_BASE_URL" };
    if (!model) return { provider: "none", reason: "AI_PROVIDER=openai-compatible needs AI_MODEL" };
    // Local servers (Ollama, LM Studio) often need no key; the SDK still wants one.
    return { provider, apiKey: apiKey ?? "not-needed", model, baseUrl };
  }
  if (!apiKey) {
    const vars = [...KEY_VARS[provider], "AI_API_KEY"].join(" or ");
    return { provider: "none", reason: `AI_PROVIDER=${provider} but no API key set (${vars})` };
  }
  return { provider, apiKey, model: model!, ...(baseUrl ? { baseUrl } : {}) };
}

export function resolveAiConfig(env: Env): AiConfig {
  const explicit = get(env, "AI_PROVIDER")?.toLowerCase();
  if (explicit) {
    if (!(PROVIDERS as readonly string[]).includes(explicit)) {
      return { provider: "none", reason: `Unknown AI_PROVIDER "${explicit}" (expected ${PROVIDERS.join(", ")})` };
    }
    return build(env, explicit as ProviderName);
  }

  for (const provider of ["anthropic", "openai", "gemini"] as const) {
    if (KEY_VARS[provider].some((name) => get(env, name))) return build(env, provider);
  }

  const generic = get(env, "AI_API_KEY");
  if (generic) {
    if (get(env, "AI_BASE_URL")) return build(env, "openai-compatible");
    const guessed = providerFromKey(generic);
    if (guessed) return build(env, guessed);
    return {
      provider: "none",
      reason: "AI_API_KEY is set but its provider can't be inferred; set AI_PROVIDER (and AI_BASE_URL/AI_MODEL if needed)",
    };
  }
  return { provider: "none", reason: "No AI API key configured" };
}

export function createProvider(config: AiConfig): AssessmentProvider {
  switch (config.provider) {
    case "none":
      return new UnconfiguredProvider(config.reason);
    case "anthropic":
      return new AnthropicProvider(new Anthropic({ apiKey: config.apiKey }), config.model);
    case "openai":
    case "gemini":
    case "openai-compatible":
      return new OpenAICompatibleProvider(new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl }), {
        name: config.provider,
        model: config.model,
        nativeOpenAI: config.provider === "openai" && !config.baseUrl,
      });
  }
}

/** Safe to log or expose: never includes the key. */
export function describeAiConfig(config: AiConfig): { provider: string; model: string | null; configured: boolean } {
  return config.provider === "none"
    ? { provider: "none", model: null, configured: false }
    : { provider: config.provider, model: config.model, configured: true };
}
