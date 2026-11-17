import { MAX_TEXT_LENGTH } from "./config.js";
import { normalizeCurrentEvent, normalizeDraft, normalizeRecurrence, normalizeReminderChange } from "./schedule.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EVENT_FIELDS = [
  "kind",
  "description",
  "title",
  "date",
  "endDate",
  "startTime",
  "endTime",
  "allDay",
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
const INTENTS = ["create", "edit", "move", "delete", "find", "clarify", "availability"];
const CALENDAR_INTENTS = ["move", "delete", "find", "clarify", "availability"];
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
  "durationMinutes",
  "windowStart",
  "windowEnd",
  "preference",
  "searchEndDate",
  "readOnly",
];
const CONTEXT_FIELDS = OPERATION_FIELDS.concat(["intent", "missing", "prompt", "candidates"]);
const PREFERENCES = ["morning", "afternoon", "evening", "later"];
const KINDS = ["event", "task"];
// A task is due on a date, so questions about an event's schedule do not apply.
const SCHEDULE_QUESTION = /\b(date|time|when|what day|which day|start|end|duration|how long)\b/i;
export const RECURRING_TASK_QUESTION =
  "QuickCalAI can't create repeating Google Tasks yet. Should this be a repeating calendar event instead?";

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
  const batch = body.batch === true;
  const batchContext = normalizeBatchContext(body.batchContext);
  if (!batchContext.ok) return batchContext;
  if (batch && batchContext.batchContext) {
    return { ok: false, error: "A batch extraction cannot also include batch follow-up context." };
  }
  const current = normalizeCurrentEvent(body.currentEvent, timeZone);
  if (!current.ok) return current;
  const clarification = normalizeClarification(body.clarification, timeZone);
  if (!clarification.ok) return clarification;
  const operation = normalizeOperationContext(body.operation);
  if (!operation.ok) return operation;
  if (batch || batchContext.batchContext) {
    if (current.event || clarification.clarification || operation.operation) {
      return { ok: false, error: "A batch request cannot also edit another event." };
    }
    return {
      ok: true,
      text,
      timeZone,
      currentEvent: null,
      clarification: null,
      operation: null,
      batch: batch,
      batchContext: batchContext.batchContext,
    };
  }
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
    batch: false,
    batchContext: null,
  };
}

function normalizeBatchContext(value) {
  if (value == null) return { ok: true, batchContext: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Batch context is not valid." };
  }
  if (typeof value.sourceText !== "string" || !value.sourceText.trim() || value.sourceText.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: "Batch context is not valid." };
  }
  if (value.targetRef != null && (typeof value.targetRef !== "string" || !/^e([1-9]|10)$/.test(value.targetRef))) {
    return { ok: false, error: "Batch context is not valid." };
  }
  if (!Array.isArray(value.drafts) || value.drafts.length === 0 || value.drafts.length > 10) {
    return { ok: false, error: "Batch context is not valid." };
  }
  const drafts = [];
  for (const draft of value.drafts) {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      return { ok: false, error: "Batch context is not valid." };
    }
    if (typeof draft.ref !== "string" || !/^e([1-9]|10)$/.test(draft.ref)) {
      return { ok: false, error: "Batch context is not valid." };
    }
    const title = nullableText(draft.title, 200);
    const date = optionalDate(draft.date == null ? null : draft.date);
    const startTime = optionalTime(draft.startTime == null ? null : draft.startTime);
    const endTime = optionalTime(draft.endTime == null ? null : draft.endTime);
    const location = nullableText(draft.location, 200);
    const missingText = nullableText(draft.missingText, 240);
    if (!title.ok || !date.ok || !startTime.ok || !endTime.ok || !location.ok || !missingText.ok) {
      return { ok: false, error: "Batch context is not valid." };
    }
    if (typeof draft.selected !== "boolean" || typeof draft.complete !== "boolean") {
      return { ok: false, error: "Batch context is not valid." };
    }
    drafts.push({
      ref: draft.ref,
      title: title.value,
      date: date.value,
      startTime: startTime.value,
      endTime: endTime.value,
      location: location.value,
      selected: draft.selected,
      complete: draft.complete,
      missingText: missingText.value || "",
    });
  }
  return {
    ok: true,
    batchContext: {
      sourceText: value.sourceText.trim(),
      targetRef: value.targetRef || null,
      drafts: drafts,
    },
  };
}

function nullableText(value, maxLength) {
  if (value == null) return { ok: true, value: null };
  return optionalText(value, maxLength);
}

function optionalDuration(value) {
  if (value == null) return { ok: true, value: null };
  if (!Number.isInteger(value) || value < 5 || value > 480) return { ok: false };
  return { ok: true, value: value };
}

function optionalPreference(value) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const key = value.trim().toLowerCase();
  if (!PREFERENCES.includes(key)) return { ok: false };
  return { ok: true, value: key };
}

function optionalReadOnly(value) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "boolean") return { ok: false };
  return { ok: true, value: value };
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
  const durationMinutes = optionalDuration(raw.durationMinutes);
  const windowStart = optionalTime(raw.windowStart);
  const windowEnd = optionalTime(raw.windowEnd);
  const preference = optionalPreference(raw.preference);
  const searchEndDate = optionalDate(raw.searchEndDate);
  const readOnly = optionalReadOnly(raw.readOnly);
  if (
    !target.ok ||
    !searchDate.ok ||
    !searchTime.ok ||
    !destinationDate.ok ||
    !destinationTime.ok ||
    !destinationEndTime.ok ||
    !durationMinutes.ok ||
    !windowStart.ok ||
    !windowEnd.ok ||
    !preference.ok ||
    !searchEndDate.ok ||
    !readOnly.ok
  ) {
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
      durationMinutes: durationMinutes.value,
      windowStart: windowStart.value,
      windowEnd: windowEnd.value,
      preference: preference.value,
      searchEndDate: searchEndDate.value,
      readOnly: readOnly.value,
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
    durationMinutes: Object.hasOwn(value, "durationMinutes") ? value.durationMinutes : null,
    windowStart: Object.hasOwn(value, "windowStart") ? value.windowStart : null,
    windowEnd: Object.hasOwn(value, "windowEnd") ? value.windowEnd : null,
    preference: Object.hasOwn(value, "preference") ? value.preference : null,
    searchEndDate: Object.hasOwn(value, "searchEndDate") ? value.searchEndDate : null,
    readOnly: Object.hasOwn(value, "readOnly") ? value.readOnly : null,
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
  const optionalFields = [
    "kind",
    "description",
    "endDate",
    "allDay",
    "notificationAction",
    "notificationOverrides",
  ];
  const requiredFields = EVENT_FIELDS.filter((field) => !optionalFields.includes(field));
  if (requiredFields.some((field) => !Object.hasOwn(raw, field))) return failure;
  if (keys.some((key) => !EVENT_FIELDS.includes(key))) return failure;

  const kind = raw.kind == null ? "event" : raw.kind;
  if (!KINDS.includes(kind)) return failure;
  const description = optionalText(raw.description == null ? null : raw.description, 1000);
  if (!description.ok) return failure;
  const title = optionalText(raw.title, 200);
  const date = optionalDate(raw.date);
  const endDate = optionalDate(Object.hasOwn(raw, "endDate") ? raw.endDate : null);
  const startTime = optionalTime(raw.startTime);
  const endTime = optionalTime(raw.endTime);
  const location = optionalText(raw.location, 200);
  const recurrence = normalizeRecurrence(raw.recurrence);
  const notification = normalizeReminderChange(raw.notificationAction, raw.notificationOverrides);
  const operation = normalizeModelOperation(raw.operation);
  if (!title.ok || !date.ok || !endDate.ok || !startTime.ok || !endTime.ok || !location.ok || !recurrence.ok || !notification.ok || !operation.ok) {
    return failure;
  }
  if (!INTENTS.includes(raw.intent)) return failure;
  const calendarIntent = CALENDAR_INTENTS.includes(raw.intent);
  if (typeof requestedTimeZone !== "string" || !isValidTimeZone(requestedTimeZone)) return failure;
  if (typeof raw.timeZone !== "string" || !isValidTimeZone(raw.timeZone)) return failure;
  if (typeof raw.needsClarification !== "boolean") return failure;
  if (typeof raw.allDay !== "boolean" && raw.allDay != null) return failure;
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

  if (kind === "task" && (raw.intent === "create" || raw.intent === "edit")) {
    return validatedTask(raw, title.value, description.value, date.value, startTime.value, recurrence.recurrence, questions, operation.operation);
  }

  let needsClarification = raw.needsClarification;
  let allDay = raw.allDay === true;
  let inclusiveEnd = endDate.value;
  if (inclusiveEnd && date.value && inclusiveEnd < date.value) {
    needsClarification = true;
    inclusiveEnd = null;
    addQuestion(questions, "What start and end dates should this event use?");
  }
  if (inclusiveEnd && date.value && inclusiveEnd === date.value) inclusiveEnd = null;
  const weekly = recurrence.recurrence && (recurrence.recurrence.frequency === "dates"
    ? recurrence.recurrence.dates.length > 0 : recurrence.recurrence.weekdays.length > 0);
  if (!calendarIntent && !date.value && !weekly) {
    needsClarification = true;
    addQuestion(questions, "What date should this event use?");
  }
  // Date without a usable start time becomes an all-day create. Timed
  // preferences/durations are handled later in applySchedule.
  if (!calendarIntent && !startTime.value && date.value) {
    allDay = true;
  } else if (!calendarIntent && !startTime.value && weekly) {
    // Weekly series still need a shared clock time.
    needsClarification = true;
    addQuestion(questions, "What time does this event start?");
  }
  if (allDay) {
    // Drop start-time questions that conflict with the all-day default.
    for (let index = questions.length - 1; index >= 0; index -= 1) {
      if (/what time does this event start/i.test(questions[index])) questions.splice(index, 1);
    }
  }
  if (raw.intent === "clarify") {
    needsClarification = true;
    if (questions.length === 0) addQuestion(questions, "What should I change?");
  }
  if (raw.intent === "availability" && !operation.operation.searchDate) {
    needsClarification = true;
    addQuestion(questions, "What day should I check?");
  }
  if (!allDay && startTime.value && endTime.value && endTime.value <= startTime.value) {
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
      endDate: inclusiveEnd,
      startTime: allDay ? null : startTime.value,
      endTime: allDay ? null : endTime.value,
      allDay: allDay,
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

// A Google Task has a title and an optional due date. The startTime field holds
// a due time only when the user stated one; it is never filled in.
function validatedTask(raw, title, description, date, dueTime, recurrence, modelQuestions, operation) {
  const questions = modelQuestions.filter((question) => !SCHEDULE_QUESTION.test(question));
  if (!title) addQuestion(questions, "What should the task be called?");
  if (recurrence) addQuestion(questions, RECURRING_TASK_QUESTION);
  return {
    ok: true,
    event: {
      kind: "task",
      description: description,
      title: title,
      date: date,
      endDate: null,
      startTime: dueTime,
      endTime: null,
      allDay: false,
      timeZone: raw.timeZone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      needsClarification: questions.length > 0,
      clarificationQuestions: questions,
      intent: raw.intent,
      operation: operation,
    },
  };
}

export function validateBatchEvent(raw, requestedTimeZone, ref) {
  const failure = { ok: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure;
  if (typeof raw.ref !== "string" || raw.ref !== ref) return failure;
  const title = optionalText(raw.title, 200);
  const date = optionalDate(raw.date);
  const endDate = optionalDate(Object.hasOwn(raw, "endDate") ? raw.endDate : null);
  const startTime = optionalTime(raw.startTime);
  const endTime = optionalTime(raw.endTime);
  const location = optionalText(raw.location, 200);
  const recurrence = normalizeRecurrence(raw.recurrence);
  const notification = normalizeReminderChange(raw.notificationAction, raw.notificationOverrides);
  if (!title.ok || !date.ok || !endDate.ok || !startTime.ok || !endTime.ok || !location.ok || !recurrence.ok || !notification.ok) {
    return failure;
  }
  if (typeof raw.timeZone !== "string" || !isValidTimeZone(raw.timeZone)) return failure;
  if (typeof requestedTimeZone !== "string" || !isValidTimeZone(requestedTimeZone)) return failure;
  if (typeof raw.needsClarification !== "boolean") return failure;
  if (typeof raw.allDay !== "boolean" && raw.allDay != null) return failure;
  if (!Array.isArray(raw.clarificationQuestions) || raw.clarificationQuestions.length > 8) return failure;
  const questions = [];
  for (const question of raw.clarificationQuestions) {
    if (typeof question !== "string") return failure;
    const trimmed = question.trim();
    if (!trimmed) continue;
    if (trimmed.length > 240) return failure;
    addQuestion(questions, trimmed);
  }
  let needsClarification = raw.needsClarification;
  let allDay = raw.allDay === true;
  let inclusiveEnd = endDate.value;
  if (inclusiveEnd && date.value && inclusiveEnd < date.value) {
    needsClarification = true;
    inclusiveEnd = null;
    addQuestion(questions, "What start and end dates should this event use?");
  }
  if (inclusiveEnd && date.value && inclusiveEnd === date.value) inclusiveEnd = null;
  if (!date.value) {
    needsClarification = true;
    addQuestion(questions, "What date should this event use?");
  }
  if (!startTime.value && date.value) {
    allDay = true;
    for (let index = questions.length - 1; index >= 0; index -= 1) {
      if (/what time does this event start/i.test(questions[index])) questions.splice(index, 1);
    }
  } else if (!startTime.value) {
    needsClarification = true;
    addQuestion(questions, "What time does this event start?");
  }
  if (!allDay && startTime.value && endTime.value && endTime.value <= startTime.value) {
    needsClarification = true;
    addQuestion(questions, "The end time is not later than the start time on the same day. What times should this event use?");
  }
  if (needsClarification && questions.length === 0) {
    addQuestion(questions, "What should be clarified about this event?");
  }
  return {
    ok: true,
    event: {
      ref: ref,
      title: title.value,
      date: date.value,
      endDate: inclusiveEnd,
      startTime: allDay ? null : startTime.value,
      endTime: allDay ? null : endTime.value,
      allDay: allDay,
      timeZone: raw.timeZone,
      location: location.value,
      recurrence: recurrence.recurrence,
      notificationAction: notification.action,
      notificationOverrides: notification.overrides,
      needsClarification,
      clarificationQuestions: questions,
      intent: "create",
      operation: {
        target: null,
        searchDate: null,
        searchTime: null,
        destinationDate: null,
        destinationTime: null,
        destinationEndTime: null,
        scope: "occurrence",
        selection: [],
        durationMinutes: null,
        windowStart: null,
        windowEnd: null,
        preference: null,
        searchEndDate: null,
        readOnly: null,
      },
    },
  };
}

export function validateBatchExtraction(raw, requestedTimeZone) {
  const failure = { ok: false, error: "The model returned a batch that failed validation." };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure;
  if (raw.kind !== "batch" || typeof raw.tooMany !== "boolean") return failure;
  if (raw.message != null && (typeof raw.message !== "string" || raw.message.length > 300)) return failure;
  if (!Array.isArray(raw.events)) return failure;
  if (raw.tooMany) {
    return {
      ok: true,
      batch: {
        kind: "batch",
        tooMany: true,
        message:
          typeof raw.message === "string" && raw.message.trim()
            ? raw.message.trim()
            : "That selection looks like more than 10 events. Highlight a smaller passage and try again.",
        events: [],
      },
    };
  }
  if (raw.events.length > 10) return failure;
  const events = [];
  const seen = Object.create(null);
  for (let index = 0; index < raw.events.length; index += 1) {
    const expected = "e" + String(index + 1);
    const item = validateBatchEvent(raw.events[index], requestedTimeZone, expected);
    if (!item.ok) return failure;
    if (seen[expected]) return failure;
    seen[expected] = true;
    events.push(item.event);
  }
  return {
    ok: true,
    batch: {
      kind: "batch",
      tooMany: false,
      message: raw.message == null || !String(raw.message).trim() ? null : String(raw.message).trim(),
      events: events,
    },
  };
}

export function validateBatchFollowup(raw, requestedTimeZone) {
  const failure = { ok: false, error: "The model returned a batch follow-up that failed validation." };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure;
  if (raw.kind !== "batch-followup") return failure;
  if (!["update", "skip", "ambiguous", "none"].includes(raw.action)) return failure;
  if (raw.ref != null && (typeof raw.ref !== "string" || !/^e([1-9]|10)$/.test(raw.ref))) return failure;
  if (raw.question != null && (typeof raw.question !== "string" || raw.question.length > 240)) return failure;
  let event = null;
  if (raw.event != null) {
    if (!raw.ref) return failure;
    const item = validateBatchEvent(raw.event, requestedTimeZone, raw.ref);
    if (!item.ok) return failure;
    event = item.event;
  }
  return {
    ok: true,
    followup: {
      kind: "batch-followup",
      action: raw.action,
      ref: raw.ref || null,
      question: raw.question == null || !String(raw.question).trim() ? null : String(raw.question).trim(),
      event: event,
    },
  };
}
