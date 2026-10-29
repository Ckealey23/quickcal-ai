import { MAX_TEXT_LENGTH } from "./config.js";
import { normalizeCurrentEvent, normalizeDraft, normalizeRecurrence, normalizeReminderChange } from "./schedule.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EVENT_FIELDS = [
  "title",
  "date",
  "startTime",
  "endTime",
  "timeZone",
  "location",
  "recurrence",
  "notificationAction",
  "notificationOverrides",
  "needsClarification",
  "clarificationQuestions",
  "intent",
  "operation",
];
const INTENTS = ["create", "edit", "move", "delete", "find", "clarify"];
const CALENDAR_INTENTS = ["move", "delete", "find", "clarify"];
const SCOPES = ["occurrence", "series", "unsupported"];
const OPERATION_FIELDS = [
  "target",
  "searchDate",
  "searchTime",
  "destinationDate",
  "destinationTime",
  "destinationEndTime",
  "scope",
  "selection",
];
const CONTEXT_FIELDS = OPERATION_FIELDS.concat(["intent", "missing", "prompt", "candidates"]);

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string") return false;
  const name = timeZone.trim();
  if (!name || name.length > 100) return false;
  let resolved = "";
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch (error) {
    return false;
  }
  // Abbreviations such as PST resolve to a different zone. Accept the
  // canonical name, or an IANA name that contains a region slash.
  if (resolved === name) return true;
  return name.includes("/");
}

export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  if (typeof body.text !== "string") {
    return { ok: false, error: "Text must be a string." };
  }
  const text = body.text.trim();
  if (!text) return { ok: false, error: "Text is required." };
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: "Text must be " + MAX_TEXT_LENGTH + " characters or fewer." };
  }
  if (typeof body.timeZone !== "string") {
    return { ok: false, error: "Time zone must be a string." };
  }
  const timeZone = body.timeZone.trim();
  if (!timeZone) return { ok: false, error: "Time zone is required." };
  if (!isValidTimeZone(timeZone)) {
    return { ok: false, error: "Time zone must be a valid IANA time zone." };
  }
  const current = normalizeCurrentEvent(body.currentEvent, timeZone);
  if (!current.ok) return current;
  const clarification = normalizeClarification(body.clarification, timeZone);
  if (!clarification.ok) return clarification;
  const operation = normalizeOperationContext(body.operation);
  if (!operation.ok) return operation;
  if (current.event && clarification.clarification) {
    return { ok: false, error: "A clarification answer cannot edit a saved event." };
  }
  if (operation.operation && (current.event || clarification.clarification)) {
    return { ok: false, error: "A calendar follow-up cannot also edit another event." };
  }
  return {
    ok: true,
    text,
    timeZone,
    currentEvent: current.event,
    clarification: clarification.clarification,
    operation: operation.operation,
  };
}

function nullableText(value, maxLength) {
  if (value == null) return { ok: true, value: null };
  return optionalText(value, maxLength);
}

function normalizeModelOperation(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const keys = Object.keys(raw);
  if (OPERATION_FIELDS.some((field) => !Object.hasOwn(raw, field))) return { ok: false };
  if (keys.some((key) => !OPERATION_FIELDS.includes(key))) return { ok: false };
  const target = nullableText(raw.target, 200);
  const searchDate = optionalDate(raw.searchDate);
  const searchTime = optionalTime(raw.searchTime);
  const destinationDate = optionalDate(raw.destinationDate);
  const destinationTime = optionalTime(raw.destinationTime);
  const destinationEndTime = optionalTime(raw.destinationEndTime);
  if (!target.ok || !searchDate.ok || !searchTime.ok || !destinationDate.ok || !destinationTime.ok || !destinationEndTime.ok) {
    return { ok: false };
  }
  if (!SCOPES.includes(raw.scope)) return { ok: false };
  if (!Array.isArray(raw.selection) || raw.selection.length > 8) return { ok: false };
  const selection = [];
  for (const item of raw.selection) {
    if (typeof item !== "string" || !/^(?:all|c[1-8])$/.test(item)) return { ok: false };
    if (!selection.includes(item)) selection.push(item);
  }
  if (selection.includes("all") && selection.length > 1) return { ok: false };
  return {
    ok: true,
    operation: {
      target: target.value,
      searchDate: searchDate.value,
      searchTime: searchTime.value,
      destinationDate: destinationDate.value,
      destinationTime: destinationTime.value,
      destinationEndTime: destinationEndTime.value,
      scope: raw.scope,
      selection: selection,
    },
  };
}

export function normalizeOperationContext(value) {
  if (value == null) return { ok: true, operation: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Operation context is not valid." };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !CONTEXT_FIELDS.includes(key))) {
    return { ok: false, error: "Operation context is not valid." };
  }
  if (!CALENDAR_INTENTS.includes(value.intent)) {
    return { ok: false, error: "Operation context is not valid." };
  }
  const model = normalizeModelOperation({
    target: Object.hasOwn(value, "target") ? value.target : null,
    searchDate: Object.hasOwn(value, "searchDate") ? value.searchDate : null,
    searchTime: Object.hasOwn(value, "searchTime") ? value.searchTime : null,
    destinationDate: Object.hasOwn(value, "destinationDate") ? value.destinationDate : null,
    destinationTime: Object.hasOwn(value, "destinationTime") ? value.destinationTime : null,
    destinationEndTime: Object.hasOwn(value, "destinationEndTime") ? value.destinationEndTime : null,
    scope: value.scope || "occurrence",
    selection: Array.isArray(value.selection) ? value.selection : [],
  });
  if (!model.ok) return { ok: false, error: "Operation context is not valid." };
  const missing = nullableText(Object.hasOwn(value, "missing") ? value.missing : null, 40);
  const prompt = nullableText(Object.hasOwn(value, "prompt") ? value.prompt : null, 240);
  if (!missing.ok || !prompt.ok) return { ok: false, error: "Operation context is not valid." };
  if (value.candidates != null && (!Array.isArray(value.candidates) || value.candidates.length > 8)) {
    return { ok: false, error: "Operation context is not valid." };
  }
  const candidates = [];
  for (const candidate of value.candidates || []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, error: "Operation context is not valid." };
    }
    if (Object.keys(candidate).some((key) => key !== "ref" && key !== "label")) {
      return { ok: false, error: "Operation context is not valid." };
    }
    if (typeof candidate.ref !== "string" || !/^c[1-8]$/.test(candidate.ref)) {
      return { ok: false, error: "Operation context is not valid." };
    }
    const label = nullableText(candidate.label, 180);
    if (!label.ok || !label.value) return { ok: false, error: "Operation context is not valid." };
    candidates.push({ ref: candidate.ref, label: label.value });
  }
  return {
    ok: true,
    operation: Object.assign({}, model.operation, {
      intent: value.intent,
      missing: missing.value,
      prompt: prompt.value,
      candidates: candidates,
    }),
  };
}

function normalizeClarification(value, timeZone) {
  if (value == null) return { ok: true, clarification: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Clarification must be an object." };
  }
  if (typeof value.originalText !== "string") {
    return { ok: false, error: "Clarification is not valid." };
  }
  const originalText = value.originalText.trim();
  if (!originalText || originalText.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: "Clarification is not valid." };
  }
  const draft = normalizeDraft(value.draft, timeZone);
  if (!draft.ok) return { ok: false, error: "Clarification is not valid." };
  return { ok: true, clarification: { originalText: originalText, draft: draft.event } };
}

export function isRealDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isRealTime(value) {
  return TIME_PATTERN.test(value);
}

function optionalText(value, maxLength) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > maxLength) return { ok: false };
  return { ok: true, value: trimmed };
}

function optionalDate(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !isRealDate(value.trim()) || value.trim() !== value) {
    return { ok: false };
  }
  return { ok: true, value };
}

function optionalTime(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !isRealTime(value)) return { ok: false };
  return { ok: true, value };
}

function addQuestion(questions, question) {
  if (!questions.includes(question)) questions.push(question);
}

export function validateExtraction(raw, requestedTimeZone) {
  const failure = { ok: false, error: "The model returned an event that failed validation." };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure;
  const keys = Object.keys(raw);
  const requiredFields = EVENT_FIELDS.filter((field) => field !== "notificationAction" && field !== "notificationOverrides");
  if (requiredFields.some((field) => !Object.hasOwn(raw, field))) return failure;
  if (keys.some((key) => !EVENT_FIELDS.includes(key))) return failure;

  const title = optionalText(raw.title, 200);
  const date = optionalDate(raw.date);
  const startTime = optionalTime(raw.startTime);
  const endTime = optionalTime(raw.endTime);
  const location = optionalText(raw.location, 200);
  const recurrence = normalizeRecurrence(raw.recurrence);
  const notification = normalizeReminderChange(raw.notificationAction, raw.notificationOverrides);
  const operation = normalizeModelOperation(raw.operation);
  if (!title.ok || !date.ok || !startTime.ok || !endTime.ok || !location.ok || !recurrence.ok || !notification.ok || !operation.ok) {
    return failure;
  }
  if (!INTENTS.includes(raw.intent)) return failure;
  const calendarIntent = CALENDAR_INTENTS.includes(raw.intent);
  if (typeof requestedTimeZone !== "string" || !isValidTimeZone(requestedTimeZone)) return failure;
  if (typeof raw.timeZone !== "string" || !isValidTimeZone(raw.timeZone)) return failure;
  if (typeof raw.needsClarification !== "boolean") return failure;
  if (!Array.isArray(raw.clarificationQuestions) || raw.clarificationQuestions.length > 8) {
    return failure;
  }

  const questions = [];
  for (const question of raw.clarificationQuestions) {
    if (typeof question !== "string") return failure;
    const trimmed = question.trim();
    if (!trimmed) continue;
    if (trimmed.length > 240) return failure;
    addQuestion(questions, trimmed);
  }

  let needsClarification = raw.needsClarification;
  const weekly = recurrence.recurrence && recurrence.recurrence.weekdays.length > 0;
  if (!calendarIntent && !date.value && !weekly) {
    needsClarification = true;
    addQuestion(questions, "What date should this event use?");
  }
  if (!calendarIntent && !startTime.value) {
    needsClarification = true;
    addQuestion(questions, "What time does this event start?");
  }
  if (raw.intent === "clarify") {
    needsClarification = true;
    if (questions.length === 0) addQuestion(questions, "What should I change?");
  }
  if (startTime.value && endTime.value && endTime.value <= startTime.value) {
    needsClarification = true;
    addQuestion(
      questions,
      "The end time is not later than the start time on the same day. What times should this event use?"
    );
  }
  if (needsClarification && questions.length === 0) {
    addQuestion(questions, "What should be clarified about this event?");
  }

  return {
    ok: true,
    event: {
      title: title.value,
      date: date.value,
      startTime: startTime.value,
      endTime: endTime.value,
      timeZone: raw.timeZone,
      location: location.value,
      recurrence: recurrence.recurrence,
      notificationAction: notification.action,
      notificationOverrides: notification.overrides,
      needsClarification,
      clarificationQuestions: questions,
      intent: raw.intent,
      operation: operation.operation,
    },
  };
}
