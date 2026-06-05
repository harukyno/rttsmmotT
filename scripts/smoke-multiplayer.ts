import WebSocket from "ws";
import type { ServerMessage, ShardSnapshot } from "@rtts/shared";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
const runId = Date.now().toString(36);

type SmokeClient = {
  label: string;
  cookie: string;
  ws: WebSocket;
  snapshot: ShardSnapshot;
  messages: ServerMessage[];
};

async function main() {
  await assertHealth();
  await resetShardIfAvailable();
  const [clientA, clientB] = await Promise.all([
    openClient("SmokeA", `smoke-a-${runId}@rtts.local`),
    openClient("SmokeB", `smoke-b-${runId}@rtts.local`)
  ]);

  try {
    assertDistinctActors(clientA.snapshot, clientB.snapshot);
    const [tickA, tickB] = await Promise.all([
      waitForMessage(clientA, (message) => message.type === "timer_tick", 20_000),
      waitForMessage(clientB, (message) => message.type === "timer_tick", 20_000)
    ]);
    if (tickA.type !== "timer_tick" || tickB.type !== "timer_tick") throw new Error("unexpected timer message");
    if (tickA.turnVersion !== tickB.turnVersion) {
      throw new Error(`timer turnVersion mismatch: ${tickA.turnVersion} != ${tickB.turnVersion}`);
    }

    const actionClient = await waitForOwnedTurn([clientA, clientB], 45_000);
    const observer = actionClient === clientA ? clientB : clientA;
    const actionTurnVersion = actionClient.snapshot.turnVersion;
    const observerMessageIndex = observer.messages.length;
    const resolvedByObserver = waitForMessageAfter(
      observer,
      observerMessageIndex,
      (message) => message.type === "action_resolved" && message.action.actorId === actionClient.snapshot.selfActorId,
      10_000
    );
    actionClient.ws.send(
      JSON.stringify({
        type: "submit_action",
        action: { type: "guard_wait", actorId: actionClient.snapshot.selfActorId, turnVersion: actionTurnVersion }
      })
    );
    const resolved = await resolvedByObserver;
    if (resolved.type !== "action_resolved") throw new Error("unexpected action resolution message");
    if (!resolved.action.accepted) throw new Error(`action rejected: ${resolved.action.message}`);
    if (resolved.action.actorId !== actionClient.snapshot.selfActorId) {
      throw new Error(`resolved actor mismatch: ${resolved.action.actorId}`);
    }
    if (resolved.snapshot.turnVersion <= actionTurnVersion) {
      throw new Error(`turnVersion did not advance after action: ${resolved.snapshot.turnVersion}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          shardId: clientA.snapshot.shardId,
          actors: [clientA.snapshot.selfActorId, clientB.snapshot.selfActorId],
          syncedTurnVersion: tickA.turnVersion,
          actionActorId: resolved.action.actorId,
          advancedTurnVersion: resolved.snapshot.turnVersion
        },
        null,
        2
      )
    );
  } finally {
    clientA.ws.close();
    clientB.ws.close();
  }
}

async function assertHealth() {
  const response = await fetch(`${baseUrl}/api/health`);
  if (!response.ok) throw new Error(`health check failed: ${response.status}`);
}

async function resetShardIfAvailable() {
  const response = await fetch(`${baseUrl}/api/dev/reset-shard`, { method: "POST" });
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`dev reset failed: ${response.status}`);
}

async function openClient(label: string, email: string): Promise<SmokeClient> {
  const cookie = await devLogin(label, email);
  const messages: ServerMessage[] = [];
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });
  const client: Partial<SmokeClient> = { label, cookie, ws, messages };

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    messages.push(message);
    if (
      (message.type === "shard_snapshot" || message.type === "action_resolved" || message.type === "visibility_delta") &&
      message.snapshot.selfActorId
    ) {
      client.snapshot = message.snapshot;
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} websocket open timed out`)), 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: "join_shard", shardId: "demo-1", characterName: label }));
      resolve();
    });
    ws.once("error", reject);
  });

  const joined = await waitForMessage(
    client as SmokeClient,
    (message) => message.type === "shard_snapshot" && Boolean(message.snapshot.selfActorId),
    10_000
  );
  if (joined.type !== "shard_snapshot") throw new Error(`${label} did not receive a shard snapshot`);
  return client as SmokeClient;
}

async function devLogin(name: string, email: string) {
  const response = await fetch(`${baseUrl}/auth/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`, {
    redirect: "manual"
  });
  if (![302, 303].includes(response.status)) {
    throw new Error(`dev login failed for ${email}: HTTP ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie?.split(";")[0];
  if (!cookie?.startsWith("rtts_session=")) throw new Error(`dev login did not return a session cookie for ${email}`);
  return cookie;
}

function assertDistinctActors(snapshotA: ShardSnapshot, snapshotB: ShardSnapshot) {
  if (!snapshotA.selfActorId || !snapshotB.selfActorId) throw new Error("missing self actor id");
  if (snapshotA.selfActorId === snapshotB.selfActorId) {
    throw new Error(`both clients joined as ${snapshotA.selfActorId}`);
  }
  if (snapshotA.shardId !== "demo-1" || snapshotB.shardId !== "demo-1") throw new Error("clients joined the wrong shard");
}

function waitForMessage(
  client: SmokeClient,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs: number
): Promise<ServerMessage> {
  const existing = client.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.ws.off("message", onMessage);
      reject(new Error(`${client.label} timed out waiting for message`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      client.ws.off("message", onMessage);
      resolve(message);
    };
    client.ws.on("message", onMessage);
  });
}

function waitForMessageAfter(
  client: SmokeClient,
  startIndex: number,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs: number
): Promise<ServerMessage> {
  const existing = client.messages.slice(startIndex).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.ws.off("message", onMessage);
      reject(new Error(`${client.label} timed out waiting for new message`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (!predicate(message)) return;
      clearTimeout(timer);
      client.ws.off("message", onMessage);
      resolve(message);
    };
    client.ws.on("message", onMessage);
  });
}

async function waitForOwnedTurn(clients: SmokeClient[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const cursors = new Map(clients.map((client) => [client, client.messages.length]));
  while (Date.now() < deadline) {
    const active = clients.find((client) => client.snapshot.activeActorId === client.snapshot.selfActorId);
    if (active) return active;
    await Promise.race(
      clients.map((client) => {
        const cursor = cursors.get(client) ?? client.messages.length;
        return waitForMessageAfter(
          client,
          cursor,
          (message) =>
            message.type === "shard_snapshot" ||
            message.type === "action_resolved" ||
            message.type === "turn_started" ||
            message.type === "timer_tick",
          Math.min(1000, Math.max(1, deadline - Date.now()))
        )
          .catch(() => null)
          .finally(() => cursors.set(client, client.messages.length));
      })
    );
  }
  throw new Error("no smoke client received an owned active turn before timeout");
}

await main();
