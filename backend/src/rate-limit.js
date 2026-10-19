export function createRateLimiter({ limit, windowMs, now = () => Date.now(), maxUsers = 1000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Rate limit is not configured.");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error("Rate limit is not configured.");
  }
  const hits = new Map();
  return function consume(userId) {
    if (typeof userId !== "string" || !userId) {
      return { ok: false, status: 503, error: "QuickCalAI could not verify Google sign-in." };
    }
    const time = now();
    const cutoff = time - windowMs;
    const recent = [];
    for (const stamp of hits.get(userId) || []) {
      if (stamp > cutoff) recent.push(stamp);
    }
    if (recent.length >= limit) {
      hits.set(userId, recent);
      const retryAfterMs = Math.max(0, recent[0] + windowMs - time);
      return {
        ok: false,
        status: 429,
        error: "Too many event requests. Try again later.",
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }
    if (!hits.has(userId) && hits.size >= maxUsers) {
      return { ok: false, status: 503, error: "QuickCalAI is not available." };
    }
    recent.push(time);
    hits.set(userId, recent);
    return { ok: true };
  };
}
