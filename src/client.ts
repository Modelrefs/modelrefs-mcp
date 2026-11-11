/**
 * The HTTP layer. One place that knows how to call the Evidence API and how to
 * turn its answers into something an agent can act on.
 *
 * WHY THE ERROR PATH IS THE LONG ONE HERE. The API already returns error,
 * message, hint and docs on every documented failure - that was Phase 1.3, and
 * it exists so a caller is told what to change rather than what went wrong.
 * The job of this file is to pass that through intact instead of flattening it
 * into "request failed", which is what every thin wrapper does and what makes
 * an agent retry the same broken call.
 *
 * WHAT IT DOES NOT DO. It does not retry a 4xx, it does not invent a payload
 * when the API says 404, and it does not cache. A stale retirement date is the
 * one answer this product must never give, and a cache in a long-lived editor
 * session is exactly how you give one.
 */
import { API_BASE_URL, API_DOCS_URL, API_ERROR_FACTS, MCP_KEY_ENV } from "./generated.js";

export interface ApiFailure {
  readonly kind: "api";
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly hint?: string;
  readonly docs?: string;
  readonly extra: Record<string, unknown>;
}

export interface TransportFailure {
  readonly kind: "transport";
  readonly message: string;
  readonly hint: string;
}

export interface ConfigFailure {
  readonly kind: "config";
  readonly message: string;
  readonly hint: string;
}

export type Failure = ApiFailure | TransportFailure | ConfigFailure;

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

const KEYS_URL = "https://modelrefs.com/api-keys";

/** The request timeout. An editor plugin that hangs is worse than one that
 *  says it could not reach us, because the agent waits on it. */
const TIMEOUT_MS = 15_000;

export class EvidenceApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(opts: { baseUrl?: string; apiKey?: string | undefined } = {}) {
    // The override exists for the self-test, which points the client at a local
    // stub. It is read from the environment rather than hard-coded so the
    // published package has exactly one default and no test branch in it.
    this.baseUrl = (opts.baseUrl ?? process.env.MODELREFS_API_URL ?? API_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.apiKey = opts.apiKey ?? process.env[MCP_KEY_ENV] ?? undefined;
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim());
  }

  /** The configuration failure for a keyed tool called with no key. Returned
   *  rather than thrown, and rather than hiding the tool: an agent that can
   *  see the tool and read this can tell the user what to do. */
  private missingKey(): ConfigFailure {
    return {
      kind: "config",
      message: `No ModelRefs API key is configured, so this tool cannot answer.`,
      hint:
        `Set the ${MCP_KEY_ENV} environment variable in the MCP server's config to a key from ` +
        `${KEYS_URL}. The free tier includes 1,000 calls a month. The list_covered_models tool ` +
        `works without a key if you only need to know which models are held.`,
    };
  }

  async get<T>(path: string, opts: { auth: boolean } = { auth: true }): Promise<Result<T>> {
    if (opts.auth && !this.hasKey) return { ok: false, failure: this.missingKey() };

    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth) headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (thrown) {
      return {
        ok: false,
        failure: {
          kind: "transport",
          message: `Could not reach the ModelRefs API: ${
            thrown instanceof Error ? thrown.message : String(thrown)
          }`,
          hint:
            "This is a network or availability problem, not a problem with the request. " +
            "Retry once with backoff; do not change the slug or re-issue the key.",
        },
      };
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (response.ok) {
      if (parsed === null) {
        return {
          ok: false,
          failure: {
            kind: "transport",
            message: `The API returned ${response.status} with a body that is not JSON.`,
            hint: "Retry once. If it persists the deployed function is serving something unexpected.",
          },
        };
      }
      return { ok: true, value: parsed as T };
    }

    /* THE API BODY WINS, AND THE LOCAL TABLE IS ONLY THE FALLBACK. The
       endpoint's own hint is written against the live behaviour; the generated
       table is a copy and can only be as fresh as the last build. Using the
       copy first would be choosing the stale one on purpose. */
    const body = (parsed ?? {}) as Record<string, unknown>;
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    const known = API_ERROR_FACTS.find((f) => f.error === code);
    const { error: _e, message: _m, hint: _h, docs: _d, ...extra } = body;

    return {
      ok: false,
      failure: {
        kind: "api",
        status: response.status,
        error: code,
        message:
          typeof body.message === "string"
            ? body.message
            : known?.message ?? `The API answered ${response.status}.`,
        hint: typeof body.hint === "string" ? body.hint : known?.hint,
        docs: typeof body.docs === "string" ? body.docs : known?.docs ?? API_DOCS_URL,
        extra,
      },
    };
  }
}

/** One readable line per failure, for the text block an agent reads first. */
export function describeFailure(failure: Failure): string {
  if (failure.kind === "api") {
    const lines = [`${failure.error} (HTTP ${failure.status}): ${failure.message}`];
    if (failure.hint) lines.push(`What to change: ${failure.hint}`);
    if (failure.docs) lines.push(`Reference: ${failure.docs}`);
    const extra = Object.entries(failure.extra);
    if (extra.length) {
      lines.push(`Context: ${extra.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`);
    }
    return lines.join("\n");
  }
  return `${failure.message}\nWhat to change: ${failure.hint}`;
}
