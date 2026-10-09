// What each screen looks like. Every function here only builds lines; the TUI
// controller (ui/tui.js) decides when to draw them.
const { theme, strings, fmt } = require("./shared");
const { c, bg, BOLD, gradientFg, width, lineWidth, cut, fit, wrap, box, center, spread } = require("./term");

const S = theme.symbols;
const SEL_BG = bg(theme.colors.selectedBg);
const BLANK = [];

// ---------- pieces ----------

// The POPKORN logo in the theme gradient, the biggest version that fits.
function logo(w) {
  const art = [theme.logo.big, theme.logo.small].find((a) => width(a[0]) <= w - 2);
  if (!art) return [[[theme.logo.plain, c.title + BOLD]]];
  const artW = width(art[0]);
  return art.map((row) =>
    [...row].map((ch, x) => [
      ch,
      theme.logo.shadowChars.includes(ch) ? c.logoShadow : ch === " " ? "" : gradientFg(x / (artW - 1)) + BOLD,
    ])
  );
}

// "[Enter] Search  [Esc] Quit"
const keyHints = (pairs) =>
  pairs.flatMap(([key, label], i) => [
    ...(i ? [["   ", ""]] : []),
    ["[", c.keyBracket],
    [key, c.key + BOLD],
    ["]", c.keyBracket],
    [" " + label, c.dim],
  ]);

// Footer hints as centred lines: one if they fit, else as many as needed.
function footer(pairs, w) {
  const lines = [];
  let row = [];
  for (const pair of pairs) {
    if (row.length && lineWidth(keyHints([...row, pair])) > w) {
      lines.push(row);
      row = [];
    }
    row.push(pair);
  }
  if (row.length) lines.push(row);
  return lines.map((r) => center(cut(keyHints(r), w), w));
}

// Gradient bar `w` wide at pct (0..1), with eighth-blocks for a smooth edge.
function progressBar(pct, w) {
  const exact = Math.min(Math.max(pct, 0), 1) * w;
  const full = Math.floor(exact);
  const eighths = "▏▎▍▌▋▊▉";
  const segs = [];
  for (let i = 0; i < full; i++) segs.push([S.barFull, gradientFg(i / Math.max(w - 1, 1))]);
  const frac = Math.floor((exact - full) * 8);
  if (full < w && frac > 0) segs.push([eighths[frac - 1], gradientFg(full / Math.max(w - 1, 1))]);
  const rest = w - lineWidth(segs);
  if (rest > 0) segs.push([S.barEmpty.repeat(rest), c.barEmpty]);
  return segs;
}

const TOAST_LOOK = {
  info: [S.info + " INFO", c.info],
  success: [S.success + " DONE", c.success],
  warning: [S.warning + " NOTE", c.warning],
  error: [S.error + " ERROR", c.error],
};

// Stacks toasts in the bottom-right corner, above the footer.
function withToasts(lines, toasts, w, h) {
  if (!toasts.length) return lines;
  const tw = Math.min(w - 2, 46);
  const blocks = toasts.slice(-3).map(({ kind, text }) => {
    const [label, color] = TOAST_LOOK[kind] || TOAST_LOOK.info;
    const body = wrap(text, tw - 4).slice(0, 3).map((l) => [[l, c.text]]);
    return box(body, tw, { title: [[label, color + BOLD]], color });
  });
  const stack = blocks.flat();
  const out = [...lines];
  while (out.length < h) out.push(BLANK);
  const y0 = Math.max(0, h - 3 - stack.length);
  // On a narrow screen the toast is nearly full width; a sliver of what's behind
  // it would only show as "…", so blank that side instead.
  const left = w - tw - 1;
  stack.forEach((toastLine, i) => {
    const y = y0 + i;
    const behind = left >= 8 ? fit(out[y] || BLANK, left) : [[" ".repeat(Math.max(left, 0)), ""]];
    out[y] = [...behind, [" ", ""], ...toastLine];
  });
  return out;
}

// Pads `body` to the screen height, with the `foot` lines at the bottom.
function withFooter(body, foot, h) {
  const out = body.slice(0, h - foot.length);
  while (out.length < h - foot.length) out.push(BLANK);
  return [...out, ...foot];
}

// ---------- screens ----------

function homeScreen(s, w, h) {
  const art = logo(w);
  const artW = lineWidth(art[0]);
  const bw = Math.min(w - 2, 64);

  const typed = s.query
    ? [[s.query, c.text + BOLD], ...(s.busy ? [] : [["▏", c.focus]])]
    : [[strings.searchPlaceholder, c.dim]];
  const input = [[S.prompt + " ", c.focus + BOLD], ...typed];
  const hint = keyHints([["Enter", "Search"]]);
  const searchLine = lineWidth(input) + lineWidth(hint) + 2 <= bw - 4 ? spread(input, hint, bw - 4) : input;

  const status = s.busy
    ? [[[S.spinner[s.frame % S.spinner.length] + " ", c.info + BOLD], [s.busy, c.info]]]
    : [
        [[fmt(strings.connected, { bot: s.bot }), c.dim]],
        [[fmt(strings.downloadsTo, { dir: s.dir }), c.dim]],
      ];

  // Where the search goes: the picked source lit up, the other dimmed. Tab switches.
  const sources = Object.entries(strings.sources).flatMap(([key, label], i) => [
    ...(i ? [["   ", ""]] : []),
    key === s.source ? [`${S.have} ${label}`, c.focus + BOLD] : [`  ${label}`, c.dim],
  ]);

  const content = [
    ...art.map((l) => center(l, w)),
    center([[" ".repeat(Math.max(0, artW - theme.version.length - 1)) + "v" + theme.version, c.dim]], w),
    BLANK,
    ...box([searchLine], bw, { color: s.busy ? c.border : c.focus }).map((l) => center(l, w)),
    center(sources, w),
    BLANK,
    ...status.map((l) => center(cut(l, w - 2), w)),
  ];
  const top = Math.max(0, Math.floor((h - 1 - content.length) / 2));
  const body = [...Array(top).fill(BLANK), ...content];
  return withToasts(withFooter(body, footer([...strings.keys.home, ...strings.keys.source], w), h), s.toasts, w, h);
}

// One result as lines `cw` wide: title, then size / quality / type / marker.
function resultBlock(item, index, selected, cw) {
  const lead = selected ? [["▌", c.selectedBar + SEL_BG], [" ", SEL_BG]] : [["  ", ""]];
  const pad = selected ? SEL_BG : "";
  const num = String(index + 1).padStart(2) + " ";
  const titleStyle = selected ? c.title + BOLD + SEL_BG : c.text;
  const meta = [
    [item.size, c.size + pad],
    ...(item.quality ? [["  " + item.quality, c.quality + BOLD + pad]] : []),
    ...(item.ext ? [["  " + item.ext, c.dim + pad]] : []),
    ...(item.marker?.kind === "have" ? [[`  ${S.have} ${strings.have}`, c.success + BOLD + pad]] : []),
    ...(item.marker?.kind === "partial"
      ? [[`  ${S.partial} ${fmt(strings.partial, { pct: item.marker.pct })}`, c.warning + BOLD + pad]]
      : []),
  ];
  const titleLines = wrap(item.title, cw - 2 - num.length);
  return [
    ...titleLines.map((t, i) =>
      fit([...lead, [i ? " ".repeat(num.length) : num, c.dim + pad], [t, titleStyle]], cw, pad)
    ),
    fit([...lead, [" ".repeat(num.length), pad], ...meta], cw, pad),
  ];
}

// Picks which items to show so the selected one is visible; returns [top, lines, shown].
function viewport(blocks, sel, top, room) {
  const height = (from, to) => blocks.slice(from, to + 1).reduce((n, b) => n + b.length + 1, 0);
  top = Math.min(top, sel);
  while (top < sel && height(top, sel) > room) top++;
  const lines = [];
  let i = top;
  for (; i < blocks.length; i++) {
    if (lines.length + blocks[i].length > room && i > sel) break;
    lines.push(...blocks[i], BLANK);
  }
  return [top, lines.slice(0, room), i - top];
}

function resultsScreen(s, w, h) {
  const cw = w - 4; // 2 margin + scrollbar
  const counterFull = [[fmt(strings.resultsCounter, { item: s.sel + 1, items: s.items.length, page: s.page, pages: s.total }), c.info + BOLD]];
  const counterShort = [[`${s.sel + 1}/${s.items.length} ${S.dot} ${s.page}/${s.total}`, c.info + BOLD]];
  const query = [[S.prompt + " ", c.focus + BOLD], [s.query, c.text + BOLD]];
  const head =
    lineWidth(query) + lineWidth(counterFull) + 2 <= w - 4 ? spread(query, counterFull, w - 4) : spread(query, counterShort, w - 4);

  // The page keys only when there's another page, x only on a half-done download,
  // and while x waits for an answer, the question instead of the keys.
  const partial = s.mode === "results" && s.items[s.sel]?.marker?.kind === "partial";
  const keys = [
    ...strings.keys[s.mode].filter(([key]) => key !== "←→" || s.total > 1),
    ...(partial ? strings.keys.discard : []),
  ];
  const foot = s.confirm
    ? [center([[S.warning + " " + strings.discardAsk, c.warning + BOLD]], w), ...footer(strings.keys.confirm, w)]
    : footer(keys, w);
  const room = h - 3 - foot.length;
  const blocks = s.items.map((it, i) => resultBlock(it, i, i === s.sel, cw));
  const [top, list, shown] = viewport(blocks, s.sel, s.top, room);
  s.top = top;

  // Scrollbar on the right edge, only when some items are off screen.
  const bar = [];
  if (shown < s.items.length) {
    const thumbLen = Math.max(1, Math.round((shown / s.items.length) * (room - 2)));
    const thumbAt = Math.round((top / s.items.length) * (room - 2));
    for (let y = 0; y < room; y++) {
      if (y === 0) bar.push([top > 0 ? S.scrollUp : " ", c.focus]);
      else if (y === room - 1) bar.push([top + shown < s.items.length ? S.scrollDown : " ", c.focus]);
      else bar.push(y - 1 >= thumbAt && y - 1 < thumbAt + thumbLen ? [S.scrollThumb, c.focus] : [S.scrollTrack, c.border]);
    }
  }

  const rows = Array.from({ length: room }, (_, y) => [
    ["  ", ""],
    ...fit(list[y] || BLANK, cw),
    ...(bar[y] ? [[" ", ""], bar[y]] : []),
  ]);
  const body = [[["  ", ""], ...head], BLANK, ...rows];
  return withToasts(withFooter(body, foot, h), s.toasts, w, h);
}

// A box in the middle of the screen with `footKeys` below it.
function centeredBox(body, title, w, h, footKeys, toasts) {
  const bw = Math.min(w - 2, 72);
  const lines = box(body, bw, { title, color: c.focus }).map((l) => center(l, w));
  const top = Math.max(0, Math.floor((h - 1 - lines.length) / 2));
  const content = [...Array(top).fill(BLANK), ...lines];
  return withToasts(withFooter(content, footer(footKeys, w), h), toasts, w, h);
}

function downloadScreen(s, w, h) {
  const d = s.download;
  const inner = Math.min(w - 2, 72) - 4;
  const mb = (n) => (n / 1024 / 1024).toFixed(0);
  const now = Date.now();
  const anchor = d.samples?.length > 1 ? d.samples[0] : null;
  const speed = anchor ? (d.bytes - anchor.bytes) / Math.max((now - anchor.t) / 1000, 0.001)
    : (d.bytes - d.startBytes) / Math.max((now - d.startedAt) / 1000, 0.001);
  const eta = speed > 0 ? Math.round((d.size - d.bytes) / speed) : 0;
  const pct = d.size ? Math.min(d.bytes / d.size, 1) : 0; // MovieBox sizes are estimates
  const sizeText = fmt(strings.downloadSize, { done: mb(d.bytes), total: mb(d.size) });
  const speedText = fmt(strings.downloadSpeed, {
    speed: (speed / 1024 / 1024).toFixed(1),
    eta: `${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, "0")}`,
  });
  const pctLine = [[`${Math.floor(pct * 100)}%  `, c.title + BOLD], [sizeText, c.text]];
  // One stats line where it fits, two on a narrow screen.
  const statsLines =
    lineWidth(pctLine) + 2 + width(speedText) <= inner
      ? [[...pctLine, ["  " + speedText, c.dim]]]
      : [pctLine, [[speedText, c.dim]]];
  const body = [
    ...wrap(d.name, inner).slice(0, 3).map((l) => [[l, c.text + BOLD]]),
    BLANK,
    progressBar(pct, inner),
    ...statsLines,
    ...(d.note ? [BLANK, ...wrap(d.note, inner).map((l) => [[l, c.warning]])] : []),
  ];
  const title = [[S.download + " ", c.focus + BOLD], [strings.downloadTitle, c.title + BOLD]];
  return centeredBox(body, title, w, h, strings.keys.download, s.toasts);
}

function streamScreen(s, w, h) {
  const st = s.stream;
  const inner = Math.min(w - 2, 72) - 4;
  const body = [
    ...wrap(st.name, inner).slice(0, 3).map((l) => [[l, c.text + BOLD]]),
    BLANK,
    ...wrap(strings.streamHelp, inner).map((l) => [[l, c.dim]]),
    BLANK,
    [[st.url, c.info + BOLD]],
    BLANK,
    ...wrap(fmt(strings.streamPlayers), inner).map((l) => [[l, c.dim]]),
  ];
  const title = [[S.stream + " ", c.focus + BOLD], [strings.streamTitle, c.title + BOLD]];
  return centeredBox(body, title, w, h, strings.keys.stream, s.toasts);
}

module.exports = { homeScreen, resultsScreen, downloadScreen, streamScreen };
