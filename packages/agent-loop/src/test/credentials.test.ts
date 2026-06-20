import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  configureProviders,
  deepseek,
  gateway,
  isAutoDiscoverEnabled,
  kimi,
  MissingCredentialError,
  resolveApiKey,
} from "../index";

const ENV = "DEEPSEEK_API_KEY";

describe("credential resolution", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
    configureProviders({ autoDiscover: true });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    configureProviders({ autoDiscover: true });
  });

  test("explicit apiKey is used and lands in the runtime config", () => {
    const p = deepseek({ apiKey: "sk-explicit" });
    const cfg = p.configureFor("ai-sdk");
    expect(cfg.runtime).toBe("ai-sdk");
    if (cfg.runtime === "ai-sdk" && cfg.spec.kind === "deepseek") {
      expect(cfg.spec.apiKey).toBe("sk-explicit");
    }
  });

  test("auto-discovers from the conventional env var", () => {
    process.env[ENV] = "sk-from-env";
    const cfg = deepseek().configureFor("claude-code");
    if (cfg.runtime === "claude-code") {
      expect(cfg.env.ANTHROPIC_API_KEY).toBe("sk-from-env");
      expect(cfg.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
    }
  });

  test("explicit wins over env", () => {
    process.env[ENV] = "sk-from-env";
    const cfg = deepseek({ apiKey: "sk-explicit" }).configureFor("ai-sdk");
    if (cfg.runtime === "ai-sdk" && cfg.spec.kind === "deepseek") {
      expect(cfg.spec.apiKey).toBe("sk-explicit");
    }
  });

  test("throws MissingCredentialError when nothing is available", () => {
    expect(() => deepseek()).toThrow(MissingCredentialError);
  });

  test("autoDiscover:false ignores env, still honors explicit", () => {
    process.env[ENV] = "sk-from-env";
    configureProviders({ autoDiscover: false });
    expect(isAutoDiscoverEnabled()).toBe(false);
    expect(() => deepseek()).toThrow(MissingCredentialError); // env ignored
    const cfg = deepseek({ apiKey: "sk-explicit" }).configureFor("ai-sdk"); // explicit OK
    if (cfg.runtime === "ai-sdk" && cfg.spec.kind === "deepseek") {
      expect(cfg.spec.apiKey).toBe("sk-explicit");
    }
  });

  test("gateway never throws for a missing key (SDK falls back)", () => {
    expect(() => gateway({ model: "deepseek/deepseek-chat" })).not.toThrow();
  });

  test("resolveApiKey helper: required:false returns undefined", () => {
    const v = resolveApiKey({ providerId: "x", envVars: ["NOPE_API_KEY"], required: false });
    expect(v).toBeUndefined();
  });

  test("kimi discovers KIMI_CODE_API_KEY for claude-code", () => {
    const previous = process.env.KIMI_CODE_API_KEY;
    process.env.KIMI_CODE_API_KEY = "sk-kimi";
    try {
      const cfg = kimi().configureFor("claude-code");
      expect(cfg.runtime).toBe("claude-code");
      if (cfg.runtime === "claude-code") {
        expect(cfg.model).toBeUndefined();
        expect(cfg.env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
        expect(cfg.env.ANTHROPIC_API_KEY).toBe("sk-kimi");
        expect(cfg.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("262144");
      }
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_API_KEY;
      else process.env.KIMI_CODE_API_KEY = previous;
    }
  });

  test("kimi does not expose ai-sdk without client allowlist onboarding", () => {
    const previous = process.env.KIMI_CODE_API_KEY;
    process.env.KIMI_CODE_API_KEY = "sk-kimi";
    try {
      expect(kimi().supportedRuntimes).toEqual(["claude-code"]);
      expect(() => kimi().configureFor("ai-sdk")).toThrow(
        /does not support the "ai-sdk" runtime/,
      );
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_API_KEY;
      else process.env.KIMI_CODE_API_KEY = previous;
    }
  });
});
