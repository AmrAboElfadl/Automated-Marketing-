import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard must degrade rather than throw. A thrown error in the page
 * becomes an opaque "Application error … Digest: …" in the browser, which hides
 * the configuration problem that caused it.
 */

type Behaviour = "ok" | "throws" | "returns-error";

interface Fixtures {
  failed?: unknown[];
  accounts?: unknown[];
}

async function load(behaviour: Behaviour, fixtures: Fixtures = {}) {
  vi.resetModules();

  vi.doMock("./supabase", () => ({
    supabaseAdmin: {
      from: (table: string) => {
        if (behaviour === "throws") {
          throw new Error(
            "Missing required environment variables: SUPABASE_URL, " +
              "SUPABASE_SERVICE_ROLE_KEY. Set them in Vercel > Settings > " +
              "Environment Variables (all environments), then redeploy."
          );
        }

        const failure =
          behaviour === "returns-error"
            ? { data: null, count: null, error: { message: "permission denied for table" } }
            : null;

        // post_targets is used twice: head-count per status, and the failure list.
        if (table === "post_targets") {
          return {
            select: (_cols: string, opts?: { head?: boolean }) =>
              opts?.head
                ? { eq: async () => failure ?? { count: 3, error: null } }
                : {
                    eq: () => ({
                      order: () => ({
                        limit: async () =>
                          failure ?? { data: fixtures.failed ?? [], error: null },
                      }),
                    }),
                  },
          };
        }

        return {
          select: () => ({
            order: async () => failure ?? { data: fixtures.accounts ?? [], error: null },
          }),
        };
      },
    },
  }));

  const module = await import("./queue-snapshot");
  return module.loadQueueSnapshot();
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("./supabase");
  process.env.SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder";
  process.env.CRON_SECRET = "placeholder";
});

describe("loadQueueSnapshot", () => {
  it("returns a count per status when the database is reachable", async () => {
    const snapshot = await load("ok");

    expect(snapshot.error).toBeNull();
    expect(snapshot.counts.map(([status]) => status)).toEqual([
      "queued",
      "processing",
      "published",
      "failed",
    ]);
    expect(snapshot.missingEnv).toEqual([]);
  });

  it("reports rather than throws when the client cannot be built", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const snapshot = await load("throws");

    expect(snapshot.error).toMatch(/Missing required environment variables/);
    expect(snapshot.counts).toEqual([]);
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.missingEnv).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("surfaces a query error while showing nothing is missing", async () => {
    const snapshot = await load("returns-error");

    expect(snapshot.error).toBe("permission denied for table");
    expect(snapshot.missingEnv).toEqual([]);
  });

  it("never includes a secret value in what it returns", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "super-secret-service-role-key";

    const snapshot = await load("returns-error");

    expect(JSON.stringify(snapshot)).not.toContain("super-secret-service-role-key");
  });

  it("carries the reason a post failed, not just the count", async () => {
    const snapshot = await load("ok", {
      failed: [
        {
          attempts: 3,
          error_message:
            "youtube token refresh failed (HTTP 400 invalid_grant) — the stored " +
            "refresh token was revoked or expired",
          content_items: { title: "First automated upload" },
          accounts: { handle: "@main" },
        },
      ],
    });

    expect(snapshot.failures).toHaveLength(1);
    expect(snapshot.failures[0]).toEqual({
      title: "First automated upload",
      handle: "@main",
      attempts: 3,
      error: expect.stringContaining("invalid_grant") as unknown as string,
    });
  });

  it("labels a failure whose joins came back empty", async () => {
    const snapshot = await load("ok", {
      failed: [{ attempts: 3, error_message: null, content_items: null, accounts: null }],
    });

    expect(snapshot.failures[0].title).toBe("(unknown content)");
    expect(snapshot.failures[0].handle).toBe("(unknown account)");
    expect(snapshot.failures[0].error).toBe("(no reason recorded)");
  });

  it("flags an account that cannot publish", async () => {
    const snapshot = await load("ok", {
      accounts: [
        {
          handle: "@main",
          platform: "youtube",
          status: "token_expired",
          token_secret_name: "yt_token_main",
        },
        {
          handle: "@second",
          platform: "youtube",
          status: "active",
          token_secret_name: null,
        },
      ],
    });

    expect(snapshot.accounts).toEqual([
      { handle: "@main", platform: "youtube", status: "token_expired", hasToken: true },
      { handle: "@second", platform: "youtube", status: "active", hasToken: false },
    ]);
  });

  it("handles Supabase returning a join as a single-element array", async () => {
    const snapshot = await load("ok", {
      failed: [
        {
          attempts: 1,
          error_message: "boom",
          content_items: [{ title: "Arrayed" }],
          accounts: [{ handle: "@arrayed" }],
        },
      ],
    });

    expect(snapshot.failures[0].title).toBe("Arrayed");
    expect(snapshot.failures[0].handle).toBe("@arrayed");
  });
});
