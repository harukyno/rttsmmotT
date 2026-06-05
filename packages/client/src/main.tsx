import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Eye, LogIn, LogOut, Move, Shield, Swords, Wifi } from "lucide-react";
import type { ActionIntent, PublicActor, RememberedActor, ServerMessage, ShardSnapshot, Vec2 } from "@rtts/shared";
import "./styles.css";

type MeResponse = {
  user: null | { id: string; email: string; name: string; avatarUrl?: string };
  googleConfigured: boolean;
  allowDevAuth: boolean;
};

type BrowserSmokeState = {
  userEmail: string | null;
  connection: "closed" | "connecting" | "open";
  shardId: string | null;
  round: number | null;
  turnVersion: number | null;
  selfActorId: string | null;
  activeActorId: string | null;
  canAct: boolean;
  remainingSeconds: number;
  visibleActors: Array<{ id: string; name: string; team: string; visible: boolean }>;
  selectedTile: Vec2 | null;
  selectedTargetId: string | null;
  toast: string;
};

declare global {
  interface Window {
    rtts_demo_state?: BrowserSmokeState;
    render_game_to_text?: () => string;
  }
}

function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [snapshot, setSnapshot] = useState<ShardSnapshot | null>(null);
  const [connection, setConnection] = useState<"closed" | "connecting" | "open">("closed");
  const [selectedTile, setSelectedTile] = useState<Vec2 | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [toast, setToast] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    void fetch("/api/me").then((res) => res.json()).then(setMe);
  }, []);

  useEffect(() => {
    if (!me?.user) return;
    setConnection("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      setConnection("open");
      ws.send(JSON.stringify({ type: "join_shard", shardId: "demo-1", characterName: me.user?.name }));
    });
    ws.addEventListener("close", () => setConnection("closed"));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === "shard_snapshot" || message.type === "visibility_delta") {
        setSnapshot(message.snapshot);
        setRemainingMs(message.snapshot.clock ? Math.max(0, message.snapshot.clock.deadlineAt - Date.now()) : 0);
      }
      if (message.type === "action_resolved") {
        setSnapshot(message.snapshot);
        setToast(message.action.message);
        setRemainingMs(message.snapshot.clock ? Math.max(0, message.snapshot.clock.deadlineAt - Date.now()) : 0);
      }
      if (message.type === "timer_tick") setRemainingMs(message.remainingMs);
      if (message.type === "turn_started") setRemainingMs(Math.max(0, message.clock.deadlineAt - Date.now()));
      if (message.type === "round_started") {
        setToast(`Round ${message.round} started`);
        setSnapshot((current) => (current ? { ...current, round: message.round, turnVersion: message.turnVersion } : current));
      }
      if (message.type === "action_accepted") setToast(message.action.message);
      if (message.type === "action_rejected") setToast(message.action.message);
      if (message.type === "error") setToast(message.message);
    });
    return () => ws.close();
  }, [me?.user?.id]);

  useEffect(() => {
    const id = setInterval(() => {
      setRemainingMs((value) => Math.max(0, value - 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const self = useMemo(() => snapshot?.actors.find((actor) => actor.visible && actor.id === snapshot.selfActorId) as PublicActor | undefined, [snapshot]);
  const activeActor = useMemo(() => snapshot?.actors.find((actor) => actor.visible && actor.id === snapshot.activeActorId) as PublicActor | undefined, [snapshot]);
  const canAct = Boolean(self && snapshot?.activeActorId === self.id);
  const browserSmokeState = useMemo<BrowserSmokeState>(
    () => ({
      userEmail: me?.user?.email ?? null,
      connection,
      shardId: snapshot?.shardId ?? null,
      round: snapshot?.round ?? null,
      turnVersion: snapshot?.turnVersion ?? null,
      selfActorId: snapshot?.selfActorId ?? null,
      activeActorId: snapshot?.activeActorId ?? null,
      canAct,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      visibleActors: (snapshot?.actors ?? []).map((actor) => ({
        id: actor.id,
        name: actor.name,
        team: actor.team,
        visible: actor.visible
      })),
      selectedTile,
      selectedTargetId,
      toast
    }),
    [canAct, connection, me?.user?.email, remainingMs, selectedTargetId, selectedTile, snapshot, toast]
  );

  useEffect(() => {
    window.rtts_demo_state = browserSmokeState;
    window.render_game_to_text = () => JSON.stringify(window.rtts_demo_state);
  }, [browserSmokeState]);

  function sendAction(action: ActionIntent) {
    wsRef.current?.send(JSON.stringify({ type: "submit_action", action }));
  }

  function moveSelf() {
    if (!snapshot || !self || !selectedTile) return;
    sendAction({ type: "move", actorId: self.id, turnVersion: snapshot.turnVersion, destination: selectedTile });
  }

  function attackTarget() {
    if (!snapshot || !self || !selectedTargetId) return;
    sendAction({ type: "attack", actorId: self.id, turnVersion: snapshot.turnVersion, targetActorId: selectedTargetId });
  }

  function guard() {
    if (!snapshot || !self) return;
    sendAction({ type: "guard_wait", actorId: self.id, turnVersion: snapshot.turnVersion });
  }

  if (!me) {
    return (
      <div className="boot">
        <StateProbe state={browserSmokeState} />
        RTTS MMO
      </div>
    );
  }

  if (!me.user) {
    return (
      <main className="login-shell">
        <StateProbe state={browserSmokeState} />
        <section className="login-panel">
          <div>
            <p className="eyebrow">RTTS MMO DEMO</p>
            <h1>ユニフォール戦術シャード</h1>
            <p className="login-copy">Googleアカウントで1シャードに入り、30秒手番のAP同期戦闘を開始します。</p>
          </div>
          <div className="login-actions">
            <a className="primary-link" data-testid="login-google" href="/auth/google/start">
              <LogIn size={18} /> Googleでサインイン
            </a>
            {me.allowDevAuth && (
              <a className="secondary-link" data-testid="login-dev" href="/auth/dev">
                <Wifi size={18} /> Dev Sign In
              </a>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell" data-testid="app-shell">
      <StateProbe state={browserSmokeState} />
      <header className="topbar">
        <div>
          <p className="eyebrow">Shard demo-1</p>
          <h1>RTTS MMO Tactical Sync</h1>
        </div>
        <div className="top-actions">
          <Status label={connection} good={connection === "open"} />
          <form action="/api/logout" method="post">
            <button className="icon-button" title="ログアウト">
              <LogOut size={18} />
            </button>
          </form>
        </div>
      </header>

      <section className="hud-band">
        <HudStat label="Round" value={snapshot?.round ?? "-"} />
        <HudStat label="Turn" value={snapshot?.turnVersion ?? "-"} />
        <HudStat label="Active" value={activeActor?.name ?? "-"} />
        <HudStat label="Clock" value={`${Math.ceil(remainingMs / 1000)}s`} urgent={remainingMs <= 8000} />
        <HudStat label="AP" value={self?.ap ?? "-"} />
        <HudStat label="HP" value={self ? `${self.resources.hp}/${self.resources.maxHp}` : "-"} />
      </section>

      <section className="workspace">
        <div className="map-wrap">
          <TacticalMap
            snapshot={snapshot}
            selectedTile={selectedTile}
            selectedTargetId={selectedTargetId}
            onTile={setSelectedTile}
            onTarget={setSelectedTargetId}
          />
        </div>
        <aside className="side-panel">
          <div className="command-bar">
            <button className="command" data-testid="command-move" disabled={!canAct || !selectedTile} onClick={moveSelf}>
              <Move size={18} /> 移動
            </button>
            <button className="command" data-testid="command-attack" disabled={!canAct || !selectedTargetId} onClick={attackTarget}>
              <Swords size={18} /> 攻撃
            </button>
            <button className="command" data-testid="command-guard" disabled={!canAct} onClick={guard}>
              <Shield size={18} /> 防御
            </button>
          </div>
          <div className="vision-card">
            <div className="panel-title">
              <Eye size={17} /> 視界
            </div>
            <ActorList actors={snapshot?.actors ?? []} />
          </div>
          <div className="log-card">
            <div className="panel-title">Action Log</div>
            <div className="log-list">
              {(snapshot?.log ?? []).slice().reverse().map((entry) => (
                <p key={`${entry.turnVersion}-${entry.actorId}-${entry.message}`}>{entry.message}</p>
              ))}
              {toast && <p className="toast-line">{toast}</p>}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function TacticalMap({
  snapshot,
  selectedTile,
  selectedTargetId,
  onTile,
  onTarget
}: {
  snapshot: ShardSnapshot | null;
  selectedTile: Vec2 | null;
  selectedTargetId: string | null;
  onTile: (tile: Vec2) => void;
  onTarget: (id: string) => void;
}) {
  const width = 40;
  const height = 24;
  const actorByTile = new Map<string, PublicActor | RememberedActor>();
  for (const actor of snapshot?.actors ?? []) {
    const position = actor.visible ? actor.position : actor.lastSeenPosition;
    actorByTile.set(`${position.x},${position.y}`, actor);
  }
  const blocked = new Set((snapshot?.blockedTiles ?? []).map((tile) => `${tile.x},${tile.y}`));

  const cells = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${x},${y}`;
      const actor = actorByTile.get(key);
      const isSelected = selectedTile?.x === x && selectedTile.y === y;
      const actorSelected = actor?.id === selectedTargetId;
      cells.push(
        <button
          key={key}
          className={[
            "cell",
            blocked.has(key) ? "blocked" : "",
            isSelected ? "selected" : "",
            actor?.visible ? `actor ${actor.team}` : "",
            actor && !actor.visible ? "remembered" : "",
            actorSelected ? "targeted" : ""
          ].join(" ")}
          onClick={() => {
            if (actor?.visible) onTarget(actor.id);
            onTile({ x, y });
          }}
          title={actor ? actor.name : `${x},${y}`}
        >
          {actor ? actor.name.slice(0, 1) : ""}
        </button>
      );
    }
  }
  return <div className="map-grid" data-testid="tactical-map">{cells}</div>;
}

function StateProbe({ state }: { state: BrowserSmokeState }) {
  return (
    <pre data-testid="render-game-state" hidden>
      {JSON.stringify(state)}
    </pre>
  );
}

function ActorList({ actors }: { actors: Array<PublicActor | RememberedActor> }) {
  return (
    <div className="actor-list">
      {actors.map((actor) => (
        <div key={actor.id} className="actor-row">
          <span className={`dot ${actor.team}`} />
          <span>{actor.name}</span>
          <span>{actor.visible ? `${actor.position.x},${actor.position.y}` : `${actor.lastSeenPosition.x},${actor.lastSeenPosition.y}`}</span>
          <span>{actor.visible ? "visible" : "memory"}</span>
        </div>
      ))}
    </div>
  );
}

function Status({ label, good }: { label: string; good: boolean }) {
  return <span className={`status ${good ? "good" : ""}`}>{label}</span>;
}

function HudStat({ label, value, urgent }: { label: string; value: React.ReactNode; urgent?: boolean }) {
  return (
    <div className={`hud-stat ${urgent ? "urgent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
