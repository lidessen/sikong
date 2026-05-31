import { AgentLoopError } from "./errors";

/**
 * API-key sourcing for providers: explicit value first, then auto-discovery from
 * the conventional environment variables — unless auto-discovery is disabled.
 *
 * Auto-discovery is the right default for local/dev DX (`deepseek()` just works
 * if `DEEPSEEK_API_KEY` is set). But it reads `process.env`, which is unsafe for
 * stateless multi-tenant workers where each request carries its own key and must
 * never inherit an ambient one. Such hosts call `configureProviders({
 * autoDiscover: false })` once at startup to force every credential to be passed
 * explicitly.
 *
 * Resolution happens once, at provider-factory call time, and the resolved value
 * is baked into the (pure-data) provider — so the rest of the pipeline still
 * injects credentials as data and never reads `process.env` again.
 */

let autoDiscover = true;

export interface ProvidersConfig {
  /**
   * When false, provider factories never read `process.env` for credentials —
   * `apiKey` must be passed explicitly. Default true.
   */
  autoDiscover?: boolean;
}

/** Process-wide provider configuration. Call once at startup if needed. */
export function configureProviders(config: ProvidersConfig): void {
  if (config.autoDiscover !== undefined) autoDiscover = config.autoDiscover;
}

/** Whether credential auto-discovery from `process.env` is currently enabled. */
export function isAutoDiscoverEnabled(): boolean {
  return autoDiscover;
}

/** Thrown when a provider has no API key (none passed, none discovered). */
export class MissingCredentialError extends AgentLoopError {
  constructor(
    readonly providerId: string,
    readonly envVars: string[],
  ) {
    super(
      `Provider "${providerId}" has no API key — pass { apiKey } explicitly` +
        (envVars.length > 0
          ? autoDiscover
            ? `, or set ${envVars.join(" / ")}.`
            : ` (auto-discovery is disabled; set ${envVars.join(" / ")} and re-enable it, or pass apiKey).`
          : "."),
    );
    this.name = "MissingCredentialError";
  }
}

/**
 * Resolve an API key. Explicit `explicit` always wins. Otherwise, when
 * auto-discovery is on, return the first set var in `envVars`. Throws
 * `MissingCredentialError` when nothing is found and `required` is not false.
 */
export function resolveApiKey(opts: {
  providerId: string;
  explicit?: string;
  envVars: string[];
  /** Default true. When false, returns undefined instead of throwing. */
  required?: boolean;
}): string | undefined {
  if (opts.explicit) return opts.explicit;
  if (autoDiscover) {
    for (const name of opts.envVars) {
      const value = process.env[name];
      if (value) return value;
    }
  }
  if (opts.required === false) return undefined;
  throw new MissingCredentialError(opts.providerId, opts.envVars);
}
