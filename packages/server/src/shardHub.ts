import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  SHARD_ID,
  applyAction,
  applyTimeoutIfNeeded,
  computeVisibility,
  createInitialShardState,
  createSnapshot,
  demoActor,
  MAX_DEMO_PLAYERS,
  pauseTurnClock,
  resumeTurnClock,
  startNextTurn,
  type ClientMessage,
  type ServerMessage,
  type ShardState
} from "@rtts/shared";
import { getSessionIdFromCookie } from "./auth.js";
import type { Store, User } from "./store.js";

type Client = {
  ws: WebSocket;
  user: User;
  actorId: string | null;
};

export class ShardHub {
  state: ShardState;
  private clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: Store) {
    this.state = createInitialShardState();
    pauseTurnClock(this.state);
  }

  async init(now = Date.now()) {
    const saved = await this.store.loadShardState(SHARD_ID);
    if (saved) {
      this.state = saved;
      resumeTurnClock(this.state, now);
    }
  }

  async selectPlayerActor(userId: string, characterName?: string) {
    const actorId = this.claimPlayerActor(userId, characterName);
    if (!actorId) return null;
    if (!this.state.clock) startNextTurn(this.state);
    await this.persistActor(actorId);
    await this.persistShardState();
    return this.state.actors.find((actor) => actor.id === actorId) ?? null;
  }

  async resetDemoState(now = Date.now()) {
    this.state = createInitialShardState(now);
    pauseTurnClock(this.state);
    await this.persistShardState();
    this.broadcastSnapshots();
  }

  attach(wss: WebSocketServer) {
    wss.on("connection", async (ws, req) => {
      const user = await this.authenticate(req);
      if (!user) {
        ws.send(JSON.stringify({ type: "error", message: "unauthenticated" } satisfies ServerMessage));
        ws.close(1008, "unauthenticated");
        return;
      }
      const client: Client = { ws, user, actorId: null };
      this.clients.add(client);
      ws.on("message", (raw) => void this.handleMessage(client, raw.toString()));
      ws.on("close", () => this.clients.delete(client));
      this.send(client, { type: "shard_snapshot", snapshot: createSnapshot(this.state, user.id, client.actorId) });
      this.ensureTimer();
    });
  }

  private async authenticate(req: IncomingMessage): Promise<User | null> {
    const sessionId = getSessionIdFromCookie(req.headers.cookie);
    if (!sessionId) return null;
    const session = await this.store.getSession(sessionId);
    if (!session) return null;
    return this.store.getUser(session.userId);
  }

  private async handleMessage(client: Client, raw: string) {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(client, { type: "error", message: "invalid json" });
      return;
    }
    if (message.type === "ping") {
      this.send(client, { type: "pong", sentAt: message.sentAt, serverAt: Date.now() });
      return;
    }
    if (message.type === "join_shard") {
      if (message.shardId !== SHARD_ID) {
        this.send(client, { type: "error", message: "unknown shard" });
        return;
      }
      const actor = await this.selectPlayerActor(client.user.id, message.characterName);
      if (!actor) {
        this.send(client, { type: "error", message: "demo shard is full" });
        return;
      }
      client.actorId = actor.id;
      this.broadcastSnapshots();
      return;
    }
    if (message.type === "submit_action") {
      const actor = this.state.actors.find((candidate) => candidate.id === message.action.actorId);
      if (message.action.actorId !== client.actorId || actor?.ownerUserId !== client.user.id) {
        this.send(client, { type: "action_rejected", action: this.rejectClientAction(message.action, "actor is not owned by this session") });
        return;
      }
      if (message.action.type === "attack" && !this.canUserSeeActor(client.user.id, message.action.targetActorId)) {
        this.send(client, { type: "action_rejected", action: this.rejectClientAction(message.action, "target is not visible") });
        return;
      }
      const result = this.applyActionWithRoundNotice(message.action);
      await this.store.appendActionLog(result);
      await this.persistActor(message.action.actorId);
      await this.persistShardState();
      this.broadcast(result.accepted ? { type: "action_accepted", action: result } : { type: "action_rejected", action: result });
      this.broadcastSnapshots(result);
    }
  }

  private claimPlayerActor(userId: string, characterName?: string): string | null {
    const existing = this.state.actors.find((actor) => actor.ownerUserId === userId);
    if (existing) return existing.id;
    const open = this.state.actors.find((actor) => actor.team === "players" && !actor.ownerUserId);
    if (open) {
      open.ownerUserId = userId;
      if (characterName?.trim()) open.name = characterName.trim().slice(0, 32);
      return open.id;
    }
    const playerCount = this.state.actors.filter((actor) => actor.team === "players").length;
    if (playerCount >= MAX_DEMO_PLAYERS) return null;
    const nextNumber = playerCount + 1;
    const actor = demoActor(
      `pc-${nextNumber}`,
      userId,
      characterName?.trim().slice(0, 32) || `Player ${nextNumber}`,
      "players",
      this.nextSpawnPosition(nextNumber),
      8 + (nextNumber % 5)
    );
    this.state.actors.splice(Math.max(0, this.state.actors.length - 2), 0, actor);
    return actor.id;
  }

  private nextSpawnPosition(nextNumber: number) {
    const x = 4 + ((nextNumber - 1) % 8) * 2;
    const y = 5 + Math.floor((nextNumber - 1) / 8) * 3;
    return { x, y };
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const automated = this.applyAutomatedTurnIfNeeded();
      if (automated) {
        void this.store.appendActionLog(automated);
        void this.persistActor(automated.actorId);
        void this.persistShardState();
        this.broadcastSnapshots(automated);
        return;
      }
      const timeoutResult = this.applyTimeoutWithRoundNotice();
      if (timeoutResult) {
        void this.store.appendActionLog(timeoutResult);
        void this.persistActor(timeoutResult.actorId);
        void this.persistShardState();
        this.broadcastSnapshots(timeoutResult);
      } else if (this.state.clock) {
        for (const client of this.clients) {
          this.send(client, {
            type: "timer_tick",
            activeActorId: this.visibleActiveActorIdFor(client),
            remainingMs: Math.max(0, this.state.clock.deadlineAt - Date.now()),
            turnVersion: this.state.turnVersion
          });
        }
      }
    }, 1000);
  }

  private broadcastSnapshots(result?: ReturnType<typeof applyAction>) {
    for (const client of this.clients) {
      const snapshot = createSnapshot(this.state, client.user.id, client.actorId);
      if (result) {
        this.send(client, {
          type: "action_resolved",
          action: result,
          snapshot
        });
      } else {
        this.send(client, { type: "shard_snapshot", snapshot });
      }
      if (snapshot.clock) {
        this.send(client, { type: "turn_started", clock: snapshot.clock, turnVersion: this.state.turnVersion });
      }
    }
  }

  private broadcast(message: ServerMessage) {
    for (const client of this.clients) this.send(client, message);
  }

  private applyActionWithRoundNotice(action: Extract<ClientMessage, { type: "submit_action" }>["action"]) {
    const previousRound = this.state.round;
    const result = applyAction(this.state, action);
    this.broadcastRoundStartedIfNeeded(previousRound);
    return result;
  }

  private applyTimeoutWithRoundNotice() {
    const previousRound = this.state.round;
    const result = applyTimeoutIfNeeded(this.state);
    if (result) this.broadcastRoundStartedIfNeeded(previousRound);
    return result;
  }

  private broadcastRoundStartedIfNeeded(previousRound: number) {
    if (this.state.round > previousRound) {
      this.broadcast({ type: "round_started", round: this.state.round, turnVersion: this.state.turnVersion });
    }
  }

  private send(client: Client, message: ServerMessage) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  private rejectClientAction(action: Extract<ClientMessage, { type: "submit_action" }>["action"], message: string) {
    return {
      turnVersion: this.state.turnVersion,
      actorId: action.actorId,
      type: action.type,
      accepted: false,
      message
    };
  }

  private canUserSeeActor(userId: string, actorId: string) {
    return computeVisibility(this.state, userId).visibleActors.some((actor) => actor.id === actorId);
  }

  private visibleActiveActorIdFor(client: Client) {
    if (!this.state.clock?.activeActorId) return null;
    const snapshot = createSnapshot(this.state, client.user.id, client.actorId);
    return snapshot.activeActorId;
  }

  private applyAutomatedTurnIfNeeded() {
    const activeActorId = this.state.clock?.activeActorId;
    if (!activeActorId) return null;
    const active = this.state.actors.find((actor) => actor.id === activeActorId);
    if (!active) return null;
    const controlled = [...this.clients].some((client) => client.actorId === activeActorId && active.ownerUserId === client.user.id);
    if (controlled) return null;
    const previousRound = this.state.round;
    const result = applyAction(this.state, {
      type: "guard_wait",
      actorId: activeActorId,
      turnVersion: this.state.turnVersion
    });
    this.broadcastRoundStartedIfNeeded(previousRound);
    return result;
  }

  private async persistActor(actorId: string) {
    const actor = this.state.actors.find((candidate) => candidate.id === actorId);
    if (actor?.ownerUserId) {
      await this.store.upsertCharacter(SHARD_ID, actor);
    }
  }

  private async persistShardState() {
    await this.store.saveShardState(SHARD_ID, this.state);
  }
}
