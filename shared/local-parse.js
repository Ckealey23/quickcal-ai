(function (root) {
  const BACKEND_ORIGIN = root.QuickCalUseLocalBackend === true
    ? "http://127.0.0.1:3000"
    : "https://quickcal-ai.onrender.com";
  const PARSE_URL = BACKEND_ORIGIN + "/parse-event";
  const HEALTH_URL = BACKEND_ORIGIN + "/health";
  const ACCESS_URL = BACKEND_ORIGIN + "/access";
  const EXTRACT_URL = BACKEND_ORIGIN + "/extract-document";
  const ANALYZE_URL = BACKEND_ORIGIN + "/analyze-document";
  const MAX_TEXT_LENGTH = 2000;
  const TIMEOUT_MS = 35000;
  const API_VERSION = 5;

  function isValidTimeZone(timeZone) {
    if (typeof timeZone !== "string") return false;
    const name = timeZone.trim();
    if (!name || name.length > 100) return false;
    let resolved = "";
    try {
      resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    } catch (error) {
      return false;
    }
    if (resolved === name) return true;
    return name.includes("/");
  }

  function validateParseRequest(message) {
    if (!message || typeof message.text !== "string") {
      return { ok: false, error: "Text must be a string." };
    }
    const text = message.text.trim();
    if (!text) return { ok: false, error: "Text is required." };
    if (text.length > MAX_TEXT_LENGTH) {
      return { ok: false, error: "Text must be " + MAX_TEXT_LENGTH + " characters or fewer." };
    }
    if (typeof message.timeZone !== "string") {
      return { ok: false, error: "Time zone must be a string." };
    }
    const timeZone = message.timeZone.trim();
    if (!isValidTimeZone(timeZone)) {
      return { ok: false, error: "Time zone must be a valid IANA time zone." };
    }
    let currentEvent = null;
    if (message.currentEvent != null) {
      const schedule = root.QuickCalSchedule;
      if (!schedule) return { ok: false, error: "Current event is not valid." };
      const current = schedule.normalizeCurrentEvent(message.currentEvent, timeZone);
      if (!current.ok) return { ok: false, error: current.error };
      currentEvent = current.event;
    }
    let clarification = null;
    if (message.clarification != null) {
      const schedule = root.QuickCalSchedule;
      if (!schedule || !schedule.normalizeDraft) return { ok: false, error: "Clarification is not valid." };
      if (!message.clarification || typeof message.clarification.originalText !== "string") {
        return { ok: false, error: "Clarification is not valid." };
      }
      const originalText = message.clarification.originalText.trim();
      if (!originalText || originalText.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: "Clarification is not valid." };
      }
      const draft = schedule.normalizeDraft(message.clarification.draft, timeZone);
      if (!draft.ok) return { ok: false, error: "Clarification is not valid." };
      clarification = { originalText: originalText, draft: draft.event };
    }
    if (currentEvent && clarification) {
      return { ok: false, error: "A clarification answer cannot edit a saved event." };
    }
    const operation = normalizeOperationContext(message.operation);
    if (!operation.ok) return operation;
    if (operation.operation && (currentEvent || clarification)) {
      return { ok: false, error: "A calendar follow-up cannot also edit another event." };
    }
    const batch = message.batch === true;
    const batchContext = normalizeBatchContext(message.batchContext, timeZone);
    if (!batchContext.ok) return batchContext;
    if (batch && batchContext.batchContext) {
      return { ok: false, error: "A batch extraction cannot also include batch follow-up context." };
    }
    if (batch || batchContext.batchContext) {
      if (currentEvent || clarification || operation.operation) {
        return { ok: false, error: "A batch request cannot also edit another event." };
      }
      return {
        ok: true,
        text: text,
        timeZone: timeZone,
        currentEvent: null,
        clarification: null,
        operation: null,
        batch: batch,
        batchContext: batchContext.batchContext,
      };
    }
    return {
      ok: true,
      text: text,
      timeZone: timeZone,
      currentEvent: currentEvent,
      clarification: clarification,
      operation: operation.operation,
      batch: false,
      batchContext: null,
    };
  }

  function normalizeBatchContext(value, timeZone) {
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
    for (let index = 0; index < value.drafts.length; index += 1) {
      const draft = value.drafts[index];
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        return { ok: false, error: "Batch context is not valid." };
      }
      if (typeof draft.ref !== "string" || !/^e([1-9]|10)$/.test(draft.ref)) {
        return { ok: false, error: "Batch context is not valid." };
      }
      if (typeof draft.selected !== "boolean" || typeof draft.complete !== "boolean") {
        return { ok: false, error: "Batch context is not valid." };
      }
      drafts.push({
        ref: draft.ref,
        title: draft.title == null ? null : String(draft.title).trim() || null,
        date: draft.date == null ? null : draft.date,
        startTime: draft.startTime == null ? null : draft.startTime,
        endTime: draft.endTime == null ? null : draft.endTime,
        location: draft.location == null ? null : String(draft.location).trim() || null,
        selected: draft.selected,
        complete: draft.complete,
        missingText: draft.missingText == null ? "" : String(draft.missingText).trim(),
      });
    }
    return {
      ok: true,
      batchContext: {
        sourceText: value.sourceText.trim(),
        targetRef: value.targetRef || null,
        drafts: drafts,
        timeZone: timeZone,
      },
    };
  }

  function nullableContextText(value, maxLength) {
    if (value == null) return { ok: true, value: null };
    if (typeof value !== "string") return { ok: false };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: null };
    if (trimmed.length > maxLength) return { ok: false };
    return { ok: true, value: trimmed };
  }

  function contextDate(value) {
    if (value == null) return { ok: true, value: null };
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false };
    return { ok: true, value: value };
  }

  function contextTime(value) {
    if (value == null) return { ok: true, value: null };
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return { ok: false };
    return { ok: true, value: value };
  }

  function contextDuration(value) {
    if (value == null) return { ok: true, value: null };
    if (!Number.isInteger(value) || value < 5 || value > 480) return { ok: false };
    return { ok: true, value: value };
  }

  function contextPreference(value) {
    if (value == null) return { ok: true, value: null };
    if (typeof value !== "string") return { ok: false };
    const key = value.trim().toLowerCase();
    if (["morning", "afternoon", "evening", "later"].indexOf(key) === -1) return { ok: false };
    return { ok: true, value: key };
  }

  function contextReadOnly(value) {
    if (value == null) return { ok: true, value: null };
    if (typeof value !== "boolean") return { ok: false };
    return { ok: true, value: value };
  }

  function normalizeOperationContext(value) {
    if (value == null) return { ok: true, operation: null };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Operation context is not valid." };
    }
    const allowed = [
      "intent",
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
      "missing",
      "prompt",
      "candidates",
    ];
    if (Object.keys(value).some((key) => allowed.indexOf(key) === -1)) {
      return { ok: false, error: "Operation context is not valid." };
    }
    if (["move", "delete", "find", "clarify", "availability"].indexOf(value.intent) === -1) {
      return { ok: false, error: "Operation context is not valid." };
    }
    if (["occurrence", "series", "unsupported"].indexOf(value.scope || "occurrence") === -1) {
      return { ok: false, error: "Operation context is not valid." };
    }
    const target = nullableContextText(value.target, 200);
    const searchDate = contextDate(value.searchDate);
    const searchTime = contextTime(value.searchTime);
    const destinationDate = contextDate(value.destinationDate);
    const destinationTime = contextTime(value.destinationTime);
    const destinationEndTime = contextTime(value.destinationEndTime);
    const durationMinutes = contextDuration(Object.hasOwn(value, "durationMinutes") ? value.durationMinutes : null);
    const windowStart = contextTime(Object.hasOwn(value, "windowStart") ? value.windowStart : null);
    const windowEnd = contextTime(Object.hasOwn(value, "windowEnd") ? value.windowEnd : null);
    const preference = contextPreference(Object.hasOwn(value, "preference") ? value.preference : null);
    const searchEndDate = contextDate(Object.hasOwn(value, "searchEndDate") ? value.searchEndDate : null);
    const readOnly = contextReadOnly(Object.hasOwn(value, "readOnly") ? value.readOnly : null);
    const missing = nullableContextText(value.missing, 40);
    const prompt = nullableContextText(value.prompt, 240);
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
      !readOnly.ok ||
      !missing.ok ||
      !prompt.ok
    ) {
      return { ok: false, error: "Operation context is not valid." };
    }
    const selection = [];
    const rawSelection = Array.isArray(value.selection) ? value.selection : [];
    if (rawSelection.length > 8) return { ok: false, error: "Operation context is not valid." };
    for (let index = 0; index < rawSelection.length; index += 1) {
      const item = rawSelection[index];
      if (typeof item !== "string" || !/^(?:all|c[1-8])$/.test(item)) {
        return { ok: false, error: "Operation context is not valid." };
      }
      if (selection.indexOf(item) === -1) selection.push(item);
    }
    const candidates = [];
    const rawCandidates = Array.isArray(value.candidates) ? value.candidates : [];
    if (rawCandidates.length > 8) return { ok: false, error: "Operation context is not valid." };
    for (let index = 0; index < rawCandidates.length; index += 1) {
      const candidate = rawCandidates[index];
      if (!candidate || typeof candidate !== "object" || typeof candidate.ref !== "string" || !/^c[1-8]$/.test(candidate.ref)) {
        return { ok: false, error: "Operation context is not valid." };
      }
      if (Object.keys(candidate).some((key) => key !== "ref" && key !== "label")) {
        return { ok: false, error: "Operation context is not valid." };
      }
      const label = nullableContextText(candidate.label, 180);
      if (!label.ok || !label.value) return { ok: false, error: "Operation context is not valid." };
      candidates.push({ ref: candidate.ref, label: label.value });
    }
    return {
      ok: true,
      operation: {
        intent: value.intent,
        target: target.value,
        searchDate: searchDate.value,
        searchTime: searchTime.value,
        destinationDate: destinationDate.value,
        destinationTime: destinationTime.value,
        destinationEndTime: destinationEndTime.value,
        scope: value.scope || "occurrence",
        selection: selection,
        durationMinutes: durationMinutes.value,
        windowStart: windowStart.value,
        windowEnd: windowEnd.value,
        preference: preference.value,
        searchEndDate: searchEndDate.value,
        readOnly: readOnly.value,
        missing: missing.value,
        prompt: prompt.value,
        candidates: candidates,
      },
    };
  }

  function optionalText(value) {
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || null;
  }

  function optionalDate(value) {
    if (value === null) return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    return value;
  }

  function optionalTime(value) {
    if (value === null) return null;
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
    return value;
  }

  function optionalDuration(value) {
    if (value === null) return null;
    if (!Number.isInteger(value) || value < 5 || value > 480) return undefined;
    return value;
  }

  function optionalPreference(value) {
    if (value === null) return null;
    if (typeof value !== "string") return undefined;
    const key = value.trim().toLowerCase();
    if (["morning", "afternoon", "evening", "later"].indexOf(key) === -1) return undefined;
    return key;
  }

  function optionalReadOnly(value) {
    if (value === null) return null;
    if (typeof value !== "boolean") return undefined;
    return value;
  }

  function sanitizeOperation(body) {
    const operation = body.operation;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
    const target = optionalText(operation.target);
    const searchDate = optionalDate(operation.searchDate);
    const searchTime = optionalTime(operation.searchTime);
    const destinationDate = optionalDate(operation.destinationDate);
    const destinationTime = optionalTime(operation.destinationTime);
    const destinationEndTime = optionalTime(operation.destinationEndTime);
    const durationMinutes = optionalDuration(Object.hasOwn(operation, "durationMinutes") ? operation.durationMinutes : null);
    const windowStart = optionalTime(Object.hasOwn(operation, "windowStart") ? operation.windowStart : null);
    const windowEnd = optionalTime(Object.hasOwn(operation, "windowEnd") ? operation.windowEnd : null);
    const preference = optionalPreference(Object.hasOwn(operation, "preference") ? operation.preference : null);
    const searchEndDate = optionalDate(Object.hasOwn(operation, "searchEndDate") ? operation.searchEndDate : null);
    const readOnly = optionalReadOnly(Object.hasOwn(operation, "readOnly") ? operation.readOnly : null);
    if (
      [target, searchDate, searchTime, destinationDate, destinationTime, destinationEndTime, durationMinutes, windowStart, windowEnd, preference, searchEndDate, readOnly].some(
        (item) => item === undefined
      )
    ) {
      return null;
    }
    if (["occurrence", "series", "unsupported"].indexOf(operation.scope) === -1) return null;
    if (!Array.isArray(operation.selection) || operation.selection.length > 8) return null;
    const selection = [];
    for (let index = 0; index < operation.selection.length; index += 1) {
      const item = operation.selection[index];
      if (typeof item !== "string" || !/^(?:all|c[1-8])$/.test(item) || selection.indexOf(item) !== -1) return null;
      selection.push(item);
    }
    if (selection.indexOf("all") !== -1 && selection.length > 1) return null;
    const questions = [];
    if (Array.isArray(body.clarificationQuestions)) {
      body.clarificationQuestions.forEach((question) => {
        if (typeof question !== "string") return;
        const trimmed = question.trim();
        if (trimmed && questions.indexOf(trimmed) === -1) questions.push(trimmed);
      });
    }
    const title = body.intent === "availability" ? optionalText(body.title) : null;
    if (body.intent === "availability" && title === undefined) return null;
    return {
      intent: body.intent,
      title: title,
      date: null,
      startTime: null,
      endTime: null,
      endDate: null,
      timeZone: typeof body.timeZone === "string" ? body.timeZone.trim() : "UTC",
      location: null,
      recurrence: null,
      reminders: { useDefault: false, overrides: [] },
      remindersText: "",
      recurrenceText: "",
      seriesEndText: "",
      needsClarification: body.intent === "clarify" || body.needsClarification === true,
      clarificationQuestions: questions,
      durationDefaulted: false,
      operation: {
        target: target,
        searchDate: searchDate,
        searchTime: searchTime,
        destinationDate: destinationDate,
        destinationTime: destinationTime,
        destinationEndTime: destinationEndTime,
        scope: operation.scope,
        selection: selection,
        durationMinutes: durationMinutes,
        windowStart: windowStart,
        windowEnd: windowEnd,
        preference: preference,
        searchEndDate: searchEndDate,
        readOnly: readOnly,
      },
    };
  }

  function sanitizeBatchEvent(body, expectedRef) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (typeof body.ref !== "string" || body.ref !== expectedRef) return null;
    const title = optionalText(body.title);
    const date = optionalDate(body.date);
    const startTime = optionalTime(body.startTime);
    const endTime = optionalTime(body.endTime);
    const location = optionalText(body.location);
    if (title === undefined || date === undefined || startTime === undefined || endTime === undefined) return null;
    if (location === undefined) return null;
    if (typeof body.timeZone !== "string" || !body.timeZone.trim()) return null;
    if (typeof body.needsClarification !== "boolean") return null;
    if (body.durationDefaulted != null && typeof body.durationDefaulted !== "boolean") return null;
    let recurrence = null;
    if (body.recurrence != null) {
      const schedule = root.QuickCalSchedule;
      if (!schedule || !schedule.normalizeRecurrence) return null;
      const parsed = schedule.normalizeRecurrence(body.recurrence);
      if (!parsed.ok) return null;
      recurrence = parsed.recurrence;
    }
    const schedule = root.QuickCalSchedule;
    if (!schedule || !schedule.normalizeReminderSettings) return null;
    if (!Object.hasOwn(body, "reminders")) return null;
    const reminderResult = schedule.normalizeReminderSettings(body.reminders);
    if (!reminderResult.ok) return null;
    let endDate = null;
    if (date) {
      endDate = body.endDate == null ? date : optionalDate(body.endDate);
      if (!endDate) return null;
    } else if (body.endDate != null) {
      return null;
    }
    if (!Array.isArray(body.clarificationQuestions)) return null;
    const questions = [];
    for (let index = 0; index < body.clarificationQuestions.length; index += 1) {
      const question = body.clarificationQuestions[index];
      if (typeof question !== "string") return null;
      const trimmed = question.trim();
      if (trimmed && questions.indexOf(trimmed) === -1) questions.push(trimmed);
    }
    return {
      ref: expectedRef,
      title: title,
      date: date,
      startTime: startTime,
      endTime: endTime,
      endDate: endDate,
      timeZone: body.timeZone.trim(),
      location: location,
      recurrence: recurrence,
      reminders: reminderResult.reminders,
      remindersText: schedule.reminderSettingsText(reminderResult.reminders),
      recurrenceText: recurrence && typeof body.recurrenceText === "string" ? body.recurrenceText.trim().slice(0, 120) : "",
      seriesEndText: recurrence && typeof body.seriesEndText === "string" ? body.seriesEndText.trim().slice(0, 120) : "",
      needsClarification: body.needsClarification,
      clarificationQuestions: questions,
      durationDefaulted: body.durationDefaulted === true,
      intent: "create",
    };
  }

  function sanitizeBatch(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (body.kind !== "batch" || typeof body.tooMany !== "boolean") return null;
    if (body.message != null && (typeof body.message !== "string" || body.message.length > 300)) return null;
    if (!Array.isArray(body.events)) return null;
    if (body.tooMany) {
      return {
        kind: "batch",
        tooMany: true,
        message:
          typeof body.message === "string" && body.message.trim()
            ? body.message.trim()
            : "That selection looks like more than 10 events. Highlight a smaller passage and try again.",
        events: [],
      };
    }
    if (body.events.length > 10) return null;
    const events = [];
    for (let index = 0; index < body.events.length; index += 1) {
      const expected = "e" + String(index + 1);
      const item = sanitizeBatchEvent(body.events[index], expected);
      if (!item) return null;
      events.push(item);
    }
    return {
      kind: "batch",
      tooMany: false,
      message: body.message == null || !String(body.message).trim() ? null : String(body.message).trim(),
      events: events,
    };
  }

  function sanitizeBatchFollowup(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (body.kind !== "batch-followup") return null;
    if (["update", "skip", "ambiguous", "none"].indexOf(body.action) === -1) return null;
    if (body.ref != null && (typeof body.ref !== "string" || !/^e([1-9]|10)$/.test(body.ref))) return null;
    if (body.question != null && (typeof body.question !== "string" || body.question.length > 240)) return null;
    let event = null;
    if (body.event != null) {
      if (!body.ref) return null;
      event = sanitizeBatchEvent(body.event, body.ref);
      if (!event) return null;
    }
    return {
      kind: "batch-followup",
      action: body.action,
      ref: body.ref || null,
      question: body.question == null || !String(body.question).trim() ? null : String(body.question).trim(),
      event: event,
    };
  }

  function sanitizeEvent(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (body.kind === "batch") return null;
    if (body.kind === "batch-followup") return null;
    if (
      body.intent === "move" ||
      body.intent === "delete" ||
      body.intent === "find" ||
      body.intent === "clarify" ||
      body.intent === "availability"
    ) {
      return sanitizeOperation(body);
    }
    if (body.intent !== "create" && body.intent !== "edit") return null;
    if (body.kind === "task") return sanitizeTask(body);
    const title = optionalText(body.title);
    const date = optionalDate(body.date);
    const startTime = optionalTime(body.startTime);
    const endTime = optionalTime(body.endTime);
    const location = optionalText(body.location);
    if (title === undefined || date === undefined || startTime === undefined || endTime === undefined) {
      return null;
    }
    if (location === undefined) return null;
    if (typeof body.timeZone !== "string" || !body.timeZone.trim()) return null;
    if (typeof body.needsClarification !== "boolean") return null;
    if (body.durationDefaulted != null && typeof body.durationDefaulted !== "boolean") return null;
    let recurrence = null;
    if (body.recurrence != null) {
      const schedule = root.QuickCalSchedule;
      if (!schedule || !schedule.normalizeRecurrence) return null;
      const parsed = schedule.normalizeRecurrence(body.recurrence);
      if (!parsed.ok) return null;
      recurrence = parsed.recurrence;
    }
    const schedule = root.QuickCalSchedule;
    if (!schedule || !schedule.normalizeReminderSettings) return null;
    if (!Object.hasOwn(body, "reminders")) return null;
    const reminderResult = schedule.normalizeReminderSettings(body.reminders);
    if (!reminderResult.ok) return null;
    let endDate = null;
    if (date) {
      endDate = body.endDate == null ? date : optionalDate(body.endDate);
      if (!endDate) return null;
    } else if (body.endDate != null) {
      return null;
    }
    if (!Array.isArray(body.clarificationQuestions)) return null;
    const questions = [];
    for (let index = 0; index < body.clarificationQuestions.length; index += 1) {
      const question = body.clarificationQuestions[index];
      if (typeof question !== "string") return null;
      const trimmed = question.trim();
      if (trimmed && questions.indexOf(trimmed) === -1) questions.push(trimmed);
    }
    return {
      title: title,
      date: date,
      startTime: startTime,
      endTime: endTime,
      endDate: endDate,
      timeZone: body.timeZone.trim(),
      location: location,
      recurrence: recurrence,
      reminders: reminderResult.reminders,
      remindersText: schedule.reminderSettingsText(reminderResult.reminders),
      recurrenceText: recurrence && typeof body.recurrenceText === "string" ? body.recurrenceText.trim().slice(0, 120) : "",
      seriesEndText: recurrence && typeof body.seriesEndText === "string" ? body.seriesEndText.trim().slice(0, 120) : "",
      needsClarification: body.needsClarification,
      clarificationQuestions: questions,
      durationDefaulted: body.durationDefaulted === true,
      intent: body.intent,
    };
  }

  function cleanQuestions(value) {
    if (!Array.isArray(value)) return null;
    const questions = [];
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] !== "string") return null;
      const trimmed = value[index].trim();
      if (trimmed && questions.indexOf(trimmed) === -1) questions.push(trimmed);
    }
    return questions;
  }

  // A Google Task carries a title, an optional due date, and an optional due
  // time the user stated. It never has an end time, a location, or a series.
  function sanitizeTask(body) {
    if (body.intent !== "create") return null;
    const title = optionalText(body.title);
    const date = optionalDate(body.date);
    const dueTime = optionalTime(body.startTime);
    const description = body.description == null ? null : optionalText(body.description);
    if (title === undefined || date === undefined || dueTime === undefined || description === undefined) return null;
    if (title && title.length > 200) return null;
    if (description && description.length > 1000) return null;
    if (body.endTime != null || body.recurrence != null) return null;
    if (typeof body.timeZone !== "string" || !body.timeZone.trim()) return null;
    if (typeof body.needsClarification !== "boolean") return null;
    const questions = cleanQuestions(body.clarificationQuestions);
    if (!questions) return null;
    return {
      kind: "task",
      title: title,
      description: description,
      date: date,
      startTime: dueTime,
      endTime: null,
      endDate: date,
      timeZone: body.timeZone.trim(),
      location: null,
      recurrence: null,
      reminders: { useDefault: false, overrides: [] },
      remindersText: "",
      recurrenceText: "",
      seriesEndText: "",
      needsClarification: body.needsClarification,
      clarificationQuestions: questions,
      durationDefaulted: false,
      intent: "create",
    };
  }

  function publicError(message) {
    const text = String(message || "").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
    if (!text.trim() || text.length > 300) return "The event parser could not read that event.";
    return text;
  }

  function failureName(error) {
    return error && (error.name || "");
  }

  async function requestLocalParse(input, dependencies) {
    const fetchImpl = dependencies && dependencies.fetchImpl;
    const timeoutMs = dependencies && dependencies.timeoutMs ? dependencies.timeoutMs : TIMEOUT_MS;
    const token = dependencies && typeof dependencies.token === "string" ? dependencies.token : "";
    if (!token) {
      return {
        ok: false,
        state: "disconnected",
        error: "Connect Google Calendar before using QuickCalAI.",
      };
    }
    let response;
    try {
      const body = { text: input.text, timeZone: input.timeZone };
      if (input.batchContext) body.batchContext = input.batchContext;
      else if (input.batch) body.batch = true;
      else if (input.operation) body.operation = input.operation;
      else if (input.clarification) body.clarification = input.clarification;
      else if (input.currentEvent) body.currentEvent = input.currentEvent;
      response = await fetchImpl(PARSE_URL, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = failureName(error);
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: "The event parser timed out. Try again." };
      }
      return { ok: false, error: "QuickCalAI could not reach QuickCal. Try again." };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    if (!response.ok) {
      const message = payload && typeof payload.error === "string" ? payload.error : "";
      const error = publicError(message);
      if (response.status === 401) {
        return { ok: false, state: "disconnected", error: "Connect Google Calendar before using QuickCalAI." };
      }
      if (response.status === 403) return { ok: false, state: "unapproved", error: error };
      return { ok: false, error: error };
    }
    if (!payload || payload.quickcalApiVersion !== API_VERSION) {
      const release = payload && typeof payload.quickcalRelease === "string"
        ? " (running " + payload.quickcalRelease + ")"
        : "";
      return {
        ok: false,
        error: "QuickCalAI's hosted parser is out of date" + release + ". Deploy the current backend, then reload the extension.",
      };
    }
    if (input.batchContext) {
      const followup = sanitizeBatchFollowup(payload);
      if (!followup) return { ok: false, error: "The event parser returned an unreadable batch follow-up." };
      return { ok: true, followup: followup };
    }
    if (input.batch) {
      const batch = sanitizeBatch(payload);
      if (!batch) return { ok: false, error: "The event parser returned an unreadable batch." };
      return { ok: true, batch: batch };
    }
    const event = sanitizeEvent(payload);
    if (!event) return { ok: false, error: "The event parser returned an unreadable response." };
    return { ok: true, event: event };
  }

  root.QuickCalLocalParse = {
    BACKEND_ORIGIN: BACKEND_ORIGIN,
    PARSE_URL: PARSE_URL,
    HEALTH_URL: HEALTH_URL,
    ACCESS_URL: ACCESS_URL,
    EXTRACT_URL: EXTRACT_URL,
    ANALYZE_URL: ANALYZE_URL,
    API_VERSION: API_VERSION,
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
    validateParseRequest: validateParseRequest,
    sanitizeEvent: sanitizeEvent,
    sanitizeBatch: sanitizeBatch,
    sanitizeBatchFollowup: sanitizeBatchFollowup,
    requestLocalParse: requestLocalParse,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
