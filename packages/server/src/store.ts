import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { ActorState, SeedData, ShardState } from "@rtts/shared";

export type User = {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
};

export type Session = {
  id: string;
  userId: string;
  expiresAt: number;
};

export interface Store {
  init(): Promise<void>;
  upsertUser(user: Omit<User, "id"> & { id?: string }): Promise<User>;
  getUser(id: string): Promise<User | null>;
  createSession(userId: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  upsertCharacter(shardId: string, actor: ActorState): Promise<void>;
  getCharacterByUser(shardId: string, userId: string): Promise<ActorState | null>;
  saveShardState(shardId: string, state: ShardState): Promise<void>;
  loadShardState(shardId: string): Promise<ShardState | null>;
  saveSeedData(seed: SeedData): Promise<void>;
  appendActionLog(entry: unknown): Promise<void>;
}

export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private sessions = new Map<string, Session>();
  private characters = new Map<string, ActorState>();
  private shardStates = new Map<string, ShardState>();
  seedDefinitions: SeedData | null = null;
  readonly actionLogs: unknown[] = [];

  async init() {}

  async upsertUser(user: Omit<User, "id"> & { id?: string }): Promise<User> {
    const existing = [...this.users.values()].find((candidate) => candidate.email === user.email);
    const next: User = {
      id: existing?.id ?? user.id ?? stableUserId(user.email),
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl
    };
    this.users.set(next.id, next);
    return next;
  }

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async createSession(userId: string): Promise<Session> {
    const session = {
      id: randomUUID(),
      userId,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt < Date.now()) return null;
    return session;
  }

  async deleteSession(id: string) {
    this.sessions.delete(id);
  }

  async upsertCharacter(shardId: string, actor: ActorState) {
    this.characters.set(characterKey(shardId, actor.id), structuredClone(actor));
  }

  async getCharacterByUser(shardId: string, userId: string): Promise<ActorState | null> {
    return structuredClone(
      [...this.characters.entries()]
        .filter(([key]) => key.startsWith(`${shardId}:`))
        .map(([, actor]) => actor)
        .find((actor) => actor.ownerUserId === userId) ?? null
    );
  }

  async saveShardState(shardId: string, state: ShardState) {
    this.shardStates.set(shardId, structuredClone(state));
  }

  async loadShardState(shardId: string): Promise<ShardState | null> {
    return structuredClone(this.shardStates.get(shardId) ?? null);
  }

  async saveSeedData(seed: SeedData) {
    this.seedDefinitions = structuredClone(seed);
  }

  async appendActionLog(entry: unknown) {
    this.actionLogs.push(entry);
  }
}

export class PostgresStore implements Store {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
    });
  }

  async init() {
    await this.pool.query(`
      create table if not exists users (
        id text primary key,
        email text unique not null,
        name text not null,
        avatar_url text
      );
      create table if not exists sessions (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        expires_at bigint not null
      );
      create table if not exists action_logs (
        id bigserial primary key,
        created_at timestamptz not null default now(),
        entry jsonb not null
      );
      create table if not exists characters (
        actor_id text not null,
        user_id text references users(id) on delete set null,
        shard_id text not null,
        name text not null,
        state jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (shard_id, actor_id)
      );
      create index if not exists characters_shard_user_idx on characters (shard_id, user_id);
      create table if not exists shard_states (
        shard_id text primary key,
        state jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists master_definitions (
        kind text not null,
        definition_id text not null,
        definition jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (kind, definition_id)
      );
    `);
  }

  async upsertUser(user: Omit<User, "id"> & { id?: string }): Promise<User> {
    const id = user.id ?? stableUserId(user.email);
    const result = await this.pool.query<User>(
      `insert into users (id, email, name, avatar_url)
       values ($1, $2, $3, $4)
       on conflict (email) do update set name = excluded.name, avatar_url = excluded.avatar_url
       returning id, email, name, avatar_url as "avatarUrl"`,
      [id, user.email, user.name, user.avatarUrl ?? null]
    );
    return result.rows[0]!;
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.pool.query<User>(
      `select id, email, name, avatar_url as "avatarUrl" from users where id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async createSession(userId: string): Promise<Session> {
    const session = { id: randomUUID(), userId, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 14 };
    await this.pool.query(`insert into sessions (id, user_id, expires_at) values ($1, $2, $3)`, [
      session.id,
      userId,
      session.expiresAt
    ]);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    const result = await this.pool.query<Session>(
      `select id, user_id as "userId", expires_at as "expiresAt" from sessions where id = $1 and expires_at > $2`,
      [id, Date.now()]
    );
    return result.rows[0] ?? null;
  }

  async deleteSession(id: string) {
    await this.pool.query(`delete from sessions where id = $1`, [id]);
  }

  async upsertCharacter(shardId: string, actor: ActorState) {
    await this.pool.query(
      `insert into characters (actor_id, user_id, shard_id, name, state, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, now())
       on conflict (shard_id, actor_id) do update
       set user_id = excluded.user_id,
           shard_id = excluded.shard_id,
           name = excluded.name,
           state = excluded.state,
           updated_at = now()`,
      [actor.id, actor.ownerUserId, shardId, actor.name, JSON.stringify(actor)]
    );
  }

  async getCharacterByUser(shardId: string, userId: string): Promise<ActorState | null> {
    const result = await this.pool.query<{ state: ActorState }>(
      `select state from characters where shard_id = $1 and user_id = $2 limit 1`,
      [shardId, userId]
    );
    return result.rows[0]?.state ?? null;
  }

  async saveShardState(shardId: string, state: ShardState) {
    await this.pool.query(
      `insert into shard_states (shard_id, state, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (shard_id) do update set state = excluded.state, updated_at = now()`,
      [shardId, JSON.stringify(state)]
    );
  }

  async loadShardState(shardId: string): Promise<ShardState | null> {
    const result = await this.pool.query<{ state: ShardState }>(`select state from shard_states where shard_id = $1`, [
      shardId
    ]);
    return result.rows[0]?.state ?? null;
  }

  async saveSeedData(seed: SeedData) {
    const definitions = [
      ...seed.skills.map((definition) => ["skill", definition.id, definition] as const),
      ...seed.items.map((definition) => ["item", definition.id, definition] as const),
      ...seed.materials.map((definition) => ["material", definition.id, definition] as const),
      ...seed.magic.map((definition) => ["magic", definition.id, definition] as const)
    ];
    for (const [kind, id, definition] of definitions) {
      await this.pool.query(
        `insert into master_definitions (kind, definition_id, definition, updated_at)
         values ($1, $2, $3::jsonb, now())
         on conflict (kind, definition_id) do update set definition = excluded.definition, updated_at = now()`,
        [kind, id, JSON.stringify(definition)]
      );
    }
  }

  async appendActionLog(entry: unknown) {
    await this.pool.query(`insert into action_logs (entry) values ($1)`, [entry]);
  }
}

export function createStore(databaseUrl: string): Store {
  return databaseUrl ? new PostgresStore(databaseUrl) : new MemoryStore();
}

function stableUserId(email: string): string {
  return `usr_${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
}

function characterKey(shardId: string, actorId: string): string {
  return `${shardId}:${actorId}`;
}
