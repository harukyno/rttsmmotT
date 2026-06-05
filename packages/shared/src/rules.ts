import type {
  ActionIntent,
  ActorState,
  PublicActor,
  RememberedActor,
  ResolvedAction,
  ShardSnapshot,
  TurnClock,
  Vec2,
  VisibilitySnapshot
} from "./types.js";

export const SHARD_ID = "demo-1" as const;
export const INITIAL_AP = 10;
export const TURN_DURATION_MS = 30_000;
export const BASE_VISION_RANGE_M = 30;
export const MAX_DEMO_PLAYERS = 20;

export type ShardState = {
  round: number;
  turnVersion: number;
  actors: ActorState[];
  blockedTiles: Vec2[];
  clock: TurnClock | null;
  log: ResolvedAction[];
  rememberedByUser: Record<string, Record<string, RememberedActor>>;
};

export function distanceM(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function createInitialShardState(now = Date.now()): ShardState {
  const actors: ActorState[] = [
    demoActor("pc-1", null, "先鋒冒険者", "players", { x: 5, y: 9 }, 12),
    demoActor("pc-2", null, "護衛冒険者", "players", { x: 7, y: 10 }, 10),
    demoActor("hostile-1", null, "ヴォルク", "hostiles", { x: 28, y: 9 }, 11),
    demoActor("hostile-2", null, "略奪者", "hostiles", { x: 32, y: 13 }, 8)
  ];
  const state: ShardState = {
    round: 1,
    turnVersion: 1,
    actors,
    blockedTiles: [
      { x: 17, y: 8 },
      { x: 17, y: 9 },
      { x: 17, y: 10 },
      { x: 22, y: 13 },
      { x: 23, y: 13 },
      { x: 24, y: 13 }
    ],
    clock: null,
    log: [],
    rememberedByUser: {}
  };
  startNextTurn(state, now);
  return state;
}

export function demoActor(
  id: string,
  ownerUserId: string | null,
  name: string,
  team: ActorState["team"],
  position: Vec2,
  spd: number
): ActorState {
  return {
    id,
    ownerUserId,
    name,
    team,
    position,
    ap: INITIAL_AP,
    stats: { str: 8, def: 7, pow: 6, prt: 5, dex: 9, spd, int: 7, wis: 6, spe: 0, kr: 0 },
    resources: { hp: 60, maxHp: 60, san: 40, maxSan: 40, mp: 20, maxMp: 20, sp: 40, maxSp: 40 },
    visionRangeM: BASE_VISION_RANGE_M,
    alive: true
  };
}

export function chooseActiveActor(actors: ActorState[]): ActorState | null {
  return actors
    .filter((actor) => actor.alive && actor.ap > 0)
    .sort((a, b) => b.ap - a.ap || b.stats.spd - a.stats.spd || a.id.localeCompare(b.id))[0] ?? null;
}

export function startNextTurn(state: ShardState, now = Date.now()): TurnClock | null {
  let active = chooseActiveActor(state.actors);
  if (!active) {
    state.round += 1;
    for (const actor of state.actors) {
      if (actor.alive) actor.ap = INITIAL_AP;
    }
    active = chooseActiveActor(state.actors);
  }
  state.clock = active
    ? {
        activeActorId: active.id,
        startedAt: now,
        deadlineAt: now + TURN_DURATION_MS,
        durationMs: TURN_DURATION_MS
      }
    : null;
  return state.clock;
}

export function resumeTurnClock(state: ShardState, now = Date.now()): TurnClock | null {
  const preferredActive = state.clock?.activeActorId
    ? state.actors.find((actor) => actor.id === state.clock?.activeActorId && actor.alive && actor.ap > 0)
    : null;
  const active = preferredActive ?? chooseActiveActor(state.actors);
  state.clock = active
    ? {
        activeActorId: active.id,
        startedAt: now,
        deadlineAt: now + TURN_DURATION_MS,
        durationMs: TURN_DURATION_MS
      }
    : null;
  return state.clock;
}

export function pauseTurnClock(state: ShardState) {
  state.clock = null;
}

export function applyAction(state: ShardState, action: ActionIntent, now = Date.now()): ResolvedAction {
  if (action.turnVersion !== state.turnVersion) {
    return rejected(state, action, "stale turn version");
  }
  const actor = state.actors.find((candidate) => candidate.id === action.actorId);
  if (!actor || !actor.alive) {
    return rejected(state, action, "actor is unavailable");
  }
  if (state.clock?.activeActorId !== actor.id) {
    return rejected(state, action, "actor is not active");
  }

  let result: ResolvedAction;
  if (action.type === "move") {
    result = applyMove(state, actor, action);
  } else if (action.type === "attack") {
    result = applyAttack(state, actor, action.targetActorId);
  } else {
    result = applyGuardWait(state, actor);
  }

  state.log = [...state.log.slice(-29), result];
  state.turnVersion += 1;
  startNextTurn(state, now);
  return result;
}

export function applyTimeoutIfNeeded(state: ShardState, now = Date.now()): ResolvedAction | null {
  if (!state.clock || now < state.clock.deadlineAt) return null;
  const activeActorId = state.clock.activeActorId;
  if (!activeActorId) return null;
  return applyAction(
    state,
    {
      type: "guard_wait",
      actorId: activeActorId,
      turnVersion: state.turnVersion
    },
    now
  );
}

function applyMove(state: ShardState, actor: ActorState, action: Extract<ActionIntent, { type: "move" }>): ResolvedAction {
  const maxDistance = Math.max(1, actor.stats.spd / 2);
  const distance = distanceM(actor.position, action.destination);
  if (distance > maxDistance) {
    return rejected(state, action, `destination is too far; max ${maxDistance.toFixed(1)}m`);
  }
  if (state.blockedTiles.some((tile) => sameTile(tile, action.destination))) {
    return rejected(state, action, "destination is blocked");
  }
  actor.position = { x: Math.round(action.destination.x), y: Math.round(action.destination.y) };
  actor.ap = Math.max(0, actor.ap - 1);
  return accepted(state, action, `${actor.name} moved`);
}

function applyAttack(state: ShardState, actor: ActorState, targetActorId: string): ResolvedAction {
  const target = state.actors.find((candidate) => candidate.id === targetActorId);
  if (!target || !target.alive) {
    return rejected(state, { type: "attack", actorId: actor.id, targetActorId, turnVersion: state.turnVersion }, "target is unavailable");
  }
  const range = distanceM(actor.position, target.position);
  if (range > 2) {
    return rejected(state, { type: "attack", actorId: actor.id, targetActorId, turnVersion: state.turnVersion }, "target is outside melee range");
  }
  const damage = Math.max(3, Math.floor(actor.stats.str / 2) + 4 - Math.floor(target.stats.def / 4));
  target.resources.hp = Math.max(0, target.resources.hp - damage);
  target.alive = target.resources.hp > 0;
  actor.ap = Math.max(0, actor.ap - 2);
  return accepted(state, { type: "attack", actorId: actor.id, targetActorId, turnVersion: state.turnVersion }, `${actor.name} hit ${target.name} for ${damage}`);
}

function applyGuardWait(state: ShardState, actor: ActorState): ResolvedAction {
  actor.ap = Math.max(0, actor.ap - 1);
  actor.guardUntilTurnVersion = state.turnVersion + 1;
  return accepted(state, { type: "guard_wait", actorId: actor.id, turnVersion: state.turnVersion }, `${actor.name} guarded`);
}

function accepted(state: ShardState, action: ActionIntent, message: string): ResolvedAction {
  return { turnVersion: state.turnVersion, actorId: action.actorId, type: action.type, accepted: true, message };
}

function rejected(state: ShardState, action: ActionIntent, message: string): ResolvedAction {
  return { turnVersion: state.turnVersion, actorId: action.actorId, type: action.type, accepted: false, message };
}

function sameTile(a: Vec2, b: Vec2): boolean {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

export function computeVisibility(state: ShardState, observerUserId: string): VisibilitySnapshot {
  const owned = state.actors.filter((actor) => actor.ownerUserId === observerUserId && actor.alive);
  const remembered = state.rememberedByUser[observerUserId] ?? {};
  const visibleActors: PublicActor[] = [];

  for (const actor of state.actors) {
    const isOwned = actor.ownerUserId === observerUserId;
    const visible =
      isOwned ||
      owned.some((observer) => {
        const inRange = distanceM(observer.position, actor.position) <= observer.visionRangeM;
        return inRange && !lineBlocked(observer.position, actor.position, state.blockedTiles);
      });
    if (visible) {
      visibleActors.push(toPublicActor(actor, isOwned));
      remembered[actor.id] = {
        id: actor.id,
        name: actor.name,
        team: actor.team,
        lastSeenPosition: actor.position,
        visible: false
      };
    }
  }

  state.rememberedByUser[observerUserId] = remembered;
  const visibleIds = new Set(visibleActors.map((actor) => actor.id));
  return {
    observerUserId,
    visibleActors,
    rememberedActors: Object.values(remembered).filter((actor) => !visibleIds.has(actor.id)),
    blockedTiles: state.blockedTiles
  };
}

export function createSnapshot(state: ShardState, observerUserId: string, selfActorId: string | null): ShardSnapshot {
  const visibility = computeVisibility(state, observerUserId);
  const actors = [...visibility.visibleActors, ...visibility.rememberedActors];
  const actorIds = new Set(actors.map((actor) => actor.id));
  const activeActorId = state.clock?.activeActorId && actorIds.has(state.clock.activeActorId) ? state.clock.activeActorId : null;
  const clock = state.clock ? { ...state.clock, activeActorId } : null;
  return {
    shardId: SHARD_ID,
    round: state.round,
    turnVersion: state.turnVersion,
    activeActorId,
    clock,
    selfActorId,
    actors,
    blockedTiles: visibility.blockedTiles,
    log: state.log.slice(-20)
  };
}

function toPublicActor(actor: ActorState, isOwned: boolean): PublicActor {
  return {
    id: actor.id,
    name: actor.name,
    team: actor.team,
    position: actor.position,
    ap: actor.ap,
    resources: actor.resources,
    alive: actor.alive,
    visionRangeM: actor.visionRangeM,
    isOwned,
    visible: true
  };
}

export function lineBlocked(a: Vec2, b: Vec2, blockedTiles: Vec2[]): boolean {
  const steps = Math.max(1, Math.ceil(distanceM(a, b) * 2));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const point = {
      x: Math.round(a.x + (b.x - a.x) * t),
      y: Math.round(a.y + (b.y - a.y) * t)
    };
    if (blockedTiles.some((tile) => sameTile(tile, point))) return true;
  }
  return false;
}
