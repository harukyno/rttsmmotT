import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { createApp } from "./app.js";
import { ShardHub } from "./shardHub.js";
import { MemoryStore } from "./store.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("dev routes", () => {
  it("resets the demo shard only when dev auth is enabled", async () => {
    const store = new MemoryStore();
    await store.init();
    const hub = new ShardHub(store);
    await hub.selectPlayerActor("user-1", "Reset Me");
    expect(hub.state.actors.filter((actor) => actor.ownerUserId).length).toBe(1);
    const origin = await startTestApp(store, hub, { ...baseConfig, allowDevAuth: true });

    const response = await fetch(`${origin}/api/dev/reset-shard`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, shardId: "demo-1", turnVersion: 1, players: 0 });
    expect(hub.state.actors.filter((actor) => actor.ownerUserId)).toHaveLength(0);
    expect(hub.state.clock).toBeNull();
  });

  it("hides the demo reset route when dev auth is disabled", async () => {
    const store = new MemoryStore();
    await store.init();
    const hub = new ShardHub(store);
    const origin = await startTestApp(store, hub, { ...baseConfig, allowDevAuth: false });

    const response = await fetch(`${origin}/api/dev/reset-shard`, { method: "POST" });

    expect(response.status).toBe(404);
  });
});

async function startTestApp(store: MemoryStore, hub: ShardHub, config: AppConfig) {
  const httpServer = createServer(
    createApp({
      config,
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
  return `http://127.0.0.1:${port}`;
}

const baseConfig: AppConfig = {
  port: 0,
  appOrigin: "http://127.0.0.1",
  sessionSecret: "test-secret",
  googleClientId: "",
  googleClientSecret: "",
  databaseUrl: "",
  allowDevAuth: true,
  nodeEnv: "test"
};
