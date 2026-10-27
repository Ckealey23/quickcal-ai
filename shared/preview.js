(function (root) {
  function scheduleApi() {
    return root.QuickCalSchedule;
  }

  function formatFullDate(value) {
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
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(date);
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

  function previewModel(event) {
    const schedule = scheduleApi();
    const questions = [];
    (event.clarificationQuestions || []).forEach((question) => {
      if (typeof question !== "string") return;
      const trimmed = question.trim();
      if (trimmed && questions.indexOf(trimmed) === -1) questions.push(trimmed);
    });
    const endDate = event.endDate || event.date;
    const recurring = event.recurrence && event.recurrence.frequency === "weekly";
    const saveable =
      event.needsClarification !== true &&
      !!event.title &&
      !!event.date &&
      !!event.startTime &&
      !!event.endTime &&
      questions.length === 0;
    return {
      title: event.title || "",
      date: event.date && schedule ? (recurring ? schedule.formatCompactDate(event.date) : schedule.formatDateSpan(event.date, endDate)) : event.date ? formatFullDate(event.date) : "",
      time: schedule ? schedule.formatTimeRange(event.startTime, event.endTime) : formatTimeRange(event.startTime, event.endTime),
      timeZone: event.timeZone || "",
      location: event.location || "",
      durationDefaulted: event.durationDefaulted === true,
      recurrenceText: recurring ? event.recurrenceText || (schedule ? schedule.recurrenceScheduleText(event.recurrence) : "") : "",
      seriesEndText: recurring ? event.seriesEndText || (schedule ? schedule.seriesEndText(event.recurrence) : "") : "",
      remindersText: event.remindersText || (schedule && schedule.reminderSettingsText
        ? schedule.reminderSettingsText(event.reminders)
        : ""),
      questions: questions,
      saveable: saveable,
    };
  }

  root.QuickCalPreview = {
    formatFullDate: formatFullDate,
    formatTimeRange: formatTimeRange,
    previewModel: previewModel,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
