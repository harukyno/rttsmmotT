export type ShardId = "demo-1";

export type Vec2 = {
  x: number;
  y: number;
};

export type ResourceState = {
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  mp: number;
  maxMp: number;
  sp: number;
  maxSp: number;
};

export type ActorStats = {
  str: number;
  def: number;
  pow: number;
  prt: number;
  dex: number;
  spd: number;
  int: number;
  wis: number;
  spe: number;
  kr: number;
};

export type ActorState = {
  id: string;
  ownerUserId: string | null;
  name: string;
  team: "players" | "hostiles";
  position: Vec2;
  ap: number;
  stats: ActorStats;
  resources: ResourceState;
  visionRangeM: number;
  guardUntilTurnVersion?: number;
  alive: boolean;
};

export type SkillDefinition = {
  id: string;
  name: string;
  kind: "move" | "attack" | "defense" | "evasion" | "magic" | "wait";
  apCost: number;
  mpCost: number | "X";
  spCost: number | "X";
  rangeM: number | "self" | "touch" | "X";
  description: string;
  source?: SourceMetadata;
};

export type ItemDefinition = {
  id: string;
  name: string;
  kind: "weapon" | "armor" | "ammo" | "material" | "other";
  price?: number;
  weightKg?: number;
  details: string;
  source?: SourceMetadata;
};

export type MaterialDefinition = {
  id: string;
  name: string;
  density?: number;
  amr?: number;
  def?: number;
  hp?: number;
  tgh?: number;
  source?: SourceMetadata;
};

export type MagicDefinition = {
  id: string;
  name: string;
  mpCost: number | "X";
  apCost: number;
  intCost?: number;
  description: string;
  source?: SourceMetadata;
};

export type SourceMetadata = {
  workbook?: string;
  sheet: string;
  range: string;
  note?: string;
};

export type ActionIntent =
  | {
      type: "move";
      actorId: string;
      turnVersion: number;
      destination: Vec2;
    }
  | {
      type: "attack";
      actorId: string;
      turnVersion: number;
      targetActorId: string;
    }
  | {
      type: "guard_wait";
      actorId: string;
      turnVersion: number;
    };

export type ResolvedAction = {
  turnVersion: number;
  actorId: string;
  type: ActionIntent["type"];
  accepted: boolean;
  message: string;
};

export type PublicActor = Pick<
  ActorState,
  "id" | "name" | "team" | "position" | "ap" | "resources" | "alive" | "visionRangeM"
> & {
  isOwned: boolean;
  visible: true;
};

export type RememberedActor = {
  id: string;
  name: string;
  team: ActorState["team"];
  lastSeenPosition: Vec2;
  visible: false;
};

export type VisibilitySnapshot = {
  observerUserId: string;
  visibleActors: PublicActor[];
  rememberedActors: RememberedActor[];
  blockedTiles: Vec2[];
};

export type TurnClock = {
  activeActorId: string | null;
  startedAt: number;
  deadlineAt: number;
  durationMs: number;
};

export type ShardSnapshot = {
  shardId: ShardId;
  round: number;
  turnVersion: number;
  activeActorId: string | null;
  clock: TurnClock | null;
  selfActorId: string | null;
  actors: Array<PublicActor | RememberedActor>;
  blockedTiles: Vec2[];
  log: ResolvedAction[];
};

export type ClientMessage =
  | { type: "join_shard"; shardId: ShardId; characterName?: string }
  | { type: "submit_action"; action: ActionIntent }
  | { type: "ping"; sentAt: number };

export type ServerMessage =
  | { type: "shard_snapshot"; snapshot: ShardSnapshot }
  | { type: "turn_started"; clock: TurnClock; turnVersion: number }
  | { type: "timer_tick"; activeActorId: string | null; remainingMs: number; turnVersion: number }
  | { type: "action_accepted"; action: ResolvedAction }
  | { type: "action_rejected"; action: ResolvedAction }
  | { type: "action_resolved"; action: ResolvedAction; snapshot: ShardSnapshot }
  | { type: "visibility_delta"; snapshot: ShardSnapshot }
  | { type: "round_started"; round: number; turnVersion: number }
  | { type: "pong"; sentAt: number; serverAt: number }
  | { type: "error"; message: string };

export type SeedData = {
  skills: SkillDefinition[];
  items: ItemDefinition[];
  materials: MaterialDefinition[];
  magic: MagicDefinition[];
};
