import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node"
  },
  resolve: {
    alias: {
      "@rtts/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url))
    }
  }
});
