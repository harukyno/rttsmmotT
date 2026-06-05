import { describe, expect, it } from "vitest";
import { createInitialShardState } from "@rtts/shared";
import { MemoryStore } from "./store.js";

describe("MemoryStore", () => {
  it("creates users and sessions", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUser({ email: "demo@example.test", name: "Demo" });
    const session = await store.createSession(user.id);

    await expect(store.getSession(session.id)).resolves.toMatchObject({ userId: user.id });
    await expect(store.getUser(user.id)).resolves.toMatchObject({ email: "demo@example.test" });
  });

  it("deletes sessions", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUser({ email: "demo@example.test", name: "Demo" });
    const session = await store.createSession(user.id);
    await store.deleteSession(session.id);
    await expect(store.getSession(session.id)).resolves.toBeNull();
  });

  it("persists characters, shard state, and seed definitions", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUser({ email: "pilot@example.test", name: "Pilot" });
    const state = createInitialShardState(1000);
    state.clock = null;
    const actor = state.actors[0]!;
    actor.ownerUserId = user.id;
    actor.name = "Pilot";

    await store.upsertCharacter("demo-1", actor);
    await store.saveShardState("demo-1", state);
    await store.saveSeedData({ skills: [], items: [], materials: [], magic: [] });

    await expect(store.getCharacterByUser("demo-1", user.id)).resolves.toMatchObject({ id: actor.id, name: "Pilot" });
    await expect(store.loadShardState("demo-1")).resolves.toMatchObject({ turnVersion: state.turnVersion });
    expect(store.seedDefinitions).toEqual({ skills: [], items: [], materials: [], magic: [] });
  });
});
