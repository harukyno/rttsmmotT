import { describe, expect, it } from "vitest";
import {
  INITIAL_AP,
  TURN_DURATION_MS,
  applyAction,
  applyTimeoutIfNeeded,
  chooseActiveActor,
  computeVisibility,
  createSnapshot,
  createInitialShardState,
  lineBlocked,
  resumeTurnClock
} from "./rules.js";

describe("turn rules", () => {
  it("orders initiative by remaining AP and SPD", () => {
    const state = createInitialShardState(0);
    state.actors[0].ap = 5;
    state.actors[1].ap = 8;
    state.actors[2].ap = 0;
    state.actors[3].ap = 0;
    expect(chooseActiveActor(state.actors)?.id).toBe("pc-2");
  });

  it("rejects stale turn versions", () => {
    const state = createInitialShardState(0);
    const result = applyAction(state, { type: "guard_wait", actorId: "pc-1", turnVersion: 0 }, 1);
    expect(result.accepted).toBe(false);
    expect(state.turnVersion).toBe(1);
  });

  it("applies timeout guard and advances turn", () => {
    const state = createInitialShardState(0);
    const active = state.clock?.activeActorId;
    const result = applyTimeoutIfNeeded(state, 31_000);
    expect(result?.accepted).toBe(true);
    expect(state.actors.find((actor) => actor.id === active)?.ap).toBe(INITIAL_AP - 1);
    expect(state.turnVersion).toBe(2);
  });

  it("resumes a saved turn clock from the current server time", () => {
    const state = createInitialShardState(0);
    const active = state.clock?.activeActorId;
    state.clock = {
      activeActorId: active ?? null,
      startedAt: 0,
      deadlineAt: 1,
      durationMs: TURN_DURATION_MS
    };

    const resumed = resumeTurnClock(state, 50_000);

    expect(resumed?.activeActorId).toBe(active);
    expect(resumed?.startedAt).toBe(50_000);
    expect(resumed?.deadlineAt).toBe(50_000 + TURN_DURATION_MS);
  });
});

describe("visibility", () => {
  it("blocks line of sight through blocked tiles", () => {
    expect(lineBlocked({ x: 0, y: 0 }, { x: 4, y: 0 }, [{ x: 2, y: 0 }])).toBe(true);
  });

  it("filters hidden actors from observer snapshot", () => {
    const state = createInitialShardState(0);
    state.actors[0].ownerUserId = "u1";
    state.actors.find((actor) => actor.id === "hostile-1")!.position = { x: 60, y: 60 };
    const visibility = computeVisibility(state, "u1");
    expect(visibility.visibleActors.some((actor) => actor.id === "hostile-1")).toBe(false);
  });

  it("does not expose hidden active actor ids in snapshots", () => {
    const state = createInitialShardState(0);
    state.actors[0].ownerUserId = "u1";
    state.actors.find((actor) => actor.id === "hostile-1")!.position = { x: 60, y: 60 };
    state.clock = {
      activeActorId: "hostile-1",
      startedAt: 0,
      deadlineAt: TURN_DURATION_MS,
      durationMs: TURN_DURATION_MS
    };

    const snapshot = createSnapshot(state, "u1", "pc-1");

    expect(snapshot.actors.some((actor) => actor.id === "hostile-1")).toBe(false);
    expect(snapshot.activeActorId).toBeNull();
    expect(snapshot.clock?.activeActorId).toBeNull();
  });

  it("includes server-owned blocked tiles in player snapshots", () => {
    const state = createInitialShardState(0);
    state.actors[0].ownerUserId = "u1";
    const snapshot = createSnapshot(state, "u1", "pc-1");
    expect(snapshot.blockedTiles).toContainEqual({ x: 17, y: 9 });
  });
});
