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

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_MODEL"];

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
