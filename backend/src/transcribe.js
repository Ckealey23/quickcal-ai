import OpenAI, { toFile } from "openai";
import { MAX_TEXT_LENGTH } from "./config.js";
import { ParseError, describeModelFailure } from "./parse.js";

export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const TRANSCRIBE_TIMEOUT_MS = 45_000;

const AUDIO_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
};

export function audioKind(contentType) {
  const base = String(contentType || "").split(";")[0].trim().toLowerCase();
  return AUDIO_EXTENSIONS[base] || "";
}

export function transcriptionConfig(env = process.env) {
  const requested = typeof env.OPENAI_TRANSCRIPTION_MODEL === "string"
    ? env.OPENAI_TRANSCRIPTION_MODEL.trim()
    : "";
  const model = requested || DEFAULT_TRANSCRIPTION_MODEL;
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
    return {
      model: "",
      error: "OPENAI_TRANSCRIPTION_MODEL is not a valid model name. QuickCalAI will not substitute another model.",
    };
  }
  return { model, error: "" };
}

function transcriptionFailure(error) {
  const mapped = describeModelFailure(error);
  if (mapped.status === 504) return { status: 504, error: "Transcription timed out. Try again." };
  if (mapped.status === 502) return { status: 502, error: "QuickCalAI could not reach OpenAI." };
  if (mapped.status === 401) return { status: 502, error: "QuickCalAI could not transcribe that recording." };
  if (mapped.status === 403) return { status: 502, error: "QuickCalAI could not transcribe that recording." };
  if (mapped.status === 404) {
    return {
      status: 502,
      error: "The configured transcription model is unavailable. QuickCalAI did not substitute another model.",
    };
  }
  if (mapped.status === 429) return { status: 429, error: "OpenAI rate-limited this request. Wait and try again." };
  if (mapped.status === 400) return { status: 422, error: "QuickCalAI could not transcribe that recording." };
  return { status: 502, error: "QuickCalAI could not transcribe that recording." };
}

export function createTranscriber({ apiKey, model, client, configError } = {}) {
  return async function transcribe(buffer, contentType) {
    if (configError) throw new ParseError(500, configError);
    if (!apiKey) {
      throw new ParseError(500, "OPENAI_API_KEY is missing. Add it to backend/.env and start the server again.");
    }
    if (!model) {
      throw new ParseError(500, "OPENAI_TRANSCRIPTION_MODEL is not set. QuickCalAI will not substitute another model.");
    }
    if (!buffer || !buffer.length) {
      throw new ParseError(422, "QuickCalAI didn't hear any words. Try again.");
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new ParseError(413, "Recording is too large.");
    }
    const extension = audioKind(contentType);
    if (!extension) throw new ParseError(415, "QuickCalAI could not read that recording.");

    const openai = client || new OpenAI({ apiKey, maxRetries: 0, timeout: TRANSCRIBE_TIMEOUT_MS });
    let result;
    try {
      const file = await toFile(buffer, "recording." + extension, {
        type: String(contentType || "").split(";")[0].trim().toLowerCase(),
      });
      result = await openai.audio.transcriptions.create({
        file,
        model,
        response_format: "json",
      });
    } catch (error) {
      if (error instanceof ParseError) throw error;
      const failure = transcriptionFailure(error);
      throw new ParseError(failure.status, failure.error);
    }
    const text = result && typeof result.text === "string" ? result.text.trim() : "";
    if (!text) throw new ParseError(422, "QuickCalAI didn't hear any words. Try again.");
    if (text.length > MAX_TEXT_LENGTH) throw new ParseError(422, "That recording is too long to use.");
    return text;
  };
}
