(function (root) {
  const PARSE_URL = "https://quickcal-ai.onrender.com/parse-event";
  const HEALTH_URL = "https://quickcal-ai.onrender.com/health";
  const ACCESS_URL = "https://quickcal-ai.onrender.com/access";
  const MAX_TEXT_LENGTH = 2000;
  const TIMEOUT_MS = 35000;
  const API_VERSION = 3;

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
    return { ok: true, text: text, timeZone: timeZone, currentEvent: currentEvent, clarification: clarification, operation: operation.operation };
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

  function normalizeOperationContext(value) {
    if (value == null) return { ok: true, operation: null };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Operation context is not valid." };
    }
    const allowed = ["intent", "target", "searchDate", "searchTime", "destinationDate", "destinationTime", "destinationEndTime", "scope", "selection", "missing", "prompt", "candidates"];
    if (Object.keys(value).some((key) => allowed.indexOf(key) === -1)) {
      return { ok: false, error: "Operation context is not valid." };
    }
    if (["move", "delete", "find", "clarify"].indexOf(value.intent) === -1) {
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
    const missing = nullableContextText(value.missing, 40);
    const prompt = nullableContextText(value.prompt, 240);
    if (!target.ok || !searchDate.ok || !searchTime.ok || !destinationDate.ok || !destinationTime.ok || !destinationEndTime.ok || !missing.ok || !prompt.ok) {
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

  function sanitizeOperation(body) {
    const operation = body.operation;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
    const target = optionalText(operation.target);
    const searchDate = optionalDate(operation.searchDate);
    const searchTime = optionalTime(operation.searchTime);
    const destinationDate = optionalDate(operation.destinationDate);
    const destinationTime = optionalTime(operation.destinationTime);
    const destinationEndTime = optionalTime(operation.destinationEndTime);
    if ([target, searchDate, searchTime, destinationDate, destinationTime, destinationEndTime].some((item) => item === undefined)) {
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
    return {
      intent: body.intent,
      title: null,
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
      },
    };
  }

  function sanitizeEvent(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (body.intent === "move" || body.intent === "delete" || body.intent === "find" || body.intent === "clarify") {
      return sanitizeOperation(body);
    }
    if (body.intent !== "create" && body.intent !== "edit") return null;
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
      response = await fetchImpl(PARSE_URL, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(
          input.operation
            ? { text: input.text, timeZone: input.timeZone, operation: input.operation }
            : input.clarification
              ? { text: input.text, timeZone: input.timeZone, clarification: input.clarification }
              : input.currentEvent
                ? { text: input.text, timeZone: input.timeZone, currentEvent: input.currentEvent }
                : { text: input.text, timeZone: input.timeZone }
        ),
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
    const event = sanitizeEvent(payload);
    if (!event) return { ok: false, error: "The event parser returned an unreadable response." };
    return { ok: true, event: event };
  }

  root.QuickCalLocalParse = {
    PARSE_URL: PARSE_URL,
    HEALTH_URL: HEALTH_URL,
    ACCESS_URL: ACCESS_URL,
    API_VERSION: API_VERSION,
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
    validateParseRequest: validateParseRequest,
    sanitizeEvent: sanitizeEvent,
    requestLocalParse: requestLocalParse,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
