import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { SHARD_ID } from "@rtts/shared";
import { createApp } from "./app.js";
import { loadConfig, validateConfig } from "./config.js";
import { loadSeedData } from "./seed.js";
import { ShardHub } from "./shardHub.js";
import { createStore } from "./store.js";

const config = loadConfig();
validateConfig(config);
const store = createStore(config.databaseUrl);
await store.init();
const seedData = loadSeedData();
await store.saveSeedData(seedData);
const hub = new ShardHub(store);
await hub.init();
const app = createApp({ config, store, hub, seedData });
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
hub.attach(wss);

httpServer.listen(config.port, "0.0.0.0", () => {
  console.log(`RTTS MMO demo listening on ${config.port} shard=${SHARD_ID}`);
});
