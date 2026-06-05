import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { createApp } from "./app.js";
import { ShardHub } from "./shardHub.js";
import { MemoryStore } from "./store.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("google oauth flow", () => {
  it("creates a user and secure session cookie after a valid callback", async () => {
    const store = new MemoryStore();
    await store.init();
    const hub = new ShardHub(store);
    const { origin } = await startTestApp(store, hub);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        expect(init?.method).toBe("POST");
        const body = init?.body as URLSearchParams;
        expect(body.get("code")).toBe("valid-code");
        expect(body.get("redirect_uri")).toBe(`${origin}/auth/google/callback`);
        return jsonResponse({ access_token: "access-token" });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access-token");
        return jsonResponse({ email: "oauth-player@rtts.local", name: "OAuth Player", picture: "https://example.test/avatar.png" });
      }
      return originalFetch(input, init);
    });

    const start = await originalFetch(`${origin}/auth/google/start`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const oauthCookie = cookieHeader(start);
    const redirect = new URL(start.headers.get("location")!);
    expect(redirect.origin).toBe("https://accounts.google.com");
    const state = redirect.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await originalFetch(`${origin}/auth/google/callback?code=valid-code&state=${state}`, {
      headers: { cookie: oauthCookie },
      redirect: "manual"
    });
    expect(callback.status).toBe(302);
    const sessionCookie = cookieHeader(callback, "rtts_session");
    expect(sessionCookie).toContain("rtts_session=");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const me = await originalFetch(`${origin}/api/me`, { headers: { cookie: sessionCookie } });
    expect(await me.json()).toMatchObject({
      user: {
        email: "oauth-player@rtts.local",
        name: "OAuth Player",
        avatarUrl: "https://example.test/avatar.png"
      },
      googleConfigured: true
    });
  });

  it("rejects callbacks with an invalid oauth state before creating a session", async () => {
    const store = new MemoryStore();
    await store.init();
    const hub = new ShardHub(store);
    const { origin } = await startTestApp(store, hub);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const start = await originalFetch(`${origin}/auth/google/start`, { redirect: "manual" });
    const oauthCookie = cookieHeader(start);

    const callback = await originalFetch(`${origin}/auth/google/callback?code=valid-code&state=wrong-state`, {
      headers: { cookie: oauthCookie },
      redirect: "manual"
    });

    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("Invalid OAuth state");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookieHeader(callback, "rtts_session")).toBe("");
  });
});

const originalFetch = globalThis.fetch.bind(globalThis);

async function startTestApp(store: MemoryStore, hub: ShardHub) {
  const httpServer = createServer(
    createApp({
      config: testConfig,
      store,
      hub,
      seedData: { skills: [], items: [], materials: [], magic: [] }
    })
  );
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () =>
      new Promise((resolve) => {
        httpServer.close(() => resolve());
      })
  });
  const { port } = httpServer.address() as AddressInfo;
  testConfig.appOrigin = `http://127.0.0.1:${port}`;
  return { origin: testConfig.appOrigin };
}

const testConfig: AppConfig = {
  port: 0,
  appOrigin: "http://127.0.0.1",
  sessionSecret: "test-secret",
  googleClientId: "google-client",
  googleClientSecret: "google-secret",
  databaseUrl: "",
  allowDevAuth: false,
  nodeEnv: "test"
};

function jsonResponse(value: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
}

function cookieHeader(response: Response, name?: string) {
  const cookie = response.headers.get("set-cookie") ?? "";
  if (!name) return cookie.split(", ").map((part) => part.split(";")[0]).join("; ");
  const match = cookie.match(new RegExp(`${name}=[^;,]+`));
  return match?.[0] ?? "";
}
