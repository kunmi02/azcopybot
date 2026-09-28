import { randomBytes, randomInt } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Database } from "./db.js";

export const SESSION_COOKIE_NAME = "copybot_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function randomLoginCode() {
  return String(randomInt(100000, 1000000));
}

export function randomSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function getSessionToken(request: FastifyRequest) {
  return readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
}

export function sessionCookie(token: string, secure: boolean) {
  return buildCookie(
    SESSION_COOKIE_NAME,
    token,
    SESSION_MAX_AGE_SECONDS,
    secure,
  );
}

export function clearSessionCookie(secure: boolean) {
  return buildCookie(SESSION_COOKIE_NAME, "", 0, secure);
}

export async function requireUser(request: FastifyRequest, db: Database) {
  const token = getSessionToken(request);
  if (!token)
    throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  const user = await db.getSessionUser(token);
  if (!user)
    throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  return user;
}

function readCookie(header: string | undefined, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey !== name) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function buildCookie(
  name: string,
  value: string,
  maxAge: number,
  secure: boolean,
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
