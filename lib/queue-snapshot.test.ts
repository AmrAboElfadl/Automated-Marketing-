import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard must degrade rather than throw. A thrown error in the page
 * becomes an opaque "Application error … Digest: …" in the browser, which hides
 * the configuration problem that caused it.
 */

type Behaviour = "ok" | "throws" | "returns-error";

async function load(behaviour: Behaviour) {
  vi.resetModules();

  vi.doMock("./supabase", () => ({
    supabaseAdmin: {
      from: () => ({
        select: () => ({
          eq: async () => {
            if (behaviour === "throws") {
              throw new Error(
                "Missing required environment variables: SUPABASE_URL, " +
                  "SUPABASE_SERVICE_ROLE_KEY. Set them in Vercel > Settings > " +
                  "Environment Variables (all environments), then redeploy."
              );
            }
            if (behaviour === "returns-error") {
              return { count: null, error: { message: "permission denied for table" } };
            }
            return { count: 3, error: null };
          },
        }),
      }),
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
    expect(snapshot.counts).toHaveLength(4);
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
    expect(snapshot.missingEnv).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("surfaces a query error while showing nothing is missing", async () => {
    const snapshot = await load("returns-error");

    expect(snapshot.error).toBe("permission denied for table");
    // Configuration is fine here, so the page must not blame env vars.
    expect(snapshot.missingEnv).toEqual([]);
  });

  it("never includes a secret value in what it returns", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "super-secret-service-role-key";

    const snapshot = await load("returns-error");

    expect(JSON.stringify(snapshot)).not.toContain("super-secret-service-role-key");
  });
});
