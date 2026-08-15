import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishAdapter, PublishInput } from "./types";

/**
 * Stubs the Supabase client, leaving lib/vault real — same boundary as the
 * YouTube tests, and for the same reason: `createClient` builds a Realtime
 * client needing a native WebSocket, which Node 20 does not have.
 */
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("../supabase", () => ({ supabaseAdmin: { rpc: rpcMock } }));

const IG_USER = "17841400000000000";
const MEDIA_URL = "https://signed.example/clip.mp4?token=SIGNED_URL_SECRET";

type Handler = (url: string, init: RequestInit | undefined) => Response | null;

interface Recorded {
  url: string;
  method: string;
  body: Record<string, string>;
}

let calls: Recorded[] = [];
/** status_code values returned in order, so processing can be simulated. */
let statusSequence: string[] = [];

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
  if (url.includes(`${IG_USER}/media_publish`)) return json({ id: "media_999" });
  if (url.includes(`${IG_USER}/media`)) return json({ id: "container_1" });

  if (url.includes("container_1")) {
    const next = statusSequence.shift() ?? "FINISHED";
    return json({ status_code: next, status: `state: ${next}` });
  }

  if (url.includes("/insights")) {
    return json({
      data: [
        { name: "views", values: [{ value: 1500 }] },
        { name: "likes", values: [{ value: 42 }] },
        { name: "comments", values: [{ value: 7 }] },
        { name: "shares", values: [{ value: 3 }] },
        { name: "saved", values: [{ value: 9 }] },
      ],
    });
  }

  if (url.includes("followers_count")) return json({ followers_count: 5000 });

  if (url.includes("media_999")) {
    return json({ like_count: 40, comments_count: 6, owner: { id: IG_USER } });
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
  return (await import("./instagram")).instagramAdapter;
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    title: "A title",
    caption: "Watch this",
    hashtags: ["Reels", "test"],
    mediaUrl: MEDIA_URL,
    mediaType: "video",
    externalAccountId: IG_USER,
    tokenSecretName: "ig_token_main",
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  statusSequence = [];
  vi.unstubAllGlobals();
  rpcMock.mockReset();
  rpcMock.mockImplementation(async () => ({ data: "long-lived-token", error: null }));
  process.env.SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder";
  delete process.env.META_ACCESS_TOKEN;
});

describe("publish", () => {
  it("creates a container then publishes it", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const result = await adapter.publish(input());

    expect(result.externalPostId).toBe("media_999");

    const create = calls.find((c) => c.url.includes("/media") && c.method === "POST");
    expect(create?.body.media_type).toBe("REELS");
    expect(create?.body.video_url).toBe(MEDIA_URL);

    const publishCall = calls.find((c) => c.url.includes("media_publish"));
    expect(publishCall?.body.creation_id).toBe("container_1");
  });

  it("waits for a video container to finish processing", async () => {
    statusSequence = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    installFetch();
    const adapter = await loadAdapter();

    const result = await adapter.publish(input());

    expect(result.externalPostId).toBe("media_999");
    // Publishing must not happen before the container reports FINISHED.
    const statusChecks = calls.filter((c) => c.url.includes("status_code"));
    const publishIndex = calls.findIndex((c) => c.url.includes("media_publish"));
    expect(statusChecks.length).toBe(3);
    expect(publishIndex).toBe(calls.length - 1);
  }, 20_000);

  it("does not poll for an image", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await adapter.publish(input({ mediaType: "image" }));

    expect(calls.some((c) => c.url.includes("status_code"))).toBe(false);
    const create = calls.find((c) => c.method === "POST" && c.url.includes("/media"));
    expect(create?.body.image_url).toBe(MEDIA_URL);
    expect(create?.body.media_type).toBeUndefined();
  });

  it("explains a container that Meta could not process", async () => {
    statusSequence = ["ERROR"];
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(/could not process the media/);
  });

  it("puts the caption and hashtags on the container", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await adapter.publish(input({ caption: "Body text", hashtags: ["#One", "two"] }));

    const create = calls.find((c) => c.method === "POST" && c.url.includes("/media"));
    expect(create?.body.caption).toBe("Body text\n\n#One #two");
  });

  it("requires the Instagram user id", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ externalAccountId: null }))).rejects.toThrow(
      /Instagram user id/
    );
  });

  it("refuses carousels rather than posting something wrong", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ mediaType: "carousel" }))).rejects.toThrow(
      /single media only/
    );
  });

  it("maps an expired token to an actionable error", async () => {
    installFetch(() =>
      graphError(190, "Error validating access token: Session has expired.", 401)
    );
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(
      /code 190.*rotate the Vault secret/s
    );
  });

  it("maps the publishing limit to an actionable error", async () => {
    installFetch(() =>
      graphError(9007, "The user has reached the maximum number of posts.", 400)
    );
    const adapter = await loadAdapter();

    await expect(adapter.publish(input())).rejects.toThrow(
      /code 9007.*daily_post_limit/s
    );
  });

  it("sends the token as a header, never in the query string", async () => {
    installFetch();
    const adapter = await loadAdapter();

    await adapter.publish(input());

    expect(calls.every((c) => !c.url.includes("access_token="))).toBe(true);
    expect(calls.every((c) => !c.url.includes("long-lived-token"))).toBe(true);
  });

  it("explains having no credentials at all", async () => {
    rpcMock.mockImplementation(async () => ({ data: null, error: null }));
    installFetch();
    const adapter = await loadAdapter();

    await expect(adapter.publish(input({ tokenSecretName: null }))).rejects.toThrow(
      /token_secret_name is null/
    );
  });
});

describe("fetchMetrics", () => {
  it("prefers insights and falls back to node fields", async () => {
    installFetch();
    const adapter = await loadAdapter();

    const metrics = await adapter.fetchMetrics!("media_999", "ig_token_main");

    expect(metrics.views).toBe(1500);
    expect(metrics.likes).toBe(42);
    expect(metrics.saves).toBe(9);
    expect(metrics.shares).toBe(3);
    expect(metrics.followerCount).toBe(5000);
  });

  it("still returns counts when insights are unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFetch((url) =>
      url.includes("/insights") ? graphError(100, "Unsupported metric", 400) : null
    );
    const adapter = await loadAdapter();

    const metrics = await adapter.fetchMetrics!("media_999", "ig_token_main");

    // Node fields, not insights.
    expect(metrics.likes).toBe(40);
    expect(metrics.comments).toBe(6);
    expect(metrics.views).toBe(0);
    warn.mockRestore();
  });
});
