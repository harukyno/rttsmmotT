import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, validateConfig, type AppConfig } from "./config.js";

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
}

function productionConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    appOrigin: "https://rtts-mmo-demo.onrender.com",
    sessionSecret: "production-session-secret",
    googleClientId: "google-client-id",
    googleClientSecret: "google-client-secret",
    databaseUrl: "postgres://render-db",
    allowDevAuth: false,
    nodeEnv: "production",
    ...overrides
  };
}

describe("config", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("allows development defaults", () => {
    process.env.NODE_ENV = "development";
    delete process.env.APP_ORIGIN;
    delete process.env.SESSION_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.DATABASE_URL;

    const config = loadConfig();

    expect(config.appOrigin).toBe("http://localhost:3000");
    expect(config.allowDevAuth).toBe(true);
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("fails fast when production environment variables are missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_ORIGIN;
    delete process.env.SESSION_SECRET;

    expect(() =>
      validateConfig(
        productionConfig({
          googleClientId: "",
          googleClientSecret: "",
          databaseUrl: ""
        })
      )
    ).toThrow("APP_ORIGIN, SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DATABASE_URL");
  });

  it("rejects the development session secret in production", () => {
    process.env.APP_ORIGIN = "https://rtts-mmo-demo.onrender.com";
    process.env.SESSION_SECRET = "dev-session-secret";

    expect(() =>
      validateConfig(
        productionConfig({
          sessionSecret: "dev-session-secret"
        })
      )
    ).toThrow("SESSION_SECRET must be set to a production secret.");
  });
});
