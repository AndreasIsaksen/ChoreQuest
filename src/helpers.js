function dateKey(value) {
  if (value instanceof Date)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return String(value || "").slice(0, 10);
}
function todayKey() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(
    new Date(),
  );
}
function formatDate(value, language = "en") {
  if (!value) return "";
  return new Intl.DateTimeFormat(language === "nb" ? "nb-NO" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateKey(value) + "T12:00:00Z"));
}
function calendarDays(month) {
  const first = new Date(month + "-01T12:00:00Z");
  const start = new Date(first);
  start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    return {
      key: d.toISOString().slice(0, 10),
      number: d.getUTCDate(),
      inMonth: d.getUTCMonth() === first.getUTCMonth(),
    };
  });
}
function filterChoresByMonth(chores, month) {
  return chores.filter((c) => !month || dateKey(c.due_date).startsWith(month));
}
function groupChoresByDate(chores) {
  return chores.reduce((acc, c) => {
    (acc[dateKey(c.due_date)] ||= []).push(c);
    return acc;
  }, {});
}
function groupSchedulesByTitle(series) {
  const groups = new Map();
  for (const item of series) {
    if (!groups.has(item.title)) groups.set(item.title, { title: item.title, items: [], rewards: [] });
    const group = groups.get(item.title);
    group.items.push(item);
    for (const reward of item.point_rewards || []) {
      if (!group.rewards.some(person => person.id === reward.id && person.name === reward.name && person.points === reward.points))
        group.rewards.push(reward);
    }
  }
  for (const group of groups.values()) group.rewards.sort((a, b) => a.name.localeCompare(b.name) || a.points - b.points);
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}
function choreReturnTo(value, choreId) {
  const base = typeof value === "string" && /^\/dashboard(?:[?#]|$)/.test(value) && !/[\\\r\n]/.test(value)
    ? value.split("#")[0] : "/dashboard?section=chores";
  return base + "#chore-" + choreId;
}
function choreHistoryStart(time, today) {
  if (time === "forever") return null;
  const start = new Date(today + "T12:00:00Z");
  start.setUTCDate(start.getUTCDate() - (["1", "5", "10"].includes(time) ? Number(time) : 0));
  return start.toISOString().slice(0, 10);
}
module.exports = {
  dateKey,
  todayKey,
  formatDate,
  calendarDays,
  filterChoresByMonth,
  groupChoresByDate,
  groupSchedulesByTitle,
  choreReturnTo,
  choreHistoryStart,
};
