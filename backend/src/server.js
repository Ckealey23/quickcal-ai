import { pathToFileURL } from "node:url";
import { createGoogleVerifier } from "./auth.js";
import { applyEnvFile, envFilePath, startupConfig } from "./config.js";
import { startServer } from "./http.js";
import { createParser } from "./parse.js";
import { createRateLimiter } from "./rate-limit.js";
import { createTranscriber, transcriptionConfig } from "./transcribe.js";

export async function main() {
  applyEnvFile(envFilePath(import.meta.url));
  const startup = startupConfig();
  const speech = transcriptionConfig();
  const startupError = [startup.error, speech.error].filter(Boolean).join(" ");
  if (startupError) {
    console.error(startupError);
    process.exitCode = 1;
    return;
  }
  const { model, listen, auth } = startup;
  const parseEvent = createParser({
    apiKey: model.apiKey,
    model: model.model,
    configError: model.error,
  });
  const transcribeAudio = createTranscriber({
    apiKey: model.apiKey,
    model: speech.model,
    configError: model.error || speech.error,
  });
  const authenticate = auth.requireAuth
    ? createGoogleVerifier({
        clientId: auth.clientId,
        allowedEmails: auth.allowedEmails,
        fetchImpl: globalThis.fetch,
      })
    : null;
  const rateLimit = auth.requireAuth
    ? createRateLimiter({ limit: auth.rateLimitMax, windowMs: auth.rateLimitWindowMs })
    : null;
  try {
    await startServer({
      host: listen.host,
      port: listen.port,
      parseEvent,
      transcribeAudio,
      apiKeyConfigured: Boolean(model.apiKey),
      requireAuth: auth.requireAuth,
      authenticate,
      rateLimit,
      release: process.env.RENDER_GIT_COMMIT || process.env.QUICKCAL_RELEASE || "local",
    });
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      console.error("Port " + listen.port + " is already in use on " + listen.host + ".");
    } else {
      console.error("QuickCalAI could not start the server.");
    }
    process.exitCode = 1;
    return;
  }
  console.log("QuickCalAI event parser listening on http://" + listen.host + ":" + listen.port);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main();
}
