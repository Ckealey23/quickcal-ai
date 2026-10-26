import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadLayout() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/layout.js"), "utf8"), context, {
    filename: "shared/layout.js",
  });
  return sandbox.QuickCalLayout;
}

describe("widget layout", () => {
  it("resizes in proportion and stays inside the viewport", () => {
    const layout = loadLayout();
    const start = { left: 200, top: 120, width: 456, height: 228, scale: 1 };
    const grown = layout.scaleFromCorner(start, { x: 120, y: 80 }, "nw", { width: 1200, height: 800 });
    assert.ok(grown.scale > 1);
    assert.ok(Math.abs(grown.width / grown.height - start.width / start.height) < 0.02);
    assert.ok(grown.left >= layout.MARGIN);
    assert.ok(grown.top >= layout.MARGIN);
    const narrow = layout.clampScale(1.6, 456, 228, { width: 360, height: 700 });
    assert.ok(narrow < 1);
    assert.ok(narrow * 456 <= 360 - layout.MARGIN * 2 + 0.1);
    const parked = layout.clampPosition(900, 20, 456, 80, { width: 500, height: 400 });
    assert.ok(parked.left + 456 <= 500);
    assert.ok(parked.top >= 0);
  });
});
