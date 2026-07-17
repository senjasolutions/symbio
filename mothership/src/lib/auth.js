/**
 * Authentication helpers implement opaque hashed sessions, CSRF validation,
 * and request middleware shared by every protected route.
 */

import crypto from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { models } from "../db/index.js";

const COOKIE_NAME = "symbio_session";

/** Hashes an opaque browser token before database lookup or storage. */
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** Creates and stores a new session, rotating any session supplied by the browser. */
export const createSession = async (context, userId) => {
  const existing = getCookie(context, COOKIE_NAME);
  if (existing) await models.Session.destroy({ where: { tokenHash: tokenHash(existing) } });
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionHours * 60 * 60 * 1000);
  await models.Session.create({ userId, tokenHash: tokenHash(token), csrfToken, expiresAt, lastSeenAt: now, createdAt: now });
  setCookie(context, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionHours * 60 * 60,
  });
};

/** Removes the current session from both SQLite and the browser. */
export const destroySession = async (context) => {
  const token = getCookie(context, COOKIE_NAME);
  if (token) await models.Session.destroy({ where: { tokenHash: tokenHash(token) } });
  deleteCookie(context, COOKIE_NAME, { path: "/" });
};

/** Resolves a non-expired session and its user for protected requests. */
export const resolveSession = async (context) => {
  const token = getCookie(context, COOKIE_NAME);
  if (!token) return null;
  const session = await models.Session.findOne({ where: { tokenHash: tokenHash(token) } });
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    if (session) await session.destroy();
    deleteCookie(context, COOKIE_NAME, { path: "/" });
    return null;
  }
  const user = await models.User.findByPk(session.userId);
  if (!user) return null;
  if (Date.now() - new Date(session.lastSeenAt).getTime() > 5 * 60 * 1000) {
    session.lastSeenAt = new Date();
    await session.save();
  }
  return { session, user };
};

/** Redirects unauthenticated page requests and attaches verified auth context. */
export const requireAuth = async (context, next) => {
  const auth = await resolveSession(context);
  if (!auth) return context.redirect(`/login?next=${encodeURIComponent(context.req.path)}`);
  context.set("auth", auth);
  await next();
};

/** Returns JSON 401 for progressive enhancement endpoints without a session. */
export const requireApiAuth = async (context, next) => {
  const auth = await resolveSession(context);
  if (!auth) return context.json({ ok: false, error: "Authentication required" }, 401);
  context.set("auth", auth);
  await next();
};

/** Rejects state changes unless their synchronizer token matches the session. */
export const requireCsrf = async (context, next) => {
  const auth = context.get("auth");
  const body = await context.req.parseBody();
  if (!auth || typeof body._csrf !== "string" || body._csrf !== auth.session.csrfToken) {
    return context.text("Invalid or missing CSRF token.", 403);
  }
  context.set("form", body);
  await next();
};

/** Destroys all sessions belonging to a user (used when password changes). */
export const destroyAllUserSessions = async (userId) => {
  await models.Session.destroy({ where: { userId } });
};

/** Creates a pre-session CSRF token for the login page. Stored in a short-lived cookie. */
export const createLoginCsrf = (context) => {
  const token = crypto.randomBytes(24).toString("base64url");
  setCookie(context, "login_csrf", token, {
    httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600,
  });
  return token;
};

/** Validates the login CSRF token from cookie against the form submission. */
export const validateLoginCsrf = (context) => {
  const cookie = getCookie(context, "login_csrf");
  if (!cookie) return false;
  const body = context.get("form");
  if (body) return body._csrf === cookie;
  return false;
};

/** Deletes expired sessions in a bounded maintenance pass. */
export const deleteExpiredSessions = async () => {
  const { Op } = await import("sequelize");
  await models.Session.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
};
