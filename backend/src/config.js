import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";
export const PORT = 3000;
export const DEFAULT_MODEL = "gpt-6-luna";
export const MAX_TEXT_LENGTH = 2000;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_OUTPUT_TOKENS = 800;
export const REQUEST_TIMEOUT_MS = 30_000;
export const PARSE_TIMEOUT_MS = 32_000;
export const SERVER_REQUEST_TIMEOUT_MS = 35_000;
export const HEADER_TIMEOUT_MS = 20_000;
export const TOKENINFO_TIMEOUT_MS = 5_000;
export const DEFAULT_RATE_LIMIT_MAX = 30;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "GOOGLE_CLIENT_ID",
  "ALLOWED_EMAILS",
  "QUICKCAL_REQUIRE_AUTH",
  "QUICKCAL_RATE_LIMIT_MAX",
  "QUICKCAL_RATE_LIMIT_WINDOW_MS",
];
const CLIENT_ID_PATTERN = /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function envFilePath(moduleUrl = import.meta.url) {
  return join(dirname(fileURLToPath(moduleUrl)), "..", ".env");
}

export function decodeEnvBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) {
    return bytes.toString("utf16le").replace(/^\uFEFF/, "");
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(contents) {
  const values = {};
  const unlabeled = [];
  const lines = String(contents).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      if (!/\s/.test(trimmed) && trimmed.length >= 20) unlabeled.push(trimmed);
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!ENV_KEYS.includes(key)) continue;
    values[key] = unquote(trimmed.slice(separator + 1).trim());
  }
  if (!String(values.OPENAI_API_KEY || "").trim() && unlabeled.length === 1) {
    values.OPENAI_API_KEY = unlabeled[0];
  }
  return values;
}

export function applyEnvFile(filePath, env = process.env) {
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
  const values = parseEnvFile(decodeEnvBytes(bytes));
  for (const key of ENV_KEYS) {
    const incoming = typeof values[key] === "string" ? values[key].trim() : "";
    if (!incoming) continue;
    const current = typeof env[key] === "string" ? env[key].trim() : "";
    if (!current) env[key] = incoming;
  }
  return values;
}

export function readConfig(env = process.env) {
  const requested = typeof env.OPENAI_MODEL === "string" ? env.OPENAI_MODEL.trim() : "";
  const model = requested || DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
    return {
      apiKey: "",
      model: "",
      error: "OPENAI_MODEL is not a valid model name. QuickCalAI will not substitute another model.",
    };
  }
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  return { apiKey, model, error: "" };
}

function trimmed(env, key) {
  return typeof env[key] === "string" ? env[key].trim() : "";
}

function positiveInt(value, fallback, max) {
  if (!value) return { ok: true, value: fallback };
  if (!/^\d+$/.test(value)) return { ok: false, value: 0 };
  const number = Number(value);
  if (number < 1 || number > max) return { ok: false, value: 0 };
  return { ok: true, value: number };
}

export function listenConfig(env = process.env) {
  const onRender = env.RENDER === "true";
  const rawPort = trimmed(env, "PORT");
  let port = PORT;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) return { host: "", port: 0, error: "PORT must be an integer from 1 to 65535." };
    port = Number(rawPort);
    if (port < 1 || port > 65535) return { host: "", port: 0, error: "PORT must be an integer from 1 to 65535." };
  } else if (onRender) {
    return { host: "", port: 0, error: "Render did not provide PORT." };
  }
  return { host: onRender ? "0.0.0.0" : HOST, port, error: "" };
}

export function authConfig(env = process.env) {
  const requireAuth =
    env.RENDER === "true" || env.NODE_ENV === "production" || env.QUICKCAL_REQUIRE_AUTH === "true";
  const clientId = trimmed(env, "GOOGLE_CLIENT_ID");
  const rawEmails = trimmed(env, "ALLOWED_EMAILS");
  const emails = [];
  let emailError = "";
  if (rawEmails) {
    const seen = new Set();
    for (const part of rawEmails.split(",")) {
      const email = part.trim().toLowerCase();
      if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
        emailError = "ALLOWED_EMAILS must list valid email addresses separated by commas.";
        break;
      }
      if (!seen.has(email)) {
        seen.add(email);
        emails.push(email);
      }
    }
    if (!emailError && emails.length > 100) {
      emailError = "ALLOWED_EMAILS must list 100 addresses or fewer.";
    }
  }
  const max = positiveInt(trimmed(env, "QUICKCAL_RATE_LIMIT_MAX"), DEFAULT_RATE_LIMIT_MAX, 1000);
  const windowMs = positiveInt(
    trimmed(env, "QUICKCAL_RATE_LIMIT_WINDOW_MS"),
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    24 * 60 * 60 * 1000
  );
  let error = "";
  if (!max.ok) error = "QUICKCAL_RATE_LIMIT_MAX must be an integer from 1 to 1000.";
  else if (!windowMs.ok) error = "QUICKCAL_RATE_LIMIT_WINDOW_MS must be an integer from 1 to 86400000.";
  else if (requireAuth && !clientId) {
    error = "Production authentication is not configured. Set GOOGLE_CLIENT_ID and ALLOWED_EMAILS.";
  } else if (clientId && !CLIENT_ID_PATTERN.test(clientId)) {
    error = "GOOGLE_CLIENT_ID must be the Chrome extension OAuth client ID.";
  } else if (emailError) error = emailError;
  else if (requireAuth && emails.length === 0) {
    error = "Production authentication is not configured. Set GOOGLE_CLIENT_ID and ALLOWED_EMAILS.";
  }
  return {
    requireAuth,
    clientId: error ? "" : clientId,
    allowedEmails: error ? [] : emails,
    rateLimitMax: max.ok ? max.value : DEFAULT_RATE_LIMIT_MAX,
    rateLimitWindowMs: windowMs.ok ? windowMs.value : DEFAULT_RATE_LIMIT_WINDOW_MS,
    error,
  };
}

export function startupConfig(env = process.env) {
  const model = readConfig(env);
  const listen = listenConfig(env);
  const auth = authConfig(env);
  const problems = [];
  if (listen.error) problems.push(listen.error);
  if (auth.error) problems.push(auth.error);
  return { model, listen, auth, error: problems.join(" ") };
}
