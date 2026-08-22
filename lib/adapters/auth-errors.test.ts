import { describe, expect, it } from "vitest";
import { AdapterAuthError, isAuthFailure } from "./types";

/**
 * A dead credential is not a retryable failure. Adapters classify it so the
 * scheduler can park the post and mark the account instead of spending the
 * remaining attempts on something that cannot succeed.
 *
 * These tests drive the two `describeFailure` implementations directly, since
 * that is where the decision is made.
 */

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isAuthFailure", () => {
  it("recognises an adapter auth error", () => {
    expect(isAuthFailure(new AdapterAuthError("dead token"))).toBe(true);
  });

  it("does not treat an ordinary error as an auth failure", () => {
    expect(isAuthFailure(new Error("quota exceeded"))).toBe(false);
    expect(isAuthFailure("invalid_grant")).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });

  it("keeps the message intact so it still reaches error_message", () => {
    const err = new AdapterAuthError("youtube token refresh failed — rotate the secret");
    expect(err.message).toMatch(/rotate the secret/);
    expect(err.name).toBe("AdapterAuthError");
  });
});

describe("youtube classification", () => {
  async function classify(body: unknown, status: number) {
    const { describeFailureForTest } = await import("./youtube");
    return describeFailureForTest(response(body, status), "youtube token refresh");
  }

  it("classifies a revoked refresh token as an auth failure", async () => {
    const err = await classify(
      { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      400
    );
    expect(isAuthFailure(err)).toBe(true);
    expect(err.message).toMatch(/rotate the Vault secret/);
  });

  it("classifies a bad client secret as an auth failure", async () => {
    const err = await classify({ error: "invalid_client" }, 401);
    expect(isAuthFailure(err)).toBe(true);
  });

  it("leaves an exhausted quota retryable", async () => {
    const err = await classify(
      { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
      403
    );
    expect(isAuthFailure(err)).toBe(false);
    expect(err.message).toMatch(/midnight Pacific/);
  });

  it("leaves a rate limit retryable", async () => {
    const err = await classify(
      { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } },
      403
    );
    expect(isAuthFailure(err)).toBe(false);
  });
});

describe("meta classification", () => {
  async function classify(code: number, status = 400) {
    const { describeFailure } = await import("./meta");
    return describeFailure(response({ error: { message: "m", code } }, status), "meta call");
  }

  it("classifies an expired token as an auth failure", async () => {
    const err = await classify(190, 401);
    expect(isAuthFailure(err)).toBe(true);
    expect(err.message).toMatch(/rotate the Vault secret/);
  });

  it("classifies an invalid session as an auth failure", async () => {
    expect(isAuthFailure(await classify(102))).toBe(true);
  });

  it("leaves a rate limit retryable", async () => {
    expect(isAuthFailure(await classify(32))).toBe(false);
  });

  it("leaves a missing permission retryable rather than blaming the token", async () => {
    // A permission gap needs an app change, not a rotation — marking the
    // account token_expired would point the operator at the wrong fix.
    expect(isAuthFailure(await classify(200, 403))).toBe(false);
  });
});
