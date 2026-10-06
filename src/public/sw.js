self.addEventListener("push", (event) => {
  if (!event.data) return;
  const message = event.data.json();
  event.waitUntil(
    self.registration.showNotification(message.title || "ChoreQuest", {
      body: message.body,
      tag: message.tag,
      data: { url: message.url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    event.notification.data?.url || "/dashboard",
    self.location.origin,
  );
  if (url.origin !== self.location.origin) return;
  event.waitUntil(clients.openWindow(url.href));
});
