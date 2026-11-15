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
    const base = { left: 200, top: 120, width: 456, height: 228, scale: 1 };
    const pointers = {
      nw: { x: 220, y: 140, dx: -80, dy: -40 },
      ne: { x: 636, y: 140, dx: 80, dy: -40 },
      sw: { x: 220, y: 328, dx: -80, dy: 40 },
      se: { x: 636, y: 328, dx: 80, dy: 40 },
    };
    for (const [corner, pointer] of Object.entries(pointers)) {
      const start = { ...base, pointerX: pointer.x, pointerY: pointer.y };
      const initial = layout.scaleFromCorner(start, { x: pointer.x, y: pointer.y }, corner, { width: 1200, height: 800 });
      assert.equal(initial.scale, start.scale, corner + " keeps its initial scale");
      assert.equal(initial.left, start.left, corner + " keeps its initial left position");
      assert.equal(initial.top, start.top, corner + " keeps its initial top position");
      const grown = layout.scaleFromCorner(start, { x: pointer.x + pointer.dx, y: pointer.y + pointer.dy }, corner, { width: 1200, height: 800 });
      assert.ok(grown.scale > 1, corner + " grows from its current size");
      assert.ok(Math.abs(grown.width / grown.height - start.width / start.height) < 0.02);
      assert.ok(grown.left >= layout.MARGIN);
      assert.ok(grown.top >= layout.MARGIN);
      const shrunk = layout.scaleFromCorner(start, { x: pointer.x - pointer.dx / 2, y: pointer.y - pointer.dy / 2 }, corner, { width: 1200, height: 800 });
      assert.ok(shrunk.scale < 1, corner + " shrinks from its current size");
    }
    const narrow = layout.clampScale(1.6, 456, 228, { width: 360, height: 700 });
    assert.ok(narrow < 1);
    assert.ok(narrow * 456 <= 360 - layout.MARGIN * 2 + 0.1);
    const parked = layout.clampPosition(900, 20, 456, 80, { width: 500, height: 400 });
    assert.ok(parked.left + 456 <= 500);
    assert.ok(parked.top >= 0);
  });
});
