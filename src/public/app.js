function revealTarget() {
  const id = location.hash.slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (target instanceof HTMLDetailsElement) target.open = true;
}
revealTarget();
window.addEventListener("hashchange", revealTarget);
for (const toggle of document.querySelectorAll("[data-individual-points]")) {
  const form = toggle.closest("form");
  function syncPoints() {
    const individual = toggle.checked;
    form.querySelector("[data-shared-points]").hidden = individual;
    const shared = form.querySelector('[name="points"]');
    shared.disabled = individual;
    shared.required = !individual;
    for (const row of form.querySelectorAll("[data-member-row]")) {
      const selected = row.querySelector("[data-member-select]").checked;
      const field = row.querySelector("[data-member-points]");
      const input = field.querySelector("input");
      field.hidden = !individual || !selected;
      input.disabled = field.hidden;
      input.required = !field.hidden;
    }
  }
  form.addEventListener("change", syncPoints);
  syncPoints();
}
for (const selector of document.querySelectorAll("[data-schedule]")) {
  const form = selector.closest("form");
  function syncSchedule() {
    const weekdays = selector.value === "weekdays";
    const recurring = selector.value !== "once";
    form.querySelector("[data-recurring]").hidden = !recurring || weekdays;
    form.querySelector("[data-weekdays]").hidden = !weekdays;
    for (const input of form.querySelectorAll("[data-weekdays] input"))
      input.disabled = !weekdays;
    form.querySelector("[data-once]").hidden = recurring;
    form.querySelector('[name="dueDate"]').disabled = recurring;
    for (const input of form.querySelectorAll(
      "[data-recurring] input, [data-recurring] select",
    ))
      input.disabled = !recurring || weekdays;
    form.querySelector('[name="startsOn"]').required = recurring;
    form.querySelector('[name="startsOn"]').min = recurring
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Oslo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date())
      : "";
    form.querySelector('[name="intervalCount"]').required = recurring && !weekdays;
  }
  selector.addEventListener("change", syncSchedule);
  syncSchedule();
}

for (const form of document.querySelectorAll("[data-language-form]")) {
  form.addEventListener("change", (event) => {
    if (event.target.name !== "language") return;
    // Preserve the current section, filters, and expanded panel on the new page.
    form.elements.returnTo.value += location.hash;
    form.requestSubmit();
  });
}
