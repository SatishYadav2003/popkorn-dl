// The Telegram connection, logged in as you, and the bot it talks to.
const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { EditedMessage } = require("telegram/events/EditedMessage");
const { Logger, LogLevel } = require("telegram/extensions/Logger");
const { SESSION_FILE } = require("./config");
const { ask } = require("./input");

// Filled in by connect(); other modules read tg.client / tg.bot.
const tg = { client: null, bot: null };

async function connect() {
  const saved = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
  const client = new TelegramClient(new StringSession(saved), Number(process.env.TG_API_ID), process.env.TG_API_HASH, {
    connectionRetries: 5,
    baseLogger: new Logger(LogLevel.ERROR), // otherwise it prints a version banner on connect
  });

  // Asks for the code only when there's no valid session yet.
  await client.start({
    phoneNumber: async () => process.env.TG_PHONE,
    phoneCode: async () => ask("Code from Telegram app: "),
    password: async () => ask("2-step verification password: "),
    onError: (err) => console.error("  ❌", err.message),
  });
  fs.writeFileSync(SESSION_FILE, client.session.save(), { mode: 0o600 });

  tg.client = client;
  tg.bot = await client.getEntity(process.env.BOT_USERNAME);
}

// Next incoming (or edited) bot message that satisfies predicate, else null.
// Every bot message seen meanwhile goes into trail, so it can be cleaned up later.
function waitFor(predicate, timeout, trail) {
  return new Promise((resolve) => {
    const events = [
      new NewMessage({ chats: [tg.bot.id], incoming: true }),
      new EditedMessage({ chats: [tg.bot.id], incoming: true }),
    ];
    const finish = (msg) => {
      clearTimeout(timer);
      events.forEach((ev) => tg.client.removeEventHandler(handler, ev));
      resolve(msg);
    };
    const handler = (event) => {
      trail.add(event.message.id);
      if (predicate(event.message)) finish(event.message);
    };
    const timer = setTimeout(() => finish(null), timeout);
    events.forEach((ev) => tg.client.addEventHandler(handler, ev));
  });
}

module.exports = { tg, connect, waitFor };
