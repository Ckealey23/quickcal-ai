const TEST_EVENT_SUMMARY = "QuickCalAI — Test Event";
const TEST_EVENT_DESCRIPTION =
  "Test event created by QuickCalAI to verify Google Calendar integration. You can delete this event.";

function padTwo(value) {
  return String(value).padStart(2, "0");
}

function toRFC3339(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return (
    date.getFullYear() +
    "-" +
    padTwo(date.getMonth() + 1) +
    "-" +
    padTwo(date.getDate()) +
    "T" +
    padTwo(date.getHours()) +
    ":" +
    padTwo(date.getMinutes()) +
    ":" +
    padTwo(date.getSeconds()) +
    sign +
    padTwo(Math.floor(absolute / 60)) +
    ":" +
    padTwo(absolute % 60)
  );
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatClock(date) {
  let hours = date.getHours();
  const minutes = padTwo(date.getMinutes());
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return { text: hours + ":" + minutes, suffix: suffix };
}

function formatTimeRange(start, end) {
  const from = formatClock(start);
  const to = formatClock(end);
  if (from.suffix === to.suffix) {
    return from.text + "\u2013" + to.text + " " + to.suffix;
  }
  return from.text + " " + from.suffix + "\u2013" + to.text + " " + to.suffix;
}

function localTomorrowWindow(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 30, 0, 0);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    summary: TEST_EVENT_SUMMARY,
    description: TEST_EVENT_DESCRIPTION,
    startDateTime: toRFC3339(start),
    endDateTime: toRFC3339(end),
    timeZone: timeZone,
    dateText: formatDate(start),
    timeText: formatTimeRange(start, end),
  };
}

function sameTestPayload(left, right) {
  if (!left || !right) return false;
  return (
    left.summary === right.summary &&
    left.description === right.description &&
    left.startDateTime === right.startDateTime &&
    left.endDateTime === right.endDateTime &&
    left.timeZone === right.timeZone
  );
}

function isValidEventId(value) {
  return typeof value === "string" && /^[a-v0-9]{5,1024}$/.test(value);
}

self.QuickCalTestEvent = {
  SUMMARY: TEST_EVENT_SUMMARY,
  DESCRIPTION: TEST_EVENT_DESCRIPTION,
  toRFC3339: toRFC3339,
  localTomorrowWindow: localTomorrowWindow,
  sameTestPayload: sameTestPayload,
  isValidEventId: isValidEventId,
};
