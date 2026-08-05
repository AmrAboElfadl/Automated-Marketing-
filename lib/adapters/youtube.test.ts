import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishAdapter, PublishInput } from "./types";

/**
 * Stub the Supabase client, not `lib/vault`. Vault's own logic — including the
 * "create it with vault.create_secret" message these tests assert on — stays
 * real; only the client underneath it is replaced.
 *
 * This is also why the boundary matters rather than being a style choice:
 * `createClient` builds a Realtime client that needs a native WebSocket, which
 * Node 20 does not have. Constructing a real client made these tests pass on
 * Node 22 and fail on Node 20.
 */
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("../supabase", () => ({ supabaseAdmin: { rpc: rpcMock } }));

/**
 * The adapter is exercised against a stubbed `fetch`, so these tests cover the
 * resumable-upload protocol, metadata shaping, the publish guards and the error
 * mapping without touching Google or Supabase.
 *
 * Every test re-imports the module via `loadAdapter()`. The adapter caches
 * access tokens per Vault secret name at module scope, and reusing that cache
 * across tests silently skips the token-refresh path — which is exactly the
 * error path several of these tests are about.
 */

const MEDIA_SIZE = 20 * 1024 * 1024; // 20 MiB => 3 chunks at 8 MiB
const MEDIA_URL = "https://signed.example/media?token=SIGNED_URL_SECRET";
const SESSION_URL = "https://upload.example/session/abc";

type Handler = (url: string, init: RequestInit | undefined) => Response | null;

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let calls: Recorded[] = [];
let uploadedBytes = 0;
let initMetadata: unknown = null;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The happy-path stub. Individual tests prepend overrides. */
function defaultHandler(url: string, init: RequestInit | undefined): Response | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;

  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    return json({ access_token: "atoken", expires_in: 3600 });
  }

  if (url.includes("/youtube/v3/channels") && url.includes("mine=true")) {
    return json({ items: [{ id: "UC_right" }] });
  }

  if (url.startsWith("https://signed.example/media")) {
    return new Response(new Uint8Array(MEDIA_SIZE), {
      status: 200,
      headers: {
        "content-length": String(MEDIA_SIZE),
        "content-type": "video/mp4",
      },
    });
  }

  if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
    initMetadata = JSON.parse(String(init?.body));
    return new Response(null, { status: 200, headers: { location: SESSION_URL } });
  }

  if (url.startsWith(SESSION_URL)) {
    const range = String(headers["content-range"]);
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!match) throw new Error(`malformed content-range: ${range}`);

    const [, startText, endText, totalText] = match;
    const start = Number(startText);
    const end = Number(endText);
    const total = Number(totalText);

    // The adapter must resume from exactly where the server left off.
    expect(start).toBe(uploadedBytes);
    expect(total).toBe(MEDIA_SIZE);

    uploadedBytes = end + 1;
    if (uploadedBytes >= total) return json({ id: "vid_123" });
    return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
  }

  if (url.includes("/youtube/v3/videos?")) {
    return json({
      items: [
        {
          statistics: { viewCount: "1234", likeCount: "56", commentCount: "7" },
          snippet: { channelId: "UC_right" },
        },
      ],
    });
  }

  if (url.includes("/youtube/v3/channels?part=statistics")) {
    return json({ items: [{ statistics: { subscriberCount: "9001" } }] });
  }

  if (url.startsWith("https://youtubeanalytics.googleapis.com")) {
    // estimatedMinutesWatched, shares, videosAddedToPlaylists
    return json({ rows: [[120, 8, 3]] });
  }

  return null;
}

/** Installs a fetch stub: overrides are tried first, then the happy path. */
function installFetch(...overrides: Handler[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      });

      for (const handler of [...overrides, defaultHandler]) {
        const response = handler(url, init);
        if (response) return response;
      }
      throw new Error(`unstubbed request: ${init?.method ?? "GET"} ${url}`);
    })
  );
}

async function loadAdapter(): Promise<PublishAdapter> {
  vi.resetModules();
  const module = await import("./youtube");
  return module.youtubeAdapter;
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    title: "A clean title",
    caption: "Watch this",
    hashtags: ["Shorts", "abaya"],
    mediaUrl: MEDIA_URL,
    mediaType: "video",
    externalAccountId: "UC_right",
    tokenSecretName: null,
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  uploadedBytes = 0;
  initMetadata = null;

  vi.unstubAllGlobals();

  // Default: the Vault secret exists. Individual tests override.
  rpcMock.mockReset();
  rpcMock.mockImplementation(async () => ({ data: "rtoken-from-vault", error: null }));

  process.env.SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder";
  process.env.YOUTUBE_CLIENT_ID = "cid";
  process.env.YOUTUBE_CLIENT_SECRET = "csecret";
  process.env.YOUTUBE_REFRESH_TOKEN = "rtoken";
  delete process.env.YOUTUBE_MAX_MEDIA_BYTES;
  delete process.env.YOUTUBE_PRIVACY_STATUS;
  delete process.env.YOUTUBE_CATEGORY_ID;
  delete process.env.YOUTUBE_MADE_FOR_KIDS;
});

describe("publish", () => {
  it("uploads every byte and returns the video id", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const result = await adapter.publish(input());

    expect(result.externalPostId).toBe("vid_123");
    expect(Number.isNaN(Date.parse(result.publishedAt))).toBe(false);
    expect(uploadedBytes).toBe(MEDIA_SIZE);
  });

  it("declares the total length up front and requests a resumable session", async () => {
    installFetch();
    const adapter = await loadAdapter();
    await adapter.publish(input());

    const init = calls.find((call) => call.url.includes("/upload/youtube/v3/videos"));
    expect(init?.headers["x-upload-content-length"]).toBe(String(MEDIA_SIZE));
    expect(init?.url).toContain("uploadType=resumable");
  });

  it("resumes from the server's Range after a transient 5xx mid-upload", async () => {
    let failed = false;
    installFetch((url) => {
      if (url.startsWith(SESSION_URL) && !failed) {
        failed = true;
        return new Response("upstream hiccup", { status: 503 });
      }
      return null;
    });

    const adapter = await loadAdapter();
    const result = await adapter.publish(input());

    expect(failed).toBe(true);
    expect(result.externalPostId).toBe("vid_123");
    expect(uploadedBytes).toBe(MEDIA_SIZE);
  });

  it("gives up when the server stops acknowledging new bytes", async () => {
    installFetch((url) => {
      // Always claims only the first byte was stored.
      if (url.startsWith(SESSION_URL)) {
        return new Response(null, { status: 308, headers: { range: "bytes=0-0" } });
      }
      return null;
    });

    const adapter = await loadAdapter();
    await expect(adapter.publish(input())).rejects.toThrow(/stalled/i);
  });

  it("verifies channel ownership before uploading anything", async () => {
    installFetch();
    const adapter = await loadAdapter();
    await adapter.publish(input());

    const ownership = calls.findIndex((call) => call.url.includes("mine=true"));
    const upload = calls.findIndex((call) => call.url.includes("/upload/youtube/v3/videos"));
    expect(ownership).toBeGreaterThanOrEqual(0);
    expect(ownership).toBeLessThan(upload);
  });

  it("refuses to publish when the token owns a different channel", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ externalAccountId: "UC_wrong" }))).rejects.toThrow(
      /channel mismatch/i
    );
    expect(calls.some((call) => call.url.includes("/upload/"))).toBe(false);
  });

  it("rejects non-video media", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ mediaType: "image" }))).rejects.toThrow(
      /only accepts video/i
    );
  });

  it("refuses oversized media instead of truncating it", async () => {
    installFetch((url) => {
      if (url.startsWith("https://signed.example/media")) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: {
            "content-length": String(400 * 1024 * 1024),
            "content-type": "video/mp4",
          },
        });
      }
      return null;
    });

    const adapter = await loadAdapter();
    await expect(adapter.publish(input())).rejects.toThrow(/400\.0 MiB.*256\.0 MiB/s);
  });

  it("ignores a malformed size cap rather than disabling it", async () => {
    process.env.YOUTUBE_MAX_MEDIA_BYTES = "not-a-number";
    installFetch((url) => {
      if (url.startsWith("https://signed.example/media")) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: {
            "content-length": String(400 * 1024 * 1024),
            "content-type": "video/mp4",
          },
        });
      }
      return null;
    });

    const adapter = await loadAdapter();
    await expect(adapter.publish(input())).rejects.toThrow(/256\.0 MiB/);
  });

  it("never leaks the signed media URL into an error message", async () => {
    installFetch((url) => {
      if (url.startsWith("https://signed.example/media")) {
        return new Response("nope", { status: 400 });
      }
      return null;
    });

    const adapter = await loadAdapter();
    await expect(adapter.publish(input())).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("SIGNED_URL_SECRET") as unknown as string,
      })
    );
  });
});

describe("metadata", () => {
  interface Metadata {
    snippet: { title: string; description: string; tags: string[]; categoryId: string };
    status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
  }

  async function publishAndReadMetadata(overrides: Partial<PublishInput> = {}): Promise<Metadata> {
    installFetch();
    const adapter = await loadAdapter();
    await adapter.publish(input(overrides));
    return initMetadata as Metadata;
  }

  it("caps the title at YouTube's 100 characters", async () => {
    const meta = await publishAndReadMetadata({ title: "x".repeat(250) });
    expect(meta.snippet.title.length).toBeLessThanOrEqual(100);
  });

  it("strips the angle brackets YouTube rejects", async () => {
    const meta = await publishAndReadMetadata({
      title: "A <very> title",
      caption: "Watch <b>this</b>",
    });
    expect(meta.snippet.title).not.toMatch(/[<>]/);
    expect(meta.snippet.description).not.toMatch(/[<>]/);
  });

  it("appends hashtags to the description and strips # from tags", async () => {
    const meta = await publishAndReadMetadata({
      hashtags: ["#Shorts", "abaya", "", "#modestfashion"],
    });
    expect(meta.snippet.description).toContain("#Shorts #abaya #modestfashion");
    expect(meta.snippet.tags).toEqual(["Shorts", "abaya", "modestfashion"]);
  });

  it("keeps the joined tag string inside the API's budget", async () => {
    const meta = await publishAndReadMetadata({
      hashtags: Array.from({ length: 60 }, (_, i) => `tag${i}`.padEnd(20, "x")),
    });
    expect(meta.snippet.tags.join(",").length).toBeLessThanOrEqual(500);
  });

  it("truncates an over-long description", async () => {
    const meta = await publishAndReadMetadata({ caption: "y".repeat(6000) });
    expect(meta.snippet.description.length).toBeLessThanOrEqual(5000);
  });

  it("defaults to public, category 22, and an explicit COPPA declaration", async () => {
    const meta = await publishAndReadMetadata();
    expect(meta.snippet.categoryId).toBe("22");
    expect(meta.status.privacyStatus).toBe("public");
    expect(meta.status.selfDeclaredMadeForKids).toBe(false);
  });

  it("honours the privacy and category overrides", async () => {
    process.env.YOUTUBE_PRIVACY_STATUS = "unlisted";
    process.env.YOUTUBE_CATEGORY_ID = "24";
    process.env.YOUTUBE_MADE_FOR_KIDS = "true";

    const meta = await publishAndReadMetadata();
    expect(meta.status.privacyStatus).toBe("unlisted");
    expect(meta.snippet.categoryId).toBe("24");
    expect(meta.status.selfDeclaredMadeForKids).toBe(true);
  });

  it("rejects an invalid privacy status rather than sending it", async () => {
    process.env.YOUTUBE_PRIVACY_STATUS = "sort-of-public";
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(/YOUTUBE_PRIVACY_STATUS/);
  });

  it("fails an empty title instead of sending one", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ title: "   " }))).rejects.toThrow(/title is empty/i);
  });
});

describe("credentials and error mapping", () => {
  it("reads the refresh token from Vault when a secret name is set", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const result = await adapter.publish(input({ tokenSecretName: "yt_vault_ok" }));

    expect(result.externalPostId).toBe("vid_123");
    expect(rpcMock).toHaveBeenCalledWith("read_secret", { secret_name: "yt_vault_ok" });
  });

  it("explains a missing Vault secret", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: null }));
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ tokenSecretName: "yt_missing" }))).rejects.toThrow(
      /yt_missing.*vault\.create_secret/s
    );
  });

  it("explains having no credentials at all", async () => {
    delete process.env.YOUTUBE_REFRESH_TOKEN;
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(/token_secret_name is null/);
  });

  it("maps a revoked refresh token to an actionable error", async () => {
    installFetch((url) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? json(
            { error: "invalid_grant", error_description: "Token has been expired or revoked." },
            400
          )
        : null
    );

    const adapter = await loadAdapter();
    await expect(adapter.publish(input())).rejects.toThrow(
      /invalid_grant.*rotate the Vault secret/s
    );
  });

  it("maps an exhausted API quota to an actionable error", async () => {
    installFetch((url) =>
      url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")
        ? json(
            {
              error: {
                code: 403,
                message: "You have exceeded your quota.",
                errors: [{ reason: "quotaExceeded" }],
              },
            },
            403
          )
        : null
    );

    const adapter = await loadAdapter();
    await expect(adapter.publish(input())).rejects.toThrow(
      /quotaExceeded.*midnight Pacific/s
    );
  });

  it("caches the access token across calls for the same secret", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await adapter.publish(input({ tokenSecretName: "yt_cached" }));
    uploadedBytes = 0;
    await adapter.publish(input({ tokenSecretName: "yt_cached", title: "Second" }));

    const refreshes = calls.filter((call) =>
      call.url.startsWith("https://oauth2.googleapis.com/token")
    );
    expect(refreshes).toHaveLength(1);
  });
});

describe("fetchMetrics", () => {
  it("parses string counters and converts watch minutes to seconds", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const metrics = await adapter.fetchMetrics!("vid_123", null);

    expect(metrics.views).toBe(1234);
    expect(metrics.likes).toBe(56);
    expect(metrics.comments).toBe(7);
    expect(metrics.watchTimeSecs).toBe(7200); // 120 minutes
    expect(metrics.shares).toBe(8);
    expect(metrics.saves).toBe(3);
    expect(metrics.followerCount).toBe(9001);
  });

  it("still returns Data API counters when the analytics scope is missing", async () => {
    installFetch((url) =>
      url.startsWith("https://youtubeanalytics.googleapis.com")
        ? json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, 403)
        : null
    );

    const adapter = await loadAdapter();
    const metrics = await adapter.fetchMetrics!("vid_123", null);

    expect(metrics.views).toBe(1234);
    expect(metrics.watchTimeSecs).toBe(0);
    expect(metrics.shares).toBe(0);
  });

  it("reports a deleted or still-processing video clearly", async () => {
    installFetch((url) => (url.includes("/youtube/v3/videos?") ? json({ items: [] }) : null));
    const adapter = await loadAdapter();

    await expect(adapter.fetchMetrics!("vid_gone", null)).rejects.toThrow(
      /vid_gone not found/
    );
  });
});
