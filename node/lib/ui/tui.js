// The full-screen app: keeps the screen state, redraws it, and turns key presses
// into answers for popkorn.js. Drawing itself is in ../view.js.
const readline = require("readline");
const { paint, ALT_SCREEN_ON, ALT_SCREEN_OFF, screenSize } = require("../term");
const view = require("../view");
const { strings, fmt } = require("../shared");

const TOAST_MS = { info: 4000, success: 5000, warning: 6000, error: 8000 };

class Tui {
  constructor() {
    this.s = { screen: "home", query: "", source: "telegram", busy: null, frame: 0, toasts: [], bot: "", dir: "" };
    this.answer = null; // resolves the question currently on screen
    this.active = false;
    this.lastPaint = 0;
  }

  start({ bot, dir }) {
    Object.assign(this.s, { bot, dir });
    this.active = true;
    process.stdout.write(ALT_SCREEN_ON);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.onKey = (str, key = {}) => this.handleKey(str, key);
    process.stdin.on("keypress", this.onKey);
    this.onResize = () => this.draw();
    process.stdout.on("resize", this.onResize);
    // Ticks the spinner, the download stats and expiring toasts.
    this.timer = setInterval(() => this.tick(), 100);
    process.on("exit", () => this.stop());
    this.draw();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    process.stdin.off("keypress", this.onKey);
    process.stdout.off("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_SCREEN_OFF);
  }

  // ---------- drawing ----------

  draw() {
    if (!this.active) return;
    const { w, h } = screenSize();
    const screens = {
      home: view.homeScreen,
      results: view.resultsScreen,
      download: view.downloadScreen,
      stream: view.streamScreen,
    };
    paint(screens[this.s.screen](this.s, w, h));
    this.lastPaint = Date.now();
  }

  tick() {
    const now = Date.now();
    const before = this.s.toasts.length;
    this.s.toasts = this.s.toasts.filter((t) => t.until > now);
    if (this.s.busy) this.s.frame++;
    if (this.s.busy || this.s.screen === "download" || this.s.toasts.length !== before) this.draw();
  }

  // ---------- keys ----------

  handleKey(str, key) {
    if (key.ctrl && key.name === "c") {
      this.stop();
      process.emit("SIGINT"); // same clean-up as Ctrl+C anywhere else
      return;
    }
    const handlers = { home: this.homeKey, results: this.resultsKey, stream: this.streamKey };
    const handler = handlers[this.s.screen];
    if (handler && this.answer && !this.s.busy) handler.call(this, str, key);
  }

  homeKey(str, key) {
    const s = this.s;
    if (key.name === "return" || key.name === "enter") {
      if (s.query.trim()) this.reply({ query: s.query.trim(), source: s.source });
    } else if (key.name === "tab") {
      s.source = s.source === "telegram" ? "moviebox" : "telegram";
    } else if (key.name === "escape") {
      if (s.query) s.query = "";
      else this.reply(null);
    } else if (key.name === "backspace") {
      s.query = [...s.query].slice(0, -1).join("");
    } else if (key.ctrl && key.name === "u") {
      s.query = "";
    } else if (str && !key.ctrl && !key.meta && str >= " " && str !== "\x7f") {
      s.query += str;
    }
    this.draw();
  }

  resultsKey(str, key) {
    const s = this.s;
    const n = s.items.length;
    // Waiting for y/n after x: y discards, any other key just closes the question.
    if (s.confirm) {
      s.confirm = false;
      if (str === "y" || str === "Y") return this.reply({ action: "discard", index: s.sel });
      return this.draw();
    }
    switch (key.name) {
      case "up":
        s.sel = (s.sel - 1 + n) % n;
        break;
      case "down":
        s.sel = (s.sel + 1) % n;
        break;
      case "right":
        if (s.page < s.total) return this.reply({ action: "next" });
        break;
      case "left":
        if (s.page > 1) return this.reply({ action: "prev" });
        break;
      case "return":
      case "enter":
        return this.reply({ action: s.mode === "browse" ? "open" : "download", index: s.sel });
      case "s":
        if (s.mode === "results") return this.reply({ action: "stream", index: s.sel });
        break;
      case "x":
        // Only a half-done download can be discarded; a finished file stays.
        if (s.mode === "results" && s.items[s.sel].marker?.kind === "partial") s.confirm = true;
        break;
      case "escape":
      case "backspace":
        return this.reply({ action: "back" });
      default:
        // 1-9 and 0 (for 10) jump straight to an item
        if (/^[0-9]$/.test(str)) {
          const i = str === "0" ? 9 : Number(str) - 1;
          if (i < n) s.sel = i;
        }
    }
    this.draw();
  }

  streamKey(str, key) {
    if (["return", "enter", "escape"].includes(key.name)) this.reply(true);
  }

  // Shows a screen and waits for handleKey to answer.
  ask(screen) {
    this.s.screen = screen;
    this.draw();
    return new Promise((resolve) => (this.answer = resolve));
  }

  reply(value) {
    const resolve = this.answer;
    this.answer = null;
    resolve(value);
  }

  // ---------- what popkorn.js and the modules call ----------

  // { query, source } (source: "telegram" or "moviebox", switched with Tab), or null to quit.
  askQuery() {
    this.s.query = "";
    return this.ask("home");
  }

  // Shows a spinner with `text` while `promise` runs; returns its result.
  async busy(text, promise) {
    this.s.busy = text;
    this.draw();
    try {
      return await promise;
    } finally {
      this.s.busy = null;
      this.draw();
    }
  }

  // items: [{ title, size, quality, ext, marker }]; returns { action, index? }.
  // mode "results": Enter downloads, s streams, x then y discards a half-done download
  // (action "discard"). "browse": Enter opens (action "open").
  pickResult(query, items, page, total, mode = "results", sel = 0) {
    Object.assign(this.s, { query, items, page, total, mode, sel: Math.min(sel, items.length - 1), top: 0, confirm: false });
    return this.ask("results");
  }

  notify(kind, text) {
    this.s.toasts.push({ kind, text, until: Date.now() + (TOAST_MS[kind] || 5000) });
    this.draw();
  }

  // Switches to the download screen; returns hooks the downloader reports to.
  startDownload(name, size) {
    const d = { name, size, bytes: 0, startBytes: 0, startedAt: Date.now(), note: "" };
    this.s.download = d;
    this.s.screen = "download";
    this.draw();
    return {
      resumed: (done, total, bytes) => {
        d.note = fmt(strings.resuming, { done, total });
        d.bytes = d.startBytes = bytes;
        this.draw();
      },
      // Redraws at most ~10 times a second; tick() covers the rest.
      progress: (bytes) => {
        d.bytes = bytes;
        if (Date.now() - this.lastPaint > 100) this.draw();
      },
    };
  }

  endDownload() {
    this.s.screen = "home";
    this.draw();
  }

  // Shows the link until Enter; resolves then.
  streamView(name, url) {
    this.s.stream = { name, url };
    return this.ask("stream").then(() => {
      this.s.screen = "home";
      this.draw();
    });
  }
}

module.exports = { Tui };
