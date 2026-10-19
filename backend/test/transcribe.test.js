import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { describe, it } from "node:test";
import { ParseError } from "../src/parse.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { startServer } from "../src/http.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  MAX_AUDIO_BYTES,
  createTranscriber,
  transcriptionConfig,
} from "../src/transcribe.js";

const TOKEN = "ya29.transcription-test-token";

function transcriber(create, model) {
  const calls = [];
  const client = {
    audio: {
      transcriptions: {
        async create(request) {
          calls.push(request);
          return create(request);
        },
      },
    },
  };
  return {
    calls,
    transcribe: createTranscriber({
      apiKey: "sk-test-not-a-real-key",
      model: model || DEFAULT_TRANSCRIPTION_MODEL,
      client,
    }),
  };
}

async function listen(options) {
  const server = await startServer(Object.assign({
    host: "127.0.0.1",
    port: 0,
    parseEvent: async () => {
      throw new Error("parser called");
    },
  }, options));
  const address = server.address();
  return { server, base: "http://127.0.0.1:" + address.port };
}

async function post(base, path, body, headers) {
  const response = await fetch(base + path, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("transcription configuration", () => {
  it("defaults the transcription model separately from the event parser", () => {
    assert.equal(transcriptionConfig({}).model, "gpt-4o-mini-transcribe");
    assert.equal(transcriptionConfig({ OPENAI_MODEL: "gpt-6-luna" }).model, "gpt-4o-mini-transcribe");
    assert.equal(
      transcriptionConfig({ OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe" }).model,
      "gpt-4o-mini-transcribe"
    );
    assert.match(transcriptionConfig({ OPENAI_TRANSCRIPTION_MODEL: "bad model" }).error, /not a valid model/);
  });

  it("sends one recording and does not call the model for silence or a missing key", async () => {
    const spoken = transcriber(async () => ({ text: "  Lunch tomorrow at noon  " }));
    assert.equal(await spoken.transcribe(Buffer.from("webm-audio"), "audio/webm;codecs=opus"), "Lunch tomorrow at noon");
    assert.equal(spoken.calls.length, 1);
    assert.equal(spoken.calls[0].model, "gpt-4o-mini-transcribe");
    assert.equal(spoken.calls[0].file.name, "recording.webm");

    const silent = transcriber(async () => ({ text: "   " }));
    await assert.rejects(
      () => silent.transcribe(Buffer.from("webm-audio"), "audio/webm"),
      (error) => error instanceof ParseError && /didn't hear any words/.test(error.message)
    );
    assert.equal(silent.calls.length, 1);

    const missing = createTranscriber({ apiKey: "", model: DEFAULT_TRANSCRIPTION_MODEL, client: { audio: { transcriptions: { create() { throw new Error("called"); } } } } });
    await assert.rejects(() => missing(Buffer.from("webm-audio"), "audio/webm"), /OPENAI_API_KEY is missing/);
  });
});

describe("transcribe route", () => {
  it("requires approval and the rate limit before transcription, and keeps the JSON body limit", async () => {
    const calls = [];
    let identityCalls = 0;
    const { server, base } = await listen({
      requireAuth: true,
      authenticate(header) {
        identityCalls += 1;
        if (header !== "Bearer " + TOKEN) return { ok: false, status: 401, error: "Sign in with Google is required." };
        return { ok: true, userId: "google-user-1" };
      },
      rateLimit: createRateLimiter({ limit: 1, windowMs: 60000 }),
      async transcribeAudio(audio, type) {
        calls.push({ bytes: audio.length, type });
        return "Lunch tomorrow at noon";
      },
    });
    try {
      const denied = await post(base, "/transcribe", Buffer.from("audio"), {
        "Content-Type": "audio/webm",
      });
      assert.equal(denied.status, 401);
      assert.equal(calls.length, 0);

      const audio = Buffer.from("simulated-webm-audio");
      const ok = await post(base, "/transcribe", audio, {
        "Content-Type": "audio/webm;codecs=opus",
        Authorization: "Bearer " + TOKEN,
      });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { text: "Lunch tomorrow at noon" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].bytes, audio.length);
      assert.equal(JSON.stringify(ok.body).includes(TOKEN), false);

      const limited = await post(base, "/transcribe", audio, {
        "Content-Type": "audio/webm",
        Authorization: "Bearer " + TOKEN,
      });
      assert.equal(limited.status, 429);
      assert.equal(calls.length, 1);

      const empty = await listen({
        async transcribeAudio() {
          return "   ";
        },
      });
      const silent = await post(empty.base, "/transcribe", Buffer.from("audio"), {
        "Content-Type": "audio/webm",
      });
      assert.equal(silent.status, 422);
      assert.match(silent.body.error, /didn't hear any words/);
      empty.server.close();

      const tooBig = await new Promise((resolve, reject) => {
        const url = new URL(base + "/transcribe");
        const req = httpRequest({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "audio/webm",
            "Content-Length": String(MAX_AUDIO_BYTES + 1),
            Authorization: "Bearer " + TOKEN,
          },
        }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
          });
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(tooBig.status, 413);
      assert.equal(calls.length, 1);

      const json = await post(base, "/parse-event", Buffer.alloc(16 * 1024 + 1), {
        "Content-Type": "application/json",
        "Content-Length": String(16 * 1024 + 1),
        Authorization: "Bearer " + TOKEN,
      });
      assert.equal(json.status, 413);
      assert.match(json.body.error, /too large/);
      assert.equal(identityCalls >= 1, true);
    } finally {
      server.close();
    }
  });
});
