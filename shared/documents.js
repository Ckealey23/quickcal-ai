(function (root) {
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 60;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const TYPES = {
    pdf: { mime: "application/pdf", label: "PDF" },
    docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "DOCX" },
    txt: { mime: "text/plain", label: "TXT" },
  };
  const DECISIONS = ["pending", "approved", "skipped"];
  const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

  function fileKind(name) {
    const match = /\.([A-Za-z0-9]+)$/.exec(typeof name === "string" ? name.trim() : "");
    const extension = match ? match[1].toLowerCase() : "";
    return Object.hasOwn(TYPES, extension) ? extension : "";
  }

  function checkFile(file) {
    if (!file || typeof file.name !== "string" || !file.name.trim()) {
      return { ok: false, error: "Choose a PDF, DOCX, or TXT file." };
    }
    if (file.name.length > 255) return { ok: false, error: "This file name is too long." };
    const kind = fileKind(file.name);
    if (!kind) {
      return { ok: false, error: "QuickCalAI reads PDF, DOCX, and TXT files. Save this file in one of those formats." };
    }
    if (!Number.isInteger(file.size) || file.size <= 0) return { ok: false, error: "This file is empty." };
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: "This file is larger than 2 MB. Upload a shorter section." };
    return { ok: true, kind: kind, mime: TYPES[kind].mime };
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " MB";
  }

  function randomId(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let id = "";
    for (let index = 0; index < bytes.length; index += 1) id += ID_ALPHABET[bytes[index] & 31];
    return id;
  }

  function realDate(value) {
    if (!DATE.test(value || "")) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function nextDay(value) {
    const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)) + 1));
    return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0");
  }

  function text(value, max) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function itemKey(item) {
    return [item.kind, text(item.title, 200).toLowerCase().replace(/\s+/g, " "), item.date || "", item.startTime || ""].join("|");
  }

  // Normalizes the server's proposals into review items. Every item starts
  // undecided: nothing is approved on the user's behalf.
  function sanitizeItems(raw) {
    const items = [];
    (Array.isArray(raw) ? raw : []).slice(0, MAX_ITEMS).forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const kind = entry.kind === "task" ? "task" : entry.kind === "event" ? "event" : "";
      const title = text(entry.title, 200);
      if (!kind || !title) return;
      const date = realDate(entry.date) ? entry.date : null;
      const startClock = TIME.test(entry.startTime || "") ? entry.startTime : null;
      const allDay = kind === "event" && (entry.allDay === true || (!!date && !startClock));
      const endDate = kind === "event" && date && realDate(entry.endDate) && entry.endDate > date ? entry.endDate : null;
      const startTime = !allDay ? startClock : null;
      let endTime = kind === "event" && !allDay && startTime && TIME.test(entry.endTime || "") ? entry.endTime : null;
      if (endTime && !endDate && endTime <= startTime) endTime = null;
      const issues = (Array.isArray(entry.issues) ? entry.issues : [])
        .filter((issue) => typeof issue === "string" && issue.trim())
        .slice(0, 6)
        .map((issue) => issue.trim().slice(0, 200));
      items.push({
        id: "i" + randomId(8),
        ref: randomId(6),
        eventId: randomId(26),
        kind: kind,
        title: title,
        date: date,
        endDate: endDate,
        startTime: startTime,
        endTime: endTime,
        allDay: allDay,
        description: text(entry.description, 500) || null,
        category: text(entry.category, 40) || null,
        sourceQuote: text(entry.sourceQuote, 300) || null,
        sourcePage: Number.isInteger(entry.sourcePage) && entry.sourcePage > 0 ? entry.sourcePage : null,
        issues: issues,
        decision: "pending",
        edited: false,
        result: null,
      });
    });
    return items;
  }

  // Carries the user's decisions and edits over to a refined list when the
  // same activity is proposed again.
  function mergeDecisions(previous, next) {
    const kept = new Map();
    (previous || []).forEach((item) => {
      if (item.decision !== "pending" || item.edited || item.result) kept.set(itemKey(item), item);
    });
    const used = new Set();
    const merged = next.map((item) => {
      const key = itemKey(item);
      const old = kept.get(key);
      if (!old) return item;
      used.add(key);
      return Object.assign({}, old, { issues: item.issues, sourceQuote: item.sourceQuote, sourcePage: item.sourcePage });
    });
    // Items already written to Google stay listed so their results remain visible.
    (previous || []).forEach((item) => {
      if (item.result && item.result.ok && !used.has(itemKey(item))) merged.push(item);
    });
    return merged;
  }

  // Why an item cannot be approved yet, or "" when it is complete.
  function itemProblem(item) {
    if (!item || !text(item.title, 200)) return "Add a title.";
    if (item.kind === "task") return "";
    if (!item.date) return "Add a date.";
    if (!item.allDay && !item.startTime) return "Add a start time or mark it all day.";
    return "";
  }

  function addMinutes(date, time, minutes) {
    const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
    const day = total >= 24 * 60 ? nextDay(date) : date;
    const wrapped = total % (24 * 60);
    return { date: day, time: String(Math.floor(wrapped / 60)).padStart(2, "0") + ":" + String(wrapped % 60).padStart(2, "0") };
  }

  // The end a timed event will be saved with. A missing end is a visible
  // one-hour default, never a silent guess.
  function effectiveEnd(item) {
    if (item.kind !== "event" || item.allDay || !item.date || !item.startTime) {
      return { endDate: item.endDate || item.date, endTime: item.endTime, defaulted: false };
    }
    if (item.endTime) return { endDate: item.endDate || item.date, endTime: item.endTime, defaulted: false };
    const end = addMinutes(item.date, item.startTime, 60);
    return { endDate: end.date, endTime: end.time, defaulted: true };
  }

  function decide(item, decision) {
    if (DECISIONS.indexOf(decision) === -1) return { ok: false, error: "Choose approve or skip." };
    if (item.result && item.result.ok) return { ok: false, error: "This item was already created." };
    if (decision === "approved") {
      const problem = itemProblem(item);
      if (problem) return { ok: false, error: problem };
    }
    return { ok: true, item: Object.assign({}, item, { decision: decision }) };
  }

  // Applies a user's correction. An edit that leaves an approved item
  // incomplete returns it to undecided rather than creating something partial.
  function applyEdit(item, patch) {
    if (!patch || typeof patch !== "object") return { ok: false, error: "Nothing to change." };
    if (item.result && item.result.ok) return { ok: false, error: "This item was already created." };
    const next = Object.assign({}, item);
    if (Object.hasOwn(patch, "kind")) {
      if (patch.kind !== "event" && patch.kind !== "task") return { ok: false, error: "Choose event or task." };
      next.kind = patch.kind;
    }
    if (Object.hasOwn(patch, "title")) {
      const title = text(patch.title, 201);
      if (!title) return { ok: false, error: "Add a title." };
      if (title.length > 200) return { ok: false, error: "Use a title of 200 characters or fewer." };
      next.title = title;
    }
    if (Object.hasOwn(patch, "description")) next.description = text(patch.description, 500) || null;
    if (Object.hasOwn(patch, "date")) {
      if (patch.date !== null && !realDate(patch.date)) return { ok: false, error: "Choose a valid date." };
      next.date = patch.date;
      if (!next.date || (next.endDate && next.endDate <= next.date)) next.endDate = null;
    }
    if (Object.hasOwn(patch, "allDay")) next.allDay = patch.allDay === true;
    for (const field of ["startTime", "endTime"]) {
      if (!Object.hasOwn(patch, field)) continue;
      if (patch[field] !== null && !TIME.test(patch[field])) return { ok: false, error: "Choose a valid time." };
      next[field] = patch[field];
    }
    // Adding a clock time converts an all-day proposal into a timed event.
    if (Object.hasOwn(patch, "startTime") && next.startTime) next.allDay = false;
    if (next.kind === "task") {
      next.allDay = false;
      next.endTime = null;
      next.endDate = null;
    }
    if (next.allDay) {
      next.startTime = null;
      next.endTime = null;
    }
    if (next.startTime && next.endTime && !next.endDate && next.endTime <= next.startTime) {
      return { ok: false, error: "The end time must be after the start time." };
    }
    if (!next.startTime) next.endTime = null;
    next.edited = true;
    if (next.decision === "approved" && itemProblem(next)) next.decision = "pending";
    if (next.result && !next.result.ok) next.result = null;
    return { ok: true, item: next };
  }

  function waiting(items) {
    return (items || []).filter((item) => item.decision === "approved" && !(item.result && item.result.ok));
  }

  function counts(items) {
    const ready = waiting(items);
    const events = ready.filter((item) => item.kind === "event").length;
    return { events: events, tasks: ready.length - events, total: ready.length };
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  function createLabel(items) {
    const tally = counts(items);
    const retrying = waiting(items).some((item) => item.result && !item.result.ok);
    const verb = retrying ? "Retry" : "Create";
    if (tally.total === 0) return "Create Approved Items";
    if (tally.tasks === 0) return verb + " " + tally.events + " Approved Event" + (tally.events === 1 ? "" : "s");
    if (tally.events === 0) return verb + " " + tally.tasks + " Approved Task" + (tally.tasks === 1 ? "" : "s");
    return verb + " " + plural(tally.events, "Event") + " and " + plural(tally.tasks, "Task");
  }

  function sourceNote(item, fileName) {
    const place = fileName ? "From " + fileName + (item.sourcePage ? ", page " + item.sourcePage : "") + "." : "";
    return [text(item.description, 500), place].filter(Boolean).join("\n\n");
  }

  // Google Calendar insert body. The id is fixed when the item is proposed, so
  // a retry finds the same event instead of making a second one.
  function eventBody(item, fileName, timeZone, schedule) {
    if (item.kind !== "event" || itemProblem(item)) return null;
    const description = [sourceNote(item, fileName), "Created by QuickCalAI."].filter(Boolean).join("\n\n");
    const body = {
      id: item.eventId,
      summary: item.title,
      description: description,
      reminders: { useDefault: true },
    };
    if (item.allDay) {
      body.start = { date: item.date };
      body.end = { date: nextDay(item.endDate || item.date) };
      return body;
    }
    const end = effectiveEnd(item);
    const prepared = schedule.prepareForSave({
      title: item.title,
      date: item.date,
      endDate: end.endDate,
      startTime: item.startTime,
      endTime: end.endTime,
      timeZone: timeZone,
      location: null,
      recurrence: null,
      reminders: { useDefault: true, overrides: [] },
      durationDefaulted: false,
      needsClarification: false,
    });
    if (!prepared) return null;
    body.start = { dateTime: prepared.startDateTime, timeZone: timeZone };
    body.end = { dateTime: prepared.endDateTime, timeZone: timeZone };
    return body;
  }

  // Google Tasks keeps only a due date, so the caller passes the title with
  // any stated time already added. The reference line lets a retry recognize
  // a task that was already saved.
  function taskBody(item, fileName, titleWithTime) {
    if (item.kind !== "task" || itemProblem(item)) return null;
    const notes = [
      sourceNote(item, fileName),
      "Created by QuickCalAI (ref " + item.ref + ").",
    ].filter(Boolean).join("\n\n");
    const body = { title: titleWithTime || item.title, notes: notes };
    if (item.date) body.due = item.date + "T00:00:00.000Z";
    return body;
  }

  root.QuickCalDocuments = {
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_ITEMS: MAX_ITEMS,
    TYPES: TYPES,
    fileKind: fileKind,
    checkFile: checkFile,
    formatSize: formatSize,
    randomId: randomId,
    sanitizeItems: sanitizeItems,
    mergeDecisions: mergeDecisions,
    itemProblem: itemProblem,
    effectiveEnd: effectiveEnd,
    decide: decide,
    applyEdit: applyEdit,
    waiting: waiting,
    counts: counts,
    createLabel: createLabel,
    eventBody: eventBody,
    taskBody: taskBody,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
