// POPKORN: search the bot, pick a result, and download it or stream it to a
// video player. Same as doing it by hand in Telegram, but the script does the
// tapping. Tab on the search screen switches to MovieBox (lib/moviebox/) instead.
// The pieces live in lib/; colours, text and the bot's format in ../shared/.
const { downloadDir } = require("./lib/config");
const { tg, connect } = require("./lib/telegram");
const { interactive, closeInput } = require("./lib/input");
const { fileButtons, pageInfo, describeResult, sendSearch, turnPage } = require("./lib/bot");
const { newTrail, clearTrail, deleteSaved, cleanupAll } = require("./lib/cleanup");
const { download } = require("./lib/download");
const { stream } = require("./lib/stream");
const { scanLocal, markerFor, discardPartial } = require("./lib/library");
const moviebox = require("./lib/moviebox/browse");
const { strings, fmt } = require("./lib/shared");
const ui = require("./lib/ui");

async function main() {
  await connect(); // may ask for the login code, so before the full-screen UI starts
  ui.start({ bot: tg.bot.username, dir: downloadDir });
  // The library's own reconnect messages would scribble over the full-screen UI;
  // it reconnects by itself either way.
  if (interactive) tg.client.setLogLevel("none");

  while (true) {
    const ask = await ui.askQuery();
    if (!ask) break;
    const { query, source } = ask;
    if (source === "moviebox") {
      await moviebox.browse(query);
      continue;
    }

    const trail = newTrail();
    try {
      await browse(query, trail);
    } finally {
      await clearTrail(trail);
    }
  }

  ui.stop();
  await tg.client.disconnect();
  closeInput();
  process.exit(0);
}

// Browse the results page by page, like in Telegram, until a file is picked or you leave.
async function browse(query, trail) {
  let msg = await ui.busy(fmt(strings.searching, { query }), sendSearch(query, trail));
  if (!msg) {
    ui.notify("warning", fmt(strings.nothingFound, { query }));
    return;
  }

  while (true) {
    const results = fileButtons(msg);
    const [page, total] = pageInfo(msg);
    const local = scanLocal(); // fresh each time: a download may have just finished
    const items = results.map((b) => {
      const result = describeResult(b.text);
      return { ...result, marker: markerFor(result, local) };
    });
    const choice = await ui.pickResult(query, items, page, total);

    if (choice.action === "back") return;
    if (choice.action === "next" || choice.action === "prev") {
      const want = page + (choice.action === "next" ? 1 : -1);
      const turned = await ui.busy(fmt(strings.loadingPage, { page: want }), turnPage(msg, choice.action, trail));
      if (turned) msg = turned;
      else ui.notify("warning", strings.pageFailed);
      continue;
    }
    if (choice.action === "discard") {
      // The half-done file, and the Saved Messages copies it was resuming from.
      const { file } = items[choice.index].marker;
      const saved = discardPartial(file);
      if (saved.length) await deleteSaved(saved);
      ui.notify("info", fmt(strings.discarded, { name: file }));
      continue;
    }
    // Done with this search once the file is down or watched; leaving it cleans up the chat.
    const button = results[choice.index];
    if (await (choice.action === "stream" ? stream(button) : download(button))) return;
  }
}

process.on("SIGINT", async () => {
  ui.stop();
  console.log(`\n${strings.cleaningUp}`);
  await cleanupAll();
  process.exit(0);
});

main().catch((err) => {
  ui.stop();
  console.error(err);
  process.exit(1);
});
