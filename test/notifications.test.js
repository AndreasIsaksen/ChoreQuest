const test = require("node:test");
const assert = require("node:assert/strict");
const { publicAddress, createNotifications } = require("../src/notifications");
test("push endpoint network boundaries and disabled configuration", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
  ])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
  const notifications = createNotifications(
    {
      connect() {
        throw new Error("Must not connect");
      },
    },
    {},
  );
  assert.equal(notifications.publicKey, null);
  await notifications.maintain();
});
