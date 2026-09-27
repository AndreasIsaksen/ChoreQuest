function revealTarget() {
  const id = location.hash.slice(1);
  if (!id) return;
  const target = document.getElementById(id);
  if (target instanceof HTMLDetailsElement) target.open = true;
}
revealTarget();
window.addEventListener("hashchange", revealTarget);
