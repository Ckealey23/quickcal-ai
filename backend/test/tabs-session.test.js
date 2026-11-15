import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const extensionId = "mkihiedalmccmhoebiiikpdoafhdfglf";

function loadBackground() {
  const sessionData = {};
  const delivered = [];
  const scripts = [];
  const logs = [];
  const listeners = {};
  const widgets = new Map();
  const fetches = [];
  let releaseParse = null;
  const tabs = [
    { id: 1, url: "https://a.example/page", incognito: false },
    { id: 2, url: "https://b.example/page", incognito: false },
  ];
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: extensionId,
        getURL(file) {
          return "chrome-extension://" + extensionId + "/" + file;
        },
        onMessage: { addListener(listener) { listeners.message = listener; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        lastError: undefined,
      },
      contextMenus: {
        create(props, callback) {
          if (callback) callback();
        },
        onClicked: { addListener() {} },
      },
      tabs: {
        async query() { return tabs.map((tab) => Object.assign({}, tab)); },
        async get(tabId) { return Object.assign({}, tabs.find((tab) => tab.id === tabId)); },
        async sendMessage(tabId, message) {
          if (message && message.action === "ping") {
            if (!widgets.has(tabId)) throw new Error("Receiving end does not exist.");
            return { ok: true, open: widgets.get(tabId) === "open" };
          }
          delivered.push({ tabId: tabId, message: message });
          if (message && message.action === "render" && message.session) {
            widgets.set(tabId, message.session.visible ? "open" : "closed");
          }
          return { ok: true };
        },
        onActivated: { addListener(listener) { listeners.activated = listener; } },
        onRemoved: { addListener() {} },
        onUpdated: { addListener(listener) { listeners.updated = listener; } },
      },
      scripting: {
        async executeScript(details) {
          scripts.push(details.files);
          if (!widgets.has(details.target.tabId)) widgets.set(details.target.tabId, "closed");
        },
      },
      storage: {
        local: {
          async get(key) { return { [key]: undefined }; },
          async set() {},
          async remove() {},
        },
        session: {
          async get(key) { return { [key]: sessionData[key] }; },
          async set(value) { Object.assign(sessionData, value); },
        },
      },
      identity: { async getAuthToken() { return "ya29.test-token"; }, async removeCachedAuthToken() {}, async clearAllCachedAuthTokens() {} },
      offscreen: { async createDocument() {}, async closeDocument() {}, async getContexts() { return []; } },
    },
    fetch: (url) => {
      fetches.push(String(url));
      if (String(url).endsWith("/parse-event")) {
        return new Promise((resolve) => {
          releaseParse = () => resolve({
            ok: true,
            status: 200,
            async json() {
              return {
                event: {
                  title: "Coffee with Alex",
                  date: null,
                  startTime: null,
                  endTime: null,
                  timeZone: "America/Los_Angeles",
                  location: null,
                  needsClarification: true,
                  clarificationQuestions: ["What date and time?"],
                },
              };
            },
          });
        });
      }
      return Promise.resolve({ ok: true, status: 200, async json() { return { ok: true }; } });
    },
    console: {
      info(...parts) { logs.push(parts.join(" ")); },
      log(...parts) { logs.push(parts.join(" ")); },
      error(...parts) { logs.push(parts.join(" ")); },
    },
    AbortController,
    AbortSignal,
    URL,
    JSON,
    Math,
    Number,
    String,
    crypto,
    setTimeout,
    clearTimeout,
  };
  sandbox.chrome.runtime.getContexts = sandbox.chrome.offscreen.getContexts;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => {
      runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
    });
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });

  function send(tabId, message) {
    const tab = tabs.find((item) => item.id === tabId);
    return new Promise((resolve) => {
      const keep = listeners.message(message, { id: extensionId, tab: tab, url: tab.url }, resolve);
      if (!keep) resolve(undefined);
    });
  }

  return {
    sessionData,
    delivered,
    scripts,
    logs,
    widgets,
    fetches,
    tabs,
    listeners,
    send,
    releaseParse: () => releaseParse && releaseParse(),
    toggle: sandbox.quickcalToggleWidget,
    session: () => sessionData.quickcalWidgetSession,
  };
}

describe("shared tabs through the service worker", () => {
  it("keeps one conversation across tabs and ignores a second save", async () => {
    const background = loadBackground();
    assert.equal(background.session(), undefined);
    assert.equal(background.scripts.length, 0);

    await background.toggle(background.tabs[0]);
    const opened = background.session();
    assert.equal(opened.visible, true);
    assert.equal(opened.input, "");
    assert.equal(opened.ownerTabId, 1);
    assert.equal(background.widgets.get(1), "open");
    assert.equal(background.widgets.get(2), "open");
    const rendered = background.delivered.filter((item) => item.message.action === "render" && item.message.session.visible);
    assert.equal(rendered.some((item) => item.tabId === 1), true);
    assert.equal(rendered.some((item) => item.tabId === 2), true);

    const snapshot = await background.send(2, { type: "quickcal-widget", action: "snapshot" });
    assert.equal(snapshot.session.input, "");
    assert.equal(snapshot.session.revision, background.session().revision);

    const typed = await background.send(1, {
      type: "quickcal-widget",
      action: "patch",
      sessionId: opened.sessionId,
      claim: opened.claim,
      seq: 1,
      input: "Coffee with Alex",
    });
    assert.equal(typed.accepted, true);
    assert.equal(background.session().input, "Coffee with Alex");
    assert.equal(background.delivered.filter((item) => item.tabId === 2 && item.message.session && item.message.session.input === "Coffee with Alex").length > 0, true);

    const stale = await background.send(2, {
      type: "quickcal-widget",
      action: "patch",
      sessionId: opened.sessionId,
      claim: opened.claim,
      seq: 2,
      input: "separate conversation",
    });
    assert.equal(stale.accepted, false);
    assert.equal(background.session().input, "Coffee with Alex");

    const claimed = await background.send(2, { type: "quickcal-widget", action: "claim" });
    const edited = await background.send(2, {
      type: "quickcal-widget",
      action: "patch",
      sessionId: claimed.session.sessionId,
      claim: claimed.session.claim,
      seq: claimed.session.inputSeq + 1,
      input: "Coffee with Alex Tuesday",
    });
    assert.equal(edited.accepted, true);
    assert.equal(background.session().input, "Coffee with Alex Tuesday");

    background.tabs.push({ id: 3, url: "https://c.example/page", incognito: false });
    await background.toggle(background.tabs[2]);
    assert.equal(background.session().visible, true);
    assert.equal(background.session().input, "Coffee with Alex Tuesday");
    assert.equal(background.widgets.get(3), "open");

    const firstSubmit = background.send(1, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex Tuesday",
      sessionId: background.session().sessionId,
      operationId: "op-tabs-1",
      timeZone: "America/Los_Angeles",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondSubmit = await background.send(2, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex Tuesday",
      sessionId: background.session().sessionId,
      operationId: "op-tabs-2",
      timeZone: "America/Los_Angeles",
    });
    assert.equal(secondSubmit.ignored, true);
    assert.equal(background.fetches.filter((url) => url.endsWith("/parse-event")).length, 1);
    background.releaseParse();
    const finished = await firstSubmit;
    assert.equal(finished.ok, true);
    assert.equal(background.fetches.filter((url) => url.endsWith("/parse-event")).length, 1);
    assert.equal(background.session().operation, null);

    const dismissed = await background.send(2, { type: "quickcal-widget", action: "dismiss" });
    assert.equal(dismissed.session.visible, false);
    assert.equal(dismissed.session.input, "");
    assert.equal(background.widgets.get(1), "closed");
    assert.equal(background.widgets.get(3), "closed");
    const late = await background.send(1, {
      type: "quickcal-widget",
      action: "patch",
      sessionId: opened.sessionId,
      claim: opened.claim,
      seq: 9,
      input: "Coffee with Alex",
    });
    assert.equal(late.accepted, false);
    assert.equal(background.session().visible, false);
    assert.equal(background.session().input, "");

    await background.toggle(background.tabs[0]);
    assert.equal(background.session().visible, true);
    assert.equal(background.session().input, "");
    assert.notEqual(background.session().sessionId, opened.sessionId);
    assert.equal(background.logs.some((line) => /separate conversation|site access/i.test(line)), false);
  });
});

const chromePath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));

function listen() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>" + request.url + "</title><p>" + request.url + "</p>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 1;
  const pending = new Map();
  const events = [];
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("Could not connect to Chrome.")));
  });
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (!data.id) events.push(data);
    if (!data.id || !pending.has(data.id)) return;
    const waiter = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
    else waiter.resolve(data.result);
  });
  return {
    events,
    ready: opened,
    send(method, params) {
      const id = next;
      next += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    },
    close() { ws.close(); },
  };
}

async function targets(port) {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    if (!response.ok) return [];
    return response.json();
  } catch (error) {
    return [];
  }
}

async function waitFor(read, ready, label, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < (timeoutMs || 8000)) {
    last = await read();
    if (ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(label + " " + JSON.stringify(last));
}

describe("real Chrome tabs", () => {
  it("synchronizes the extension session across browser tabs", { timeout: 90000 }, async () => {
    if (!chromePath || typeof WebSocket === "undefined") {
      assert.fail("Real Chrome multi-tab test cannot be run in this environment.");
    }
    const server = await listen();
    const port = server.address().port;
    const origin = "http://127.0.0.1:" + port;
    const profile = mkdtempSync(path.join(tmpdir(), "quickcal-tabs-"));
    const chrome = spawn(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--user-data-dir=" + profile,
      "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    let client = null;
    let browser = null;
    try {
      const debugFile = await waitFor(async () => {
        try { return readFileSync(path.join(profile, "DevToolsActivePort"), "utf8"); }
        catch (error) { return ""; }
      }, (value) => /^\d+\n/.test(value), "Chrome debugging port");
      const debugPort = debugFile.split("\n")[0];
      const browserPath = debugFile.split("\n")[1];
      browser = connect("ws://127.0.0.1:" + debugPort + browserPath);
      await browser.ready;
      const loaded = await browser.send("Extensions.loadUnpacked", { path: root });
      assert.equal(loaded.id, "mkihiedalmccmhoebiiikpdoafhdfglf");
      async function attachWorker(previousUrl) {
        const worker = await waitFor(async () => {
          const list = await targets(debugPort);
          return list.find((item) => item.type === "service_worker" && item.url === "chrome-extension://" + extensionId + "/background.js" && item.webSocketDebuggerUrl !== previousUrl) || null;
        }, (item) => !!item, "extension service worker", previousUrl ? 15000 : 8000);
        const attached = connect(worker.webSocketDebuggerUrl);
        await attached.ready;
        await attached.send("Runtime.enable");
        await attached.send("Runtime.runIfWaitingForDebugger");
        await waitFor(async () => {
          const value = await attached.send("Runtime.evaluate", { expression: 'JSON.stringify({ready:typeof self.quickcalToggleWidget, toggle:typeof toggleWidget, items:typeof self.QuickCalItems, review:typeof reviewRows})', returnByValue: true });
          return { state: value.result && value.result.value, errors: attached.events.filter(event => event.method === "Runtime.exceptionThrown") };
        }, value => value && value.state && value.state.includes('"ready":"function"'), "extension worker did not initialize");
        return attached;
      }
      client = await attachWorker();
      async function workerEval(expression) {
        const result = await client.send("Runtime.evaluate", {
          expression: expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      await workerEval(`(async () => {
        await chrome.tabs.create({ url: ${JSON.stringify(origin + "/a")} });
        await chrome.tabs.create({ url: ${JSON.stringify(origin + "/b")} });
        return true;
      })()`);

      const pages = await waitFor(async () => {
        const list = await targets(debugPort);
        return list.filter((item) => item.type === "page" && item.url && item.url.startsWith(origin));
      }, (list) => list.length >= 2, "two pages");
      const opened = await workerEval(`(async () => {
        let tab = null;
        for (let attempt = 0; attempt < 40 && !tab; attempt += 1) {
          const tabs = await chrome.tabs.query({ url: ${JSON.stringify(origin + "/*")} });
          tab = tabs.find((item) => (item.url || "").endsWith("/a"));
          if (!tab) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await quickcalToggleWidget(tab);
        const stored = await chrome.storage.session.get("quickcalWidgetSession");
        return stored.quickcalWidgetSession;
      })()`);
      assert.equal(opened.visible, true);
      const pageA = connect(pages.find((item) => item.url.endsWith("/a")).webSocketDebuggerUrl);
      const pageB = connect(pages.find((item) => item.url.endsWith("/b")).webSocketDebuggerUrl);
      await pageA.ready;
      await pageB.ready;
      async function pageEval(page, expression) {
        const result = await page.send("Runtime.evaluate", { expression: expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }
      async function typeOn(suffix, text) {
        return workerEval(`(async () => {
          let tab = null;
          for (let attempt = 0; attempt < 40 && !tab; attempt += 1) {
            const tabs = await chrome.tabs.query({ url: ${JSON.stringify(origin + "/*")} });
            tab = tabs.find((item) => (item.url || "").endsWith(${JSON.stringify(suffix)}));
            if (!tab) await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (chrome.windows && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
          await new Promise((resolve) => setTimeout(resolve, 100));
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (value) => {
              const input = document.getElementById("quickcal-ai-host").shadowRoot.querySelector("#quickcal-input");
              input.focus();
              input.value = value;
              input.dispatchEvent(new Event("input", { bubbles: true }));
            },
            args: [${JSON.stringify(text)}],
          });
          const expected = ${JSON.stringify(text)};
          let input = "";
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const stored = await chrome.storage.session.get("quickcalWidgetSession");
            input = stored.quickcalWidgetSession ? stored.quickcalWidgetSession.input : "";
            if (input === expected) return input;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const diag = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({
              hasSession: !!(chrome.storage && chrome.storage.session),
              storageKeys: chrome.storage ? Object.keys(chrome.storage) : [],
              value: (document.getElementById("quickcal-ai-host") && document.getElementById("quickcal-ai-host").shadowRoot.querySelector("#quickcal-input").value) || "",
            }),
          });
          return JSON.stringify({ input: input, diag: diag && diag[0] && diag[0].result });
        })()`);
      }
      const savedOnA = await typeOn("/a", "Coffee with Alex");
      assert.equal(savedOnA, "Coffee with Alex");
      const typed = await pageEval(pageA, `(() => {
        const host = document.getElementById("quickcal-ai-host");
        const input = host && host.shadowRoot.querySelector("#quickcal-input");
        return { open: host ? host.dataset.open : "missing", value: input ? input.value : null };
      })()`);
      assert.equal(typed.open, "true");
      assert.equal(typed.value, "Coffee with Alex");
      const mirrored = await waitFor(
        () => pageEval(pageB, `(() => {
          const host = document.getElementById("quickcal-ai-host");
          const input = host && host.shadowRoot && host.shadowRoot.querySelector("#quickcal-input");
          return { open: host ? host.dataset.open : "missing", value: input ? input.value : null };
        })()`),
        (value) => value.open === "true" && value.value === "Coffee with Alex",
        "tab B did not show the shared text"
      );
      assert.equal(mirrored.value, "Coffee with Alex");
      await typeOn("/b", "Coffee with Alex Tuesday");
      await waitFor(
        () => pageEval(pageA, `document.getElementById("quickcal-ai-host").shadowRoot.querySelector("#quickcal-input").value`),
        (value) => value === "Coffee with Alex Tuesday",
        "tab A did not receive the edit from tab B"
      );
      const created = await client.send("Runtime.evaluate", {
        expression: `(async () => {
          const tab = await chrome.tabs.create({ url: ${JSON.stringify(origin + "/c")} });
          return tab.id;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (created.exceptionDetails) throw new Error(JSON.stringify(created.exceptionDetails));
      const pageCTarget = await waitFor(async () => {
        const list = await targets(debugPort);
        return list.find((item) => item.type === "page" && item.url === origin + "/c") || null;
      }, (item) => !!item, "tab C");
      const pageC = connect(pageCTarget.webSocketDebuggerUrl);
      await pageC.ready;
      await waitFor(
        async () => {
          const page = await pageEval(pageC, `(() => {
            const host = document.getElementById("quickcal-ai-host");
            const input = host && host.shadowRoot && host.shadowRoot.querySelector("#quickcal-input");
            return { open: host ? host.dataset.open : "missing", value: input ? input.value : null };
          })()`);
          const stored = await workerEval(`(async () => {
            const value = await chrome.storage.session.get("quickcalWidgetSession");
            return value.quickcalWidgetSession ? value.quickcalWidgetSession.input : null;
          })()`);
          return { page: page, stored: stored };
        },
        (value) => value.page.open === "true" && value.page.value === "Coffee with Alex Tuesday" && value.stored === "Coffee with Alex Tuesday",
        "new tab C did not restore the session"
      );
      await pageEval(pageB, `document.getElementById("quickcal-ai-host").shadowRoot.querySelector(".dismiss").click()`);
      await waitFor(
        async () => [
          await pageEval(pageA, `document.getElementById("quickcal-ai-host").dataset.open`),
          await pageEval(pageC, `document.getElementById("quickcal-ai-host").dataset.open`),
        ],
        (value) => value[0] === "false" && value[1] === "false",
        "dismiss did not hide every tab"
      );
      await workerEval(`(async () => {
        let tab = null;
        for (let attempt = 0; attempt < 40 && !tab; attempt += 1) {
          const tabs = await chrome.tabs.query({ url: ${JSON.stringify(origin + "/*")} });
          tab = tabs.find((item) => (item.url || "").endsWith("/a"));
          if (!tab) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await quickcalToggleWidget(tab);
        return true;
      })()`);
      await waitFor(
        async () => [
          await pageEval(pageA, `document.getElementById("quickcal-ai-host").shadowRoot.querySelector("#quickcal-input").value`),
          await pageEval(pageB, `(() => { const host = document.getElementById("quickcal-ai-host"); const input = host.shadowRoot.querySelector("#quickcal-input"); return host.dataset.open + ":" + input.value; })()`),
        ],
        (value) => value[0] === "" && value[1] === "true:",
        "reopen was not one fresh shared input"
      );
      const previousWorker = (await targets(debugPort)).find((item) => item.type === "service_worker" && item.url === "chrome-extension://" + extensionId + "/background.js");
      // Exercise the assembled content widget and real service worker together.
      // All paid AI and Google writes below are intercepted inside this isolated profile.
      await workerEval(`(() => {
        requestToken = async () => 'fixture-token';
        self.reviewTestWrites = [];
        self.reviewTestEvents = {};
        self.fetch = async (url, options = {}) => {
          const target = String(url), method = options.method || 'GET';
          const reply = (body, status = 200) => ({ok:status < 400,status,json:async()=>body});
          if (target.endsWith('/analyze-document')) return reply({items:[
            {kind:'event',title:'Project review',date:'2026-11-20',startTime:'10:03',endTime:'11:03',timeZone:'America/Los_Angeles',description:'Review milestones',sourceContext:'Project review November 20',uncertainty:'',allDay:false},
            {kind:'task',title:'Submit report',date:'2026-11-21',startTime:null,endTime:null,timeZone:'America/Los_Angeles',description:'',sourceContext:'Report due November 21',uncertainty:'',allDay:false}
          ],warning:''});
          if(target.includes('/calendar/v3/')) {
            if(method==='GET') {
              const id=target.split('/events/')[1];
              return self.reviewTestEvents[id] ? reply(self.reviewTestEvents[id]) : reply({},404);
            }
            const body=JSON.parse(options.body); self.reviewTestWrites.push(body);
            const saved={...body,status:'confirmed',htmlLink:'https://calendar.google.com/calendar/event?eid='+body.id};
            self.reviewTestEvents[body.id]=saved; return reply(saved);
          }
          if(target.endsWith('/health'))return reply({ok:true,quickcalApiVersion:4});
          if(target.endsWith('/access'))return reply({ok:true,approved:true});
          throw new Error('Unexpected fixture request');
        };
        return true;
      })()`);
      await pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.attachment-button').click()`);
      await waitFor(() => pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.upload-panel').classList.contains('is-open')`), value => value, "upload did not open");
      await pageEval(pageA, `(() => {
        const drop=document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.document-drop');
        const data=new DataTransfer();data.items.add(new File(['Project review November 20. Report due November 21.'],'timeline.txt',{type:'text/plain'}));
        drop.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
      })()`);
      await waitFor(() => pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.attached-name').textContent`), value => value.includes('timeline.txt'), "file did not attach");
      await pageEval(pageA, `(() => {const shadow=document.getElementById('quickcal-ai-host').shadowRoot;[...shadow.querySelectorAll('button')].find(button=>button.textContent==='Analyze document').click();})()`);
      await waitFor(() => pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelectorAll('.proposal').length`), value => value === 2, "document proposals missing");
      assert.equal(await workerEval('self.reviewTestWrites.length'), 0);
      await pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.time-trigger').click()`);
      await waitFor(() => pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelectorAll('.time-option').length`), value => value === 288, "time picker missing");
      await pageEval(pageA, `(() => {const shadow=document.getElementById('quickcal-ai-host').shadowRoot;[...shadow.querySelectorAll('.time-option')].find(option=>option.textContent==='10:05 AM').click();})()`);
      await waitFor(() => workerEval(`(async()=>{const value=await chrome.storage.session.get('quickcalWidgetSession');return value.quickcalWidgetSession.review.rows[0].item.startTime})()`), value => value === '10:05', "edited time missing from session");
      await pageEval(pageA, `(() => {const first=document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.proposal');[...first.querySelectorAll('button')].find(button=>button.textContent==='Approve').click();})()`);
      await waitFor(() => pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.review-create').textContent`), value => value.includes('1 approved event'), "approval count incorrect");
      if (process.env.QUICKCAL_SCREENSHOT_PATH) {
        const shot = await pageA.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(process.env.QUICKCAL_SCREENSHOT_PATH, Buffer.from(shot.data, "base64"));
      }
      const bounds = await pageEval(pageA, `(() => {const card=document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.card').getBoundingClientRect();return {top:card.top,bottom:card.bottom,height:innerHeight};})()`);
      assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, JSON.stringify(bounds));
      await pageEval(pageA, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.review-create').click()`);
      await waitFor(() => workerEval('self.reviewTestWrites.length'), value => value === 1, "approved event not saved");
      const reviewedWrite = await workerEval('self.reviewTestWrites[0]');
      assert.match(reviewedWrite.start.dateTime, /T10:05:00-08:00/);
      assert.equal(reviewedWrite.summary, 'Project review');
      await waitFor(() => pageEval(pageB, `document.getElementById('quickcal-ai-host').shadowRoot.querySelector('.proposal-status')?.textContent`), value => value === 'Created ✓', "creation result did not synchronize");
      assert.equal(await workerEval('self.reviewTestWrites.length'), 1);
      client.close();
      client = null;
      await browser.send("Extensions.loadUnpacked", { path: root });
      client = await attachWorker(previousWorker && previousWorker.webSocketDebuggerUrl);
      await workerEval(`(async () => {
        let tab = null;
        for (let attempt = 0; attempt < 40 && !tab; attempt += 1) {
          const tabs = await chrome.tabs.query({ url: ${JSON.stringify(origin + "/*")} });
          tab = tabs.find((item) => (item.url || "").endsWith("/a"));
          if (!tab) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await quickcalToggleWidget(tab);
        return true;
      })()`);
      await typeOn("/a", "After reload");
      await waitFor(
        () => pageEval(pageB, `(() => {
          const host = document.getElementById("quickcal-ai-host");
          const input = host && host.shadowRoot && host.shadowRoot.querySelector("#quickcal-input");
          return { open: host ? host.dataset.open : "missing", value: input ? input.value : null };
        })()`),
        (value) => value.open === "true" && value.value === "After reload",
        "existing tab B did not get the session after extension reload"
      );
      pageA.close();
      pageB.close();
      pageC.close();
      client.close();
      client = null;
    } finally {
      if (client) client.close();
      if (browser) browser.close();
      chrome.kill("SIGKILL");
      server.close();
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error) {
        // Chrome can still be releasing the temporary profile.
      }
    }
  });
});
