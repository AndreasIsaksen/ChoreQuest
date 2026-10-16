function revealTarget() {
  const id = location.hash.slice(1);
  if (!id) return;
  const target = document.getElementById(id) || (id.startsWith("chore-") ? document.getElementById("household-plan") : null);
  if (!target) return;
  for (let element = target; element; element = element.parentElement) {
    if (element instanceof HTMLDetailsElement) element.open = true;
  }
  target.scrollIntoView({ block: "start" });
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
}
window.addEventListener("hashchange", revealTarget);
window.addEventListener("load", revealTarget);
window.addEventListener("pageshow", () => window.requestAnimationFrame(revealTarget));

for (const row of document.querySelectorAll("[data-filter-options]")) {
  const selected = row.querySelector('[aria-current="true"]');
  if (selected) row.scrollLeft = selected.offsetLeft - (row.clientWidth - selected.offsetWidth) / 2;
}
for (const form of document.querySelectorAll("[data-filter-month]")) {
  form.querySelector("[data-filter-apply]").hidden = true;
  form.addEventListener("change", () => {
    if (form.reportValidity()) form.requestSubmit();
  });
}

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

for (const form of document.querySelectorAll("[data-series-editor]")) {
  const count = form.querySelector("[data-member-count]");
  const template = count.textContent.replace(/\d+/, "{count}");
  function syncMembers() {
    const choices = [...form.querySelectorAll("[data-member-select]")];
    const selected = choices.filter(choice => choice.checked).length;
    count.textContent = template.replace("{count}", selected);
    if (choices[0]) choices[0].setCustomValidity(
      form.elements.mode.value === "cooperative" && selected < 2
        ? form.querySelector("[data-member-guidance]").textContent.trim() : "",
    );
  }
  form.addEventListener("change", syncMembers);
  syncMembers();
}

for (const form of document.querySelectorAll("[data-language-form]")) {
  form.addEventListener("change", (event) => {
    if (event.target.name !== "language") return;
    // Preserve the current section, filters, and expanded panel on the new page.
    form.elements.returnTo.value += location.hash;
    form.requestSubmit();
  });
}

for (const opener of document.querySelectorAll("[data-quick-open]")) {
  const dialog = document.querySelector("[data-quick-dialog]");
  const form = dialog.querySelector("form");
  const deadline = form.querySelector("[data-quick-deadline]");
  function syncDeadline() {
    form.querySelector("[data-quick-dates]").hidden = !deadline.checked;
    for (const input of form.querySelectorAll("[data-quick-dates] input"))
      input.disabled = !deadline.checked;
    form.elements.dueDate.required = deadline.checked;
  }
  deadline.addEventListener("change", syncDeadline);
  opener.addEventListener("click", () => dialog.showModal());
  for (const close of dialog.querySelectorAll("[data-quick-close]"))
    close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    form.reset();
    form.dispatchEvent(new Event("change", { bubbles: true }));
    syncDeadline();
    opener.focus();
  });
  form.addEventListener("submit", (event) => {
    const members = form.querySelectorAll("[data-member-select]:checked");
    const minimum = form.elements.mode.value === "cooperative" ? 2 : 1;
    if (members.length < minimum) {
      event.preventDefault();
      const choice = form.querySelector("[data-member-select]");
      if (choice) {
        choice.setCustomValidity(form.querySelector(".form-hint").textContent.trim());
        choice.reportValidity();
      }
    }
  });
  form.addEventListener("change", () => {
    for (const choice of form.querySelectorAll("[data-member-select]")) choice.setCustomValidity("");
  });
  syncDeadline();
}
// Reveal the action target after conditional form fields have their final layout.
revealTarget();
