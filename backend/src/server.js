import { pathToFileURL } from "node:url";
import { applyEnvFile, envFilePath, HOST, PORT, readConfig } from "./config.js";
import { startServer } from "./http.js";
import { createParser } from "./parse.js";

export async function main() {
  applyEnvFile(envFilePath(import.meta.url));
  const config = readConfig();
  const parseEvent = createParser({
    apiKey: config.apiKey,
    model: config.model,
    configError: config.error,
  });
  try {
    await startServer({
      host: HOST,
      port: PORT,
      parseEvent,
      apiKeyConfigured: Boolean(config.apiKey),
    });
  } catch (error) {
    if (error && error.code === "EADDRINUSE") {
      console.error("Port 3000 is already in use on 127.0.0.1.");
    } else {
      console.error("QuickCalAI could not start the server.");
    }
    process.exitCode = 1;
    return;
  }
  console.log("QuickCalAI event parser listening on http://127.0.0.1:3000");
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  main();
}
