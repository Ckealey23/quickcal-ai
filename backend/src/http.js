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
import { MAX_AUDIO_BYTES, TRANSCRIBE_TIMEOUT_MS, audioKind } from "./transcribe.js";
import { validateRequest } from "./validate.js";
import { DOCUMENT_TIMEOUT_MS, MAX_DOCUMENT_BODY, validateDocumentRequest } from "./documents.js";

const EXTENSION_ORIGIN = "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf";
export const QUICKCAL_API_VERSION = 4;

function publicRelease(value) {
  const release = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(release) ? release : "local";
}

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

function withDeadline(promise, ms, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ParseError(504, timeoutMessage || "The event parser timed out. Try again."));
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

function readLimited(request, maxBytes, tooLarge) {
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
      if (size > maxBytes) {
        fail(new ParseError(413, tooLarge));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => fail(error));
  });
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return readLimited(request, limit, "Request body is too large.").then((buffer) => buffer.toString("utf8"));
}

export function createHandler({
  parseEvent,
  analyzeDocument = null,
  transcribeAudio = null,
  apiKeyConfigured = false,
  requireAuth = false,
  authenticate = null,
  rateLimit = null,
  parseTimeoutMs = PARSE_TIMEOUT_MS,
  documentHeartbeatMs = 10000,
  release = "local",
}) {
  const quickcalRelease = publicRelease(release);
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
    if (request.method === "OPTIONS" && ["/health", "/access", "/parse-event", "/transcribe", "/analyze-document"].includes(url.pathname)) {
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
      sendJson(request, response, 200, {
        ok: true,
        apiKeyConfigured: Boolean(apiKeyConfigured),
        quickcalApiVersion: QUICKCAL_API_VERSION,
        quickcalRelease: quickcalRelease,
        capabilities: ["event-notifications", "calendar-operations", "tasks", "document-review"],
      });
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
    if (url.pathname === "/transcribe") {
      if (request.method !== "POST") {
        sendJson(request, response, 405, { error: "Method not allowed." });
        return;
      }
      const kind = audioKind(request.headers["content-type"]);
      if (!kind) {
        sendJson(request, response, 415, { error: "QuickCalAI could not read that recording." });
        finishUnread(request);
        return;
      }
      const audioLength = declaredLength(request);
      if (Number.isNaN(audioLength)) {
        sendJson(request, response, 400, { error: "QuickCalAI could not read the request." });
        finishUnread(request);
        return;
      }
      if (audioLength != null && audioLength > MAX_AUDIO_BYTES) {
        sendJson(request, response, 413, { error: "Recording is too large." });
        request.destroy();
        return;
      }
      if (typeof transcribeAudio !== "function") {
        sendJson(request, response, 503, { error: "QuickCalAI is not available." });
        finishUnread(request);
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
      let audio;
      try {
        audio = await readLimited(request, MAX_AUDIO_BYTES, "Recording is too large.");
      } catch (error) {
        if (error instanceof ParseError) {
          sendJson(request, response, error.status, { error: error.message });
          return;
        }
        sendJson(request, response, 400, { error: "QuickCalAI could not read the request." });
        return;
      }
      try {
        const text = await withDeadline(
          transcribeAudio(audio, request.headers["content-type"]),
          TRANSCRIBE_TIMEOUT_MS,
          "Transcription timed out. Try again."
        );
        if (typeof text !== "string" || !text.trim()) {
          sendJson(request, response, 422, { error: "QuickCalAI didn't hear any words. Try again." });
          return;
        }
        sendJson(request, response, 200, { text: text.trim() });
      } catch (error) {
        if (error instanceof ParseError) {
          sendJson(request, response, error.status, { error: error.message });
          return;
        }
        sendJson(request, response, 500, { error: "QuickCalAI could not complete that request." });
      }
      return;
    }
    const documentRequest = url.pathname === "/analyze-document";
    if (url.pathname !== "/parse-event" && !documentRequest) {
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
    const bodyLimit = documentRequest ? MAX_DOCUMENT_BODY : MAX_BODY_BYTES;
    if (length != null && length > bodyLimit) {
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
      raw = await readBody(request, bodyLimit);
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

    if (documentRequest) {
      // Flush small JSON whitespace heartbeats on slow analysis. MV3 workers
      // terminate fetches that wait more than 30 seconds for response headers.
      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        if (!response.headersSent) response.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, corsHeaders(request)));
        response.write("\n");
      }, documentHeartbeatMs);
      const finish = (status, body) => {
        if (response.destroyed || response.writableEnded) return;
        if (response.headersSent) response.end(JSON.stringify(status >= 400 ? { ...body, error: publicMessage(request, body.error), status } : body));
        else sendJson(request, response, status, body);
      };
      try {
        const input = validateDocumentRequest(body);
        if (!analyzeDocument) throw new ParseError(503, "Deploy the current backend to enable document analysis.");
        const result = await withDeadline(analyzeDocument(input), DOCUMENT_TIMEOUT_MS, "Document analysis timed out. Try a smaller section.");
        finish(200, result);
      } catch (error) {
        finish(error instanceof ParseError ? error.status : 500, {
          error: error instanceof ParseError ? error.message : "Document analysis could not be completed.",
        });
      } finally { clearInterval(heartbeat); }
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
        clarification: input.clarification,
        operation: input.operation,
      }), parseTimeoutMs);
      sendJson(request, response, 200, Object.assign({}, event, {
        quickcalApiVersion: QUICKCAL_API_VERSION,
        quickcalRelease: quickcalRelease,
      }));
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
  analyzeDocument = null,
  transcribeAudio = null,
  apiKeyConfigured = false,
  requireAuth = false,
  authenticate = null,
  rateLimit = null,
  parseTimeoutMs = PARSE_TIMEOUT_MS,
  documentHeartbeatMs = 10000,
  release = "local",
}) {
  const server = createServer({ maxHeaderSize: MAX_BODY_BYTES }, (request, response) => {
    createHandler({
      parseEvent,
      analyzeDocument,
      transcribeAudio,
      apiKeyConfigured,
      requireAuth,
      authenticate,
      rateLimit,
      parseTimeoutMs,
      documentHeartbeatMs,
      release,
    })(request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "QuickCalAI could not complete that request." });
      }
    });
  });
  server.requestTimeout = Math.max(SERVER_REQUEST_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS + 15_000, DOCUMENT_TIMEOUT_MS + 10000);
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
