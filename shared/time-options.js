(function (root) {
  const STEP_MINUTES = 5;
  const DAY_MINUTES = 24 * 60;
  const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function minutesOf(value) {
    const match = TIME.exec(value || "");
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function valueOf(minutes) {
    return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  }

  function label(value) {
    const minutes = minutesOf(value);
    if (minutes == null) return "";
    const hours = Math.floor(minutes / 60);
    const hour = hours % 12 === 0 ? 12 : hours % 12;
    return hour + ":" + String(minutes % 60).padStart(2, "0") + " " + (hours >= 12 ? "PM" : "AM");
  }

  // Every 5-minute time of the day, later than `after` when it is given. The
  // current value stays listed exactly as saved, even off the 5-minute grid.
  function options(current, after) {
    const floor = minutesOf(after);
    const selected = minutesOf(current);
    const values = [];
    for (let minutes = 0; minutes < DAY_MINUTES; minutes += STEP_MINUTES) {
      if (floor != null && minutes <= floor) continue;
      values.push(minutes);
    }
    if (selected != null && selected % STEP_MINUTES !== 0 && (floor == null || selected > floor)) {
      values.push(selected);
      values.sort((left, right) => left - right);
    }
    return values.map((minutes) => {
      const value = valueOf(minutes);
      return { value: value, label: label(value), selected: minutes === selected };
    });
  }

  // Moving the start keeps the event's length when that still ends the same day.
  function shiftedEnd(oldStart, oldEnd, newStart) {
    const start = minutesOf(oldStart);
    const end = minutesOf(oldEnd);
    const next = minutesOf(newStart);
    if (start == null || end == null || next == null || end <= start) return null;
    const moved = next + (end - start);
    return moved < DAY_MINUTES ? valueOf(moved) : null;
  }

  // Returns the new start and end for a pick, or an error when the end would not
  // follow the start on the same day.
  function applyPick(schedule, field, value) {
    const sameDay = !schedule.endDate || schedule.endDate === schedule.date;
    let startTime = schedule.startTime;
    let endTime = schedule.endTime;
    if (minutesOf(value) == null) return { ok: false, error: "Choose a valid time." };
    if (field === "start") {
      if (value === startTime) return { ok: true, changed: false, startTime: startTime, endTime: endTime };
      startTime = value;
      if (sameDay) {
        const moved = shiftedEnd(schedule.startTime, schedule.endTime, value);
        if (moved) endTime = moved;
      }
    } else {
      if (value === endTime) return { ok: true, changed: false, startTime: startTime, endTime: endTime };
      endTime = value;
    }
    if (sameDay && endTime && minutesOf(endTime) <= minutesOf(startTime)) {
      return { ok: false, error: "The end time must be after the start time." };
    }
    return { ok: true, changed: true, startTime: startTime, endTime: endTime };
  }

  root.QuickCalTimes = {
    STEP_MINUTES: STEP_MINUTES,
    label: label,
    options: options,
    shiftedEnd: shiftedEnd,
    applyPick: applyPick,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
