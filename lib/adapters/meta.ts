import { AdapterAuthError } from "./types";
import { readSecret } from "../vault";

/**
 * Shared plumbing for the Meta Graph API, used by both the Instagram and
 * Facebook adapters. They differ in endpoints and publish flow, but share a
 * host, an auth model and an error envelope.
 *
 * TOKENS DIFFER FROM YOUTUBE. Google issues a refresh token that is exchanged
 * for short access tokens on every run. Meta has no refresh grant: the Vault
 * secret holds a long-lived access token that is sent directly. Practically:
 *
 *   - a long-lived *user* token lasts ~60 days
 *   - a *Page* token derived from one does not expire on its own, but is
 *     invalidated by a password change, a permission revocation, or Meta's
 *     periodic security checks
 *
 * So a Meta token is a thing that eventually dies with no automatic recovery.
 * The error mapping below is written to make that unmistakable when it happens.
 */

/**
 * Pinned deliberately. Meta deprecates versions on a schedule, and an
 * unversioned call silently follows whatever is current — changing behaviour
 * under a deployment nobody touched.
 */
export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
export const GRAPH_HOST = "https://graph.facebook.com";

export function graphUrl(path: string): string {
  return `${GRAPH_HOST}/${GRAPH_VERSION}/${path.replace(/^\/+/, "")}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drains a response we aren't going to read, so the socket is released. */
export async function discard(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* nothing left to drain */
  }
}

/**
 * Actionable hints keyed by Meta's numeric error code. These land in
 * `post_targets.error_message`, so they have to say what to do next.
 */
const ERROR_HINTS: Record<number, string> = {
  190:
    "the access token is invalid or expired — Meta has no refresh grant, so generate a new " +
    "long-lived token and rotate the Vault secret",
  102:
    "the session is invalid — regenerate the long-lived token and rotate the Vault secret",
  10:
    "the app lacks a required permission — check instagram_business_content_publish / " +
    "pages_manage_posts are granted for this account",
  200:
    "the token does not have permission for this account — confirm the Page and Instagram " +
    "account are linked and the app has a role on them",
  4: "the app hit its rate limit; the scheduler will retry this post",
  17: "this user hit their rate limit; the scheduler will retry this post",
  32: "the Page hit its rate limit; the scheduler will retry this post",
  613: "calls to this endpoint are being throttled; the scheduler will retry this post",
  9007:
    "the account hit Instagram's publishing limit (50 API posts per 24h) — lower " +
    "accounts.daily_post_limit",
  100:
    "Meta rejected a parameter — most often the media URL was unreachable, or the account id " +
    "is not an Instagram Business/Creator user id",
  324: "the media could not be fetched or is an unsupported format",
  2207026: "the video format is not supported by Instagram",
};

/**
 * Codes that mean "the token is dead", as opposed to a transient or
 * request-specific failure. 190 is an invalid/expired token; 102 is an invalid
 * session. Both need a rotation, not a retry.
 */
const AUTH_FAILURE_CODES = new Set([190, 102]);

interface GraphError {
  message: string;
  code: number;
  subcode: number | null;
  type: string;
}

function parseGraphError(raw: string): GraphError | null {
  try {
    const body: unknown = JSON.parse(raw);
    if (!isRecord(body) || !isRecord(body.error)) return null;

    const err = body.error;
    return {
      message: typeof err.message === "string" ? err.message : "",
      code: typeof err.code === "number" ? err.code : 0,
      subcode: typeof err.error_subcode === "number" ? err.error_subcode : null,
      type: typeof err.type === "string" ? err.type : "",
    };
  } catch {
    return null;
  }
}

/** Turns a failed Graph response into one readable, actionable Error. */
export async function describeFailure(res: Response, context: string): Promise<Error> {
  const raw = await res.text().catch(() => "");
  const parsed = parseGraphError(raw);

  const parts = [`${context} failed (HTTP ${res.status}`];
  if (parsed?.code) parts[0] += ` code ${parsed.code}`;
  if (parsed?.subcode) parts[0] += `/${parsed.subcode}`;
  parts[0] += ")";

  if (parsed?.message) parts.push(parsed.message);
  else if (raw) parts.push(raw.slice(0, 200));

  const hint = parsed ? ERROR_HINTS[parsed.code] : undefined;
  if (hint) parts.push(hint);

  const message = parts.join(" — ");

  // Credentials rejected, not the request. Meta has no refresh grant, so these
  // fail identically on every retry until a human rotates the token.
  if (parsed && AUTH_FAILURE_CODES.has(parsed.code)) {
    return new AdapterAuthError(message);
  }

  return new Error(message);
}

/**
 * Resolves the access token for an account.
 *
 * Never accepts a raw token from the caller, and never logs the value. The
 * env fallback exists only for a single-account setup with no Vault secret,
 * mirroring the YouTube adapter.
 */
export async function getAccessToken(tokenSecretName: string | null): Promise<string> {
  if (tokenSecretName) return readSecret(tokenSecretName);

  const fromEnv = process.env.META_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;

  throw new Error(
    "no Meta credentials: accounts.token_secret_name is null and META_ACCESS_TOKEN is unset"
  );
}

/**
 * A Graph API call. The token goes in the Authorization header rather than a
 * query parameter so it cannot leak into an intermediary's request log.
 */
export async function graphRequest(
  path: string,
  accessToken: string,
  context: string,
  init: { method?: "GET" | "POST"; params?: Record<string, string> } = {}
): Promise<Record<string, unknown>> {
  const method = init.method ?? "GET";
  const params = new URLSearchParams(init.params ?? {});

  const url = method === "GET" && params.toString()
    ? `${graphUrl(path)}?${params.toString()}`
    : graphUrl(path);

  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(method === "POST"
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: method === "POST" ? params : undefined,
  });

  if (!res.ok) throw await describeFailure(res, context);

  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error(`${context} returned an unexpected response shape`);
  return body;
}

/** Caption text shared by both platforms: body, then hashtags on their own line. */
export function buildCaption(caption: string, hashtags: string[], maxLength: number): string {
  const tagLine = hashtags
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");

  const body = [caption.trim(), tagLine].filter(Boolean).join("\n\n");
  return body.length > maxLength ? body.slice(0, maxLength) : body;
}
