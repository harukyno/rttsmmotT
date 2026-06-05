import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const sharedEntry = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@rtts/shared": sharedEntry
    }
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: false
  }
});
