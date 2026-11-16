(function (root) {
  const DEFAULT_DURATION_MINUTES = 60;
  const DEFAULT_WINDOW_START = "09:00";
  const DEFAULT_WINDOW_END = "18:00";
  const MAX_SLOTS = 3;
  const MAX_SEARCH_DAYS = 14;
  const SLOT_STEP_MINUTES = 30;
  const PREFERENCE_WINDOWS = {
    morning: { start: "09:00", end: "12:00", label: "morning" },
    afternoon: { start: "12:00", end: "17:00", label: "afternoon" },
    evening: { start: "17:00", end: "21:00", label: "evening" },
    later: { start: null, end: null, label: "later" },
  };

  function scheduleApi() {
    return root.QuickCalSchedule;
  }

  function conflictsApi() {
    return root.QuickCalConflicts;
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

  function minutesBetween(start, end) {
    const a = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5));
    const b = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
    return b - a;
  }

  function addMinutes(time, minutes) {
    const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
    const hour = Math.floor(((total % 1440) + 1440) % 1440 / 60);
    const minute = ((total % 60) + 60) % 60;
    return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
  }

  function clampDuration(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 5) return DEFAULT_DURATION_MINUTES;
    return Math.min(480, Math.round(minutes));
  }

  function normalizePreference(value) {
    if (typeof value !== "string") return null;
    const key = value.trim().toLowerCase();
    if (PREFERENCE_WINDOWS[key]) return key;
    return null;
  }

  function resolveWindow(options) {
    const preference = normalizePreference(options && options.preference);
    let start = options && options.windowStart ? options.windowStart : DEFAULT_WINDOW_START;
    let end = options && options.windowEnd ? options.windowEnd : DEFAULT_WINDOW_END;
    let preferenceLabel = "";
    if (preference && preference !== "later" && PREFERENCE_WINDOWS[preference]) {
      start = PREFERENCE_WINDOWS[preference].start;
      end = PREFERENCE_WINDOWS[preference].end;
      preferenceLabel = PREFERENCE_WINDOWS[preference].label;
    } else if (preference === "later") {
      preferenceLabel = "later";
    }
    if (options && options.windowStart) start = options.windowStart;
    if (options && options.windowEnd) end = options.windowEnd;
    if (minutesBetween(start, end) <= 0) {
      return { ok: false, error: "That time window is not valid." };
    }
    return { ok: true, start: start, end: end, preference: preference, preferenceLabel: preferenceLabel };
  }

  function mergeBusy(intervals) {
    const sorted = (intervals || [])
      .filter((item) => item && Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
      .slice()
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    const merged = [];
    sorted.forEach((item) => {
      const last = merged[merged.length - 1];
      if (!last || item.startMs > last.endMs) {
        merged.push({ startMs: item.startMs, endMs: item.endMs });
        return;
      }
      if (item.endMs > last.endMs) last.endMs = item.endMs;
    });
    return merged;
  }

  function dayBounds(date, windowStart, windowEnd, timeZone) {
    const api = scheduleApi();
    if (!api) return null;
    const start = api.resolveLocal(date, windowStart, timeZone);
    const end = api.resolveLocal(date, windowEnd, timeZone);
    if (!start.ok || !end.ok || end.epoch <= start.epoch) return null;
    return { startMs: start.epoch, endMs: end.epoch, date: date };
  }

  function isInsideBusy(startMs, endMs, busy) {
    for (let index = 0; index < busy.length; index += 1) {
      if (conflictsApi().intervalsOverlap(startMs, endMs, busy[index].startMs, busy[index].endMs)) {
        return true;
      }
    }
    return false;
  }

  function formatSlot(date, startTime, endTime, timeZone, durationMinutes) {
    const api = scheduleApi();
    return {
      date: date,
      endDate: date,
      startTime: startTime,
      endTime: endTime,
      durationMinutes: durationMinutes,
      timeZone: timeZone,
      dateText: api.formatCompactDate(date),
      timeText: api.formatTimeRange(startTime, endTime),
      startMs: api.resolveLocal(date, startTime, timeZone).epoch,
      endMs: api.resolveLocal(date, endTime, timeZone).epoch,
    };
  }

  function collectSlotsForDay(date, options) {
    const api = scheduleApi();
    const conflicts = conflictsApi();
    if (!api || !conflicts) return [];
    const duration = clampDuration(options.durationMinutes);
    const window = resolveWindow(options);
    if (!window.ok) return [];
    const bounds = dayBounds(date, window.start, window.end, options.timeZone);
    if (!bounds) return [];
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const earliest = Math.max(bounds.startMs, nowMs);
    const busy = mergeBusy(options.busyIntervals || []);
    const slots = [];
    let cursor = earliest;
    const remainder = cursor % (SLOT_STEP_MINUTES * 60000);
    if (remainder) cursor += SLOT_STEP_MINUTES * 60000 - remainder;
    while (cursor + duration * 60000 <= bounds.endMs) {
      const endMs = cursor + duration * 60000;
      if (!isInsideBusy(cursor, endMs, busy)) {
        const startLocal = zoneParts(cursor, options.timeZone);
        const endLocal = zoneParts(endMs, options.timeZone);
        if (startLocal.date === date && endLocal.date === date) {
          slots.push(formatSlot(date, startLocal.time, endLocal.time, options.timeZone, duration));
        }
      }
      cursor += SLOT_STEP_MINUTES * 60000;
    }
    return slots;
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
    }).formatToParts(new Date(epoch)).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    const hour = parts.hour === "24" ? "00" : parts.hour;
    return {
      date: parts.year + "-" + parts.month + "-" + parts.day,
      time: hour + ":" + parts.minute,
    };
  }

  function pickDistinctSlots(candidates, limit) {
    const selected = [];
    const max = limit || MAX_SLOTS;
    for (let index = 0; index < candidates.length && selected.length < max; index += 1) {
      const candidate = candidates[index];
      const tooClose = selected.some((item) => Math.abs(item.startMs - candidate.startMs) < 60 * 60000);
      if (tooClose && selected.length + (candidates.length - index) > max) continue;
      selected.push(candidate);
    }
    while (selected.length < max && selected.length < candidates.length) {
      const next = candidates.find((item) => selected.indexOf(item) === -1);
      if (!next) break;
      selected.push(next);
    }
    return selected.slice(0, max);
  }

  function windowFullyPast(date, windowStart, windowEnd, timeZone, nowMs, durationMinutes) {
    const bounds = dayBounds(date, windowStart, windowEnd, timeZone);
    if (!bounds) return true;
    const duration = clampDuration(durationMinutes) * 60000;
    const latestStart = bounds.endMs - duration;
    return latestStart <= nowMs;
  }

  function advancePastNamedWindow(options) {
    const preference = normalizePreference(options && options.preference);
    if (!preference || preference === "later") return options && options.searchDate;
    if (!options || !options.searchDate) return options && options.searchDate;
    if (options.searchEndDate && options.searchEndDate !== options.searchDate) {
      return options.searchDate;
    }
    const window = resolveWindow(options);
    if (!window.ok) return options.searchDate;
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    if (!windowFullyPast(options.searchDate, window.start, window.end, options.timeZone, nowMs, options.durationMinutes)) {
      return options.searchDate;
    }
    return addDays(options.searchDate, 7);
  }

  function searchRange(options) {
    let startDate = options && options.searchDate;
    if (!startDate) return { ok: false, missing: "searchDate", error: "What day should I check?" };
    const window = resolveWindow(options || {});
    if (!window.ok) return window;
    const rolled = advancePastNamedWindow(Object.assign({}, options, {
      windowStart: window.start,
      windowEnd: window.end,
      preference: window.preference,
    }));
    if (rolled && rolled !== startDate) startDate = rolled;
    const endDate = options.searchEndDate && options.searchEndDate !== options.searchDate
      ? options.searchEndDate
      : startDate;
    let cursor = startDate;
    const days = [];
    for (let step = 0; step < MAX_SEARCH_DAYS; step += 1) {
      days.push(cursor);
      if (cursor === endDate) break;
      cursor = addDays(cursor, 1);
      if (step === MAX_SEARCH_DAYS - 1 && cursor !== endDate) {
        return {
          ok: false,
          error:
            "QuickCal can search up to " +
            MAX_SEARCH_DAYS +
            " days at a time. Narrow the date range and try again.",
        };
      }
    }
    const duration = clampDuration(options.durationMinutes);
    const all = [];
    days.forEach((date) => {
      collectSlotsForDay(date, Object.assign({}, options, {
        durationMinutes: duration,
        windowStart: window.start,
        windowEnd: window.end,
      })).forEach((slot) => all.push(slot));
    });
    const after = options.afterStartMs
      ? all.filter((slot) => slot.startMs > options.afterStartMs)
      : all;
    const selected = pickDistinctSlots(after, MAX_SLOTS);
    return {
      ok: true,
      durationMinutes: duration,
      windowStart: window.start,
      windowEnd: window.end,
      preference: window.preference,
      preferenceLabel: window.preferenceLabel,
      searchDate: startDate,
      searchEndDate: endDate,
      rolledFromPastWindow: rolled !== (options && options.searchDate),
      slots: selected,
      totalFound: after.length,
    };
  }

  function summarizeDefaults(result) {
    const api = scheduleApi();
    const parts = [];
    if (result.searchDate && api) parts.push(api.formatCompactDate(result.searchDate));
    parts.push(result.durationMinutes === 60 ? "1-hour default" : result.durationMinutes + "-minute meetings");
    if (result.preferenceLabel) {
      parts.push(result.preferenceLabel + " " + result.windowStart + "\u2013" + result.windowEnd);
    } else {
      parts.push(result.windowStart + "\u2013" + result.windowEnd + " local");
    }
    return parts.join("; ");
  }

  function slotLines(slots, title) {
    return (slots || []).map((slot, index) => {
      const label = title ? title : "Available";
      return (index + 1) + ". " + label + ", " + slot.dateText + ", " + slot.timeText;
    });
  }

  function slotRefs(slots) {
    return (slots || []).map((slot, index) => Object.assign({}, slot, {
      ref: "c" + (index + 1),
      summary: slot.dateText + ", " + slot.timeText,
      id: "slot-" + slot.date + "-" + slot.startTime.replace(":", ""),
    }));
  }

  root.QuickCalAvailability = {
    DEFAULT_DURATION_MINUTES: DEFAULT_DURATION_MINUTES,
    DEFAULT_WINDOW_START: DEFAULT_WINDOW_START,
    DEFAULT_WINDOW_END: DEFAULT_WINDOW_END,
    MAX_SLOTS: MAX_SLOTS,
    MAX_SEARCH_DAYS: MAX_SEARCH_DAYS,
    mergeBusy: mergeBusy,
    resolveWindow: resolveWindow,
    clampDuration: clampDuration,
    searchRange: searchRange,
    collectSlotsForDay: collectSlotsForDay,
    pickDistinctSlots: pickDistinctSlots,
    summarizeDefaults: summarizeDefaults,
    slotLines: slotLines,
    slotRefs: slotRefs,
    addDays: addDays,
    normalizePreference: normalizePreference,
    advancePastNamedWindow: advancePastNamedWindow,
    windowFullyPast: windowFullyPast,
    PREFERENCE_WINDOWS: PREFERENCE_WINDOWS,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
