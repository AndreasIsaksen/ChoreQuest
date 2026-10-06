(async () => {
  const panel = document.querySelector("#push-device");
  if (!panel) return;
  const enable = panel.querySelector("[data-push-enable]");
  const disable = panel.querySelector("[data-push-disable]");
  const status = panel.querySelector("[data-push-status]");
  const nb = document.documentElement.lang === "nb";
  const say = (en, no) => {
    status.textContent = nb ? no : en;
  };
  async function post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": panel.dataset.csrf,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Subscription failed");
  }
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    enable.disabled = true;
    say(
      "Push notifications need a supported browser and HTTPS. On iPhone/iPad, install ChoreQuest on the Home Screen first.",
      "Pushvarsler krever en støttet nettleser og HTTPS. På iPhone/iPad må ChoreQuest først legges til på hjemskjermen.",
    );
    return;
  }
  try {
    const config = await (await fetch("/api/push")).json();
    if (!config.publicKey) {
      enable.disabled = true;
      say(
        "Push notifications have not been configured on the server.",
        "Pushvarsler er ikke konfigurert på serveren.",
      );
      return;
    }
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    const render = () => {
      enable.hidden = !!subscription;
      disable.hidden = !subscription;
      say(
        subscription
          ? "Notifications enabled on this device."
          : "Notifications are off on this device.",
        subscription
          ? "Varsler er aktivert på denne enheten."
          : "Varsler er av på denne enheten.",
      );
    };
    // Rebind existing permission/subscription after login, including account switches.
    if (subscription && Notification.permission === "granted")
      await post("/api/push/subscribe", subscription.toJSON());
    render();
    enable.addEventListener("click", async () => {
      enable.disabled = true;
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          say(
            "Allow notifications in browser settings to enable them.",
            "Tillat varsler i nettleserinnstillingene for å aktivere dem.",
          );
          return;
        }
        const padding = "=".repeat((4 - (config.publicKey.length % 4)) % 4);
        const key = Uint8Array.from(
          atob(
            (config.publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"),
          ),
          (c) => c.charCodeAt(0),
        );
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        await post("/api/push/subscribe", subscription.toJSON());
        render();
      } catch {
        say(
          "Could not enable notifications. Please try again.",
          "Kunne ikke aktivere varsler. Prøv igjen.",
        );
      } finally {
        enable.disabled = false;
      }
    });
    disable.addEventListener("click", async () => {
      disable.disabled = true;
      try {
        await post("/api/push/unsubscribe", {
          endpoint: subscription.endpoint,
        });
        await subscription.unsubscribe();
        subscription = null;
        render();
      } catch {
        say(
          "Could not disable notifications. Please try again.",
          "Kunne ikke deaktivere varsler. Prøv igjen.",
        );
      } finally {
        disable.disabled = false;
      }
    });
  } catch {
    enable.disabled = true;
    say(
      "Could not load notification settings. Reload to try again.",
      "Kunne ikke laste varselinnstillinger. Last siden på nytt.",
    );
  }
})();
