function part(parts, type) {
  const match = parts.find((item) => item.type === type);
  return match ? match.value : "";
}

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function referenceClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  let hour = part(parts, "hour");
  if (hour === "24") hour = "00";
  return {
    serverTimestamp: now.toISOString(),
    weekday: part(parts, "weekday"),
    localDate: part(parts, "year") + "-" + part(parts, "month") + "-" + part(parts, "day"),
    localTime: hour + ":" + part(parts, "minute") + ":" + part(parts, "second"),
    timeZone,
  };
}

export function addLocalDays(date, days) {
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

export function nextWeekdayDate(clock, weekdayName, options = {}) {
  if (!clock || !clock.localDate || typeof weekdayName !== "string") return null;
  const target = WEEKDAY_INDEX[weekdayName.trim().toLowerCase()];
  if (target == null) return null;
  const current = WEEKDAY_INDEX[String(clock.weekday || "").trim().toLowerCase()];
  if (current == null) return null;
  let delta = (target - current + 7) % 7;
  if (delta === 0) {
    const preferToday = options.preferToday !== false;
    if (!preferToday) delta = 7;
  }
  return addLocalDays(clock.localDate, delta);
}
