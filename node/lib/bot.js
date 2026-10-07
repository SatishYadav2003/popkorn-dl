// Talking to the bot. How it formats its replies (button data, pager, /start
// payload, result text) is described in shared/bot.json.
const { Api } = require("telegram");
const { tg, waitFor } = require("./telegram");
const { SEARCH_TIMEOUT, FILE_TIMEOUT } = require("./config");
const { botFormat: F } = require("./shared");

const PAGER = new RegExp(F.pagerText);
const RESULT = new RegExp(F.resultText, "i");
const QUALITY = new RegExp(F.qualityTag, "i");
const EXTENSION = new RegExp(F.extensionTag, "i");

const buttonsOf = (m) => (m.replyMarkup?.rows ?? []).flatMap((r) => r.buttons);
// Older layers put callback data on the button, newer ones under button.type.
const dataOf = (b) => (b.data ?? b.type?.data)?.toString() ?? "";

const fileButtons = (m) => buttonsOf(m).filter((b) => dataOf(b).startsWith(F.fileButtonPrefix));

function pageInfo(m) {
  for (const b of buttonsOf(m)) {
    const match = b.text.match(PAGER);
    if (dataOf(b) === F.pagerData && match) return [Number(match[1]), Number(match[2])];
  }
  return [1, 1];
}

// The bot's "Next ⏩" / "⏪ Previous" button, if this page has one.
const navButton = (m, word) =>
  buttonsOf(m).find((b) => dataOf(b).startsWith(F.navDataPrefix) && b.text.toLowerCase().includes(word));

// "1.31 GB ● Avengers Endgame 2019 720p ... mkv" ->
//   { size: "1.31 GB", bytes, title: "Avengers Endgame 2019 720p ...", quality: "720p", ext: "MKV" }
function describeResult(text) {
  const m = RESULT.exec(text);
  const name = (m ? m[3] : text).trim();
  const units = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
  const ext = EXTENSION.exec(name);
  return {
    size: m ? `${m[1]} ${m[2].toUpperCase()}` : "",
    bytes: m ? Number(m[1]) * units[m[2].toUpperCase()] : null,
    name,
    title: ext ? name.slice(0, ext.index).trim() : name,
    quality: (QUALITY.exec(name)?.[1] ?? "").toLowerCase(),
    ext: ext ? ext[1].toUpperCase() : "",
  };
}

// Sends the search; returns the bot's first result page, or null.
async function sendSearch(query, trail) {
  const waiter = waitFor((m) => fileButtons(m).length > 0, SEARCH_TIMEOUT, trail);
  trail.add((await tg.client.sendMessage(tg.bot, { message: query })).id);
  return waiter;
}

// Tap Next/Previous; the bot edits the same message. Returns the new page, or null.
async function turnPage(msg, direction, trail) {
  const button = navButton(msg, direction === "next" ? F.nextWord : F.prevWord);
  if (!button) return null;
  const want = pageInfo(msg)[0] + (direction === "next" ? 1 : -1);
  const waiter = waitFor((m) => m.id === msg.id && pageInfo(m)[0] === want, SEARCH_TIMEOUT, trail);
  try {
    await tg.client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer: tg.bot, msgId: msg.id, data: Buffer.from(dataOf(button)) })
    );
  } catch {
    // Some bots never answer the callback; the edit is what we wait for.
  }
  return waiter;
}

// Gets the file from the bot and keeps a copy in Saved Messages, since the bot
// deletes its own after ~1 min. Returns { saved, name, size }, or null.
async function requestFile(button, trail) {
  // Tapping a result just hands back t.me/<bot>?start=file_<id>, so we send that
  // /start ourselves. Clicking isn't an option: Telegram rejects taps on buttons
  // from a page the bot has already paged away from.
  const start = F.startPrefix + dataOf(button).slice(F.fileButtonPrefix.length);

  const waiter = waitFor((m) => Boolean(m.document), FILE_TIMEOUT, trail);
  trail.add((await tg.client.sendMessage(tg.bot, { message: `/start ${start}` })).id);
  const msg = await waiter;
  if (!msg) return null;

  // gramjs returns one array per forwarded batch, hence flat().
  const saved = (await tg.client.forwardMessages("me", { messages: [msg.id], fromPeer: tg.bot })).flat()[0];
  return { saved, name: msg.file?.name || `${start}.mkv`, size: Number(msg.document.size) };
}

module.exports = { fileButtons, pageInfo, describeResult, sendSearch, turnPage, requestFile };
