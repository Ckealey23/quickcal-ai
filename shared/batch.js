(function (root) {
  const MAX_BATCH_EVENTS = 10;
  const REF_PATTERN = /^e([1-9]|10)$/;

  function previewApi() {
    return root.QuickCalPreview;
  }

  function scheduleApi() {
    return root.QuickCalSchedule;
  }

  function isComplete(event) {
    const preview = previewApi();
    if (!preview) return false;
    return preview.previewModel(event).saveable === true;
  }

  function missingSummary(event) {
    const missing = [];
    const allDay = !!(event && (event.allDay === true || (!event.startTime && !event.endTime && event.date)));
    if (!event || !event.title) missing.push("title");
    if (!event || !event.date) missing.push("date");
    if (!allDay) {
      if (!event || !event.startTime) missing.push("start time");
      if (!event || !event.endTime) missing.push("end time");
    }
    if (event && event.needsClarification && Array.isArray(event.clarificationQuestions) && event.clarificationQuestions.length) {
      return event.clarificationQuestions[0];
    }
    if (!missing.length) return "";
    if (missing.length === 1) return "Missing " + missing[0] + ".";
    return "Missing " + missing.slice(0, -1).join(", ") + ", and " + missing[missing.length - 1] + ".";
  }

  function normalizeDraft(raw, index, timeZone) {
    if (!raw || typeof raw !== "object") return null;
    const schedule = scheduleApi();
    if (!schedule) return null;
    const ref = typeof raw.ref === "string" && REF_PATTERN.test(raw.ref) ? raw.ref : "e" + String(index + 1);
    const title = raw.title == null ? null : String(raw.title).trim() || null;
    const date = raw.date == null ? null : String(raw.date);
    const startTime = raw.startTime == null ? null : String(raw.startTime);
    const endTime = raw.endTime == null ? null : String(raw.endTime);
    const location = raw.location == null ? null : String(raw.location).trim() || null;
    let recurrence = null;
    if (raw.recurrence != null) {
      const parsed = schedule.normalizeRecurrence(raw.recurrence);
      if (!parsed.ok) return null;
      recurrence = parsed.recurrence;
    }
    let reminders = { useDefault: false, overrides: [] };
    if (Object.hasOwn(raw, "reminders")) {
      const reminderResult = schedule.normalizeReminderSettings(raw.reminders);
      if (!reminderResult.ok) return null;
      reminders = reminderResult.reminders;
    }
    const endDate = date ? (raw.endDate == null ? date : raw.endDate) : null;
    const allDay = raw.allDay === true || (!!date && !startTime);
    const event = {
      ref: ref,
      title: title,
      date: date,
      endDate: endDate,
      startTime: allDay ? null : startTime,
      endTime: allDay ? null : endTime,
      allDay: allDay,
      timeZone: typeof raw.timeZone === "string" && raw.timeZone.trim() ? raw.timeZone.trim() : timeZone,
      location: location,
      recurrence: recurrence,
      reminders: reminders,
      remindersText: schedule.reminderSettingsText(reminders),
      recurrenceText: recurrence && typeof raw.recurrenceText === "string" ? raw.recurrenceText.trim().slice(0, 120) : "",
      seriesEndText: recurrence && typeof raw.seriesEndText === "string" ? raw.seriesEndText.trim().slice(0, 120) : "",
      needsClarification: raw.needsClarification === true,
      clarificationQuestions: Array.isArray(raw.clarificationQuestions)
        ? raw.clarificationQuestions.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : [],
      durationDefaulted: allDay ? false : raw.durationDefaulted === true,
      intent: "create",
    };
    if (recurrence && schedule.recurrenceScheduleText && !event.recurrenceText) {
      event.recurrenceText = schedule.recurrenceScheduleText(recurrence);
    }
    if (recurrence && schedule.seriesEndText && !event.seriesEndText) {
      event.seriesEndText = schedule.seriesEndText(recurrence);
    }
    const complete = isComplete(event);
    if (!complete && !event.needsClarification) {
      event.needsClarification = true;
      const summary = missingSummary(event);
      if (summary && event.clarificationQuestions.indexOf(summary) === -1) {
        event.clarificationQuestions = [summary].concat(event.clarificationQuestions);
      }
    }
    return {
      ref: ref,
      event: event,
      complete: complete,
      missingText: complete ? "" : missingSummary(event),
      selected: complete,
      calendarEventId: typeof raw.calendarEventId === "string" ? raw.calendarEventId : "",
      saveStatus: typeof raw.saveStatus === "string" ? raw.saveStatus : "pending",
      savedRecord: raw.savedRecord && typeof raw.savedRecord === "object" ? raw.savedRecord : null,
      saveError: typeof raw.saveError === "string" ? raw.saveError : "",
      conflictNotice: raw.conflictNotice && typeof raw.conflictNotice === "object" ? raw.conflictNotice : null,
    };
  }

  function buildBatch(sourceText, events, timeZone) {
    const drafts = [];
    (events || []).forEach((item, index) => {
      if (drafts.length >= MAX_BATCH_EVENTS) return;
      const draft = normalizeDraft(item, index, timeZone);
      if (draft) drafts.push(draft);
    });
    return {
      sourceText: String(sourceText || "").slice(0, 2000),
      drafts: drafts,
      clarifyingRef: "",
      saving: false,
      dismissedGeneration: 0,
      generation: 1,
    };
  }

  function selectedCount(batch) {
    return (batch && batch.drafts || []).filter((draft) => draft.selected && draft.complete && draft.saveStatus !== "saved").length;
  }

  function mergePatch(batch, patches) {
    if (!batch) return batch;
    const next = Object.assign({}, batch, {
      drafts: batch.drafts.map((draft) => Object.assign({}, draft, {
        event: Object.assign({}, draft.event),
      })),
      generation: (batch.generation || 1) + 1,
    });
    (patches || []).forEach((patch) => {
      if (!patch || !patch.ref) return;
      const index = next.drafts.findIndex((draft) => draft.ref === patch.ref);
      if (index < 0) return;
      const current = next.drafts[index];
      if (patch.skip === true) {
        current.selected = false;
        return;
      }
      if (patch.event) {
        const normalized = normalizeDraft(Object.assign({}, patch.event, {
          ref: patch.ref,
          calendarEventId: current.calendarEventId,
          saveStatus: current.saveStatus,
          savedRecord: current.savedRecord,
          saveError: current.saveError,
          conflictNotice: current.conflictNotice,
        }), index, current.event.timeZone);
        if (!normalized) return;
        normalized.selected = current.selected && normalized.complete ? true : normalized.complete ? current.selected : false;
        if (!normalized.complete) normalized.selected = false;
        else if (current.selected) normalized.selected = true;
        next.drafts[index] = normalized;
      }
      if (typeof patch.selected === "boolean" && next.drafts[index].complete && next.drafts[index].saveStatus !== "saved") {
        next.drafts[index].selected = patch.selected;
      }
    });
    return next;
  }

  function contextForModel(batch, targetRef) {
    if (!batch) return null;
    return {
      sourceText: batch.sourceText,
      targetRef: targetRef || null,
      drafts: (batch.drafts || []).map((draft) => ({
        ref: draft.ref,
        title: draft.event.title,
        date: draft.event.date,
        startTime: draft.event.startTime,
        endTime: draft.event.endTime,
        location: draft.event.location,
        selected: !!draft.selected,
        complete: !!draft.complete,
        missingText: draft.missingText || "",
      })),
    };
  }

  root.QuickCalBatch = {
    MAX_BATCH_EVENTS: MAX_BATCH_EVENTS,
    REF_PATTERN: REF_PATTERN,
    isComplete: isComplete,
    missingSummary: missingSummary,
    normalizeDraft: normalizeDraft,
    buildBatch: buildBatch,
    selectedCount: selectedCount,
    mergePatch: mergePatch,
    contextForModel: contextForModel,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
