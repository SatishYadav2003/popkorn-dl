"""What each screen looks like. Every function here only builds lines; the TUI
controller (ui/tui.py) decides when to draw them."""
import math
import time

from .shared import fmt, strings, theme
from .term import (BOLD, bg, box, c, center, cut, fit, gradient_fg, line_width, spread,
                   width, wrap)

S = theme["symbols"]
SEL_BG = bg(theme["colors"]["selectedBg"])
BLANK = []


# ---------- pieces ----------

def logo(w):
    """The POPKORN logo in the theme gradient, the biggest version that fits."""
    art = next((a for a in (theme["logo"]["big"], theme["logo"]["small"]) if width(a[0]) <= w - 2), None)
    if not art:
        return [[(theme["logo"]["plain"], c.title + BOLD)]]
    art_w = width(art[0])
    shadow = theme["logo"]["shadowChars"]
    return [[(ch, c.logoShadow if ch in shadow else "" if ch == " " else gradient_fg(x / (art_w - 1)) + BOLD)
             for x, ch in enumerate(row)] for row in art]


def key_hints(pairs):
    """[Enter] Search   [Esc] Quit"""
    line = []
    for i, (key, label) in enumerate(pairs):
        if i:
            line.append(("   ", ""))
        line += [("[", c.keyBracket), (key, c.key + BOLD), ("]", c.keyBracket), (" " + label, c.dim)]
    return line


def footer(pairs, w):
    """Footer hints as centred lines: one if they fit, else as many as needed."""
    lines, row = [], []
    for pair in pairs:
        if row and line_width(key_hints(row + [pair])) > w:
            lines.append(row)
            row = []
        row.append(pair)
    if row:
        lines.append(row)
    return [center(cut(key_hints(r), w), w) for r in lines]


def progress_bar(pct, w):
    """Gradient bar w wide at pct (0..1), with eighth-blocks for a smooth edge."""
    exact = min(max(pct, 0), 1) * w
    full = math.floor(exact)
    eighths = "▏▎▍▌▋▊▉"
    segs = [(S["barFull"], gradient_fg(i / max(w - 1, 1))) for i in range(full)]
    frac = math.floor((exact - full) * 8)
    if full < w and frac > 0:
        segs.append((eighths[frac - 1], gradient_fg(full / max(w - 1, 1))))
    rest = w - line_width(segs)
    if rest > 0:
        segs.append((S["barEmpty"] * rest, c.barEmpty))
    return segs


TOAST_LOOK = {
    "info": (S["info"] + " INFO", "info"),
    "success": (S["success"] + " DONE", "success"),
    "warning": (S["warning"] + " NOTE", "warning"),
    "error": (S["error"] + " ERROR", "error"),
}


def with_toasts(lines, toasts, w, h):
    """Stacks toasts in the bottom-right corner, above the footer."""
    if not toasts:
        return lines
    tw = min(w - 2, 46)
    stack = []
    for toast in toasts[-3:]:
        label, color_name = TOAST_LOOK.get(toast["kind"], TOAST_LOOK["info"])
        color = getattr(c, color_name)
        body = [[(l, c.text)] for l in wrap(toast["text"], tw - 4)[:3]]
        stack += box(body, tw, title=[(label, color + BOLD)], color=color)
    out = list(lines) + [BLANK] * max(0, h - len(lines))
    y0 = max(0, h - 3 - len(stack))
    # On a narrow screen the toast is nearly full width; a sliver of what's behind
    # it would only show as "…", so blank that side instead.
    left = w - tw - 1
    for i, toast_line in enumerate(stack):
        y = y0 + i
        behind = fit(out[y] or BLANK, left) if left >= 8 else [(" " * max(left, 0), "")]
        out[y] = [*behind, (" ", ""), *toast_line]
    return out


def with_footer(body, foot, h):
    """Pads body to the screen height, with the foot lines at the bottom."""
    out = body[:h - len(foot)]
    out += [BLANK] * (h - len(foot) - len(out))
    return out + foot


# ---------- screens ----------

def home_screen(s, w, h):
    art = logo(w)
    art_w = line_width(art[0])
    bw = min(w - 2, 64)

    if s["query"]:
        typed = [(s["query"], c.text + BOLD)] + ([] if s["busy"] else [("▏", c.focus)])
    else:
        typed = [(strings["searchPlaceholder"], c.dim)]
    prompt = [(S["prompt"] + " ", c.focus + BOLD), *typed]
    hint = key_hints([("Enter", "Search")])
    search_line = (spread(prompt, hint, bw - 4)
                   if line_width(prompt) + line_width(hint) + 2 <= bw - 4 else prompt)

    if s["busy"]:
        spinner = S["spinner"][s["frame"] % len(S["spinner"])]
        status = [[(spinner + " ", c.info + BOLD), (s["busy"], c.info)]]
    else:
        source = s.get("source", "telegram")
        source_label = (strings.get("sources") or {}).get(source, source.title())
        status = [
            [(fmt(strings["connected"], bot=s["bot"]), c.dim)],
            [(fmt(strings["downloadsTo"], dir=s["dir"]), c.dim)],
            [("[Tab] ", c.keyBracket + BOLD), (source_label, c.focus + BOLD)],
        ]

    version = "v" + theme["version"]
    content = [
        *[center(l, w) for l in art],
        center([(" " * max(0, art_w - len(version)) + version, c.dim)], w),
        BLANK,
        *[center(l, w) for l in box([search_line], bw, color=c.border if s["busy"] else c.focus)],
        BLANK,
        *[center(cut(l, w - 2), w) for l in status],
    ]
    top = max(0, (h - 1 - len(content)) // 2)
    body = [BLANK] * top + content
    foot_keys = list(strings["keys"]["home"]) + list(strings["keys"].get("source", []))
    return with_toasts(with_footer(body, footer(foot_keys, w), h), s["toasts"], w, h)


def result_block(item, index, selected, cw):
    """One result as lines cw wide: title, then size / quality / type / marker."""
    pad = SEL_BG if selected else ""
    lead = [("▌", c.selectedBar + SEL_BG), (" ", SEL_BG)] if selected else [("  ", "")]
    num = f"{index + 1:>2} "
    title_style = c.title + BOLD + SEL_BG if selected else c.text
    meta = [(item["size"], c.size + pad)]
    if item["quality"]:
        meta.append(("  " + item["quality"], c.quality + BOLD + pad))
    if item["ext"]:
        meta.append(("  " + item["ext"], c.dim + pad))
    marker = item.get("marker")
    if marker and marker["kind"] == "have":
        meta.append((f"  {S['have']} {strings['have']}", c.success + BOLD + pad))
    elif marker and marker["kind"] == "partial":
        meta.append((f"  {S['partial']} {fmt(strings['partial'], pct=marker['pct'])}", c.warning + BOLD + pad))
    title_lines = wrap(item["title"], cw - 2 - len(num))
    return [
        *[fit([*lead, (" " * len(num) if i else num, c.dim + pad), (t, title_style)], cw, pad)
          for i, t in enumerate(title_lines)],
        fit([*lead, (" " * len(num), pad), *meta], cw, pad),
    ]


def viewport(blocks, sel, top, room):
    """Picks which items to show so the selected one is visible; returns (top, lines, shown)."""
    def height(start, end):
        return sum(len(b) + 1 for b in blocks[start:end + 1])
    top = min(top, sel)
    while top < sel and height(top, sel) > room:
        top += 1
    lines, i = [], top
    while i < len(blocks):
        if len(lines) + len(blocks[i]) > room and i > sel:
            break
        lines += blocks[i] + [BLANK]
        i += 1
    return top, lines[:room], i - top


def results_screen(s, w, h):
    cw = w - 4  # 2 margin + scrollbar
    items, sel = s["items"], s["sel"]
    counter_full = [(fmt(strings["resultsCounter"], item=sel + 1, items=len(items),
                         page=s["page"], pages=s["total"]), c.info + BOLD)]
    counter_short = [(f"{sel + 1}/{len(items)} {S['dot']} {s['page']}/{s['total']}", c.info + BOLD)]
    query = [(S["prompt"] + " ", c.focus + BOLD), (s["query"], c.text + BOLD)]
    head = (spread(query, counter_full, w - 4)
            if line_width(query) + line_width(counter_full) + 2 <= w - 4
            else spread(query, counter_short, w - 4))

    foot = footer(strings["keys"]["results"], w)
    room = h - 3 - len(foot)
    blocks = [result_block(it, i, i == sel, cw) for i, it in enumerate(items)]
    top, lst, shown = viewport(blocks, sel, s["top"], room)
    s["top"] = top

    # Scrollbar on the right edge, only when some items are off screen.
    bar = []
    if shown < len(items):
        thumb_len = max(1, round(shown / len(items) * (room - 2)))
        thumb_at = round(top / len(items) * (room - 2))
        for y in range(room):
            if y == 0:
                bar.append((S["scrollUp"] if top > 0 else " ", c.focus))
            elif y == room - 1:
                bar.append((S["scrollDown"] if top + shown < len(items) else " ", c.focus))
            elif thumb_at <= y - 1 < thumb_at + thumb_len:
                bar.append((S["scrollThumb"], c.focus))
            else:
                bar.append((S["scrollTrack"], c.border))

    rows = [[("  ", ""), *fit(lst[y] if y < len(lst) else BLANK, cw), *([(" ", ""), bar[y]] if bar else [])]
            for y in range(room)]
    body = [[("  ", ""), *head], BLANK, *rows]
    return with_toasts(with_footer(body, foot, h), s["toasts"], w, h)


def centered_box(body, title, w, h, foot_keys, toasts):
    """A box in the middle of the screen with foot_keys below it."""
    bw = min(w - 2, 72)
    lines = [center(l, w) for l in box(body, bw, title=title, color=c.focus)]
    top = max(0, (h - 1 - len(lines)) // 2)
    return with_toasts(with_footer([BLANK] * top + lines, footer(foot_keys, w), h), toasts, w, h)


def download_screen(s, w, h):
    d = s["download"]
    inner = min(w - 2, 72) - 4
    elapsed = max(time.monotonic() - d["started_at"], 0.001)
    speed = (d["bytes"] - d["start_bytes"]) / elapsed
    eta = round((d["size"] - d["bytes"]) / speed) if speed > 0 else 0
    pct = d["bytes"] / d["size"] if d["size"] else 0
    mb = 1024 * 1024
    size_text = fmt(strings["downloadSize"], done=d["bytes"] // mb, total=d["size"] // mb)
    speed_text = fmt(strings["downloadSpeed"], speed=f"{speed / mb:.1f}", eta=f"{eta // 60}:{eta % 60:02d}")
    pct_line = [(f"{int(pct * 100)}%  ", c.title + BOLD), (size_text, c.text)]
    # One stats line where it fits, two on a narrow screen.
    if line_width(pct_line) + 2 + width(speed_text) <= inner:
        stats = [[*pct_line, ("  " + speed_text, c.dim)]]
    else:
        stats = [pct_line, [(speed_text, c.dim)]]
    body = [
        *[[(l, c.text + BOLD)] for l in wrap(d["name"], inner)[:3]],
        BLANK,
        progress_bar(pct, inner),
        *stats,
        *([BLANK, *[[(l, c.warning)] for l in wrap(d["note"], inner)]] if d["note"] else []),
    ]
    title = [(S["download"] + " ", c.focus + BOLD), (strings["downloadTitle"], c.title + BOLD)]
    return centered_box(body, title, w, h, strings["keys"]["download"], s["toasts"])


def stream_screen(s, w, h):
    st = s["stream"]
    inner = min(w - 2, 72) - 4
    body = [
        *[[(l, c.text + BOLD)] for l in wrap(st["name"], inner)[:3]],
        BLANK,
        *[[(l, c.dim)] for l in wrap(strings["streamHelp"], inner)],
        BLANK,
        [(st["url"], c.info + BOLD)],
        BLANK,
        *[[(l, c.dim)] for l in wrap(fmt(strings["streamPlayers"]), inner)],
    ]
    title = [(S["stream"] + " ", c.focus + BOLD), (strings["streamTitle"], c.title + BOLD)]
    return centered_box(body, title, w, h, strings["keys"]["stream"], s["toasts"])
