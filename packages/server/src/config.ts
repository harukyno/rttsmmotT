export type AppConfig = {
  port: number;
  appOrigin: string;
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  databaseUrl: string;
  allowDevAuth: boolean;
  nodeEnv: string;
};

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT || 3000);
  return {
    port,
    appOrigin: process.env.APP_ORIGIN || `http://localhost:${port}`,
    sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    databaseUrl: process.env.DATABASE_URL || "",
    allowDevAuth: process.env.ALLOW_DEV_AUTH === "true" || process.env.NODE_ENV !== "production",
    nodeEnv: process.env.NODE_ENV || "development"
  };
}

export function validateConfig(config: AppConfig) {
  if (config.nodeEnv !== "production") return;
  const missing = [
    ["APP_ORIGIN", process.env.APP_ORIGIN],
    ["SESSION_SECRET", process.env.SESSION_SECRET],
    ["GOOGLE_CLIENT_ID", config.googleClientId],
    ["GOOGLE_CLIENT_SECRET", config.googleClientSecret],
    ["DATABASE_URL", config.databaseUrl]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
  if (config.sessionSecret === "dev-session-secret") {
    throw new Error("SESSION_SECRET must be set to a production secret.");
  }
}
