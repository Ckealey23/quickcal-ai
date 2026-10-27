(function (root) {
  const MAX_REMINDERS = 5;
  const MAX_REMINDER_MINUTES = 40320;
  const REMINDER_ACTIONS = ["preserve", "replace", "add", "remove", "default"];

  function noReminders() {
    return { useDefault: false, overrides: [] };
  }

  function normalizeReminderOverrides(value) {
    if (!Array.isArray(value) || value.length > MAX_REMINDERS) return { ok: false };
    const overrides = [];
    for (let index = 0; index < value.length; index += 1) {
      const reminder = value[index];
      if (!reminder || typeof reminder !== "object" || Array.isArray(reminder)) return { ok: false };
      const keys = Object.keys(reminder);
      if (keys.length !== 2 || keys.indexOf("method") === -1 || keys.indexOf("minutes") === -1) {
        return { ok: false };
      }
      if (reminder.method !== "popup" && reminder.method !== "email") return { ok: false };
      if (!Number.isInteger(reminder.minutes) || reminder.minutes < 0 || reminder.minutes > MAX_REMINDER_MINUTES) {
        return { ok: false };
      }
      const duplicate = overrides.some((item) => {
        return item.method === reminder.method && item.minutes === reminder.minutes;
      });
      if (!duplicate) overrides.push({ method: reminder.method, minutes: reminder.minutes });
    }
    return { ok: true, overrides: overrides };
  }

  function normalizeReminderSettings(value) {
    if (value == null) return { ok: true, reminders: noReminders() };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "useDefault" && key !== "overrides")) return { ok: false };
    if (typeof value.useDefault !== "boolean") return { ok: false };
    if (value.useDefault) {
      if (value.overrides != null && (!Array.isArray(value.overrides) || value.overrides.length > 0)) return { ok: false };
      return { ok: true, reminders: { useDefault: true, overrides: [] } };
    }
    const normalized = normalizeReminderOverrides(value.overrides == null ? [] : value.overrides);
    if (!normalized.ok) return normalized;
    return { ok: true, reminders: { useDefault: false, overrides: normalized.overrides } };
  }

  function sameReminderSettings(leftValue, rightValue) {
    const left = normalizeReminderSettings(leftValue);
    const right = normalizeReminderSettings(rightValue);
    if (!left.ok || !right.ok || left.reminders.useDefault !== right.reminders.useDefault) return false;
    if (left.reminders.overrides.length !== right.reminders.overrides.length) return false;
    return left.reminders.overrides.every((leftReminder) => {
      return right.reminders.overrides.some((rightReminder) => {
        return leftReminder.method === rightReminder.method && leftReminder.minutes === rightReminder.minutes;
      });
    });
  }

  function normalizeReminderChange(action, overrides) {
    const name = action == null ? "preserve" : action;
    if (REMINDER_ACTIONS.indexOf(name) === -1) return { ok: false };
    const normalized = normalizeReminderOverrides(overrides == null ? [] : overrides);
    if (!normalized.ok) return normalized;
    if ((name === "preserve" || name === "remove" || name === "default") && normalized.overrides.length) {
      return { ok: false };
    }
    if ((name === "replace" || name === "add") && normalized.overrides.length === 0) return { ok: false };
    return { ok: true, action: name, overrides: normalized.overrides };
  }

  function applyReminderChange(currentValue, action, overrides) {
    const current = normalizeReminderSettings(currentValue);
    const change = normalizeReminderChange(action, overrides);
    if (!current.ok || !change.ok) return null;
    if (change.action === "preserve") return current.reminders;
    if (change.action === "default") return { useDefault: true, overrides: [] };
    if (change.action === "remove") return noReminders();
    if (change.action === "replace") return { useDefault: false, overrides: change.overrides };
    if (current.reminders.useDefault) return null;
    const combined = [];
    current.reminders.overrides.concat(change.overrides).forEach((reminder) => {
      const duplicate = combined.some((item) => {
        return item.method === reminder.method && item.minutes === reminder.minutes;
      });
      if (!duplicate) combined.push(reminder);
    });
    const normalized = normalizeReminderOverrides(combined);
    if (!normalized.ok) return null;
    return { useDefault: false, overrides: normalized.overrides };
  }

  function reminderLeadText(minutes) {
    if (minutes === 0) return "at start time";
    if (minutes % 10080 === 0) {
      const weeks = minutes / 10080;
      return weeks + (weeks === 1 ? " week before" : " weeks before");
    }
    if (minutes % 1440 === 0) {
      const days = minutes / 1440;
      return days + (days === 1 ? " day before" : " days before");
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours + (hours === 1 ? " hour before" : " hours before");
    }
    return minutes + (minutes === 1 ? " minute before" : " minutes before");
  }

  function reminderSettingsText(value) {
    if (value == null) return "Notification settings not loaded";
    const normalized = normalizeReminderSettings(value);
    if (!normalized.ok) return "";
    const reminders = normalized.reminders;
    if (reminders.useDefault) return "Calendar default notifications";
    if (!reminders.overrides.length) return "Notifications off";
    return reminders.overrides.map((reminder) => {
      const method = reminder.method === "email" ? "Email" : "Popup";
      return method + " " + reminderLeadText(reminder.minutes);
    }).join(" · ");
  }

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

  function zoneParts(utcMillis, timeZone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = {};
    formatter.formatToParts(new Date(utcMillis)).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    let hour = parts.hour;
    if (hour === "24") hour = "00";
    return {
      date: parts.year + "-" + parts.month + "-" + parts.day,
      time: hour + ":" + parts.minute,
      second: parts.second,
      hour: hour,
    };
  }

  function zoneOffsetMinutes(utcMillis, timeZone) {
    const parts = zoneParts(utcMillis, timeZone);
    const asUtc = Date.UTC(
      Number(parts.date.slice(0, 4)),
      Number(parts.date.slice(5, 7)) - 1,
      Number(parts.date.slice(8, 10)),
      Number(parts.hour),
      Number(parts.time.slice(3, 5)),
      Number(parts.second)
    );
    return Math.round((asUtc - utcMillis) / 60000);
  }

  function resolveLocal(date, time, timeZone) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) {
      return { ok: false, reason: "invalid" };
    }
    if (!isValidTimeZone(timeZone)) return { ok: false, reason: "invalid" };
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(3, 5));
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    const instants = [];
    for (let offset = -16 * 60; offset <= 16 * 60; offset += 15) {
      const instant = desiredUtc - offset * 60000;
      if (zoneOffsetMinutes(instant, timeZone) !== offset) continue;
      const parts = zoneParts(instant, timeZone);
      if (parts.date === date && parts.time === time && instants.indexOf(instant) === -1) {
        instants.push(instant);
      }
    }
    if (instants.length === 1) return { ok: true, epoch: instants[0] };
    if (instants.length === 0) return { ok: false, reason: "nonexistent" };
    return { ok: false, reason: "ambiguous" };
  }

  function formatClock(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || "");
    if (!match) return null;
    let hours = Number(match[1]);
    const suffix = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return { text: hours + ":" + match[2], suffix: suffix };
  }

  function formatTimeRange(start, end) {
    const from = formatClock(start);
    const to = formatClock(end);
    if (from && to) {
      if (from.suffix === to.suffix) return from.text + "\u2013" + to.text + " " + to.suffix;
      return from.text + " " + from.suffix + "\u2013" + to.text + " " + to.suffix;
    }
    if (from) return from.text + " " + from.suffix;
    if (to) return to.text + " " + to.suffix;
    return "";
  }

  function formatCompactDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return "";
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (
      date.getUTCFullYear() !== Number(match[1]) ||
      date.getUTCMonth() !== Number(match[2]) - 1 ||
      date.getUTCDate() !== Number(match[3])
    ) {
      return "";
    }
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  function formatDateSpan(start, end) {
    const from = formatCompactDate(start);
    const to = formatCompactDate(end);
    if (from && to && start !== end) return from + " \u2013 " + to;
    return from || to || "";
  }

  function rfc3339(epoch, timeZone) {
    const parts = zoneParts(epoch, timeZone);
    const offset = zoneOffsetMinutes(epoch, timeZone);
    const sign = offset >= 0 ? "+" : "-";
    const absolute = Math.abs(offset);
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
    const minutes = String(absolute % 60).padStart(2, "0");
    return parts.date + "T" + parts.time + ":00" + sign + hours + ":" + minutes;
  }

  const WEEKDAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const WEEKDAY_LABELS = {
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
    SU: "Sunday",
  };
  const WEEKDAY_WORDS = [
    { re: /\b(?:mondays?|mon)\b/gi, code: "MO" },
    { re: /\b(?:tuesdays?|tues|tue)\b/gi, code: "TU" },
    { re: /\b(?:wednesdays?|wed)\b/gi, code: "WE" },
    { re: /\b(?:thursdays?|thurs|thu)\b/gi, code: "TH" },
    { re: /\b(?:fridays?|fri)\b/gi, code: "FR" },
    { re: /\b(?:saturdays?|sat)\b/gi, code: "SA" },
    { re: /\b(?:sundays?|sun)\b/gi, code: "SU" },
  ];
  const ZONE_HINTS = {
    "America/New_York": /\b(eastern|east coast|est|edt)\b/i,
    "America/Chicago": /\b(central|cst|cdt)\b/i,
    "America/Denver": /\b(mountain|mst|mdt)\b/i,
    "America/Los_Angeles": /\b(pacific|pst|pdt)\b/i,
    "America/Phoenix": /\barizona\b/i,
    "Pacific/Honolulu": /\b(hawaii|hst)\b/i,
    "America/Anchorage": /\b(alaska|akst|akdt)\b/i,
    UTC: /\b(utc|gmt)\b/i,
  };
  const UNSUPPORTED_RECURRENCE = [
    /\b(?:every|each)\s+day\b/i,
    /\b(?:every|each)\s+(?:morning|evening|night)s?\b/i,
    /\bdaily\b/i,
    /\b(?:monthly|yearly|annually)\b/i,
    /\b(?:every|each)\s+(?:month|year)\b/i,
    /\b(?:every|each)\s+other\b/i,
    /\bbi-?weekly\b/i,
    /\bfortnightly\b/i,
    /\bevery\s+\d+\s+(?:days?|weeks?|months?|years?)\b/i,
  ];

  function dedupe(questions) {
    const unique = [];
    (questions || []).forEach((question) => {
      if (typeof question !== "string") return;
      const trimmed = question.trim();
      if (trimmed && unique.indexOf(trimmed) === -1) unique.push(trimmed);
    });
    return unique;
  }

  function isResolvedEndQuestion(question) {
    const text = question.toLowerCase();
    if (text.indexOf("start") !== -1) return false;
    if (text.indexOf("not later") !== -1) return false;
    return (
      text.indexOf("end time") !== -1 ||
      text.indexOf("time does this event end") !== -1 ||
      text.indexOf("time does it end") !== -1 ||
      text.indexOf("when does this event end") !== -1 ||
      text.indexOf("when does it end") !== -1 ||
      text.indexOf("how long") !== -1
    );
  }

  function explicitDurationMinutes(text) {
    const source = String(text || "");
    const found = [];
    function add(minutes) {
      const rounded = Math.round(minutes);
      if (rounded > 0 && rounded <= 24 * 60) found.push(rounded);
      else found.push(0);
    }
    const patterns = [
      { re: /\b(?:for|lasting)\s+(\d+(?:\.\d+)?)\s*(?:hours|hour|hrs|hr)\b/gi, scale: 60 },
      { re: /\b(?:for|lasting)\s+(\d+)\s*(?:minutes|minute|mins|min)\b/gi, scale: 1 },
      { re: /\b(?:for|lasting)\s+(?:an|one)\s+hour\b/gi, fixed: 60 },
      { re: /\b(?:for|lasting)\s+half(?:\s+an)?\s+hour\b/gi, fixed: 30 },
      { re: /\b(\d+(?:\.\d+)?)-hour\b/gi, scale: 60 },
      { re: /\b(\d+)-minute\b/gi, scale: 1 },
    ];
    patterns.forEach((pattern) => {
      source.replace(pattern.re, function (match, value) {
        if (pattern.fixed) add(pattern.fixed);
        else add(Number(value) * pattern.scale);
        return match;
      });
    });
    if (!found.length) return null;
    if (found.some((minutes) => minutes <= 0)) return { ambiguous: true };
    const unique = found.filter((minutes, index) => found.indexOf(minutes) === index);
    if (unique.length !== 1) return { ambiguous: true };
    return { minutes: unique[0] };
  }

  function localFromEpoch(epoch, timeZone) {
    const parts = zoneParts(epoch, timeZone);
    return { date: parts.date, time: parts.time };
  }

  function isIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return false;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return (
      date.getUTCFullYear() === Number(match[1]) &&
      date.getUTCMonth() === Number(match[2]) - 1 &&
      date.getUTCDate() === Number(match[3])
    );
  }

  function addDays(date, days) {
    const next = new Date(
      Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days)
    );
    const month = String(next.getUTCMonth() + 1).padStart(2, "0");
    const day = String(next.getUTCDate()).padStart(2, "0");
    return next.getUTCFullYear() + "-" + month + "-" + day;
  }

  function weekdayCode(date) {
    const index = new Date(Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10))
    )).getUTCDay();
    return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][index];
  }

  function canonicalWeekdays(days) {
    return WEEKDAY_ORDER.filter((day) => days.indexOf(day) !== -1);
  }

  function sameWeekdays(left, right) {
    const a = canonicalWeekdays(left);
    const b = canonicalWeekdays(right);
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  function textRecurrenceKind(text) {
    const source = String(text || "");
    for (let index = 0; index < UNSUPPORTED_RECURRENCE.length; index += 1) {
      if (UNSUPPORTED_RECURRENCE[index].test(source)) return "unsupported";
    }
    if (/\b(?:every|each)\s+week(?:day|end)s?\b/i.test(source)) return "weekly";
    if (/\b(?:every|each)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thu|thurs|fri|sat|sun)s?\b/i.test(source)) {
      return "weekly";
    }
    if (/\b(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/i.test(source)) return "weekly";
    if (/\bweekly\b/i.test(source) || /\b(?:every|each)\s+week\b/i.test(source)) return "weekly";
    return "none";
  }

  function weekdaysFromText(text) {
    const source = String(text || "").toLowerCase();
    if (/\b(?:every|each)\s+weekdays?\b/.test(source)) return ["MO", "TU", "WE", "TH", "FR"];
    if (/\b(?:every|each)\s+weekends?\b/.test(source)) return ["SA", "SU"];
    const found = [];
    WEEKDAY_WORDS.forEach((pattern) => {
      if (pattern.re.test(source) && found.indexOf(pattern.code) === -1) found.push(pattern.code);
      pattern.re.lastIndex = 0;
    });
    return canonicalWeekdays(found);
  }

  function hasExplicitStart(text) {
    const source = String(text || "")
      .replace(/\b(?:until|through|till|til)\s+(?:the\s+)?(?:end\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\b(?:[^,.\n]{0,24})/gi, " ")
      .replace(/\b(?:until|through|till|til)\s+\d{4}-\d{2}-\d{2}\b/gi, " ")
      .replace(/\b(?:until|through|till|til)\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi, " ");
    if (/\b(?:today|tomorrow|tonight)\b/i.test(source)) return true;
    if (/\b(?:next|this)\s+week\b/i.test(source)) return true;
    if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(source)) {
      return true;
    }
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(source)) return true;
    if (/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(source)) return true;
    if (/\b(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(source)) return true;
    return false;
  }

  function missingSeriesLimit(text, recurrence) {
    if (!recurrence || recurrence.until || recurrence.count) return false;
    const source = String(text || "");
    if (/\bfor\s+\d+\s+weeks?\b/i.test(source)) return true;
    if (/\b\d+\s+(?:times|occurrences)\b/i.test(source)) return true;
    return /\b(?:until|through|till|til)\s+(?:the\s+)?(?:end\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/i.test(source);
  }

  function isStillAhead(startTime, localTime) {
    const now = String(localTime || "");
    const padded = now.length === 5 ? now + ":00" : now;
    return startTime + ":00" > padded;
  }

  function nextWeeklyDate(localDate, localTime, weekdays, startTime) {
    const days = canonicalWeekdays(weekdays);
    if (!days.length || !isIsoDate(localDate) || !startTime) return null;
    for (let offset = 0; offset < 14; offset += 1) {
      const date = addDays(localDate, offset);
      if (days.indexOf(weekdayCode(date)) === -1) continue;
      if (offset === 0 && !isStillAhead(startTime, localTime)) continue;
      return date;
    }
    return null;
  }

  function textSupportsZone(text, zone) {
    const source = String(text || "").toLowerCase();
    const name = String(zone || "");
    if (!name) return false;
    if (source.indexOf(name.toLowerCase()) !== -1) return true;
    const city = name.split("/").pop().replace(/_/g, " ").toLowerCase();
    if (city && city.length > 2 && source.indexOf(city) !== -1) return true;
    return !!(ZONE_HINTS[name] && ZONE_HINTS[name].test(text || ""));
  }

  function resolveEventZone(modelZone, requestedZone, sourceText) {
    if (modelZone === requestedZone) return requestedZone;
    if (typeof modelZone === "string" && isValidTimeZone(modelZone) && textSupportsZone(sourceText, modelZone)) {
      return modelZone;
    }
    return requestedZone;
  }

  function normalizeRecurrence(value) {
    if (value == null) return { ok: true, recurrence: null };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    const allowed = ["frequency", "weekdays", "until", "count"];
    const keys = Object.keys(value);
    for (let index = 0; index < keys.length; index += 1) {
      if (allowed.indexOf(keys[index]) === -1) return { ok: false };
    }
    if (value.frequency !== "weekly") return { ok: false };
    if (!Array.isArray(value.weekdays) || value.weekdays.length === 0 || value.weekdays.length > 7) {
      return { ok: false };
    }
    const seen = [];
    for (let index = 0; index < value.weekdays.length; index += 1) {
      const day = value.weekdays[index];
      if (WEEKDAY_ORDER.indexOf(day) === -1 || seen.indexOf(day) !== -1) return { ok: false };
      seen.push(day);
    }
    let until = null;
    if (value.until != null) {
      if (typeof value.until !== "string" || !isIsoDate(value.until)) return { ok: false };
      until = value.until;
    }
    let count = null;
    if (value.count != null) {
      if (!Number.isInteger(value.count) || value.count < 1 || value.count > 520) return { ok: false };
      count = value.count;
    }
    return {
      ok: true,
      recurrence: {
        frequency: "weekly",
        weekdays: canonicalWeekdays(seen),
        until: until,
        count: count,
      },
    };
  }

  function seriesProblem(date, recurrence) {
    if (!recurrence) return "";
    if (recurrence.until && recurrence.count) {
      return "Should this series end on a date or after a number of occurrences?";
    }
    if (date && recurrence.weekdays.indexOf(weekdayCode(date)) === -1) {
      return "That date is not on the weekly schedule. What date should the series start?";
    }
    if (date && recurrence.until && recurrence.until < date) {
      return "The series end date is before the first occurrence. What end date should this series use?";
    }
    return "";
  }

  function recurrenceScheduleText(recurrence) {
    if (!recurrence) return "";
    const names = canonicalWeekdays(recurrence.weekdays).map((day) => WEEKDAY_LABELS[day]);
    if (names.length === 1) return "Every " + names[0];
    if (names.length === 2) return "Every " + names[0] + " and " + names[1];
    return "Every " + names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
  }

  function seriesEndText(recurrence) {
    if (!recurrence) return "";
    if (recurrence.until) return "Ends " + formatCompactDate(recurrence.until);
    if (recurrence.count === 1) return "Ends after 1 occurrence";
    if (recurrence.count) return "Ends after " + recurrence.count + " occurrences";
    return "No end date";
  }

  function attachSeries(event, recurrence) {
    const series = recurrence || null;
    event.recurrence = series;
    event.recurrenceText = series ? recurrenceScheduleText(series) : "";
    event.seriesEndText = series ? seriesEndText(series) : "";
    return event;
  }

  function isSeriesLimitQuestion(question) {
    const lower = String(question || "").toLowerCase();
    return (
      lower.indexOf("when should this weekly series end") !== -1 ||
      lower.indexOf("how long should this repeat") !== -1 ||
      lower.indexOf("how many weeks") !== -1 ||
      lower.indexOf("does this repeat") !== -1 ||
      lower.indexOf("is this a recurring") !== -1 ||
      lower.indexOf("until when") !== -1 ||
      lower.indexOf("when does this series end") !== -1
    );
  }

  function isUnnecessaryQuestion(question, event, dropSeriesLimits) {
    const text = String(question || "");
    const lower = text.toLowerCase();
    if (lower.indexOf("daylight") !== -1 || lower.indexOf("does not exist") !== -1 || lower.indexOf("not later") !== -1) {
      return false;
    }
    if (text === "What should be clarified about this event?") return true;
    if (isResolvedEndQuestion(text)) return true;
    if (!event.location && /what is the location|where should this|where is this/.test(lower)) return true;
    if (/attendee|invitation|\binvite\b|\bguest\b/.test(lower)) return true;
    if (event.date && /what date should this event use|which date should/.test(lower)) return true;
    if (event.startTime && /what time does this event start/.test(lower)) return true;
    if (event.title && /what should this event be called|what is this event called/.test(lower)) return true;
    if (dropSeriesLimits && isSeriesLimitQuestion(text)) return true;
    return false;
  }

  function finish(next, recurrence, options) {
    const dropSeriesLimits = !options || options.keepSeriesQuestions !== true;
    attachSeries(next, recurrence);
    next.clarificationQuestions = dedupe(next.clarificationQuestions).filter((question) => {
      return !isUnnecessaryQuestion(question, next, dropSeriesLimits);
    });
    next.needsClarification =
      next.clarificationQuestions.length > 0 || !next.title || !next.date || !next.startTime || !next.endTime;
    return next;
  }

  function utcBasic(epoch) {
    const date = new Date(epoch);
    function two(value) {
      return String(value).padStart(2, "0");
    }
    return (
      String(date.getUTCFullYear()) +
      two(date.getUTCMonth() + 1) +
      two(date.getUTCDate()) +
      "T" +
      two(date.getUTCHours()) +
      two(date.getUTCMinutes()) +
      two(date.getUTCSeconds()) +
      "Z"
    );
  }

  function buildRecurrenceRule(recurrence, timeZone) {
    if (!recurrence || (recurrence.until && recurrence.count)) return "";
    const days = canonicalWeekdays(recurrence.weekdays);
    if (!days.length) return "";
    let rule = "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=" + days.join(",");
    if (recurrence.count) return rule + ";COUNT=" + recurrence.count;
    if (!recurrence.until) return rule;
    const end = resolveLocal(recurrence.until, "23:59", timeZone);
    if (!end.ok) return "";
    // UNTIL is inclusive and must be UTC. Use the end of that local day so the day's occurrence remains.
    return rule + ";UNTIL=" + utcBasic(end.epoch + 59000);
  }

  function seriesScope(text) {
    const source = String(text || "");
    const instance = /\b(?:this occurrence|only this|just this|this one only|this week only|only this (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(source);
    const series = /\b(?:entire series|whole series|all future|all of them|every occurrence|the series)\b/i.test(source);
    if (instance && series) return "ambiguous";
    if (instance) return "instance";
    if (series) return "series";
    return "ambiguous";
  }

  function editedSeries(extracted, current) {
    if (extracted && extracted.recurrence) return extracted.recurrence;
    if (current && current.recurrence) return current.recurrence;
    return null;
  }

  function blankSchedule(event) {
    const startingReminders = Object.hasOwn(event, "reminders")
      ? event.reminders
      : { useDefault: true, overrides: [] };
    const reminders = applyReminderChange(
      startingReminders,
      event.notificationAction,
      event.notificationOverrides
    );
    return {
      title: event.title,
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      endDate: event.date,
      timeZone: event.timeZone,
      location: event.location,
      reminders: reminders || startingReminders,
      needsClarification: false,
      clarificationQuestions: dedupe(event.clarificationQuestions),
      durationDefaulted: false,
    };
  }

  function ask(next, question, recurrence) {
    next.clarificationQuestions = [question];
    return finish(next, recurrence, { keepSeriesQuestions: true });
  }

  function applySchedule(event, sourceText, clock) {
    const next = blankSchedule(event);
    const notificationOnly = event.notificationAction && event.notificationAction !== "preserve" &&
      !event.title && !event.date && !event.startTime && !event.endTime && !event.location && !event.recurrence;
    if (notificationOnly) {
      next.clarificationQuestions = ["Which event do you mean?"];
      next.needsClarification = true;
      return attachSeries(next, null);
    }
    const kind = textRecurrenceKind(sourceText);
    if (kind === "unsupported") {
      return ask(
        next,
        "QuickCal cannot create that repeat pattern. What weekly schedule should this event use?",
        null
      );
    }

    let recurrence = null;
    if (event.recurrence) {
      const normalized = normalizeRecurrence(event.recurrence);
      if (!normalized.ok) {
        return ask(
          next,
          "QuickCal cannot create that repeat pattern. What weekly schedule should this event use?",
          null
        );
      }
      recurrence = normalized.recurrence;
    }

    if (kind === "weekly") {
      const fromText = weekdaysFromText(sourceText);
      if (!recurrence) {
        if (!fromText.length) return ask(next, "Which weekdays should this weekly event use?", null);
        recurrence = { frequency: "weekly", weekdays: fromText, until: null, count: null };
      } else if (fromText.length && !sameWeekdays(fromText, recurrence.weekdays)) {
        return ask(next, "Which weekdays should this weekly event use?", null);
      }
      if (missingSeriesLimit(sourceText, recurrence)) {
        return ask(next, "When should this weekly series end?", recurrence);
      }
    }

    if (recurrence && recurrence.until && recurrence.count) {
      return ask(next, "Should this series end on a date or after a number of occurrences?", null);
    }

    const impliedWeekly = recurrence && kind === "weekly" && !hasExplicitStart(sourceText);
    if (impliedWeekly) {
      if (next.startTime && clock && clock.localDate && clock.localTime) {
        next.date = nextWeeklyDate(clock.localDate, clock.localTime, recurrence.weekdays, next.startTime);
      } else {
        next.date = null;
      }
    } else if (
      recurrence &&
      !next.date &&
      !hasExplicitStart(sourceText) &&
      next.startTime &&
      clock &&
      clock.localDate &&
      clock.localTime
    ) {
      next.date = nextWeeklyDate(clock.localDate, clock.localTime, recurrence.weekdays, next.startTime);
    }

    if (!next.date || !next.startTime) {
      if (!next.startTime) next.clarificationQuestions.push("What time does this event start?");
      if (!next.date && !impliedWeekly) {
        next.clarificationQuestions.push(
          recurrence ? "What date should this weekly series start?" : "What date should this event use?"
        );
      }
      return finish(next, recurrence, { keepSeriesQuestions: true });
    }

    const datedProblem = seriesProblem(next.date, recurrence);
    if (datedProblem) return ask(next, datedProblem, recurrence);

    const start = resolveLocal(next.date, next.startTime, next.timeZone);
    if (!start.ok) {
      next.endTime = null;
      return ask(
        next,
        start.reason === "ambiguous"
          ? "That start time happens twice because of a daylight-saving change. Which time should this event use?"
          : "That start time does not exist in this time zone. What time should this event use?",
        recurrence
      );
    }

    if (!next.endTime) {
      const duration = explicitDurationMinutes(sourceText);
      if (duration && duration.ambiguous) return ask(next, "Which duration should this event use?", recurrence);
      const minutes = duration ? duration.minutes : 60;
      const end = localFromEpoch(start.epoch + minutes * 60000, next.timeZone);
      next.endDate = end.date;
      next.endTime = end.time;
      next.durationDefaulted = !duration;
    } else {
      const end = resolveLocal(next.date, next.endTime, next.timeZone);
      if (end.ok && end.epoch > start.epoch) {
        next.endDate = next.date;
      } else if (!end.ok) {
        return ask(
          next,
          end.reason === "ambiguous"
            ? "That end time happens twice because of a daylight-saving change. Which time should this event use?"
            : "That end time does not exist in this time zone. What time should this event use?",
          recurrence
        );
      }
    }

    return finish(next, recurrence);
  }

  function normalizeDraft(value, timeZone) {
    if (value == null) return { ok: false, error: "Clarification draft is not valid." };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Clarification draft is not valid." };
    }
    const title = value.title == null ? null : typeof value.title === "string" ? value.title.trim() : null;
    if (value.title != null && !title) return { ok: false, error: "Clarification draft is not valid." };
    if (title && title.length > 200) return { ok: false, error: "Clarification draft is not valid." };
    const location = value.location == null ? null : typeof value.location === "string" ? value.location.trim() : null;
    if (value.location != null && location == null) return { ok: false, error: "Clarification draft is not valid." };
    if (location && location.length > 200) return { ok: false, error: "Clarification draft is not valid." };
    const date = value.date == null ? null : value.date;
    const startTime = value.startTime == null ? null : value.startTime;
    const endTime = value.endTime == null ? null : value.endTime;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Clarification draft is not valid." };
    if (startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
      return { ok: false, error: "Clarification draft is not valid." };
    }
    if (endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
      return { ok: false, error: "Clarification draft is not valid." };
    }
    if (value.timeZone != null && value.timeZone !== timeZone) {
      return { ok: false, error: "Clarification draft is not valid." };
    }
    const series = normalizeRecurrence(value.recurrence === undefined ? null : value.recurrence);
    const reminders = normalizeReminderSettings(value.reminders);
    if (!series.ok || !reminders.ok) return { ok: false, error: "Clarification draft is not valid." };
    return {
      ok: true,
      event: {
        title: title,
        date: date,
        startTime: startTime,
        endTime: endTime,
        timeZone: timeZone,
        location: location,
        recurrence: series.recurrence,
        reminders: reminders.reminders,
      },
    };
  }

  function applyClarification(extracted, draft, answerText, originalText, clock) {
    const current = draft || {};
    const title = extracted.title || current.title || null;
    const date = extracted.date || current.date || null;
    const startTime = extracted.startTime || current.startTime || null;
    const location = extracted.location == null ? current.location || null : extracted.location;
    const recurrence = extracted.recurrence || current.recurrence || null;
    const reminders = applyReminderChange(
      current.reminders,
      extracted.notificationAction,
      extracted.notificationOverrides
    ) || normalizeReminderSettings(current.reminders).reminders;
    const answerSetsEnd = mentionsScheduleChange(answerText);
    const endTime = answerSetsEnd ? extracted.endTime : current.endTime || null;
    const source = [originalText, answerText].filter(Boolean).join("\n");
    return applySchedule(
      {
        title: title,
        date: date,
        startTime: startTime,
        endTime: endTime,
        timeZone: current.timeZone || extracted.timeZone,
        location: location,
        recurrence: recurrence,
        reminders: reminders,
        notificationAction: "preserve",
        notificationOverrides: [],
        needsClarification: false,
        clarificationQuestions: extracted.clarificationQuestions || [],
      },
      source,
      clock
    );
  }

  function normalizeCurrentEvent(value, timeZone) {
    if (value == null) return { ok: true, event: null };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Current event must be an object." };
    }
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const location = value.location == null ? null : typeof value.location === "string" ? value.location.trim() : null;
    if (!title || title.length > 200) return { ok: false, error: "Current event is not valid." };
    if (value.location != null && location == null) return { ok: false, error: "Current event is not valid." };
    const endDate = value.endDate || value.date;
    const start = resolveLocal(value.date, value.startTime, timeZone);
    const end = resolveLocal(endDate, value.endTime, timeZone);
    const series = normalizeRecurrence(value.recurrence === undefined ? null : value.recurrence);
    const reminders = normalizeReminderSettings(value.reminders);
    if (value.timeZone !== timeZone || !start.ok || !end.ok || end.epoch <= start.epoch || !series.ok || !reminders.ok) {
      return { ok: false, error: "Current event is not valid." };
    }
    return {
      ok: true,
      event: {
        title: title,
        date: value.date,
        endDate: endDate,
        startTime: value.startTime,
        endTime: value.endTime,
        timeZone: timeZone,
        location: location || null,
        recurrence: series.recurrence,
        reminders: reminders.reminders,
      },
    };
  }

  function mentionsScheduleChange(text) {
    const source = String(text || "");
    if (explicitDurationMinutes(source)) return true;
    return /\b(until|till|til|ending|ends)\b/i.test(source) || /\bfor\s+(?:an|one|half|\d)/i.test(source);
  }

  function applyEdit(extracted, current, sourceText, clock) {
    const notificationChanged = extracted.notificationAction && extracted.notificationAction !== "preserve";
    const notificationOnly = notificationChanged && !extracted.title && !extracted.date && !extracted.startTime &&
      !extracted.endTime && !extracted.location && !extracted.recurrence;
    const reminders = applyReminderChange(
      current.reminders,
      extracted.notificationAction,
      extracted.notificationOverrides
    );
    if (!reminders) {
      return attachSeries({
        title: current.title,
        date: current.date,
        startTime: current.startTime,
        endTime: current.endTime,
        endDate: current.endDate || current.date,
        timeZone: current.timeZone,
        location: current.location || null,
        reminders: normalizeReminderSettings(current.reminders).reminders,
        needsClarification: true,
        clarificationQuestions: current.reminders && current.reminders.useDefault
          ? ["Google Calendar cannot combine calendar defaults with an event-specific notification. What custom notifications should replace the defaults?"]
          : ["An event can have at most five notifications. Which notifications should this event use?"],
        durationDefaulted: false,
      }, current.recurrence);
    }
    if (current && current.recurrence && !notificationOnly && seriesScope(sourceText) !== "series") {
      const question = seriesScope(sourceText) === "instance"
        ? "QuickCal will not change the whole series for one occurrence. Say that the entire weekly series should change, or start a new event."
        : "Should this change the entire weekly series? QuickCal will not change the series unless you say so.";
      return attachSeries({
        title: current.title,
        date: current.date,
        startTime: current.startTime,
        endTime: current.endTime,
        endDate: current.endDate || current.date,
        timeZone: current.timeZone,
        location: current.location || null,
        reminders: reminders,
        needsClarification: true,
        clarificationQuestions: [question],
        durationDefaulted: false,
      }, current.recurrence);
    }

    const series = editedSeries(extracted, current);
    const title = extracted.title || current.title;
    const date = extracted.date || current.date;
    const startTime = extracted.startTime || current.startTime;
    const location = extracted.location == null ? current.location : extracted.location;
    const questions = dedupe(extracted.clarificationQuestions).filter((question) => {
      if (isResolvedEndQuestion(question)) return false;
      if (/date should/i.test(question) && date) return false;
      if (/time does this event start|start time/i.test(question) && startTime) return false;
      if (/what is this event called|title/i.test(question) && title) return false;
      if (question === "What should be clarified about this event?") return false;
      return true;
    });
    if (questions.length) {
      return attachSeries({
        title: title,
        date: date,
        startTime: startTime,
        endTime: current.endTime,
        endDate: current.endDate || current.date,
        timeZone: current.timeZone,
        location: location,
        reminders: reminders,
        needsClarification: true,
        clarificationQuestions: questions,
        durationDefaulted: false,
      }, series);
    }

    if (notificationOnly) {
      return attachSeries({
        title: current.title,
        date: current.date,
        startTime: current.startTime,
        endTime: current.endTime,
        endDate: current.endDate || current.date,
        timeZone: current.timeZone,
        location: current.location || null,
        reminders: reminders,
        needsClarification: false,
        clarificationQuestions: [],
        durationDefaulted: false,
      }, series);
    }

    if (mentionsScheduleChange(sourceText)) {
      return applySchedule(
        {
          title: title,
          date: date,
          startTime: startTime,
          endTime: extracted.endTime,
          timeZone: current.timeZone,
          location: location,
          recurrence: series,
          reminders: reminders,
          notificationAction: "preserve",
          notificationOverrides: [],
          needsClarification: false,
          clarificationQuestions: [],
        },
        sourceText,
        clock
      );
    }

    const previousStart = resolveLocal(current.date, current.startTime, current.timeZone);
    const previousEnd = resolveLocal(current.endDate || current.date, current.endTime, current.timeZone);
    const nextStart = resolveLocal(date, startTime, current.timeZone);
    if (!previousStart.ok || !previousEnd.ok || !nextStart.ok) {
      const reason = !nextStart.ok ? nextStart.reason : "invalid";
      return attachSeries({
        title: title,
        date: date,
        startTime: startTime,
        endTime: null,
        endDate: date,
        timeZone: current.timeZone,
        location: location,
        reminders: reminders,
        needsClarification: true,
        clarificationQuestions: [
          reason === "ambiguous"
            ? "That start time happens twice because of a daylight-saving change. Which time should this event use?"
            : "That start time does not exist in this time zone. What time should this event use?",
        ],
        durationDefaulted: false,
      }, series);
    }
    const problem = seriesProblem(date, series);
    if (problem) {
      return attachSeries({
        title: title,
        date: date,
        startTime: startTime,
        endTime: current.endTime,
        endDate: current.endDate || current.date,
        timeZone: current.timeZone,
        location: location,
        reminders: reminders,
        needsClarification: true,
        clarificationQuestions: [problem],
        durationDefaulted: false,
      }, series);
    }
    const minutes = Math.round((previousEnd.epoch - previousStart.epoch) / 60000);
    const end = localFromEpoch(nextStart.epoch + minutes * 60000, current.timeZone);
    return attachSeries({
      title: title,
      date: date,
      startTime: startTime,
      endTime: end.time,
      endDate: end.date,
      timeZone: current.timeZone,
      location: location,
      reminders: reminders,
      needsClarification: false,
      clarificationQuestions: [],
      durationDefaulted: false,
    }, series);
  }

  function prepareForSave(event) {
    if (!event || typeof event !== "object" || event.needsClarification) return null;
    if (typeof event.title !== "string" || !event.title.trim() || event.title.trim().length > 200) return null;
    if (typeof event.durationDefaulted !== "boolean") return null;
    if (event.location != null && (typeof event.location !== "string" || event.location.trim().length > 200)) {
      return null;
    }
    const series = normalizeRecurrence(event.recurrence === undefined ? null : event.recurrence);
    const reminders = normalizeReminderSettings(event.reminders);
    if (!series.ok || !reminders.ok) return null;
    const recurrence = series.recurrence;
    const endDate = event.endDate || event.date;
    const start = resolveLocal(event.date, event.startTime, event.timeZone);
    const end = resolveLocal(endDate, event.endTime, event.timeZone);
    if (!start.ok || !end.ok || end.epoch <= start.epoch) return null;
    if (event.durationDefaulted && end.epoch - start.epoch !== 60 * 60000) return null;
    if (recurrence && seriesProblem(event.date, recurrence)) return null;
    const recurrenceRule = recurrence ? buildRecurrenceRule(recurrence, event.timeZone) : "";
    if (recurrence && !recurrenceRule) return null;
    const title = event.title.trim();
    const location = event.location ? event.location.trim() : "";
    return {
      fingerprint: JSON.stringify({
        title: title,
        date: event.date,
        endDate: endDate,
        startTime: event.startTime,
        endTime: event.endTime,
        timeZone: event.timeZone,
        location: location,
        recurrence: recurrence,
        reminders: reminders.reminders,
      }),
      summary: title,
      description: "Created by QuickCalAI.",
      location: location,
      startDateTime: rfc3339(start.epoch, event.timeZone),
      endDateTime: rfc3339(end.epoch, event.timeZone),
      timeZone: event.timeZone,
      date: event.date,
      endDate: endDate,
      startTime: event.startTime,
      endTime: event.endTime,
      dateText: recurrence ? formatCompactDate(event.date) : formatDateSpan(event.date, endDate),
      timeText: formatTimeRange(event.startTime, event.endTime),
      recurrence: recurrence,
      recurrenceRule: recurrenceRule,
      recurrenceText: recurrence ? recurrenceScheduleText(recurrence) : "",
      seriesEndText: recurrence ? seriesEndText(recurrence) : "",
      reminders: reminders.reminders,
      remindersText: reminderSettingsText(reminders.reminders),
    };
  }

  root.QuickCalSchedule = {
    resolveLocal: resolveLocal,
    applySchedule: applySchedule,
    prepareForSave: prepareForSave,
    explicitDurationMinutes: explicitDurationMinutes,
    formatTimeRange: formatTimeRange,
    formatDateSpan: formatDateSpan,
    formatCompactDate: formatCompactDate,
    normalizeCurrentEvent: normalizeCurrentEvent,
    normalizeRecurrence: normalizeRecurrence,
    normalizeReminderSettings: normalizeReminderSettings,
    sameReminderSettings: sameReminderSettings,
    normalizeReminderChange: normalizeReminderChange,
    applyReminderChange: applyReminderChange,
    reminderSettingsText: reminderSettingsText,
    resolveEventZone: resolveEventZone,
    recurrenceScheduleText: recurrenceScheduleText,
    seriesEndText: seriesEndText,
    applyEdit: applyEdit,
    applyClarification: applyClarification,
    normalizeDraft: normalizeDraft,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
