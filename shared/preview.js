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

  function trustedCalendarUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value);
      const calendarHost =
        url.hostname === "calendar.google.com" ||
        (url.hostname === "www.google.com" && url.pathname.indexOf("/calendar/") === 0);
      if (url.protocol !== "https:" || !calendarHost) return null;
      return url;
    } catch (error) {
      return null;
    }
  }

  function browserEventKey(url) {
    const fromQuery = url.searchParams.get("eid");
    if (fromQuery) return fromQuery;
    const match = /\/eventedit\/([^/]+)$/.exec(url.pathname);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return "";
    }
  }

  function calendarEditLink(value) {
    const url = trustedCalendarUrl(value);
    if (!url || url.searchParams.get("action") === "TEMPLATE") return "";
    const key = browserEventKey(url);
    if (!key || key.length > 2048 || !/^[A-Za-z0-9+/_=-]+$/.test(key)) return "";
    return "https://calendar.google.com/calendar/r/eventedit/" + encodeURIComponent(key);
  }

  function calendarViewLink(value) {
    const url = trustedCalendarUrl(value);
    if (!url || url.searchParams.get("action") === "TEMPLATE") return "";
    if (/\/eventedit\/?$/.test(url.pathname) && !url.searchParams.get("eid")) return "";
    if (!browserEventKey(url)) return "";
    return url.href;
  }

  root.QuickCalPreview = {
    formatFullDate: formatFullDate,
    formatTimeRange: formatTimeRange,
    previewModel: previewModel,
    calendarEditLink: calendarEditLink,
    calendarViewLink: calendarViewLink,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
