import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
const context = createContext({ Intl, Date });
for (const file of ["schedule", "items"]) {
  runInContext(readFileSync(new URL(`../../shared/${file}.js`, import.meta.url), "utf8"), context);
}
export const items = context.QuickCalItems;
