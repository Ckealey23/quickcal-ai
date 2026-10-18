function part(parts, type) {
  const match = parts.find((item) => item.type === type);
  return match ? match.value : "";
}

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
