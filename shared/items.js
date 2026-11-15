(function (root) {
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_DOCUMENT_CHARS = 100000;
  const MAX_ITEMS = 50;
  function realDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const date = new Date(value + "T12:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function realTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(value || ""); }
  function validZone(value) {
    try {
      if (typeof value !== "string" || !value || value.length > 100) return false;
      const resolved = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
      return value === resolved || value.includes("/");
    }
    catch (_) { return false; }
  }
  function normalize(raw) {
    if (!raw || !["event", "task"].includes(raw.kind)) throw new Error("Choose event or task.");
    const item = {};
    for (const [key, limit] of Object.entries({ title: 200, description: 4000, category: 120, sourceContext: 1500, uncertainty: 1000, location: 200 })) {
      const value = raw[key] == null ? "" : raw[key];
      if (typeof value !== "string" || value.length > limit) throw new Error("Invalid " + key + ".");
      item[key] = value.trim();
    }
    for (const key of ["date", "endDate"]) {
      const value = raw[key] == null || raw[key] === "" ? null : raw[key];
      if (value !== null && !realDate(value)) throw new Error("Enter a valid date.");
      item[key] = value;
    }
    for (const key of ["startTime", "endTime"]) {
      const value = raw[key] == null || raw[key] === "" ? null : raw[key];
      if (value !== null && !realTime(value)) throw new Error("Enter a valid time.");
      item[key] = value;
    }
    if (!validZone(raw.timeZone)) throw new Error("Choose a valid IANA time zone.");
    item.kind = raw.kind;
    if (raw.needsClarification && !item.uncertainty) {
      item.uncertainty = (raw.clarificationQuestions || []).filter(question => !/what date|what time|start time|end time|date and time/i.test(question)).join(" ").slice(0, 1000);
    }
    item.timeZone = raw.timeZone;
    item.allDay = raw.allDay === true;
    item.recurrence = raw.recurrence || null;
    item.reminders = raw.reminders || null;
    item.durationDefaulted = raw.durationDefaulted === true;
    item.needsClarification = false;
    item.clarificationQuestions = [];
    return item;
  }
  function problem(item) {
    if (!item.title) return "Add a title.";
    if (item.uncertainty) return "Resolve the source uncertainty before approving.";
    if (item.kind === "task") {
      if (item.recurrence) return "Recurring tasks are not supported. Choose a single deadline.";
      if (item.startTime && !item.date) return "Add a due date for the requested time.";
      return "";
    }
    if (!item.date) return "Add the event date.";
    const endDate = item.endDate || item.date;
    if (endDate < item.date) return "End date must be on or after the start date.";
    if (item.allDay) return "";
    if (!item.startTime || !item.endTime) return "Add start and end times, or explicitly choose all day.";
    const schedule = root.QuickCalSchedule;
    const start = schedule.resolveLocal(item.date, item.startTime, item.timeZone);
    const end = schedule.resolveLocal(endDate, item.endTime, item.timeZone);
    if (!start.ok || !end.ok) return "This local time is missing or ambiguous in the selected time zone.";
    if (end.epoch <= start.epoch) return "End time must be after start time.";
    return "";
  }
  function key(item) {
    return JSON.stringify([item.kind, item.title.toLocaleLowerCase().replace(/\s+/g, " "), item.date, item.endDate, item.startTime, item.endTime, item.timeZone, item.allDay]);
  }
  function timeOptions() {
    return Array.from({ length: 288 }, (_, index) => String(Math.floor(index / 12)).padStart(2, "0") + ":" + String((index % 12) * 5).padStart(2, "0"));
  }
  function fileProblem(file) {
    if (!file || !/\.(pdf|docx|txt)$/i.test(file.name || "")) return "Choose a PDF, DOCX, or TXT file.";
    if (!file.size) return "This file is empty.";
    if (file.size > MAX_FILE_BYTES) return "Choose a file of 2 MB or less.";
    return "";
  }
  root.QuickCalItems = { normalize, problem, key, realDate, realTime, validZone, timeOptions, fileProblem, MAX_FILE_BYTES, MAX_DOCUMENT_CHARS, MAX_ITEMS };
})(typeof globalThis !== "undefined" ? globalThis : self);
