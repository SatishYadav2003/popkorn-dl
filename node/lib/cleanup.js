// Removes what the script leaves in Telegram, so the bot chat and Saved Messages
// only keep what you did by hand.
const { tg } = require("./telegram");
const ui = require("./ui");

// A trail is the set of bot-chat messages the script sent or got back during one
// search or one download.
const openTrails = new Set();
// Saved Messages copies that are only temporary (streaming), so Ctrl+C can remove them.
const tempSaved = new Set();

function newTrail() {
  const trail = new Set();
  openTrails.add(trail);
  return trail;
}

async function clearTrail(trail) {
  openTrails.delete(trail);
  if (!trail.size) return;
  try {
    await tg.client.deleteMessages(tg.bot, [...trail], { revoke: true });
  } catch (err) {
    ui.notify("warning", `Couldn't clean up the bot chat: ${err.message}`);
  }
}

async function deleteSaved(ids) {
  ids.forEach((id) => tempSaved.delete(id));
  await tg.client.deleteMessages("me", ids, { revoke: true }).catch(() => {});
}

// On Ctrl+C: whatever is still open.
async function cleanupAll() {
  for (const trail of [...openTrails]) await clearTrail(trail);
  if (tempSaved.size) await deleteSaved([...tempSaved]);
}

module.exports = { newTrail, clearTrail, tempSaved, deleteSaved, cleanupAll };
