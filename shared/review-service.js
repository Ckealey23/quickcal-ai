// Runs only in the service worker. Tokens and Google writes never reach the widget.
const REVIEW_WORKER_ID = createOperationId();
function recoverReviewOperation(state) {
  if (!state.operation || !["document", "review-create"].includes(state.operation.kind) || state.operation.workerId === REVIEW_WORKER_ID) return state;
  const review = state.review ? Object.assign({}, state.review, {
    rows: state.review.rows.map(row => row.decision === "approved" && row.status !== "created"
      ? Object.assign({}, row, { status: "failed", uncertain: true, error: "The extension restarted before this request finished. Retry to safely check or finish this item." }) : row),
  }) : null;
  return Object.assign({}, state, { operation: null, review, revision: state.revision + 1, statusText: "The extension restarted. Review your items and retry; successful items stay saved.", statusError: true });
}
function keepReviewAlive() {
  let timer = null, stopped = false;
  const ping = async () => {
    if (stopped || typeof chrome.runtime.getPlatformInfo !== "function") return;
    try { await chrome.runtime.getPlatformInfo(); } catch (_) { /* Recovery handles a suspended worker. */ }
    if (!stopped) timer = setTimeout(ping, 20000);
  };
  ping();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
function mutateReviewSession(incognito, updater) {
  return mutateWidgetSession(incognito, current => {
    const next = updater(current);
    return next === current ? current : Object.assign({}, next, { revision: current.revision + 1 });
  });
}
function reviewRows(items, created) {
  return items.map(item => ({
    id: createOperationId(), item: self.QuickCalItems.normalize(item),
    decision: "pending", status: (created || []).includes(self.QuickCalItems.key(item)) ? "created" : "ready",
    requestId: createEventId(), error: "", result: null, uncertain: false,
  }));
}
function reviewFailure(result, service) {
  if (result.unauthorized || result.authError || result.status === 403) {
    return `Allow Google ${service} access in Extension options, then reconnect. Also check that the ${service} API is enabled in Google Cloud.`;
  }
  return `Google ${service} could not save this item. Try again.`;
}
async function createReviewEvent(row) {
  const item = row.item;
  const prepared = item.allDay ? null : self.QuickCalSchedule.prepareForSave(item);
  if (!item.allDay && !prepared) return { ok: false, error: "Check the event dates, times, and recurrence." };
  let body;
  if (item.allDay) {
    const last = new Date((item.endDate || item.date) + "T12:00:00Z");
    last.setUTCDate(last.getUTCDate() + 1);
    body = { start: { date: item.date }, end: { date: last.toISOString().slice(0, 10) } };
  } else {
    body = { start: { dateTime: prepared.startDateTime, timeZone: item.timeZone }, end: { dateTime: prepared.endDateTime, timeZone: item.timeZone } };
    if (prepared.recurrenceRule) body.recurrence = [prepared.recurrenceRule];
    if (item.reminders) body.reminders = item.reminders;
  }
  Object.assign(body, {
    id: row.requestId, summary: item.title, location: item.location,
    description: [item.description, item.sourceContext ? "Source: " + item.sourceContext : "", "Created by QuickCalAI."].filter(Boolean).join("\n\n"),
  });
  const url = CALENDAR_EVENTS_URL + "/" + encodeURIComponent(row.requestId);
  // Client-generated Calendar IDs make retries safe, including after a lost response.
  let result = await calendarCall(url, { method: "GET" });
  if (result.notFound) result = await calendarCall(CALENDAR_EVENTS_URL, { method: "POST", body: JSON.stringify(body) });
  if (result.conflict || result.network || (result.status >= 500)) result = await calendarCall(url, { method: "GET" });
  if (!result.ok || !result.body || result.body.id !== row.requestId || result.body.status === "cancelled") return {
    ok: false, uncertain: !!(result.network || result.notFound || result.conflict || result.status >= 500 || result.ok),
    error: reviewFailure(result, "Calendar"),
  };
  const saved = result.body;
  const record = prepared ? Object.assign({}, prepared, { id: saved.id, phase: "created", htmlLink: saved.htmlLink, description: WIDGET_DESCRIPTION, userDescription: body.description }) : null;
  return { ok: true, id: saved.id, htmlLink: safeCalendarLink(saved.htmlLink), savedRecord: record ? publicSavedEvent(record) : null, record };
}
const REVIEW_TASKS_URL = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
async function findReviewTask(marker) {
  let page = "";
  for (let index = 0; index < 200; index++) {
    const url = REVIEW_TASKS_URL + "?maxResults=100&showCompleted=true&showHidden=true" + (page ? "&pageToken=" + encodeURIComponent(page) : "");
    const result = await calendarCall(url, { method: "GET" });
    if (!result.ok || !result.body) return { ok: false, error: reviewFailure(result, "Tasks") };
    const match = (result.body.items || []).find(item => typeof item.notes === "string" && item.notes.includes(marker));
    if (match) return { ok: true, id: match.id };
    page = result.body.nextPageToken;
    if (!page) return { ok: false, error: "Google did not confirm the earlier task request. Check Google Tasks before starting a new request; retry only checks for the existing task.", uncertain: true };
  }
  return { ok: false, error: "The task list is too large to safely check the earlier request. Check Google Tasks.", uncertain: true };
}
async function createReviewTask(row, markDispatched) {
  const marker = "QuickCalAI request: " + row.requestId;
  if (row.uncertain) return findReviewTask(marker);
  const item = row.item;
  const body = {
    title: item.title,
    notes: [item.description, item.startTime ? `Requested due time: ${item.date} ${item.startTime} (${item.timeZone}). Google Tasks stores dates only; this time is a note, not an alarm.` : "", item.sourceContext ? "Source: " + item.sourceContext : "", marker].filter(Boolean).join("\n\n"),
  };
  if (item.date) body.due = item.date + "T00:00:00.000Z";
  // Tasks has no client ID or idempotency key. Persist dispatch BEFORE the POST;
  // an interrupted/lost response can only be reconciled, never blindly re-posted.
  await markDispatched();
  const result = await calendarCall(REVIEW_TASKS_URL, { method: "POST", body: JSON.stringify(body) });
  if (result.ok && result.body && result.body.id) return { ok: true, id: result.body.id };
  if (result.network || result.status >= 500 || (result.ok && !result.body?.id)) return { ok: false, uncertain: true, error: "Google's task response was interrupted. Retry will check for the existing task without creating a duplicate." };
  return { ok: false, uncertain: false, error: reviewFailure(result, "Tasks") };
}
async function analyzeReviewDocument(state, text, operation, incognito) {
  let result;
  try {
    if (await isSuppressed()) throw new Error("Connect Google in Extension options before analyzing a document.");
    const token = await requestToken(false);
    if (!token) throw new Error("Reconnect Google in Extension options.");
    const response = await fetch("https://quickcal-ai.onrender.com/analyze-document", {
      method: "POST", credentials: "omit", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ file: state.attachment, instructions: text, timeZone: state.reviewTimeZone }),
      signal: AbortSignal.timeout(95000),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(response.status === 404 ? "Deploy the updated backend to enable document analysis." : body.error || "Document analysis failed.");
    if (!Array.isArray(body.items) || body.items.length > self.QuickCalItems.MAX_ITEMS) throw new Error("Invalid document proposals.");
    result = { review: { source: "document", rows: reviewRows(body.items, state.createdItemKeys), warning: String(body.warning || "").slice(0, 1500) }, uploadOpen: false, mode: "review", statusText: "", statusError: false };
  } catch (error) {
    result = { statusText: String(error.message || "Document analysis failed.").slice(0, 500), statusError: true };
  }
  return mutateReviewSession(incognito, latest => self.QuickCalSession.finishOperation(latest, operation, result).state);
}
async function createApprovedReview(state, operation, incognito) {
  for (const row of state.review.rows) {
    if (row.decision !== "approved" || row.status === "created") continue;
    const latest = await readWidgetSession(incognito);
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    let result;
    try {
      if (await isSuppressed()) throw new Error("Reconnect Google in Extension options before saving.");
      result = row.item.kind === "task"
        ? await createReviewTask(row, async () => {
          await mutateReviewSession(incognito, current => {
            if (!self.QuickCalSession.operationCurrent(current, operation)) return current;
            return Object.assign({}, current, { review: Object.assign({}, current.review, { rows: current.review.rows.map(entry => entry.id === row.id ? Object.assign({}, entry, { uncertain: true }) : entry) }) });
          });
        })
        : await createReviewEvent(row);
    } catch (error) { result = { ok: false, uncertain: row.item.kind === "task", error: error.message || "This item could not be saved." }; }
    if (result.ok && result.record && state.review.source === "request") {
      try { await saveDraftEvent(result.record); }
      catch (_) { result.savedRecord = null; }
    }
    await mutateReviewSession(incognito, current => {
      if (!self.QuickCalSession.operationCurrent(current, operation)) return current;
      const keys = current.createdItemKeys || [];
      const rows = current.review.rows.map(entry => entry.id === row.id ? Object.assign({}, entry, {
        status: result.ok ? "created" : "failed", error: result.error || "", result, uncertain: result.uncertain === true,
      }) : entry);
      return Object.assign({}, current, {
        review: Object.assign({}, current.review, { rows }),
        createdItemKeys: result.ok ? [...new Set(keys.concat(self.QuickCalItems.key(row.item)))] : keys,
        savedRecord: state.review.source === "request" && result.savedRecord ? result.savedRecord : current.savedRecord,
        statusText: "Saving approved items…", statusError: false,
      });
    });
  }
  return mutateReviewSession(incognito, current => {
    if (!self.QuickCalSession.operationCurrent(current, operation)) return current;
    const rows = current.review.rows;
    const done = rows.filter(row => row.status === "created").length;
    const failed = rows.filter(row => row.status === "failed").length;
    return self.QuickCalSession.finishOperation(current, operation, {
      statusText: `${done} item${done === 1 ? "" : "s"} created.${failed ? ` ${failed} failed; retry checks only failed approved items.` : ""}`,
      statusError: failed > 0,
    }).state;
  });
}
async function handleReviewMessage(message, sender) {
  try { return await runReviewMessage(message, sender); }
  catch (error) { return { ok: false, error: String(error.message || "QuickCalAI could not update this review.").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 400) }; }
}
async function runReviewMessage(message, sender) {
  const incognito = !!sender.tab.incognito;
  let operation = null;
  const state = await mutateReviewSession(incognito, current => {
    if (!current.visible || message.sessionId !== current.sessionId) return current;
    const action = message.action;
    if (action === "upload-panel") return Object.assign({}, current, { uploadOpen: !!message.open });
    if (current.operation && current.operation.kind !== "document") return current;
    if (action === "attachment") {
      let attachment = null;
      if (message.file) {
        const file = message.file;
        if (typeof file.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length > 2796204 || typeof file.name !== "string" || file.name.length > 255) throw new Error("Invalid attachment.");
        const size = Math.floor(file.data.length * 3 / 4) - (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0);
        const problem = self.QuickCalItems.fileProblem({ name: file.name, size });
        if (problem) throw new Error(problem);
        attachment = { name: file.name, data: file.data, size };
      }
      return Object.assign({}, current, { attachment, review: null, operation: null, mode: "input", savedRecord: null, clarification: null, event: null, uploadOpen: true, statusText: "", statusError: false });
    }
    if (current.operation) return current;
    if (action === "review-item" && current.review) {
      const rows = current.review.rows.map(row => {
        if (row.id !== message.id || row.status === "created") return row;
        if ((row.uncertain || row.status === "failed") && message.item) throw new Error("Retry or check the earlier request before editing it. A response may have been interrupted.");
        const item = message.item ? self.QuickCalItems.normalize(message.item) : row.item;
        const decision = message.item ? "pending" : message.decision;
        if (!["approved", "pending", "skipped"].includes(decision)) return row;
        const problem = self.QuickCalItems.problem(item);
        if (decision === "approved" && problem) throw new Error(problem);
        return Object.assign({}, row, { item, decision, error: "", status: row.uncertain ? row.status : "ready" });
      });
      return Object.assign({}, current, { review: Object.assign({}, current.review, { rows }) });
    }
    if (action === "analyze-document" && current.attachment) {
      if (current.review && current.review.rows.some(row => row.uncertain && row.status !== "created")) {
        throw new Error("Retry the unconfirmed items before refining this document. If Google still cannot confirm them, check Google directly before starting a new request.");
      }
      const text = typeof message.text === "string" ? message.text.trim() : "";
      if (text.length > 2000 || !self.QuickCalItems.validZone(message.timeZone)) throw new Error("Check the instructions and time zone.");
      const begun = self.QuickCalSession.beginOperation(current, "document", createOperationId(), current.sessionId);
      if (!begun.accepted) return current;
      operation = begun.state.operation;
      operation.workerId = REVIEW_WORKER_ID;
      return Object.assign({}, begun.state, { input: text, reviewTimeZone: message.timeZone, statusText: "Analyzing document…", statusError: false });
    }
    if (action === "create-approved" && current.review) {
      const approved = current.review.rows.filter(row => row.decision === "approved" && row.status !== "created");
      if (!approved.length) return current;
      for (const row of approved) { const problem = self.QuickCalItems.problem(row.item); if (problem) throw new Error(problem); }
      const begun = self.QuickCalSession.beginOperation(current, "review-create", createOperationId(), current.sessionId);
      if (!begun.accepted) return current;
      operation = begun.state.operation;
      operation.workerId = REVIEW_WORKER_ID;
      return Object.assign({}, begun.state, { statusText: "Saving approved items…", statusError: false });
    }
    return current;
  });
  if (!operation) return { ok: true, session: state };
  const stop = keepReviewAlive();
  try {
    const session = message.action === "analyze-document"
      ? await analyzeReviewDocument(state, state.input, operation, incognito)
      : await createApprovedReview(state, operation, incognito);
    return { ok: true, session };
  } finally { stop(); }
}
