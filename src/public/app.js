function revealTarget() {
  const id = location.hash.slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (target instanceof HTMLDetailsElement) target.open = true;
}
revealTarget();
window.addEventListener("hashchange", revealTarget);
for (const selector of document.querySelectorAll("[data-schedule]")) {
  const form = selector.closest("form");
  function syncSchedule() {
    const recurring = selector.value === "recurring";
    form.querySelector("[data-recurring]").hidden = !recurring;
    form.querySelector("[data-once]").hidden = recurring;
    form.querySelector('[name="dueDate"]').disabled = recurring;
    for (const input of form.querySelectorAll(
      "[data-recurring] input, [data-recurring] select",
    ))
      input.disabled = !recurring;
    form.querySelector('[name="startsOn"]').required = recurring;
    form.querySelector('[name="startsOn"]').min = recurring
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Oslo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date())
      : "";
    form.querySelector('[name="intervalCount"]').required = recurring;
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
