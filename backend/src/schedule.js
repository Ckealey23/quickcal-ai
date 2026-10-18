import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

const sandbox = { Intl, Date, JSON, Math, String, Number };
sandbox.globalThis = sandbox;
const context = createContext(sandbox);
runInContext(
  readFileSync(fileURLToPath(new URL("../../shared/schedule.js", import.meta.url)), "utf8"),
  context,
  { filename: "shared/schedule.js" }
);

export const applySchedule = sandbox.QuickCalSchedule.applySchedule;
export const applyEdit = sandbox.QuickCalSchedule.applyEdit;
export const normalizeCurrentEvent = sandbox.QuickCalSchedule.normalizeCurrentEvent;
export const normalizeRecurrence = sandbox.QuickCalSchedule.normalizeRecurrence;
export const resolveEventZone = sandbox.QuickCalSchedule.resolveEventZone;
export const prepareForSave = sandbox.QuickCalSchedule.prepareForSave;
