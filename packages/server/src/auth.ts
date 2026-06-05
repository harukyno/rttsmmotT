import type { Request, Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import cookie from "cookie";
import type { AppConfig } from "./config.js";
import type { Store, User } from "./store.js";

const sessionCookie = "rtts_session";
const oauthStateCookie = "rtts_oauth_state";
const oauthStateMaxAgeSeconds = 60 * 5;

export function getSessionIdFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  return cookie.parse(header)[sessionCookie] ?? null;
}

export function getOAuthStateFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  return cookie.parse(header)[oauthStateCookie] ?? null;
}

export function writeSessionCookie(res: Response, sessionId: string, config: AppConfig) {
  appendSetCookie(
    res,
    cookie.serialize(sessionCookie, sessionId, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 14
    })
  );
}

export function clearSessionCookie(res: Response, config: AppConfig) {
  appendSetCookie(
    res,
    cookie.serialize(sessionCookie, "", {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0
    })
  );
}

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function writeOAuthStateCookie(res: Response, state: string, config: AppConfig) {
  appendSetCookie(
    res,
    cookie.serialize(oauthStateCookie, state, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/auth/google/callback",
      maxAge: oauthStateMaxAgeSeconds
    })
  );
}

export function clearOAuthStateCookie(res: Response, config: AppConfig) {
  appendSetCookie(
    res,
    cookie.serialize(oauthStateCookie, "", {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/auth/google/callback",
      maxAge: 0
    })
  );
}

export function verifyOAuthState(cookieState: string | null, queryState: string | undefined): boolean {
  if (!cookieState || !queryState) return false;
  const cookieBuffer = Buffer.from(cookieState);
  const queryBuffer = Buffer.from(queryState);
  return cookieBuffer.length === queryBuffer.length && timingSafeEqual(cookieBuffer, queryBuffer);
}

export async function currentUser(req: Request, store: Store): Promise<User | null> {
  const sessionId = getSessionIdFromCookie(req.headers.cookie);
  if (!sessionId) return null;
  const session = await store.getSession(sessionId);
  if (!session) return null;
  return store.getUser(session.userId);
}

export function googleAuthUrl(config: AppConfig, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", `${config.appOrigin}/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  return url.toString();
}

function appendSetCookie(res: Response, value: string) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, value]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), value]);
  }
}

export async function exchangeGoogleCode(code: string, config: AppConfig): Promise<Omit<User, "id">> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: `${config.appOrigin}/auth/google/callback`,
      grant_type: "authorization_code",
      code
    })
  });
  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed: ${tokenResponse.status}`);
  }
  const tokenJson = (await tokenResponse.json()) as { access_token: string };
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${tokenJson.access_token}` }
  });
  if (!profileResponse.ok) {
    throw new Error(`Google profile fetch failed: ${profileResponse.status}`);
  }
  const profile = (await profileResponse.json()) as {
    email: string;
    name?: string;
    picture?: string;
  };
  return {
    email: profile.email,
    name: profile.name || profile.email,
    avatarUrl: profile.picture
  };
}
