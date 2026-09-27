import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODELS,
  GEMINI_BASE_URL,
  OPENROUTER_BASE_URL,
  createProvider,
  describeAiConfig,
  providerFromKey,
  resolveAiConfig,
} from "./config";
import { AnthropicProvider, OpenAICompatibleProvider, UnconfiguredProvider } from "./providers";

describe("resolveAiConfig", () => {
  it("is unconfigured with no keys", () => {
    expect(resolveAiConfig({})).toEqual({ provider: "none", reason: "No AI API key configured" });
  });

  it("treats blank values as unset (compose passes VAR= for unset vars)", () => {
    expect(resolveAiConfig({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "  ", AI_PROVIDER: "" }).provider).toBe("none");
  });

  it.each([
    [{ ANTHROPIC_API_KEY: "a" }, "anthropic", DEFAULT_MODELS.anthropic],
    [{ OPENAI_API_KEY: "o" }, "openai", DEFAULT_MODELS.openai],
    [{ GEMINI_API_KEY: "g" }, "gemini", DEFAULT_MODELS.gemini],
    [{ GOOGLE_API_KEY: "g" }, "gemini", DEFAULT_MODELS.gemini],
  ])("detects the provider from a provider-specific key %j", (env, provider, model) => {
    expect(resolveAiConfig(env)).toMatchObject({ provider, model });
  });

  it("prefers Anthropic, then OpenAI, then Gemini when several keys are set", () => {
    expect(resolveAiConfig({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" }).provider).toBe("openai");
    expect(resolveAiConfig({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }).provider).toBe("anthropic");
  });

  it("points Gemini at Google's OpenAI-compatible endpoint", () => {
    expect(resolveAiConfig({ GEMINI_API_KEY: "g" })).toMatchObject({ baseUrl: GEMINI_BASE_URL, apiKey: "g" });
  });

  it("lets AI_PROVIDER choose explicitly, overriding key detection", () => {
    expect(resolveAiConfig({ AI_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toMatchObject({
      provider: "gemini",
      apiKey: "g",
    });
  });

  it("accepts the generic AI_API_KEY for an explicit provider", () => {
    expect(resolveAiConfig({ AI_PROVIDER: "OpenAI", AI_API_KEY: "k" })).toMatchObject({
      provider: "openai",
      apiKey: "k",
    });
  });

  it("uses AI_MODEL to override the default model", () => {
    expect(resolveAiConfig({ OPENAI_API_KEY: "o", AI_MODEL: "gpt-custom" })).toMatchObject({ model: "gpt-custom" });
  });

  it.each([
    ["sk-ant-api03-xyz", "anthropic"],
    ["sk-proj-abc", "openai"],
    ["AIzaSyXYZ", "gemini"],
  ])("infers the provider of a bare AI_API_KEY from its prefix (%s)", (key, provider) => {
    expect(resolveAiConfig({ AI_API_KEY: key })).toMatchObject({ provider, apiKey: key });
  });

  it("treats AI_API_KEY + AI_BASE_URL + AI_MODEL as an OpenAI-compatible API", () => {
    expect(
      resolveAiConfig({ AI_API_KEY: "gsk_x", AI_BASE_URL: "https://api.groq.com/openai/v1", AI_MODEL: "llama-x" }),
    ).toEqual({
      provider: "openai-compatible",
      apiKey: "gsk_x",
      model: "llama-x",
      baseUrl: "https://api.groq.com/openai/v1",
    });
  });

  it("routes an OpenRouter key (sk-or-) to OpenRouter, not OpenAI", () => {
    expect(resolveAiConfig({ AI_API_KEY: "sk-or-v1-abc", AI_MODEL: "google/gemma-x:free" })).toEqual({
      provider: "openai-compatible",
      apiKey: "sk-or-v1-abc",
      model: "google/gemma-x:free",
      baseUrl: OPENROUTER_BASE_URL,
    });
    expect(
      resolveAiConfig({ AI_PROVIDER: "openai-compatible", AI_API_KEY: "sk-or-v1-abc", AI_MODEL: "m" }),
    ).toMatchObject({ baseUrl: OPENROUTER_BASE_URL });
  });

  it("still needs AI_MODEL for an OpenRouter key", () => {
    expect(resolveAiConfig({ AI_API_KEY: "sk-or-v1-abc" })).toMatchObject({
      provider: "none",
      reason: expect.stringMatching(/AI_MODEL/),
    });
  });

  it("allows a keyless local OpenAI-compatible server (Ollama, LM Studio)", () => {
    expect(
      resolveAiConfig({
        AI_PROVIDER: "openai-compatible",
        AI_BASE_URL: "http://host.docker.internal:11434/v1",
        AI_MODEL: "llama3.1",
      }),
    ).toMatchObject({ provider: "openai-compatible", apiKey: "not-needed" });
  });

  it.each([
    [{ AI_API_KEY: "mystery-key" }, /can't be inferred/],
    [{ AI_PROVIDER: "cohere", AI_API_KEY: "k" }, /Unknown AI_PROVIDER "cohere"/],
    [{ AI_PROVIDER: "openai" }, /no API key set \(OPENAI_API_KEY or AI_API_KEY\)/],
    [{ AI_PROVIDER: "openai-compatible", AI_MODEL: "m" }, /needs AI_BASE_URL/],
    [{ AI_PROVIDER: "openai-compatible", AI_BASE_URL: "http://x/v1" }, /needs AI_MODEL/],
  ])("explains misconfiguration %j instead of guessing", (env, reason) => {
    const config = resolveAiConfig(env);
    expect(config.provider).toBe("none");
    expect(config.provider === "none" && config.reason).toMatch(reason);
  });
});

describe("providerFromKey", () => {
  it("maps OpenRouter keys to openai-compatible before the generic sk- rule", () => {
    expect(providerFromKey("sk-or-v1-abc")).toBe("openai-compatible");
  });

  it("returns null for unknown formats", () => {
    expect(providerFromKey("gsk_groq")).toBeNull();
  });
});

describe("createProvider", () => {
  it.each([
    [{ ANTHROPIC_API_KEY: "a" }, AnthropicProvider, "anthropic"],
    [{ OPENAI_API_KEY: "o" }, OpenAICompatibleProvider, "openai"],
    [{ GEMINI_API_KEY: "g" }, OpenAICompatibleProvider, "gemini"],
    [
      { AI_PROVIDER: "openai-compatible", AI_BASE_URL: "http://x/v1", AI_MODEL: "m" },
      OpenAICompatibleProvider,
      "openai-compatible",
    ],
    [{}, UnconfiguredProvider, "none"],
  ])("builds the right adapter for %j", (env, cls, name) => {
    const provider = createProvider(resolveAiConfig(env));
    expect(provider).toBeInstanceOf(cls);
    expect(provider.name).toBe(name);
  });
});

describe("describeAiConfig", () => {
  it("never exposes the key", () => {
    const described = describeAiConfig(resolveAiConfig({ OPENAI_API_KEY: "sk-secret" }));
    expect(described).toEqual({ provider: "openai", model: DEFAULT_MODELS.openai, configured: true });
    expect(JSON.stringify(described)).not.toContain("sk-secret");
  });
});
