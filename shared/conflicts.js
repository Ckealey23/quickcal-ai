(function (root) {
  const RECURRING_HORIZON_DAYS = 90;
  const MAX_NOTICE_LINES = 5;

  function scheduleApi() {
    return root.QuickCalSchedule;
  }

  function addDays(date, days) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return (
      String(next.getUTCFullYear()) +
      "-" +
      String(next.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(next.getUTCDate()).padStart(2, "0")
    );
  }

  function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    if (!Number.isFinite(aStart) || !Number.isFinite(aEnd) || !Number.isFinite(bStart) || !Number.isFinite(bEnd)) {
      return false;
    }
    return aStart < bEnd && aEnd > bStart;
  }

  function parseInstant(value) {
    if (typeof value !== "string" || !value) return NaN;
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) ? epoch : NaN;
  }

  function intervalFromGoogleTimes(start, end) {
    if (!start || !end) return null;
    if (start.date && end.date && !start.dateTime && !end.dateTime) {
      const begin = Date.parse(start.date + "T00:00:00Z");
      const finish = Date.parse(end.date + "T00:00:00Z");
      if (!Number.isFinite(begin) || !Number.isFinite(finish) || finish <= begin) return null;
      return { startMs: begin, endMs: finish, allDay: true };
    }
    const startMs = parseInstant(start.dateTime || start.date);
    const endMs = parseInstant(end.dateTime || end.date);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return { startMs: startMs, endMs: endMs, allDay: false };
  }

  function intervalFromSaved(saved) {
    if (!saved || typeof saved !== "object") return null;
    if (saved.startDateTime && saved.endDateTime) {
      const startMs = parseInstant(saved.startDateTime);
      const endMs = parseInstant(saved.endDateTime);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        return { startMs: startMs, endMs: endMs, allDay: false };
      }
    }
    const api = scheduleApi();
    if (!api || !saved.date || !saved.startTime || !saved.endTime || !saved.timeZone) return null;
    const start = api.resolveLocal(saved.date, saved.startTime, saved.timeZone);
    const end = api.resolveLocal(saved.endDate || saved.date, saved.endTime, saved.timeZone);
    if (!start.ok || !end.ok || end.epoch <= start.epoch) return null;
    return { startMs: start.epoch, endMs: end.epoch, allDay: false };
  }

  function isRecurringSaved(saved) {
    if (!saved) return false;
    if (saved.recurrence && typeof saved.recurrence === "object") return true;
    if (typeof saved.recurrenceRule === "string" && saved.recurrenceRule) return true;
    if (typeof saved.recurrenceText === "string" && saved.recurrenceText && /every/i.test(saved.recurrenceText)) {
      return true;
    }
    return false;
  }

  function checkWindow(saved) {
    const interval = intervalFromSaved(saved);
    if (!interval) return null;
    const api = scheduleApi();
    const zone = saved.timeZone || "UTC";
    let timeMinMs = interval.startMs;
    let timeMaxMs = interval.endMs;
    let horizonDate = "";
    let horizonText = "";
    if (isRecurringSaved(saved)) {
      if (!api) return null;
      const startParts = zoneParts(interval.startMs, zone);
      horizonDate = addDays(startParts.date, RECURRING_HORIZON_DAYS);
      const horizon = api.resolveLocal(horizonDate, "00:00", zone);
      if (!horizon.ok) return null;
      timeMaxMs = horizon.epoch;
      horizonText = "Checked through " + api.formatCompactDate(horizonDate) + ".";
    }
    return {
      timeMin: new Date(timeMinMs).toISOString(),
      timeMax: new Date(timeMaxMs).toISOString(),
      startMs: timeMinMs,
      endMs: timeMaxMs,
      eventStartMs: interval.startMs,
      eventEndMs: interval.endMs,
      recurring: isRecurringSaved(saved),
      horizonDate: horizonDate,
      horizonText: horizonText,
    };
  }

  function zoneParts(epoch, timeZone) {
    const parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
    }).formatToParts(new Date(epoch)).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return {
      date: parts.year + "-" + parts.month + "-" + parts.day,
      time: hour + ":" + parts.minute,
      weekday: parts.weekday || "",
    };
  }

  function isTransparent(item) {
    return !!(item && item.transparency === "transparent");
  }

  function isCancelled(item) {
    return !!(item && item.status === "cancelled");
  }

  function isDeclined(item) {
    const people = item && Array.isArray(item.attendees) ? item.attendees : [];
    for (let index = 0; index < people.length; index += 1) {
      const person = people[index];
      if (person && person.self === true && person.responseStatus === "declined") return true;
    }
    return false;
  }

  function isBusyCandidate(item) {
    if (!item || !item.id) return false;
    if (isCancelled(item) || isTransparent(item) || isDeclined(item)) return false;
    return !!intervalFromGoogleTimes(item.start, item.end);
  }

  function isSavedEvent(item, saved, calendarId) {
    if (!item || !saved) return false;
    const savedCalendar = saved.calendarId || "primary";
    const sameCalendar =
      !calendarId ||
      calendarId === savedCalendar ||
      (savedCalendar === "primary" && (calendarId === "primary" || calendarId === saved.calendarEmail));
    if (saved.id && item.id === saved.id && sameCalendar) return true;
    if (saved.id && item.recurringEventId === saved.id) return true;
    if (saved.recurringEventId && item.id === saved.recurringEventId) return true;
    if (saved.recurringEventId && item.recurringEventId === saved.recurringEventId && item.id === saved.id) {
      return true;
    }
    if (saved.iCalUID && item.iCalUID && saved.iCalUID === item.iCalUID) return true;
    return false;
  }

  function dedupeKey(item, calendarId) {
    if (item && item.iCalUID) return "ical:" + item.iCalUID;
    if (item && item.id) return "id:" + (calendarId || "primary") + ":" + item.id;
    if (item && item.busyOnly) {
      return "busy:" + (calendarId || "") + ":" + item.startMs + ":" + item.endMs;
    }
    return "";
  }

  function formatTimeLabel(startMs, endMs, timeZone, allDay) {
    const api = scheduleApi();
    if (allDay) return "All day";
    const start = zoneParts(startMs, timeZone);
    const end = zoneParts(endMs, timeZone);
    return api.formatTimeRange(start.time, end.time);
  }

  function formatConflictLine(entry, timeZone, showCalendar) {
    const start = zoneParts(entry.startMs, timeZone);
    const weekday = start.weekday || "";
    const when = formatTimeLabel(entry.startMs, entry.endMs, timeZone, entry.allDay);
    const title = entry.busyOnly
      ? "Busy event"
      : String(entry.summary || "Untitled event").replace(/'/g, "\u2019");
    const named =
      showCalendar && entry.calendarName && entry.calendarId !== "primary" && !entry.primary
        ? "'" + title + "' (" + entry.calendarName + ")"
        : "'" + title + "'";
    if (weekday && when) return "Overlaps with " + named + ", " + weekday + ", " + when + ".";
    if (when) return "Overlaps with " + named + ", " + when + ".";
    return "Overlaps with " + named + ".";
  }

  function collectConflicts(options) {
    const saved = options.saved;
    const timeZone = (saved && saved.timeZone) || options.timeZone || "UTC";
    const ourIntervals = options.ourIntervals || [];
    const entries = options.entries || [];
    const seen = Object.create(null);
    const conflicts = [];
    const multiCalendar = (options.calendarCount || 0) > 1;

    entries.forEach((entry) => {
      if (!entry) return;
      const key = dedupeKey(entry, entry.calendarId);
      if (key && seen[key]) return;
      let overlaps = false;
      for (let index = 0; index < ourIntervals.length; index += 1) {
        const mine = ourIntervals[index];
        if (intervalsOverlap(mine.startMs, mine.endMs, entry.startMs, entry.endMs)) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) return;
      if (key) seen[key] = true;
      conflicts.push(entry);
    });

    const lines = conflicts.slice(0, MAX_NOTICE_LINES).map((entry) => {
      return formatConflictLine(entry, timeZone, multiCalendar);
    });
    if (conflicts.length > MAX_NOTICE_LINES) {
      lines.push("+" + (conflicts.length - MAX_NOTICE_LINES) + " more overlapping events.");
    }
    return { conflicts: conflicts, lines: lines };
  }

  function entryFromEvent(item, calendar) {
    const interval = intervalFromGoogleTimes(item.start, item.end);
    if (!interval) return null;
    return {
      id: item.id,
      iCalUID: item.iCalUID || "",
      recurringEventId: item.recurringEventId || "",
      summary: item.summary || "Untitled event",
      busyOnly: false,
      allDay: interval.allDay,
      startMs: interval.startMs,
      endMs: interval.endMs,
      calendarId: calendar.id,
      calendarName: calendar.summary || calendar.id,
      primary: !!calendar.primary,
    };
  }

  function entryFromBusy(block, calendar) {
    const startMs = parseInstant(block.start);
    const endMs = parseInstant(block.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return {
      id: "",
      iCalUID: "",
      recurringEventId: "",
      summary: "Busy event",
      busyOnly: true,
      allDay: false,
      startMs: startMs,
      endMs: endMs,
      calendarId: calendar.id,
      calendarName: calendar.summary || calendar.id,
      primary: !!calendar.primary,
    };
  }

  function checkingNotice(checkId, saved) {
    return {
      checkId: checkId,
      savedEventId: saved && saved.id ? saved.id : "",
      status: "checking",
      statusText: "Checking for conflicts\u2026",
      lines: [],
      horizonText: "",
      incomplete: false,
      needsScopes: false,
    };
  }

  function clearNotice(checkId, saved) {
    return {
      checkId: checkId,
      savedEventId: saved && saved.id ? saved.id : "",
      status: "clear",
      statusText: "",
      lines: [],
      horizonText: "",
      incomplete: false,
      needsScopes: false,
    };
  }

  function buildNotice(options) {
    const checkId = options.checkId || "";
    const saved = options.saved || null;
    const window = options.window || null;
    if (options.needsScopes) {
      return {
        checkId: checkId,
        savedEventId: saved && saved.id ? saved.id : "",
        status: "needsScopes",
        statusText:
          "Event saved. Reconnect Google Calendar to check other calendars for conflicts.",
        lines: [],
        horizonText: window && window.horizonText ? window.horizonText : "",
        incomplete: true,
        needsScopes: true,
      };
    }
    const collected = collectConflicts({
      saved: saved,
      timeZone: options.timeZone,
      ourIntervals: options.ourIntervals || [],
      entries: options.entries || [],
      calendarCount: options.calendarCount || 0,
    });
    const incompleteReasons = (options.incompleteReasons || []).filter(Boolean);
    const horizonText = window && window.horizonText ? window.horizonText : "";
    if (collected.lines.length) {
      const statusText = collected.lines.length === 1
        ? collected.lines[0]
        : collected.lines.length + " overlapping events found.";
      return {
        checkId: checkId,
        savedEventId: saved && saved.id ? saved.id : "",
        status: "conflicts",
        statusText: incompleteReasons.length
          ? statusText + " Conflict check was incomplete for some calendars."
          : statusText,
        lines: collected.lines.concat(horizonText ? [horizonText] : []),
        horizonText: horizonText,
        incomplete: incompleteReasons.length > 0,
        needsScopes: false,
        incompleteReasons: incompleteReasons,
      };
    }
    if (incompleteReasons.length) {
      return {
        checkId: checkId,
        savedEventId: saved && saved.id ? saved.id : "",
        status: "incomplete",
        statusText:
          "Event saved. Conflict check was incomplete" +
          (incompleteReasons.length === 1 ? ": " + incompleteReasons[0] : ".") +
          (horizonText ? " " + horizonText : ""),
        lines: incompleteReasons.length > 1 ? incompleteReasons.slice(0, MAX_NOTICE_LINES) : [],
        horizonText: horizonText,
        incomplete: true,
        needsScopes: false,
        incompleteReasons: incompleteReasons,
      };
    }
    const clear = clearNotice(checkId, saved);
    if (horizonText) {
      clear.statusText = horizonText;
      clear.horizonText = horizonText;
      clear.lines = [horizonText];
      clear.status = "clear";
    }
    return clear;
  }

  function noticeStillCurrent(session, notice) {
    if (!session || !notice) return false;
    if (!session.visible) return false;
    if (session.mode === "reviewing" || session.mode === "batch-results") {
      if (!session.batch || !Array.isArray(session.batch.drafts) || !notice.savedEventId) return false;
      const draft = session.batch.drafts.find((item) => {
        if (!item) return false;
        if (item.calendarEventId && item.calendarEventId === notice.savedEventId) return true;
        return !!(item.savedRecord && item.savedRecord.id === notice.savedEventId);
      });
      if (!draft || draft.saveStatus !== "saved") return false;
      const current = draft.conflictNotice;
      if (current && current.checkId && notice.checkId && current.checkId !== notice.checkId) return false;
      return true;
    }
    if (session.mode !== "saved" || !session.savedRecord) return false;
    if (notice.savedEventId && session.savedRecord.id && notice.savedEventId !== session.savedRecord.id) {
      return false;
    }
    const current = session.conflictNotice;
    if (current && current.checkId && notice.checkId && current.checkId !== notice.checkId) {
      return false;
    }
    return true;
  }

  root.QuickCalConflicts = {
    RECURRING_HORIZON_DAYS: RECURRING_HORIZON_DAYS,
    intervalsOverlap: intervalsOverlap,
    intervalFromGoogleTimes: intervalFromGoogleTimes,
    intervalFromSaved: intervalFromSaved,
    isRecurringSaved: isRecurringSaved,
    checkWindow: checkWindow,
    isBusyCandidate: isBusyCandidate,
    isTransparent: isTransparent,
    isCancelled: isCancelled,
    isDeclined: isDeclined,
    isSavedEvent: isSavedEvent,
    dedupeKey: dedupeKey,
    entryFromEvent: entryFromEvent,
    entryFromBusy: entryFromBusy,
    collectConflicts: collectConflicts,
    formatConflictLine: formatConflictLine,
    checkingNotice: checkingNotice,
    clearNotice: clearNotice,
    buildNotice: buildNotice,
    noticeStillCurrent: noticeStillCurrent,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
