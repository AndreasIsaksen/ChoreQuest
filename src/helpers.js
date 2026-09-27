function filterChoresByMonth(chores, month) {
  if (!month) return chores;
  return chores.filter((chore) => String(chore.due_date).startsWith(month));
}

function groupChoresByDate(chores) {
  return chores.reduce((acc, chore) => {
    const key = String(chore.due_date);
    if (!acc[key]) acc[key] = [];
    acc[key].push(chore);
    return acc;
  }, {});
}

module.exports = { filterChoresByMonth, groupChoresByDate };
