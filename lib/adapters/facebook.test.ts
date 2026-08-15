import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishAdapter, PublishInput } from "./types";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("../supabase", () => ({ supabaseAdmin: { rpc: rpcMock } }));

const PAGE_ID = "102030405060708";
const MEDIA_URL = "https://signed.example/clip.mp4?token=SIGNED_URL_SECRET";

type Handler = (url: string, init: RequestInit | undefined) => Response | null;

interface Recorded {
  url: string;
  method: string;
  body: Record<string, string>;
}

let calls: Recorded[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function graphError(code: number, message: string, status = 400): Response {
  return json({ error: { message, code, type: "OAuthException" } }, status);
}

function defaultHandler(url: string): Response | null {
  if (url.includes(`${PAGE_ID}/videos`)) return json({ id: "video_555" });
  if (url.includes(`${PAGE_ID}/photos`)) {
    return json({ id: "photo_1", post_id: `${PAGE_ID}_9999` });
  }

  if (url.includes("/video_insights")) {
    return json({ data: [{ name: "total_video_views", values: [{ value: 2500 }] }] });
  }

  if (url.includes("video_555") || url.includes("_9999")) {
    return json({
      likes: { summary: { total_count: 120 } },
      comments: { summary: { total_count: 15 } },
      shares: { count: 8 },
    });
  }

  return null;
}

function installFetch(...overrides: Handler[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      const body: Record<string, string> = {};
      if (init?.body instanceof URLSearchParams) {
        init.body.forEach((value, key) => {
          body[key] = value;
        });
      }
      calls.push({ url, method: init?.method ?? "GET", body });

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
  return (await import("./facebook")).facebookAdapter;
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    title: "A title",
    caption: "Watch this",
    hashtags: ["test"],
    mediaUrl: MEDIA_URL,
    mediaType: "video",
    externalAccountId: PAGE_ID,
    tokenSecretName: "fb_page_token",
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  vi.unstubAllGlobals();
  rpcMock.mockReset();
  rpcMock.mockImplementation(async () => ({ data: "page-token", error: null }));
  process.env.SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder";
  delete process.env.META_ACCESS_TOKEN;
});

describe("publish", () => {
  it("posts a video to the Page in one call", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const result = await adapter.publish(input());

    expect(result.externalPostId).toBe("video_555");
    const call = calls.find((c) => c.method === "POST");
    expect(call?.url).toContain(`${PAGE_ID}/videos`);
    expect(call?.body.file_url).toBe(MEDIA_URL);
    expect(call?.body.description).toBe("Watch this\n\n#test");
  });

  it("prefers post_id over id for a photo", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const result = await adapter.publish(input({ mediaType: "image" }));

    // /photos returns both; the feed post id is the useful one.
    expect(result.externalPostId).toBe(`${PAGE_ID}_9999`);
    const call = calls.find((c) => c.method === "POST");
    expect(call?.url).toContain(`${PAGE_ID}/photos`);
    expect(call?.body.url).toBe(MEDIA_URL);
  });

  it("requires the Page id", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ externalAccountId: null }))).rejects.toThrow(
      /Page id/
    );
  });

  it("refuses carousels rather than posting something wrong", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ mediaType: "carousel" }))).rejects.toThrow(
      /single media only/
    );
  });

  it("maps a missing permission to an actionable error", async () => {
    installFetch(() => graphError(200, "Permissions error", 403));
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(/code 200.*linked/s);
  });

  it("maps a rate limit to an actionable error", async () => {
    installFetch(() => graphError(32, "Page request limit reached", 400));
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(/code 32.*retry/s);
  });

  it("never puts the token in a URL", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await adapter.publish(input());

    expect(calls.every((c) => !c.url.includes("access_token="))).toBe(true);
    expect(calls.every((c) => !c.url.includes("page-token"))).toBe(true);
  });
});

describe("fetchMetrics", () => {
  it("reads engagement totals from summaries", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const metrics = await adapter.fetchMetrics!("video_555", "fb_page_token");

    expect(metrics.likes).toBe(120);
    expect(metrics.comments).toBe(15);
    expect(metrics.shares).toBe(8);
    expect(metrics.views).toBe(2500);
  });

  it("treats a missing view count as zero rather than failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFetch((url) =>
      url.includes("/video_insights")
        ? graphError(100, "nonexisting field on node", 400)
        : null
    );
    const adapter = await loadAdapter();

    const metrics = await adapter.fetchMetrics!("video_555", "fb_page_token");

    expect(metrics.views).toBe(0);
    expect(metrics.likes).toBe(120);
    warn.mockRestore();
  });
});
