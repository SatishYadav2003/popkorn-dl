// Terminal drawing primitives. A line is a list of segments [text, style], so it
// can be measured and cut to the screen width before any colour codes go in.
const { theme } = require("./shared");

// 24-bit colour where the terminal has it, else the nearest of the 256. Termux has
// it but doesn't say so in COLORTERM, so it's recognised by its own variable.
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || "") || Boolean(process.env.TERMUX_VERSION);

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function rgbTo256([r, g, b]) {
  const level = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

const colorCode = (rgb, ground) =>
  TRUECOLOR ? `\x1b[${ground};2;${rgb.join(";")}m` : `\x1b[${ground};5;${rgbTo256(rgb)}m`;

const fg = (hex) => colorCode(hexToRgb(hex), 38);
const bg = (hex) => colorCode(hexToRgb(hex), 48);
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Named theme colours as foreground styles: c.title, c.dim, ...
const c = Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [k, fg(v)]));

// Colour at position t (0..1) along the theme gradient.
function gradientAt(t, stops = theme.gradient) {
  const pts = stops.map(hexToRgb);
  const x = Math.min(Math.max(t, 0), 1) * (pts.length - 1);
  const i = Math.min(Math.floor(x), pts.length - 2);
  const f = x - i;
  return pts[i].map((v, k) => Math.round(v + (pts[i + 1][k] - v) * f));
}
const gradientFg = (t) => colorCode(gradientAt(t), 38);

// ---------- width ----------

// Columns a character takes: 0 for joiners/accents, 2 for CJK and emoji, else 1.
function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
const width = (s) => [...s].reduce((w, ch) => w + charWidth(ch.codePointAt(0)), 0);
const lineWidth = (line) => line.reduce((w, [t]) => w + width(t), 0);

// Cuts a line to `max` columns, ending in "…" if anything was dropped.
function cut(line, max) {
  if (lineWidth(line) <= max) return line;
  const out = [];
  let room = max - 1;
  for (const [text, style] of line) {
    let part = "";
    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0));
      if (w > room) break;
      part += ch;
      room -= w;
    }
    if (part) out.push([part, style]);
    if (part.length < text.length) break;
  }
  out.push(["…", c.dim]);
  return out;
}

// Cuts or pads a line to exactly `w` columns (padding takes `padStyle`, e.g. a background).
const fit = (line, w, padStyle = "") => {
  const cutLine = cut(line, w);
  const gap = w - lineWidth(cutLine);
  return gap > 0 ? [...cutLine, [" ".repeat(gap), padStyle]] : cutLine;
};

// Word-wraps plain text to lines of at most `w` columns.
function wrap(text, w) {
  const lines = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && width(cur) + 1 + width(word) > w) {
      lines.push(cur);
      cur = "";
    }
    let piece = word;
    while (width(piece) > w) {
      // a single word longer than the line: hard-break it
      lines.push((cur ? cur + " " : "") + [...piece].slice(0, w).join(""));
      piece = [...piece].slice(w).join("");
      cur = "";
    }
    cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

const render = (line) => line.map(([t, s]) => (s ? s + t + RESET : t)).join("");

// ---------- shapes ----------

// A rounded box around `body` lines, `w` columns wide in total, with an optional title.
function box(body, w, { title = [], color = c.border } = {}) {
  const inner = w - 4;
  const titleW = lineWidth(title);
  const top = titleW
    ? [["╭─ ", color], ...title, [" " + "─".repeat(Math.max(0, w - titleW - 5)) + "╮", color]]
    : [["╭" + "─".repeat(w - 2) + "╮", color]];
  return [
    top,
    ...body.map((l) => [["│ ", color], ...fit(l, inner), [" │", color]]),
    [["╰" + "─".repeat(w - 2) + "╯", color]],
  ];
}

// Centres a line in `w` columns.
const center = (line, w) => {
  const gap = Math.max(0, Math.floor((w - lineWidth(line)) / 2));
  return gap ? [[" ".repeat(gap), ""], ...line] : line;
};

// Puts `right` at the far end of a `w`-wide line that starts with `left`.
function spread(left, right, w) {
  const gap = w - lineWidth(left) - lineWidth(right);
  return gap >= 1 ? [...left, [" ".repeat(gap), ""], ...right] : cut(left, w);
}

// ---------- screen ----------

const screenSize = () => ({ w: process.stdout.columns || 80, h: process.stdout.rows || 24 });

// Draws whole screen: home, every line, clearing the rest of each line and below.
// \r\n because raw mode turns off the terminal's own newline handling.
function paint(lines) {
  const { w, h } = screenSize();
  const out = lines.slice(0, h).map((l) => render(cut(l, w)) + "\x1b[K");
  process.stdout.write("\x1b[H" + out.join("\r\n") + "\x1b[J");
}

const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l"; // separate screen (like vim) + hide cursor
const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";

module.exports = {
  c, fg, bg, BOLD, gradientFg, width, lineWidth, cut, fit, wrap, box, center, spread,
  screenSize, paint, ALT_SCREEN_ON, ALT_SCREEN_OFF,
};
