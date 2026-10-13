// Preview the same completion windows as generate_chore_occurrences, without
// creating tasks, advancing the generation cursor, or affecting points.
function upcomingOccurrences(series, today, month = null) {
  const key = day => day.toISOString().slice(0, 10);
  const day = value => new Date(value + "T12:00:00Z");
  const addDays = (value, count) => {
    const result = day(value);
    result.setUTCDate(result.getUTCDate() + count);
    return key(result);
  };
  const first = month ? month + "-01" : addDays(today, 1);
  const last = month ? key(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 12))) : null;
  const result = [];
  for (const item of series) {
    if (!item.active || item.removed_at) continue;
    const anchor = day(item.starts_on);
    const months = !item.weekdays && item.interval_unit === "months";
    const step = item.weekdays ? 1 : item.interval_count * (item.interval_unit === "weeks" ? 7 : 1);
    const boundary = n => {
      if (!months) return addDays(item.starts_on, n * step);
      // Clamp each month to its last day, always using the original anchor.
      const value = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + n * item.interval_count, 1, 12));
      const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0, 12)).getUTCDate();
      value.setUTCDate(Math.min(anchor.getUTCDate(), end));
      return key(value);
    };
    const lower = day(first > today ? first : addDays(today, 1));
    const offset = months
      ? ((lower.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + lower.getUTCMonth() - anchor.getUTCMonth()) / item.interval_count
      : (lower - anchor) / 86400000 / step;
    let n = Math.max(item.generated_count || 0, 0, Math.floor(offset) - 1);
    for (;;) {
      const start = boundary(n);
      if (last && start > last) break;
      const end = addDays(boundary(n + 1), -1);
      n++;
      if (start <= today || end < first || (last && end > last) || (item.weekdays && !item.weekdays.includes(day(start).getUTCDay() || 7))) continue;
      result.push({ ...item, series_id: item.id, window_start: start, due_date: end, calendar_date: end,
        preview_id: `upcoming-series-${item.id}-${start}` });
      // Lists show the next task from every schedule, even for a distant start.
      if (!month) break;
    }
  }
  return result.sort((a, b) => a.window_start.localeCompare(b.window_start) || a.id - b.id);
}

module.exports = { upcomingOccurrences };
