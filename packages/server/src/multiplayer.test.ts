import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { ServerMessage } from "@rtts/shared";
import { ShardHub } from "./shardHub.js";
import { MemoryStore } from "./store.js";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("multiplayer shard", () => {
  it("rejects unauthenticated websocket clients", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;

    const result = await new Promise<{ code: number; message: string | null }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let errorMessage: string | null = null;
      const timer = setTimeout(() => reject(new Error("unauthenticated close timed out")), 5000);
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.type === "error") errorMessage = message.message;
      });
      ws.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, message: errorMessage });
      });
      ws.on("error", reject);
    });

    expect(result.code).toBe(1008);
    expect(result.message).toBe("unauthenticated");
  });

  it("assigns many authenticated websocket sessions to distinct actors on one shard", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;

    const snapshots = [];
    for (let index = 1; index <= 20; index += 1) {
      const user = await store.upsertUser({ email: `player${index}@test.local`, name: `Player${index}` });
      const session = await store.createSession(user.id);
      snapshots.push(await join(`ws://127.0.0.1:${port}/ws`, session.id, `Player${index}`));
    }

    const actorIds = snapshots.map((snapshot) => snapshot.selfActorId);
    expect(snapshots.every((snapshot) => snapshot.shardId === "demo-1")).toBe(true);
    expect(new Set(actorIds).size).toBe(20);
    expect(actorIds).toContain("pc-20");
  });

  it("rejects control of another user's actor", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;
    const user1 = await store.upsertUser({ email: "owner@test.local", name: "Owner" });
    const user2 = await store.upsertUser({ email: "intruder@test.local", name: "Intruder" });
    const session1 = await store.createSession(user1.id);
    const session2 = await store.createSession(user2.id);
    const ownerSnapshot = await join(`ws://127.0.0.1:${port}/ws`, session1.id, "Owner");
    const intruder = await openJoinedSocket(`ws://127.0.0.1:${port}/ws`, session2.id, "Intruder");

    const rejection = await new Promise<Extract<ServerMessage, { type: "action_rejected" }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("rejection timed out")), 5000);
      intruder.ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.type === "action_rejected") {
          clearTimeout(timer);
          resolve(message);
        }
      });
      intruder.ws.send(
        JSON.stringify({
          type: "submit_action",
          action: { type: "guard_wait", actorId: ownerSnapshot.selfActorId, turnVersion: intruder.snapshot.turnVersion }
        })
      );
    });
    intruder.ws.close();

    expect(rejection.action.accepted).toBe(false);
    expect(rejection.action.message).toContain("not owned");
  });

  it("broadcasts a resolved action to another authenticated client on the same shard", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;
    const user1 = await store.upsertUser({ email: "sync-a@test.local", name: "SyncA" });
    const user2 = await store.upsertUser({ email: "sync-b@test.local", name: "SyncB" });
    const session1 = await store.createSession(user1.id);
    const session2 = await store.createSession(user2.id);
    const clientA = await openJoinedSocket(`ws://127.0.0.1:${port}/ws`, session1.id, "SyncA");
    const clientB = await openJoinedSocket(`ws://127.0.0.1:${port}/ws`, session2.id, "SyncB");

    expect(clientA.snapshot.activeActorId).toBe(clientA.snapshot.selfActorId);
    const resolvedByB = waitForActionResolved(clientB.ws);
    clientA.ws.send(
      JSON.stringify({
        type: "submit_action",
        action: { type: "guard_wait", actorId: clientA.snapshot.selfActorId, turnVersion: clientA.snapshot.turnVersion }
      })
    );
    const resolved = await resolvedByB;
    clientA.ws.close();
    clientB.ws.close();

    expect(resolved.action.accepted).toBe(true);
    expect(resolved.action.actorId).toBe(clientA.snapshot.selfActorId);
    expect(resolved.action.type).toBe("guard_wait");
    expect(resolved.snapshot.turnVersion).toBe(clientA.snapshot.turnVersion + 1);
    expect(resolved.snapshot.actors.some((actor) => actor.id === clientA.snapshot.selfActorId)).toBe(true);
  });

  it("broadcasts round_started when the last usable AP is spent", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    const user = await store.upsertUser({ email: "round@test.local", name: "Round" });
    const session = await store.createSession(user.id);
    const actor = await hub.selectPlayerActor(user.id, "Round");
    for (const candidate of hub.state.actors) candidate.ap = 0;
    actor!.ap = 1;
    hub.state.clock = {
      activeActorId: actor!.id,
      startedAt: 0,
      deadlineAt: 30_000,
      durationMs: 30_000
    };
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;
    const client = await openJoinedSocket(`ws://127.0.0.1:${port}/ws`, session.id, "Round");

    const roundStarted = waitForRoundStarted(client.ws);
    client.ws.send(
      JSON.stringify({
        type: "submit_action",
        action: { type: "guard_wait", actorId: client.snapshot.selfActorId, turnVersion: client.snapshot.turnVersion }
      })
    );
    const message = await roundStarted;
    client.ws.close();

    expect(message.round).toBe(2);
    expect(message.turnVersion).toBe(client.snapshot.turnVersion + 1);
  });

  it("sends different visibility-filtered snapshots to clients in different positions", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    const user1 = await store.upsertUser({ email: "vision-a@test.local", name: "VisionA" });
    const user2 = await store.upsertUser({ email: "vision-b@test.local", name: "VisionB" });
    const session1 = await store.createSession(user1.id);
    const session2 = await store.createSession(user2.id);
    await hub.selectPlayerActor(user1.id, "VisionA");
    await hub.selectPlayerActor(user2.id, "VisionB");
    hub.state.actors.find((actor) => actor.id === "pc-1")!.position = { x: 2, y: 2 };
    hub.state.actors.find((actor) => actor.id === "pc-2")!.position = { x: 38, y: 20 };
    hub.state.actors.find((actor) => actor.id === "hostile-1")!.position = { x: 4, y: 2 };
    hub.state.actors.find((actor) => actor.id === "hostile-2")!.position = { x: 36, y: 20 };
    const now = Date.now();
    hub.state.clock = {
      activeActorId: "pc-1",
      startedAt: now,
      deadlineAt: now + 30_000,
      durationMs: 30_000
    };
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;

    const clientA = await openJoinedSocketWithTurnStarted(`ws://127.0.0.1:${port}/ws`, session1.id, "VisionA");
    const clientB = await openJoinedSocketWithTurnStarted(`ws://127.0.0.1:${port}/ws`, session2.id, "VisionB");
    const tickA = waitForTimerTick(clientA.ws);
    const tickB = waitForTimerTick(clientB.ws);
    const timerA = await tickA;
    const timerB = await tickB;
    clientA.ws.close();
    clientB.ws.close();

    const visibleToA = new Set(clientA.snapshot.actors.map((actor) => actor.id));
    const visibleToB = new Set(clientB.snapshot.actors.map((actor) => actor.id));
    expect(visibleToA.has("hostile-1")).toBe(true);
    expect(visibleToA.has("hostile-2")).toBe(false);
    expect(visibleToB.has("hostile-1")).toBe(false);
    expect(visibleToB.has("hostile-2")).toBe(true);
    expect(clientA.snapshot.activeActorId).toBe("pc-1");
    expect(clientA.snapshot.clock?.activeActorId).toBe("pc-1");
    expect(clientA.turnStarted.clock.activeActorId).toBe("pc-1");
    expect(timerA.activeActorId).toBe("pc-1");
    expect(clientB.snapshot.activeActorId).toBeNull();
    expect(clientB.snapshot.clock?.activeActorId).toBeNull();
    expect(clientB.turnStarted.clock.activeActorId).toBeNull();
    expect(timerB.activeActorId).toBeNull();
  });

  it("rejects attacks against actors outside the player's current visibility", async () => {
    const store = new MemoryStore();
    await store.init();
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    const hub = new ShardHub(store);
    const user = await store.upsertUser({ email: "hidden-attack@test.local", name: "HiddenAttack" });
    const session = await store.createSession(user.id);
    await hub.selectPlayerActor(user.id, "HiddenAttack");
    const self = hub.state.actors.find((actor) => actor.ownerUserId === user.id)!;
    self.position = { x: 2, y: 2 };
    hub.state.actors.find((actor) => actor.id === "hostile-2")!.position = { x: 38, y: 20 };
    hub.state.clock = {
      activeActorId: self.id,
      startedAt: 0,
      deadlineAt: 30_000,
      durationMs: 30_000
    };
    hub.attach(wss);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    servers.push({
      close: () =>
        new Promise((resolve) => {
          wss.close(() => httpServer.close(() => resolve()));
        })
    });
    const port = (httpServer.address() as AddressInfo).port;
    const client = await openJoinedSocket(`ws://127.0.0.1:${port}/ws`, session.id, "HiddenAttack");

    const rejection = waitForActionRejected(client.ws);
    client.ws.send(
      JSON.stringify({
        type: "submit_action",
        action: { type: "attack", actorId: client.snapshot.selfActorId, targetActorId: "hostile-2", turnVersion: client.snapshot.turnVersion }
      })
    );
    const rejected = await rejection;
    client.ws.close();

    expect(rejected.action.accepted).toBe(false);
    expect(rejected.action.message).toBe("target is not visible");
    expect(hub.state.turnVersion).toBe(client.snapshot.turnVersion);
  });

  it("restores saved shard actors after hub restart", async () => {
    const store = new MemoryStore();
    await store.init();
    const user = await store.upsertUser({ email: "restore@test.local", name: "Restore" });

    const firstHub = new ShardHub(store);
    const firstActor = await firstHub.selectPlayerActor(user.id, "Restore");
    expect(firstActor?.id).toBe("pc-1");
    expect(await store.loadShardState("demo-1")).toMatchObject({ actors: expect.arrayContaining([expect.objectContaining({ id: "pc-1", ownerUserId: user.id })]) });

    const restoredHub = new ShardHub(store);
    await restoredHub.init(100_000);
    const restoredActor = await restoredHub.selectPlayerActor(user.id, "Restore Renamed");

    expect(restoredActor?.id).toBe("pc-1");
    expect(restoredActor?.ownerUserId).toBe(user.id);
    expect(restoredHub.state.actors.filter((actor) => actor.ownerUserId === user.id)).toHaveLength(1);
    expect(restoredHub.state.clock?.startedAt).toBe(100_000);
    expect(restoredHub.state.clock?.deadlineAt).toBeGreaterThan(100_000);
  });
});

function join(url: string, sessionId: string, characterName: string) {
  return new Promise<Extract<ServerMessage, { type: "shard_snapshot" }>["snapshot"]>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: `rtts_session=${sessionId}` } });
    const timer = setTimeout(() => reject(new Error(`join timed out for ${characterName}`)), 5000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join_shard", shardId: "demo-1", characterName }));
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "shard_snapshot" && message.snapshot.selfActorId) {
        clearTimeout(timer);
        ws.close();
        resolve(message.snapshot);
      }
    });
    ws.on("error", reject);
  });
}

function openJoinedSocket(url: string, sessionId: string, characterName: string) {
  return new Promise<{ ws: WebSocket; snapshot: Extract<ServerMessage, { type: "shard_snapshot" }>["snapshot"] }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: `rtts_session=${sessionId}` } });
    const timer = setTimeout(() => reject(new Error(`join timed out for ${characterName}`)), 5000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join_shard", shardId: "demo-1", characterName }));
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "shard_snapshot" && message.snapshot.selfActorId) {
        clearTimeout(timer);
        resolve({ ws, snapshot: message.snapshot });
      }
    });
    ws.on("error", reject);
  });
}

function openJoinedSocketWithTurnStarted(url: string, sessionId: string, characterName: string) {
  return new Promise<{
    ws: WebSocket;
    snapshot: Extract<ServerMessage, { type: "shard_snapshot" }>["snapshot"];
    turnStarted: Extract<ServerMessage, { type: "turn_started" }>;
  }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Cookie: `rtts_session=${sessionId}` } });
    const timer = setTimeout(() => reject(new Error(`join with turn start timed out for ${characterName}`)), 5000);
    let snapshot: Extract<ServerMessage, { type: "shard_snapshot" }>["snapshot"] | null = null;
    let turnStarted: Extract<ServerMessage, { type: "turn_started" }> | null = null;
    const complete = () => {
      if (snapshot && turnStarted) {
        clearTimeout(timer);
        resolve({ ws, snapshot, turnStarted });
      }
    };
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "join_shard", shardId: "demo-1", characterName }));
    });
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "shard_snapshot" && message.snapshot.selfActorId) {
        snapshot = message.snapshot;
        complete();
      }
      if (message.type === "turn_started") {
        turnStarted = message;
        complete();
      }
    });
    ws.on("error", reject);
  });
}

function waitForActionResolved(ws: WebSocket) {
  return new Promise<Extract<ServerMessage, { type: "action_resolved" }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("action resolution timed out")), 5000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "action_resolved") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}

function waitForActionRejected(ws: WebSocket) {
  return new Promise<Extract<ServerMessage, { type: "action_rejected" }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("action rejection timed out")), 5000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "action_rejected") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}

function waitForRoundStarted(ws: WebSocket) {
  return new Promise<Extract<ServerMessage, { type: "round_started" }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("round start timed out")), 5000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "round_started") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}

function waitForTimerTick(ws: WebSocket) {
  return new Promise<Extract<ServerMessage, { type: "timer_tick" }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timer tick timed out")), 5000);
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "timer_tick") {
        clearTimeout(timer);
        resolve(message);
      }
    });
    ws.on("error", reject);
  });
}
