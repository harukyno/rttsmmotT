import { describe, expect, it } from "vitest";
import type { Response } from "express";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  getOAuthStateFromCookie,
  getSessionIdFromCookie,
  googleAuthUrl,
  verifyOAuthState,
  writeOAuthStateCookie,
  writeSessionCookie
} from "./auth.js";
import type { AppConfig } from "./config.js";

const config: AppConfig = {
  port: 3000,
  appOrigin: "http://localhost:3000",
  sessionSecret: "test",
  googleClientId: "",
  googleClientSecret: "",
  databaseUrl: "",
  allowDevAuth: true,
  nodeEnv: "test"
};

describe("auth cookie handling", () => {
  it("writes and reads the http-only session cookie", () => {
    const headers = new Map<string, string>();
    const res = {
      getHeader(name: string) {
        return headers.get(name);
      },
      setHeader(name: string, value: string) {
        headers.set(name, value);
      }
    } as unknown as Response;

    writeSessionCookie(res, "session-1", config);
    const cookie = headers.get("Set-Cookie")!;

    expect(cookie).toContain("HttpOnly");
    expect(getSessionIdFromCookie(cookie)).toBe("session-1");
  });

  it("clears the session cookie", () => {
    const headers = new Map<string, string>();
    const res = {
      getHeader(name: string) {
        return headers.get(name);
      },
      setHeader(name: string, value: string) {
        headers.set(name, value);
      }
    } as unknown as Response;

    clearSessionCookie(res, config);
    expect(headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("writes and verifies the oauth state cookie", () => {
    const headers = new Map<string, string | string[]>();
    const res = {
      getHeader(name: string) {
        return headers.get(name);
      },
      setHeader(name: string, value: string | string[]) {
        headers.set(name, value);
      }
    } as unknown as Response;

    writeOAuthStateCookie(res, "state-1", config);
    const cookie = headers.get("Set-Cookie") as string;

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/auth/google/callback");
    expect(getOAuthStateFromCookie(cookie)).toBe("state-1");
    expect(verifyOAuthState("state-1", "state-1")).toBe(true);
    expect(verifyOAuthState("state-1", "state-2")).toBe(false);
  });

  it("appends multiple set-cookie headers in one response", () => {
    const headers = new Map<string, string | string[]>();
    const res = {
      getHeader(name: string) {
        return headers.get(name);
      },
      setHeader(name: string, value: string | string[]) {
        headers.set(name, value);
      }
    } as unknown as Response;

    clearOAuthStateCookie(res, config);
    writeSessionCookie(res, "session-1", config);

    const values = headers.get("Set-Cookie");
    expect(Array.isArray(values)).toBe(true);
    expect(values).toHaveLength(2);
    expect(values?.[0]).toContain("rtts_oauth_state=");
    expect(values?.[1]).toContain("rtts_session=session-1");
  });

  it("includes state in the google auth url", () => {
    const url = new URL(googleAuthUrl({ ...config, googleClientId: "client" }, "state-1"));
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("client_id")).toBe("client");
  });
});
