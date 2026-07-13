/** Security middleware sets conservative headers and applies bounded login throttling. */

const loginAttempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_TRACKED_ADDRESSES = 10_000;

/** Bounds and expires the in-memory throttle map so address rotation cannot grow it forever. */
const pruneLoginAttempts = () => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [address, record] of loginAttempts) {
    if (record.startedAt < cutoff) loginAttempts.delete(address);
  }
  while (loginAttempts.size >= MAX_TRACKED_ADDRESSES) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
};

/** Adds only the essential security headers that do not break SSR or inline styles. */
export const securityHeaders = async (context, next) => {
  await next();
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Frame-Options", "DENY");
  context.header("Referrer-Policy", "same-origin");
};

/** Uses the socket address as a best-effort Beta throttle key. */
export const requestAddress = (context) => context.env?.incoming?.socket?.remoteAddress || "unknown";

/** Reports whether another login attempt is allowed for this address. */
export const loginAllowed = (address) => {
  pruneLoginAttempts();
  const now = Date.now();
  const record = loginAttempts.get(address);
  if (!record || now - record.startedAt > WINDOW_MS) {
    loginAttempts.set(address, { startedAt: now, attempts: 0 });
    return true;
  }
  return record.attempts < MAX_ATTEMPTS;
};

/** Records a failed login without retaining submitted usernames or passwords. */
export const recordLoginFailure = (address) => {
  const record = loginAttempts.get(address) || { startedAt: Date.now(), attempts: 0 };
  record.attempts += 1;
  loginAttempts.set(address, record);
};

/** Clears throttling after successful authentication. */
export const clearLoginFailures = (address) => loginAttempts.delete(address);
