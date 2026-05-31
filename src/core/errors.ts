import type { Capability } from "./capabilities";

export class AgentLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLoopError";
  }
}

/**
 * Thrown when the caller asks for a feature the chosen backend cannot provide
 * (e.g. passing `tools` to a backend without the `tools` capability).
 */
export class CapabilityNotSupportedError extends AgentLoopError {
  constructor(
    readonly backend: string,
    readonly capability: Capability,
    detail?: string,
  ) {
    super(
      `Backend "${backend}" does not support capability "${capability}"` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "CapabilityNotSupportedError";
  }
}

/** Thrown when a backend's required CLI / SDK / API key is unavailable. */
export class PreflightError extends AgentLoopError {
  constructor(
    readonly backend: string,
    reason: string,
    readonly missingEnv?: string[],
  ) {
    super(`Backend "${backend}" preflight failed: ${reason}`);
    this.name = "PreflightError";
  }
}
