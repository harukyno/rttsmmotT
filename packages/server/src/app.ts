import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { SHARD_ID, createSnapshot, type SeedData } from "@rtts/shared";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createOAuthState,
  currentUser,
  exchangeGoogleCode,
  getOAuthStateFromCookie,
  googleAuthUrl,
  verifyOAuthState,
  writeOAuthStateCookie,
  writeSessionCookie
} from "./auth.js";
import type { AppConfig } from "./config.js";
import type { ShardHub } from "./shardHub.js";
import type { Store } from "./store.js";

export function createApp({ config, store, hub, seedData }: { config: AppConfig; store: Store; hub: ShardHub; seedData: SeedData }) {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      shardId: SHARD_ID,
      players: hub.state.actors.filter((actor) => actor.team === "players" && actor.ownerUserId).length,
      turnVersion: hub.state.turnVersion
    });
  });

  app.get("/api/me", async (req, res) => {
    const user = await currentUser(req, store);
    res.json({ user, googleConfigured: Boolean(config.googleClientId && config.googleClientSecret), allowDevAuth: config.allowDevAuth });
  });

  app.get("/auth/google/start", (_req, res) => {
    if (!config.googleClientId || !config.googleClientSecret) {
      res.status(503).send("Google OAuth is not configured.");
      return;
    }
    const state = createOAuthState();
    writeOAuthStateCookie(res, state, config);
    res.redirect(googleAuthUrl(config, state));
  });

  app.get("/auth/google/callback", async (req, res, next) => {
    try {
      const code = String(req.query.code || "");
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const cookieState = getOAuthStateFromCookie(req.headers.cookie);
      clearOAuthStateCookie(res, config);
      if (!verifyOAuthState(cookieState, state)) {
        res.status(400).send("Invalid OAuth state.");
        return;
      }
      if (!code) {
        res.status(400).send("Missing code.");
        return;
      }
      const googleUser = await exchangeGoogleCode(code, config);
      const user = await store.upsertUser(googleUser);
      const session = await store.createSession(user.id);
      writeSessionCookie(res, session.id, config);
      res.redirect("/");
    } catch (error) {
      next(error);
    }
  });

  app.get("/auth/dev", async (req, res) => {
    if (!config.allowDevAuth) {
      res.status(404).send("Not found");
      return;
    }
    const email = typeof req.query.email === "string" && req.query.email.includes("@")
      ? req.query.email.slice(0, 120)
      : "demo@rtts.local";
    const name = typeof req.query.name === "string" && req.query.name.trim()
      ? req.query.name.trim().slice(0, 40)
      : "Demo Player";
    const user = await store.upsertUser({ email, name });
    const session = await store.createSession(user.id);
    writeSessionCookie(res, session.id, config);
    res.redirect("/");
  });

  app.post("/api/dev/reset-shard", async (_req, res) => {
    if (!config.allowDevAuth) {
      res.status(404).send("Not found");
      return;
    }
    await hub.resetDemoState();
    res.json({ ok: true, shardId: SHARD_ID, turnVersion: hub.state.turnVersion, players: 0 });
  });

  app.post("/api/logout", async (req, res) => {
    const user = await currentUser(req, store);
    if (user) {
      const sessionId = req.headers.cookie?.match(/rtts_session=([^;]+)/)?.[1];
      if (sessionId) await store.deleteSession(sessionId);
    }
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  app.get("/api/shards/demo-1", async (req, res) => {
    const user = await currentUser(req, store);
    if (!user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const self = hub.state.actors.find((actor) => actor.ownerUserId === user.id);
    res.json({
      snapshot: createSnapshot(hub.state, user.id, self?.id ?? null),
      seed: {
        skills: seedData.skills,
        itemCount: seedData.items.length,
        materialCount: seedData.materials.length,
        magicCount: seedData.magic.length
      }
    });
  });

  app.post("/api/characters/select", async (req, res) => {
    const user = await currentUser(req, store);
    if (!user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name : user.name;
    const actor = await hub.selectPlayerActor(user.id, name);
    if (!actor) {
      res.status(409).json({ error: "no open player actor" });
      return;
    }
    res.json({ actor });
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(resolve(clientDist, "index.html"));
  });

  return app;
}
