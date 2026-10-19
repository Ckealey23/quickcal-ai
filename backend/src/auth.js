import { TOKENINFO_TIMEOUT_MS } from "./config.js";

export const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const MAX_TOKEN_LENGTH = 4096;
const CLOCK_SKEW_MS = 30_000;

function failed(status, error) {
  return { ok: false, status, error };
}

export function bearerToken(header) {
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return "";
  const token = match[1];
  if (token.length < 20 || token.length > MAX_TOKEN_LENGTH) return "";
  return token;
}

function audienceMatches(payload, clientId) {
  const aud = typeof payload.aud === "string" ? payload.aud : "";
  const azp = typeof payload.azp === "string" ? payload.azp : "";
  if (!aud && !azp) return false;
  if (aud && aud !== clientId) return false;
  if (azp && azp !== clientId) return false;
  return true;
}

function verifiedEmail(payload, allowed) {
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const verified = payload.email_verified === true || payload.email_verified === "true";
  if (!email || !verified || !allowed.has(email)) return false;
  return true;
}

export function createGoogleVerifier({
  clientId,
  allowedEmails,
  fetchImpl,
  timeoutMs = TOKENINFO_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const allowed = new Set(
    Array.isArray(allowedEmails) ? allowedEmails.map((email) => String(email).trim().toLowerCase()) : []
  );
  return async function verify(authorization) {
    if (!clientId || allowed.size === 0 || typeof fetchImpl !== "function") {
      return failed(503, "QuickCalAI is not available.");
    }
    const token = bearerToken(authorization);
    if (!token) return failed(401, "Sign in with Google is required.");

    let response;
    try {
      response = await fetchImpl(TOKENINFO_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ access_token: token }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return failed(503, "QuickCalAI could not verify Google sign-in.");
    }
    if (!response || response.status >= 500) return failed(503, "QuickCalAI could not verify Google sign-in.");
    if (!response.ok) return failed(401, "Google did not accept this sign-in.");

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return failed(401, "Google did not accept this sign-in.");
    }
    if (!payload || typeof payload !== "object") return failed(401, "Google did not accept this sign-in.");
    if (!audienceMatches(payload, clientId)) {
      return failed(403, "This Google sign-in is for a different app.");
    }
    if (!verifiedEmail(payload, allowed)) {
      return failed(403, "This Google account is not approved for QuickCalAI.");
    }
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!sub || sub.length > 255 || /\s/.test(sub)) {
      return failed(403, "Google did not confirm this account.");
    }
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= now() - CLOCK_SKEW_MS) {
      return failed(401, "Google sign-in has expired.");
    }
    return { ok: true, userId: sub };
  };
}
