import { createServer } from "node:http";
import {
  HEADER_TIMEOUT_MS,
  HOST,
  MAX_BODY_BYTES,
  PARSE_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
} from "./config.js";
import { bearerToken } from "./auth.js";
import { ParseError } from "./parse.js";
import { validateRequest } from "./validate.js";

const EXTENSION_ORIGIN = "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf";

function writeJson(response, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  response.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  }, extraHeaders || {}));
  response.end(payload);
}

function corsHeaders(request) {
  if (!request || !request.headers || request.headers.origin !== EXTENSION_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": EXTENSION_ORIGIN,
    Vary: "Origin",
  };
}

function publicMessage(request, message) {
  let text = typeof message === "string" && message.trim()
    ? message
    : "QuickCalAI could not complete that request.";
  const token = bearerToken(request && request.headers && request.headers.authorization);
  if (token && text.includes(token)) text = text.split(token).join("[redacted]");
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
}

function sendJson(request, response, status, body, extraHeaders) {
  const safeBody = status >= 400 && body && typeof body.error === "string"
    ? Object.assign({}, body, { error: publicMessage(request, body.error) })
    : body;
  writeJson(response, status, safeBody, Object.assign({}, corsHeaders(request), extraHeaders || {}));
}

function finishUnread(request) {
  if (request && typeof request.resume === "function") request.resume();
}

function declaredLength(request) {
  const value = request.headers["content-length"];
  if (value == null) return null;
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) return Number.NaN;
  return Number(value);
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ParseError(504, "The event parser timed out. Try again."));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new ParseError(413, "Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => fail(error));
  });
}

export function createHandler({
  parseEvent,
  apiKeyConfigured = false,
  requireAuth = false,
  authenticate = null,
  rateLimit = null,
  parseTimeoutMs = PARSE_TIMEOUT_MS,
}) {
  return async function handle(request, response) {
    async function identify(request) {
      if (!requireAuth) return { ok: true, userId: "" };
      if (typeof authenticate !== "function") {
        return { ok: false, status: 503, error: "QuickCalAI is not available." };
      }
      let identity;
      try {
        identity = await authenticate(request.headers.authorization);
      } catch (error) {
        return { ok: false, status: 503, error: "QuickCalAI could not verify Google sign-in." };
      }
      if (!identity || !identity.ok) {
        return {
          ok: false,
          status: identity && Number.isInteger(identity.status) ? identity.status : 401,
          error: identity && identity.error ? identity.error : "Sign in with Google is required.",
        };
      }
      if (typeof identity.userId !== "string" || !identity.userId) {
        return { ok: false, status: 403, error: "Google did not confirm this account." };
      }
      return { ok: true, userId: identity.userId };
    }

    const url = new URL(request.url || "/", "http://" + HOST);
    if (request.method === "OPTIONS" && (url.pathname === "/health" || url.pathname === "/access" || url.pathname === "/parse-event")) {
      if (request.headers.origin !== EXTENSION_ORIGIN) {
        sendJson(request, response, 403, { error: "Origin is not allowed." });
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Origin": EXTENSION_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
        "Content-Length": "0",
      });
      response.end();
      return;
    }
    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(request, response, 200, { ok: true, apiKeyConfigured: Boolean(apiKeyConfigured) });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(request, response, 405, { error: "Method not allowed." });
      return;
    }
    if (url.pathname === "/access" && request.method === "GET") {
      const identity = await identify(request);
      if (!identity.ok) {
        sendJson(request, response, identity.status, { error: identity.error });
        finishUnread(request);
        return;
      }
      sendJson(request, response, 200, { ok: true, approved: true });
      return;
    }
    if (url.pathname === "/access") {
      sendJson(request, response, 405, { error: "Method not allowed." });
      return;
    }
    if (url.pathname !== "/parse-event") {
      sendJson(request, response, 404, { error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      sendJson(request, response, 405, { error: "Method not allowed." });
      return;
    }

    const contentType = String(request.headers["content-type"] || "");
    if (!contentType.toLowerCase().startsWith("application/json")) {
      sendJson(request, response, 415, { error: "Content-Type must be application/json." });
      finishUnread(request);
      return;
    }

    const length = declaredLength(request);
    if (Number.isNaN(length)) {
      sendJson(request, response, 400, { error: "QuickCalAI could not read the request." });
      finishUnread(request);
      return;
    }
    if (length != null && length > MAX_BODY_BYTES) {
      sendJson(request, response, 413, { error: "Request body is too large." });
      request.destroy();
      return;
    }

    if (requireAuth) {
      if (typeof rateLimit !== "function") {
        sendJson(request, response, 503, { error: "QuickCalAI is not available." });
        finishUnread(request);
        return;
      }
      const identity = await identify(request);
      if (!identity.ok) {
        sendJson(request, response, identity.status, { error: identity.error });
        finishUnread(request);
        return;
      }
      const limit = rateLimit(identity.userId);
      if (!limit || !limit.ok) {
        const status = limit && Number.isInteger(limit.status) ? limit.status : 429;
        const extra = limit && limit.retryAfterSeconds
          ? { "Retry-After": String(limit.retryAfterSeconds) }
          : undefined;
        sendJson(request, response, status, {
          error: limit && limit.error ? limit.error : "Too many event requests. Try again later.",
        }, extra);
        finishUnread(request);
        return;
      }
    }

    let raw = "";
    try {
      raw = await readBody(request);
    } catch (error) {
      if (error instanceof ParseError) {
        sendJson(request, response, error.status, { error: error.message });
        return;
      }
      sendJson(request, response, 400, { error: "QuickCalAI could not read the request." });
      return;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      sendJson(request, response, 400, { error: "Request body must be JSON." });
      return;
    }

    const input = validateRequest(body);
    if (!input.ok) {
      sendJson(request, response, 400, { error: input.error });
      return;
    }

    try {
      const event = await withDeadline(parseEvent({
        text: input.text,
        timeZone: input.timeZone,
        currentEvent: input.currentEvent,
      }), parseTimeoutMs);
      sendJson(request, response, 200, event);
    } catch (error) {
      if (error instanceof ParseError) {
        sendJson(request, response, error.status, { error: error.message });
        return;
      }
      sendJson(request, response, 500, { error: "QuickCalAI could not complete that request." });
    }
  };
}

export function startServer({
  host = HOST,
  port = 0,
  parseEvent,
  apiKeyConfigured = false,
  requireAuth = false,
  authenticate = null,
  rateLimit = null,
  parseTimeoutMs = PARSE_TIMEOUT_MS,
}) {
  const server = createServer({ maxHeaderSize: MAX_BODY_BYTES }, (request, response) => {
    createHandler({
      parseEvent,
      apiKeyConfigured,
      requireAuth,
      authenticate,
      rateLimit,
      parseTimeoutMs,
    })(request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "QuickCalAI could not complete that request." });
      }
    });
  });
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADER_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
