import { randomBytes, randomInt } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Database } from "./db.js";

export function randomLoginCode() {
  return String(randomInt(100000, 1000000));
}

export function randomSessionToken() {
  return randomBytes(32).toString("base64url");
}

export async function requireUser(request: FastifyRequest, db: Database) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  const user = await db.getSessionUser(token);
  if (!user) throw Object.assign(new Error("UNAUTHORIZED"), { statusCode: 401 });
  return user;
}
