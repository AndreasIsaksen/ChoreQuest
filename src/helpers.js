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
function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", {
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
module.exports = {
  dateKey,
  todayKey,
  formatDate,
  calendarDays,
  filterChoresByMonth,
  groupChoresByDate,
};
