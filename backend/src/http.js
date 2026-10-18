import { createServer } from "node:http";
import { HOST, MAX_BODY_BYTES } from "./config.js";
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

function sendJson(request, response, status, body) {
  writeJson(response, status, body, corsHeaders(request));
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

export function createHandler({ parseEvent, apiKeyConfigured = false }) {
  return async function handle(request, response) {
    const url = new URL(request.url || "/", "http://" + HOST);
    if (request.method === "OPTIONS" && (url.pathname === "/health" || url.pathname === "/parse-event")) {
      if (request.headers.origin !== EXTENSION_ORIGIN) {
        sendJson(request, response, 403, { error: "Origin is not allowed." });
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Origin": EXTENSION_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
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
      return;
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
      const event = await parseEvent({
        text: input.text,
        timeZone: input.timeZone,
        currentEvent: input.currentEvent,
      });
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

export function startServer({ host = HOST, port = 0, parseEvent, apiKeyConfigured = false }) {
  const server = createServer((request, response) => {
    createHandler({ parseEvent, apiKeyConfigured })(request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: "QuickCalAI could not complete that request." });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
