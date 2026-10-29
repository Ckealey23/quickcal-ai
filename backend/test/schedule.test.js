import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { referenceClock } from "../src/clock.js";
import {
  applyClarification,
  applyEdit,
  applySchedule,
  normalizeReminderChange,
  normalizeReminderSettings,
  prepareForSave,
  reminderSettingsText,
  resolveEventZone,
  sameReminderSettings,
} from "../src/schedule.js";
import { validateExtraction } from "../src/validate.js";

const zone = "America/Los_Angeles";
const plain = (value) => JSON.parse(JSON.stringify(value));

describe("event notifications", () => {
  const current = {
    title: "Coffee with Alex",
    date: "2026-10-17",
    endDate: "2026-10-17",
    startTime: "10:00",
    endTime: "11:00",
    timeZone: zone,
    location: "Avila",
    recurrence: null,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
  };

  function notificationEdit(action, overrides = []) {
    return {
      title: null,
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: action,
      notificationOverrides: overrides,
      needsClarification: false,
      clarificationQuestions: [],
    };
  }

  it("uses Calendar defaults when a new event has no notification instruction", () => {
    const result = applySchedule({
      title: "Meeting",
      date: "2026-10-27",
      startTime: "15:00",
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      clarificationQuestions: [],
    }, "Meeting tomorrow at 3 PM", referenceClock(new Date("2026-10-26T12:00:00-07:00"), zone));
    assert.deepEqual(plain(result.reminders), { useDefault: true, overrides: [] });
    assert.equal(reminderSettingsText(undefined), "Notification settings not loaded");
  });

  it("treats Google reminder override order as insignificant", () => {
    const first = {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }, { method: "email", minutes: 30 }],
    };
    const reversed = {
      useDefault: false,
      overrides: [{ method: "email", minutes: 30 }, { method: "popup", minutes: 10 }],
    };
    assert.equal(sameReminderSettings(first, reversed), true);
  });

  it("adds without duplicates and preserves every unrelated event field", () => {
    const added = applyEdit(
      notificationEdit("add", [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 10 },
      ]),
      current,
      "Also notify me 10 minutes before",
    );
    assert.equal(added.title, current.title);
    assert.equal(added.date, current.date);
    assert.equal(added.startTime, current.startTime);
    assert.equal(added.endTime, current.endTime);
    assert.equal(added.location, current.location);
    assert.deepEqual(plain(added.reminders), {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 10 },
      ],
    });
  });

  it("replaces, removes, restores defaults, and formats resulting settings", () => {
    const replaced = applyEdit(
      notificationEdit("replace", [{ method: "email", minutes: 30 }]),
      current,
      "Change the notification to email 30 minutes before",
    );
    assert.deepEqual(plain(replaced.reminders), {
      useDefault: false,
      overrides: [{ method: "email", minutes: 30 }],
    });
    assert.equal(reminderSettingsText(replaced.reminders), "Email 30 minutes before");
    assert.deepEqual(plain(applyEdit(notificationEdit("remove"), current, "Remove notifications").reminders), {
      useDefault: false,
      overrides: [],
    });
    assert.deepEqual(plain(applyEdit(notificationEdit("default"), current, "Use my calendar defaults").reminders), {
      useDefault: true,
      overrides: [],
    });
  });

  it("preserves notifications when another event field changes", () => {
    const renamed = notificationEdit("preserve");
    renamed.title = "Planning with Alex";
    const result = applyEdit(renamed, current, "Rename it to Planning with Alex");
    assert.equal(result.title, "Planning with Alex");
    assert.deepEqual(plain(result.reminders), current.reminders);
  });

  it("enforces Google reminder methods, lead times, and the five-reminder maximum", () => {
    assert.equal(normalizeReminderChange("replace", [{ method: "sms", minutes: 10 }]).ok, false);
    assert.equal(normalizeReminderChange("replace", [{ method: "popup", minutes: 40321 }]).ok, false);
    assert.equal(normalizeReminderSettings({
      useDefault: false,
      overrides: [0, 1, 2, 3, 4, 5].map((minutes) => ({ method: "popup", minutes })),
    }).ok, false);
    assert.equal(normalizeReminderSettings({ useDefault: true, overrides: [{ method: "popup", minutes: 10 }] }).ok, false);
  });
});

function event(overrides = {}) {
  return {
    title: "Coffee with Alex",
    date: "2026-10-17",
    startTime: "10:00",
    endTime: null,
    timeZone: zone,
    location: null,
    recurrence: null,
    needsClarification: true,
    clarificationQuestions: ["What time does this event end?", "What time does this event end?"],
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
    },
    ...overrides,
  };
}

describe("duration default", () => {
  it("defaults a missing end time to one hour and drops the end-time question", () => {
    const result = applySchedule(validateExtraction(event(), zone).event, "Coffee with Alex tomorrow at 10 AM");
    assert.equal(result.endTime, "11:00");
    assert.equal(result.endDate, "2026-10-17");
    assert.equal(result.durationDefaulted, true);
    assert.equal(result.needsClarification, false);
    assert.deepEqual(Array.from(result.clarificationQuestions), []);
  });

  it("keeps an explicit end time", () => {
    const result = applySchedule(
      validateExtraction(event({ endTime: "10:30", needsClarification: false, clarificationQuestions: [] }), zone).event,
      "Coffee with Alex tomorrow from 10 to 10:30 AM"
    );
    assert.equal(result.endTime, "10:30");
    assert.equal(result.endDate, "2026-10-17");
    assert.equal(result.durationDefaulted, false);
    assert.equal(result.needsClarification, false);
  });

  it("uses an explicit duration instead of the one-hour default", () => {
    const result = applySchedule(
      validateExtraction(event({ startTime: "12:00" }), zone).event,
      "Lunch for 2 hours"
    );
    assert.equal(result.endTime, "14:00");
    assert.equal(result.durationDefaulted, false);
    assert.equal(result.needsClarification, false);
  });

  it("rolls a late-night default into the next date", () => {
    const result = applySchedule(
      validateExtraction(event({ startTime: "23:30" }), zone).event,
      "Coffee with Alex at 11:30 PM"
    );
    assert.equal(result.endDate, "2026-10-18");
    assert.equal(result.endTime, "00:30");
    assert.equal(result.durationDefaulted, true);
    const saved = prepareForSave(result);
    assert.equal(saved.timeZone, zone);
    assert.match(saved.startDateTime, /^2026-10-17T23:30:00-07:00$/);
    assert.match(saved.endDateTime, /^2026-10-18T00:30:00-07:00$/);
  });

  it("keeps a real clarification and asks about an ambiguous start time", () => {
    const missingDate = applySchedule(
      validateExtraction(event({ date: null, startTime: null }), zone).event,
      "Coffee with Alex"
    );
    assert.equal(missingDate.endTime, null);
    assert.equal(missingDate.durationDefaulted, false);
    assert.equal(missingDate.clarificationQuestions.filter((question) => question === "What date should this event use?").length, 1);
    assert.equal(missingDate.clarificationQuestions.some((question) => /end/i.test(question)), false);

    const ambiguous = applySchedule(
      validateExtraction(event({ date: "2026-11-01", startTime: "01:30", clarificationQuestions: [] }), zone).event,
      "Coffee at 1:30 AM"
    );
    assert.equal(ambiguous.durationDefaulted, false);
    assert.equal(ambiguous.endTime, null);
    assert.match(ambiguous.clarificationQuestions.join(" "), /daylight-saving/);
  });

  it("crosses the spring-forward gap by sixty real minutes", () => {
    const result = applySchedule(
      validateExtraction(event({ date: "2026-03-08", startTime: "01:30", clarificationQuestions: [] }), zone).event,
      "Coffee at 1:30 AM"
    );
    assert.equal(result.endDate, "2026-03-08");
    assert.equal(result.endTime, "03:30");
    assert.equal(result.durationDefaulted, true);
  });
  it("does not invent an end across a missing daylight-saving hour", () => {
    const gap = applySchedule(
      validateExtraction(event({ date: "2026-03-08", startTime: "02:30", clarificationQuestions: [] }), zone).event,
      "Coffee at 2:30 AM"
    );
    assert.equal(gap.endTime, null);
    assert.equal(gap.durationDefaulted, false);
    assert.match(gap.clarificationQuestions.join(" "), /does not exist/);
  });
});

describe("editing a saved event", () => {
  const current = {
    title: "Coffee with Alex",
    date: "2026-10-17",
    endDate: "2026-10-17",
    startTime: "10:00",
    endTime: "10:30",
    timeZone: zone,
    location: "Avila",
  };

  function extracted(overrides) {
    return validateExtraction(event({
      endTime: null,
      location: null,
      needsClarification: false,
      clarificationQuestions: [],
      ...overrides,
    }), zone).event;
  }

  it("keeps the previous duration when the start time moves", () => {
    const result = applyEdit(extracted({ startTime: "11:00", endTime: "12:00" }), current, "Move it to 11 AM");
    assert.equal(result.startTime, "11:00");
    assert.equal(result.endTime, "11:30");
    assert.equal(result.endDate, "2026-10-17");
    assert.equal(result.location, "Avila");
    assert.equal(result.title, "Coffee with Alex");
    assert.equal(result.needsClarification, false);
    assert.equal(result.durationDefaulted, false);
  });

  it("uses an explicit duration when the edit asks for one", () => {
    const result = applyEdit(extracted({ startTime: "11:00" }), current, "Move it to 11 AM for 2 hours");
    assert.equal(result.startTime, "11:00");
    assert.equal(result.endTime, "13:00");
    assert.equal(result.durationDefaulted, false);
    assert.equal(result.needsClarification, false);
  });

  it("asks for clarification instead of inventing a change", () => {
    const result = applyEdit(
      extracted({
        startTime: null,
        needsClarification: true,
        clarificationQuestions: ["Which time should this event use?"],
      }),
      current,
      "Move it"
    );
    assert.equal(result.needsClarification, true);
    assert.equal(result.startTime, "10:00");
    assert.equal(result.endTime, "10:30");
    assert.match(result.clarificationQuestions.join(" "), /Which time/);
  });
});

function weekly(overrides = {}) {
  return event({
    title: "Date with John",
    date: null,
    startTime: "18:00",
    endTime: null,
    location: null,
    recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
    needsClarification: true,
    clarificationQuestions: ["When should this weekly series end?", "What time does this event end?"],
    ...overrides,
  });
}

function clock(localDate, localTime) {
  return { localDate: localDate, localTime: localTime, timeZone: zone };
}

describe("weekly series", () => {
  const phrase = "Make a date every Friday with John at 6pm";

  it("starts on the next Friday, including later the same day", () => {
    const upcoming = applySchedule(validateExtraction(weekly(), zone).event, phrase, clock("2026-10-14", "15:00:00"));
    assert.equal(upcoming.date, "2026-10-16");
    assert.equal(upcoming.endTime, "19:00");
    assert.equal(upcoming.durationDefaulted, true);
    assert.equal(upcoming.location, null);
    assert.equal(upcoming.needsClarification, false);
    assert.deepEqual(Array.from(upcoming.clarificationQuestions), []);
    assert.equal(upcoming.recurrenceText, "Every Friday");
    assert.equal(upcoming.seriesEndText, "No end date");
    const saved = prepareForSave(upcoming);
    assert.equal(saved.recurrenceRule, "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR");
    assert.equal(saved.summary, "Date with John");

    const laterToday = applySchedule(validateExtraction(weekly(), zone).event, phrase, clock("2026-10-16", "15:00:00"));
    assert.equal(laterToday.date, "2026-10-16");

    const after = applySchedule(validateExtraction(weekly(), zone).event, phrase, clock("2026-10-16", "19:00:00"));
    assert.equal(after.date, "2026-10-23");
    const exact = applySchedule(validateExtraction(weekly(), zone).event, phrase, clock("2026-10-16", "18:00:00"));
    assert.equal(exact.date, "2026-10-23");
  });

  it("keeps an explicit duration, start date, and series limit", () => {
    const timed = applySchedule(
      validateExtraction(weekly(), zone).event,
      "Make a date every Friday with John at 6pm for 90 minutes",
      clock("2026-10-14", "15:00:00")
    );
    assert.equal(timed.date, "2026-10-16");
    assert.equal(timed.endTime, "19:30");
    assert.equal(timed.durationDefaulted, false);

    const limited = applySchedule(
      validateExtraction(weekly({
        date: "2026-11-06",
        recurrence: { frequency: "weekly", weekdays: ["FR"], until: "2026-12-18", count: null },
      }), zone).event,
      "Make a date every Friday with John at 6pm starting November 6, 2026 until December 18, 2026",
      clock("2026-10-14", "15:00:00")
    );
    assert.equal(limited.date, "2026-11-06");
    assert.equal(limited.needsClarification, false);
    const saved = prepareForSave(limited);
    assert.equal(saved.seriesEndText, "Ends Dec 18, 2026");
    assert.equal(saved.recurrenceRule, "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR;UNTIL=20261219T075959Z");

    const counted = applySchedule(
      validateExtraction(weekly({
        recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: 4 },
      }), zone).event,
      "Make a date every Friday with John at 6pm for 4 weeks",
      clock("2026-10-14", "15:00:00")
    );
    assert.equal(counted.seriesEndText, "Ends after 4 occurrences");
    assert.equal(prepareForSave(counted).recurrenceRule, "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR;COUNT=4");
  });

  it("asks instead of dropping an unsupported pattern or a missing series limit", () => {
    const daily = applySchedule(
      validateExtraction(event({
        date: "2026-10-17",
        startTime: "07:00",
        endTime: "08:00",
        needsClarification: false,
        clarificationQuestions: [],
      }), zone).event,
      "Gym every day at 7 AM"
    );
    assert.equal(daily.needsClarification, true);
    assert.equal(daily.recurrence, null);
    assert.equal(prepareForSave(daily), null);

    const other = applySchedule(
      validateExtraction(weekly({ needsClarification: false, clarificationQuestions: [] }), zone).event,
      "Make a date every other Friday with John at 6pm",
      clock("2026-10-14", "15:00:00")
    );
    assert.equal(other.needsClarification, true);
    assert.equal(prepareForSave(other), null);

    const unlimited = applySchedule(
      validateExtraction(weekly({
        clarificationQuestions: [],
        recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
      }), zone).event,
      "Make a date every Friday with John at 6pm until December 18, 2026",
      clock("2026-10-14", "15:00:00")
    );
    assert.equal(unlimited.needsClarification, true);
    assert.match(unlimited.clarificationQuestions.join(" "), /series end/);
  });

  it("preserves 6 PM local time on either side of daylight saving", () => {
    function at(date) {
      return prepareForSave(applySchedule(
        validateExtraction(weekly({
          date: date,
          clarificationQuestions: [],
          needsClarification: false,
        }), zone).event,
        "Date with John every Friday at 6pm starting " + date,
        clock("2026-01-01", "12:00:00")
      ));
    }
    const winter = at("2026-03-06");
    const summer = at("2026-10-30");
    assert.equal(winter.startDateTime, "2026-03-06T18:00:00-08:00");
    assert.equal(summer.startDateTime, "2026-10-30T18:00:00-07:00");
    assert.equal(winter.timeZone, zone);
    assert.equal(summer.timeZone, zone);
    assert.equal(winter.recurrenceRule, summer.recurrenceRule);
    assert.equal(winter.recurrenceRule.includes("UNTIL"), false);
  });

  it("uses an explicit time zone and ignores one the text does not name", () => {
    const named = "Make a date every Friday with John at 6pm Eastern";
    assert.equal(resolveEventZone("America/New_York", zone, named), "America/New_York");
    assert.equal(resolveEventZone("America/New_York", zone, "Make a date every Friday with John at 6pm"), zone);
    const easternClock = referenceClock(new Date("2026-10-17T00:30:00.000Z"), "America/New_York");
    const result = applySchedule(
      validateExtraction(weekly({ timeZone: "America/New_York" }), "America/New_York").event,
      named,
      easternClock
    );
    assert.equal(result.timeZone, "America/New_York");
    assert.equal(result.date, "2026-10-23");
    assert.equal(prepareForSave(result).startDateTime, "2026-10-23T18:00:00-04:00");
  });
});

describe("editing a recurring series", () => {
  const current = {
    title: "Date with John",
    date: "2026-10-16",
    endDate: "2026-10-16",
    startTime: "18:00",
    endTime: "19:00",
    timeZone: zone,
    location: null,
    recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
  };

  it("asks before changing the whole series and still edits a one-time event", () => {
    const ambiguous = applyEdit(
      validateExtraction(weekly({ startTime: "19:00", clarificationQuestions: [] }), zone).event,
      current,
      "Move it to 7 PM"
    );
    assert.equal(ambiguous.needsClarification, true);
    assert.equal(ambiguous.startTime, "18:00");
    assert.equal(ambiguous.endTime, "19:00");
    assert.match(ambiguous.clarificationQuestions.join(" "), /entire weekly series/);
    assert.equal(prepareForSave(ambiguous), null);

    const instance = applyEdit(
      validateExtraction(weekly({ startTime: "19:00", clarificationQuestions: [] }), zone).event,
      current,
      "Only this Friday, move it to 7 PM"
    );
    assert.equal(instance.needsClarification, true);
    assert.equal(instance.startTime, "18:00");
    assert.match(instance.clarificationQuestions.join(" "), /one occurrence/);

    const series = applyEdit(
      validateExtraction(weekly({ startTime: "19:00", title: "Date night", clarificationQuestions: [] }), zone).event,
      current,
      "Change the entire series to 7 PM"
    );
    assert.equal(series.needsClarification, false);
    assert.equal(series.startTime, "19:00");
    assert.equal(series.endTime, "20:00");
    assert.equal(series.recurrence.weekdays[0], "FR");
    assert.equal(prepareForSave(series).recurrenceRule, "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR");
  });
});

describe("unsaved clarification", () => {
  const clock = referenceClock(new Date("2026-10-19T20:00:00.000Z"), zone);

  function extracted(overrides) {
    return validateExtraction(event({
      title: null,
      date: null,
      startTime: null,
      endTime: null,
      needsClarification: false,
      clarificationQuestions: [],
      ...overrides,
    }), zone).event;
  }

  it("keeps the draft and fills one answer at a time", () => {
    const draft = {
      title: "Coffee with Alex",
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: "Avila",
      recurrence: null,
    };
    const dated = applyClarification(extracted({ date: "2026-10-20" }), draft, "Tuesday", "Coffee with Alex", clock);
    assert.equal(dated.title, "Coffee with Alex");
    assert.equal(dated.date, "2026-10-20");
    assert.equal(dated.location, "Avila");
    assert.equal(dated.startTime, null);
    assert.equal(dated.needsClarification, true);
    assert.match(dated.clarificationQuestions.join(" "), /start/);
    assert.equal(dated.clarificationQuestions.some((question) => /end/i.test(question)), false);

    const timed = applyClarification(extracted({ startTime: "20:00" }), dated, "8 PM", "Coffee with Alex", clock);
    assert.equal(timed.title, "Coffee with Alex");
    assert.equal(timed.date, "2026-10-20");
    assert.equal(timed.startTime, "20:00");
    assert.equal(timed.endTime, "21:00");
    assert.equal(timed.location, "Avila");
    assert.equal(timed.durationDefaulted, true);
    assert.equal(timed.needsClarification, false);
    assert.equal(prepareForSave(timed).summary, "Coffee with Alex");
  });

  it("applies an explicit correction and does not treat the draft as a saved series", () => {
    const draft = {
      title: "Coffee with Alex",
      date: "2026-10-20",
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
    };
    const corrected = applyClarification(
      extracted({ date: "2026-10-22", startTime: "19:00" }),
      draft,
      "Thursday at 7 PM",
      "Coffee with Alex",
      clock
    );
    assert.equal(corrected.date, "2026-10-22");
    assert.equal(corrected.startTime, "19:00");
    assert.equal(corrected.endTime, "20:00");
    assert.equal(corrected.needsClarification, false);
    assert.equal(String(corrected.clarificationQuestions || []).includes("entire weekly series"), false);

    const answered = applyClarification(
      extracted({ startTime: "20:00" }),
      {
        title: "Coffee with Alex",
        date: null,
        startTime: null,
        endTime: null,
        timeZone: zone,
        location: null,
        recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
      },
      "8 PM",
      "Coffee with Alex every Friday",
      clock
    );
    assert.equal(answered.needsClarification, false);
    assert.equal(answered.startTime, "20:00");
    assert.equal(answered.endTime, "21:00");
    assert.equal(String(answered.clarificationQuestions || []).includes("entire weekly series"), false);
  });
});
