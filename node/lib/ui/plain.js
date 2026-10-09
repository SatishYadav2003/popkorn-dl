// Line-by-line version of the UI for when input is piped in (no keyboard):
// prints results as a numbered list and reads typed answers.
const { ask } = require("../input");
const { strings, theme, fmt } = require("../shared");
const { wrap } = require("../term");

const S = theme.symbols;
const ICON = { info: S.info, success: S.success, warning: S.warning, error: S.error };

class Plain {
  constructor() {
    this.source = "telegram";
  }

  start({ bot, dir }) {
    console.log(`🍿 ${fmt(strings.connected, { bot })}. ${fmt(strings.downloadsTo, { dir })}`);
  }

  stop() {}

  // Typing /m or /t switches between MovieBox and Telegram.
  async askQuery() {
    while (true) {
      const q = await ask(`\n🔎 Search ${strings.sources[this.source]} (/m MovieBox, /t Telegram, blank = quit): `);
      if (q === "/m" || q === "/t") this.source = q === "/m" ? "moviebox" : "telegram";
      else return q ? { query: q, source: this.source } : null;
    }
  }

  busy(text, promise) {
    return promise;
  }

  async pickResult(query, items, page, total, mode = "results") {
    console.log(`\n  📄 Page ${page}/${total}\n`);
    items.forEach((it, i) => {
      const label = `  [${i + 1}] `;
      const marker =
        it.marker?.kind === "have" ? `${S.have} ${strings.have} ` :
        it.marker?.kind === "partial" ? `${S.partial} ${it.marker.pct}% ` : "";
      // A bot result has the bot's own line (`name`); a MovieBox one is put together.
      const text = it.name
        ? `${it.size} ● ${it.name}`
        : [it.title, it.size, it.quality, it.ext].filter(Boolean).join(" ● ");
      const lines = wrap(marker + text, 78 - label.length);
      lines.forEach((l, j) => console.log((j ? " ".repeat(label.length) : label) + l));
      console.log();
    });
    const keys = mode === "browse" ? ["number = open"] : ["number = download", "number+s = stream (e.g. 3s)"];
    if (mode === "results" && items.some((it) => it.marker?.kind === "partial")) keys.push("number+x = discard partial");
    if (page < total) keys.push("n = next page");
    if (page > 1) keys.push("p = previous page");
    keys.push("blank = back");
    while (true) {
      const ans = (await ask(`  (${keys.join(", ")}): `)).toLowerCase();
      if (!ans) return { action: "back" };
      if (ans === "n" && page < total) return { action: "next" };
      if (ans === "p" && page > 1) return { action: "prev" };
      const x = /^(\d+)x$/.exec(ans);
      const picked = x && items[Number(x[1]) - 1];
      if (mode === "results" && picked?.marker?.kind === "partial") {
        const sure = (await ask(`  ${strings.discardAsk} (y/n): `)).toLowerCase();
        if (sure === "y") return { action: "discard", index: Number(x[1]) - 1 };
        continue;
      }
      const m = /^(\d+)(s?)$/.exec(ans);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= items.length && !(m[2] && mode === "browse")) {
        const action = mode === "browse" ? "open" : m[2] ? "stream" : "download";
        return { action, index: Number(m[1]) - 1 };
      }
      console.log("  ❌ invalid choice");
    }
  }

  notify(kind, text) {
    console.log(`\n  ${ICON[kind] || ""} ${text}`);
  }

  startDownload(name) {
    console.log(`\n  ${S.download} ${name}\n`);
    let startBytes = 0;
    let size = 0;
    const startedAt = Date.now();
    const samples = [];
    return {
      resumed: (done, total, bytes) => {
        startBytes = bytes;
        samples.length = 0;
        console.log("  " + fmt(strings.resuming, { done, total }) + "\n");
      },
      progress: (bytes, total) => {
        size = total || size;
        const pct = size ? Math.floor((bytes * 100) / size) : 0;
        const now = Date.now();
        samples.push({ t: now, bytes });
        const cutoff = now - 6000;
        while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
        const anchor = samples.length > 1 ? samples[0] : null;
        const speed = anchor ? (bytes - anchor.bytes) / Math.max((now - anchor.t) / 1000, 0.001)
          : (bytes - startBytes) / Math.max((now - startedAt) / 1000, 0.001);
        process.stdout.write(`\r  ${String(pct).padStart(3)}%  ${(speed / 1024 / 1024).toFixed(1)} MB/s\x1b[K`);
      },
    };
  }

  endDownload() {
    console.log();
  }

  async streamView(name, url) {
    console.log(`\n  ${S.stream} ${name}\n\n  ${strings.streamHelp}\n  ${fmt(strings.streamPlayers)}\n\n  ${url}\n`);
    await ask("  (Enter = stop streaming): ");
  }
}

module.exports = { Plain };
