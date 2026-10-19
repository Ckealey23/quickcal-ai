(function (root) {
  const PARSE_URL = "https://quickcal-ai.onrender.com/parse-event";
  const HEALTH_URL = "https://quickcal-ai.onrender.com/health";
  const ACCESS_URL = "https://quickcal-ai.onrender.com/access";
  const MAX_TEXT_LENGTH = 2000;
  const TIMEOUT_MS = 35000;

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
    return { ok: true, text: text, timeZone: timeZone, currentEvent: currentEvent, clarification: clarification };
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

  function sanitizeEvent(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
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
      recurrenceText: recurrence && typeof body.recurrenceText === "string" ? body.recurrenceText.trim().slice(0, 120) : "",
      seriesEndText: recurrence && typeof body.seriesEndText === "string" ? body.seriesEndText.trim().slice(0, 120) : "",
      needsClarification: body.needsClarification,
      clarificationQuestions: questions,
      durationDefaulted: body.durationDefaulted === true,
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
          input.clarification
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
    const event = sanitizeEvent(payload);
    if (!event) return { ok: false, error: "The event parser returned an unreadable response." };
    return { ok: true, event: event };
  }

  root.QuickCalLocalParse = {
    PARSE_URL: PARSE_URL,
    HEALTH_URL: HEALTH_URL,
    ACCESS_URL: ACCESS_URL,
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
    validateParseRequest: validateParseRequest,
    sanitizeEvent: sanitizeEvent,
    requestLocalParse: requestLocalParse,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
