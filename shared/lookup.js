(function (root) {
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const WEEKDAY_WORDS = [
    { re: /\b(?:mondays?|mon)\b/i, index: 1 },
    { re: /\b(?:tuesdays?|tues|tue)\b/i, index: 2 },
    { re: /\b(?:wednesdays?|wed)\b/i, index: 3 },
    { re: /\b(?:thursdays?|thurs|thu)\b/i, index: 4 },
    { re: /\b(?:fridays?|fri)\b/i, index: 5 },
    { re: /\b(?:saturdays?|sat)\b/i, index: 6 },
    { re: /\b(?:sundays?|sun)\b/i, index: 0 },
  ];

  function scheduleApi() {
    return root.QuickCalSchedule;
  }

  function clockFrom(now, timeZone) {
    const parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    let hour = parts.hour === "24" ? "00" : parts.hour;
    return {
      localDate: parts.year + "-" + parts.month + "-" + parts.day,
      localTime: hour + ":" + parts.minute,
      weekdayIndex: WEEKDAY_INDEX[parts.weekday] == null ? 0 : WEEKDAY_INDEX[parts.weekday],
    };
  }

  function addDays(date, days) {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const next = new Date(Date.UTC(year, month - 1, day + days));
    const y = String(next.getUTCFullYear());
    const m = String(next.getUTCMonth() + 1).padStart(2, "0");
    const d = String(next.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  function zonedParts(epoch, timeZone) {
    const parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(epoch)).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return { date: parts.year + "-" + parts.month + "-" + parts.day, time: hour + ":" + parts.minute };
  }

  function toMinutes(match) {
    let hour = Number(match[1] != null ? match[1] : match[4]);
    const minute = Number(match[2] != null ? match[2] : match[5] || 0);
    const suffix = match[3] ? match[3].toLowerCase() : "";
    if (suffix) {
      if (hour < 1 || hour > 12 || minute > 59) return null;
      if (suffix === "pm" && hour < 12) hour += 12;
      if (suffix === "am" && hour === 12) hour = 0;
    } else if (hour > 23 || minute > 59) {
      return null;
    }
    return { hour: hour, minute: minute, named: !!suffix };
  }

  function formatHHMM(value) {
    return String(value.hour).padStart(2, "0") + ":" + String(value.minute).padStart(2, "0");
  }

  function readClocks(text) {
    const clocks = [];
    const pattern = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b|\b([01]\d|2[0-3]):([0-5]\d)\b/gi;
    let match = pattern.exec(text);
    while (match) {
      const parsed = toMinutes(match);
      if (parsed) clocks.push({ index: match.index, time: formatHHMM(parsed), named: parsed.named });
      match = pattern.exec(text);
    }
    return clocks;
  }

  function bareTime(text) {
    return /\b(?:at|to)\s+\d{1,2}(?::[0-5]\d)?\b(?!\s*(?:am|pm)\b)/i.test(text);
  }

  function namedDate(text, clock) {
    if (/\btoday\b/i.test(text)) return clock.localDate;
    if (/\btomorrow\b/i.test(text)) return addDays(clock.localDate, 1);
    const explicit = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text);
    if (explicit) return explicit[1];
    for (let i = 0; i < WEEKDAY_WORDS.length; i += 1) {
      if (WEEKDAY_WORDS[i].re.test(text)) {
        const delta = (WEEKDAY_WORDS[i].index - clock.weekdayIndex + 7) % 7;
        return addDays(clock.localDate, delta);
      }
    }
    return "";
  }

  function personIn(text) {
    const match = /\bwith\s+([A-Za-z][A-Za-z'-]{1,40})\b/.exec(text);
    if (!match) return "";
    if (/^(me|us|you|them|him|her)$/i.test(match[1])) return "";
    return match[1];
  }

  function scopeOf(text) {
    if (/\bthis and following\b/i.test(text)) return "unsupported";
    if (/\b(entire|whole)\s+series\b/i.test(text) || /\ball\s+future\b/i.test(text) || /\bevery occurrence\b/i.test(text)) {
      return "series";
    }
    return "occurrence";
  }

  function isLookupPhrase(text) {
    if (/\b(move|reschedule)\s+(it|this|that)\b/i.test(text)) return false;
    return /\b(remove|delete)\b/i.test(text) ||
      /\bcancel\s+my\b/i.test(text) ||
      /\b(move|reschedule)\b/i.test(text) ||
      /\b(my|the)\s+(meeting|event|appointment)\b/i.test(text);
  }

  function refersToCurrent(text) {
    return /\b(it|this event|that event)\b/i.test(text) && !isLookupPhrase(text);
  }

  function buildQuery(text, clock) {
    const toAt = text.search(/\bto\b/i);
    const clocks = readClocks(text);
    const original = clocks.filter((item) => toAt === -1 || item.index < toAt);
    const destination = clocks.filter((item) => toAt !== -1 && item.index > toAt);
    const dateWord = namedDate(text, clock);
    return {
      person: personIn(text),
      date: dateWord,
      explicitDate: !!dateWord,
      startTime: original.length ? original[0].time : "",
      explicitTime: original.length > 0,
      newDate: destination.length && dateWord ? dateWord : "",
      newStartTime: destination.length ? destination[destination.length - 1].time : "",
      newEndTime: "",
      ambiguousTime: bareTime(text),
      scope: scopeOf(text),
    };
  }

  function classify(text, context) {
    const value = String(text || "").trim();
    const clock = context && context.clock ? context.clock : clockFrom(context && context.now ? context.now : new Date(), context && context.timeZone || "UTC");
    if (context && context.lookup && (context.lookup.kind === "choose" || context.lookup.kind === "ask")) {
      return { intent: "choose", text: value, clock: clock };
    }
    if (context && context.lookup && context.lookup.kind === "confirm") {
      return { intent: "correction", text: value, clock: clock };
    }
    const lookup = isLookupPhrase(value);
    const saved = !!(context && context.hasSaved);
    if (saved && refersToCurrent(value) && !lookup) return { intent: "edit-current", clock: clock };
    if (!lookup && saved && !/\b(find|search|look up)\b/i.test(value)) return { intent: "edit-current", clock: clock };
    if (!lookup) return { intent: "create", clock: clock };
    const query = buildQuery(value, clock);
    if (!query.explicitDate) query.date = clock.localDate;
    if (query.scope === "unsupported") {
      return {
        intent: "unsupported",
        message: "Changing this and the following occurrences is not supported yet. No events were changed.",
        clock: clock,
      };
    }
    const deleting = /\b(remove|delete)\b/i.test(value) || /\bcancel\s+my\b/i.test(value);
    const moving = /\b(move|reschedule)\b/i.test(value);
    if (!deleting && !moving) {
      return { intent: "find", query: query, clock: clock };
    }
    return { intent: deleting ? "delete" : "move", query: query, clock: clock };
  }

  function dayWindow(date, timeZone) {
    const api = scheduleApi();
    const start = api.resolveLocal(date, "00:00", timeZone);
    const end = api.resolveLocal(addDays(date, 1), "00:00", timeZone);
    if (!start.ok || !end.ok) return null;
    return {
      timeMin: new Date(start.epoch).toISOString(),
      timeMax: new Date(end.epoch).toISOString(),
    };
  }

  function includesPerson(item, person) {
    if (!person) return true;
    const needle = person.toLowerCase();
    const summary = String(item.summary || "").toLowerCase();
    if (summary.indexOf(needle) !== -1) return true;
    const people = Array.isArray(item.attendees) ? item.attendees : [];
    return people.some((personItem) => {
      const name = String(personItem && (personItem.displayName || personItem.email) || "").toLowerCase();
      return name.indexOf(needle) !== -1;
    });
  }

  function candidateFrom(item, timeZone) {
    const startRaw = item.start && (item.start.dateTime || item.start.date) || "";
    const endRaw = item.end && (item.end.dateTime || item.end.date) || "";
    const allDay = !!(item.start && item.start.date && !item.start.dateTime);
    const startParts = allDay ? { date: item.start.date, time: "" } : zonedParts(Date.parse(startRaw), timeZone);
    const endParts = allDay ? { date: item.end.date, time: "" } : zonedParts(Date.parse(endRaw), timeZone);
    const api = scheduleApi();
    return {
      id: item.id,
      recurringEventId: item.recurringEventId || "",
      summary: item.summary || "Untitled event",
      htmlLink: typeof item.htmlLink === "string" ? item.htmlLink : "",
      status: item.status || "confirmed",
      allDay: allDay,
      date: startParts.date,
      endDate: endParts.date,
      startTime: startParts.time,
      endTime: endParts.time,
      dateText: api.formatCompactDate(startParts.date),
      timeText: allDay ? "All day" : api.formatTimeRange(startParts.time, endParts.time),
      fingerprint: [item.id, item.summary || "", startRaw, endRaw, item.status || "confirmed"].join("|"),
    };
  }

  function matchEvents(items, query, timeZone) {
    const matches = [];
    (items || []).forEach((item) => {
      if (!item || item.status === "cancelled" || !item.id) return;
      if (!includesPerson(item, query.target || query.person)) return;
      const candidate = candidateFrom(item, timeZone);
      if (query.date && candidate.date !== query.date) return;
      if (query.explicitTime && candidate.startTime !== query.startTime) return;
      if (candidate.allDay && (query.explicitTime || query.newStartTime)) return;
      matches.push(candidate);
    });
    return matches;
  }

  function choose(text, candidates) {
    const value = String(text || "").trim().toLowerCase().replace(/^the\s+/, "");
    if (!value) return { ids: [], ask: true };
    if (/^(both|all|all listed|all of them)$/.test(value)) {
      return { ids: candidates.map((item) => item.id), all: true };
    }
    const ordinals = { first: 0, "1": 0, one: 0, second: 1, "2": 1, two: 1, third: 2, "3": 2 };
    if (Object.prototype.hasOwnProperty.call(ordinals, value) && candidates[ordinals[value]]) {
      return { ids: [candidates[ordinals[value]].id] };
    }
    const clocks = readClocks(text);
    if (clocks.length === 1) {
      const timed = candidates.filter((item) => item.startTime === clocks[0].time);
      if (timed.length === 1) return { ids: [timed[0].id] };
    }
    const titled = candidates.filter((item) => item.summary.toLowerCase().indexOf(value) !== -1);
    if (titled.length === 1) return { ids: [titled[0].id] };
    return { ids: [], ask: true };
  }

  function planMove(candidate, query, timeZone) {
    if (candidate.allDay) {
      return { unsupported: "Moving an all-day event is not supported yet. No events were changed." };
    }
    if (query.ambiguousTime) return { ask: "Which time should it move to?" };
    if (!query.newStartTime) return { ask: "What time should it move to?" };
    const api = scheduleApi();
    const date = query.newDate || candidate.date;
    const start = api.resolveLocal(candidate.date, candidate.startTime, timeZone);
    const end = api.resolveLocal(candidate.endDate || candidate.date, candidate.endTime, timeZone);
    const next = api.resolveLocal(date, query.newStartTime, timeZone);
    if (!start.ok || !end.ok || !next.ok) {
      return { unsupported: "QuickCal cannot determine that time. No events were changed." };
    }
    let endEpoch = next.epoch + (end.epoch - start.epoch);
    if (query.newEndTime) {
      const explicit = api.resolveLocal(date, query.newEndTime, timeZone);
      if (!explicit.ok || explicit.epoch <= next.epoch) return { ask: "What end time should it use?" };
      endEpoch = explicit.epoch;
    }
    if (endEpoch <= next.epoch) return { ask: "What time should it move to?" };
    const endParts = zonedParts(endEpoch, timeZone);
    return {
      id: candidate.id,
      date: date,
      startTime: query.newStartTime,
      endDate: endParts.date,
      endTime: endParts.time,
      startDateTime: new Date(next.epoch).toISOString(),
      endDateTime: new Date(endEpoch).toISOString(),
    };
  }

  function targetId(candidate, scope) {
    if (scope === "series") return candidate.recurringEventId || candidate.id;
    return candidate.id;
  }

  function enterAction(input) {
    if (!input || input.repeat || input.composing) return "ignore";
    if (input.mode === "confirming" && !String(input.text || "").trim()) {
      return input.armed ? "confirm" : "ignore";
    }
    if (!String(input.text || "").trim()) return "ignore";
    return "submit";
  }

  function mergeQuery(previous, incoming) {
    const base = previous || {};
    const next = {
      target: base.target || base.person || "",
      person: base.target || base.person || "",
      date: base.date || "",
      explicitDate: !!base.explicitDate,
      startTime: base.startTime || "",
      explicitTime: !!base.explicitTime,
      newDate: base.newDate || "",
      newStartTime: base.newStartTime || "",
      newEndTime: base.newEndTime || "",
      scope: base.scope || "occurrence",
      ambiguousTime: false,
    };
    if (!incoming) return next;
    if (incoming.target) {
      next.target = incoming.target;
      next.person = incoming.target;
    }
    if (incoming.searchDate) {
      next.date = incoming.searchDate;
      next.explicitDate = true;
    }
    if (incoming.searchTime) {
      next.startTime = incoming.searchTime;
      next.explicitTime = true;
    }
    if (incoming.destinationDate) next.newDate = incoming.destinationDate;
    if (incoming.destinationTime) next.newStartTime = incoming.destinationTime;
    if (incoming.destinationEndTime) next.newEndTime = incoming.destinationEndTime;
    if (incoming.scope) next.scope = incoming.scope;
    return next;
  }

  function sameFingerprint(candidate, item, timeZone) {
    return candidateFrom(item, timeZone).fingerprint === candidate.fingerprint;
  }

  root.QuickCalLookup = {
    clockFrom: clockFrom,
    addDays: addDays,
    classify: classify,
    dayWindow: dayWindow,
    matchEvents: matchEvents,
    choose: choose,
    planMove: planMove,
    targetId: targetId,
    enterAction: enterAction,
    candidateFrom: candidateFrom,
    sameFingerprint: sameFingerprint,
    mergeQuery: mergeQuery,
    dateIn: function (text, clock) { return namedDate(text, clock); },
    destinationTime: function (text) {
      const clocks = readClocks(text);
      return clocks.length ? clocks[clocks.length - 1].time : "";
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
