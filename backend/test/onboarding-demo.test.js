import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { chromePath, runPage } from "./support/chrome.js";
import { widgetPage } from "./support/widget-page.js";

const shotDir = path.resolve(import.meta.dirname, "../../dist/onboarding-shots");

async function expectPass(script, options) {
  if (!chromePath) assert.fail("Chrome is required for onboarding demo checks.");
  const output = await runPage(widgetPage(script, options), Object.assign({ budget: 12000 }, options || {}));
  assert.match(output.stdout, /QUICKCAL_PASS/, output.stdout.slice(-4000) + "\n" + output.stderr.slice(-2000));
}

async function captureStep(step, waitMs, fileName) {
  mkdirSync(shotDir, { recursive: true });
  const output = await runPage(
    widgetPage(
      `
      await wait(${waitMs});
      check("step title present", !!$(".onboarding-title").textContent);
      finish();
    `,
      {
        onboarding: {
          active: true,
          replay: true,
          step: step,
          exampleIndex: 0,
          connectState: step === "connect" ? "ready" : "",
          connectMessage: "",
        },
      }
    ),
    {
      budget: waitMs + 2500,
      screenshot: path.join(shotDir, fileName),
      size: "520,720",
    }
  );
  assert.equal(output.code, 0, output.stderr.slice(-1000));
}

describe("animated onboarding demos", () => {
  it("shows overview capabilities without contacting backend APIs", async () => {
    await expectPass(
      `
      check("onboarding open", !$(".onboarding").hidden);
      check("card hidden", $(".card").hidden === true);
      check("title", $(".onboarding-title").textContent === "Welcome to QuickCalAI");
      check("four capabilities", $$(".onboarding-capability").length === 4);
      check("primary label", $(".onboarding-primary").textContent === "See how it works");
      check("skip label", $(".onboarding-skip").textContent === "Skip tour");
      check("stage hidden", $(".onboarding-stage").hidden === true);
      check("no backend calls", !quickcalTest.calls.some((item) => item.type === "quickcal-backend"));
      check("no calendar writes", !quickcalTest.calls.some((item) => item.type === "quickcal-calendar" && item.action && item.action !== "status"));
      finish();
    `,
      {
        onboarding: {
          active: true,
          replay: false,
          step: "overview",
          exampleIndex: 0,
          connectState: "",
          connectMessage: "",
        },
      }
    );
  });

  it("autoplays one feature demo at a time and keeps demos local", async () => {
    await expectPass(
      `
      check("event step", $(".onboarding-title").textContent === "Create an event");
      check("progress", $(".onboarding-progress").textContent === "1 of 4 examples");
      check("stage visible", !$(".onboarding-stage").hidden);
      check("capabilities hidden", $(".onboarding-capabilities").hidden === true);
      await wait(4500);
      check("event result", Array.from($$(".onboarding-demo-card-title")).some((node) => node.textContent === "Meeting with Joe"));
      check("example badge", $(".onboarding-demo-badge") && $(".onboarding-demo-badge").textContent === "Example");
      $(".onboarding-primary").click();
      await settle();
      await wait(200);
      check("availability only", $(".onboarding-title").textContent === "Find a time");
      check("progress 2", $(".onboarding-progress").textContent === "2 of 4 examples");
      await wait(4500);
      check("scheduled title", Array.from($$(".onboarding-demo-card-title")).some((node) => node.textContent === "Project sync"));
      $(".onboarding-primary").click();
      await settle();
      await wait(200);
      check("task only", $(".onboarding-title").textContent === "Create a task");
      await wait(3500);
      check("task due date only", Array.from($$(".onboarding-demo-card-meta")).some((node) => /Due Thursday, March 12, 2026/.test(node.textContent)));
      $(".onboarding-primary").click();
      await settle();
      await wait(200);
      check("docs only", $(".onboarding-title").textContent === "Import from documents");
      await wait(5500);
      check("review or summary", $$(".onboarding-demo-review-item").length > 0 || /Saved 2 events/.test(($(".onboarding-demo-summary") || {}).textContent || ""));
      check("no AI/backend during demos", !quickcalTest.calls.some((item) => item.type === "quickcal-backend"));
      check("no upload attach", !quickcalTest.calls.some((item) => item.type === "quickcal-widget" && String(item.action || "").indexOf("doc-") === 0));
      check("no voice", !quickcalTest.calls.some((item) => item.type === "quickcal-voice"));
      finish();
    `,
      {
        onboarding: {
          active: true,
          replay: true,
          step: "demo-event",
          exampleIndex: 0,
          connectState: "",
          connectMessage: "",
        },
        budget: 28000,
      }
    );
  });

  it("respects reduced motion with a readable final preview", async () => {
    await expectPass(
      `
      await wait(200);
      check("reduced event card", Array.from($$(".onboarding-demo-card-title")).some((node) => node.textContent === "Meeting with Joe"));
      finish();
    `,
      {
        onboarding: {
          active: true,
          replay: true,
          step: "demo-event",
          exampleIndex: 0,
          connectState: "",
          connectMessage: "",
        },
        reducedMotion: true,
        budget: 4000,
      }
    );
  });

  it("captures rendered demo screenshots for visual inspection", async () => {
    await captureStep("overview", 400, "01-overview.png");
    await captureStep("demo-event", 4500, "02-demo-event.png");
    await captureStep("demo-availability", 5000, "03-demo-availability.png");
    await captureStep("demo-task", 4000, "04-demo-task.png");
    await captureStep("demo-documents", 6500, "05-demo-documents.png");
    await captureStep("connect", 400, "06-connect.png");
  });
});
