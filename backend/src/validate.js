import { MAX_TEXT_LENGTH } from "./config.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EVENT_FIELDS = [
  "title",
  "date",
  "startTime",
  "endTime",
  "timeZone",
  "location",
  "needsClarification",
  "clarificationQuestions",
];

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
  return { ok: true, text, timeZone };
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
  if (EVENT_FIELDS.some((field) => !Object.hasOwn(raw, field))) return failure;
  if (keys.some((key) => !EVENT_FIELDS.includes(key))) return failure;

  const title = optionalText(raw.title, 200);
  const date = optionalDate(raw.date);
  const startTime = optionalTime(raw.startTime);
  const endTime = optionalTime(raw.endTime);
  const location = optionalText(raw.location, 200);
  if (!title.ok || !date.ok || !startTime.ok || !endTime.ok || !location.ok) return failure;
  if (typeof raw.timeZone !== "string" || raw.timeZone !== requestedTimeZone) return failure;
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
  if (!date.value) {
    needsClarification = true;
    addQuestion(questions, "What date should this event use?");
  }
  if (!startTime.value) {
    needsClarification = true;
    addQuestion(questions, "What time does this event start?");
  }
  if (!endTime.value) {
    needsClarification = true;
    addQuestion(questions, "What time does this event end?");
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
      timeZone: requestedTimeZone,
      location: location.value,
      needsClarification,
      clarificationQuestions: questions,
    },
  };
}
