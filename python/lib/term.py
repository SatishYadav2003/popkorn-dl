"""Terminal drawing primitives. A line is a list of segments (text, style), so it
can be measured and cut to the screen width before any colour codes go in."""
import os
import re
import shutil
import sys

from .shared import theme

# 24-bit colour where the terminal has it, else the nearest of the 256. Termux has
# it but doesn't say so in COLORTERM, so it's recognised by its own variable.
TRUECOLOR = bool(re.search(r"truecolor|24bit", os.environ.get("COLORTERM", ""), re.I)
                 or os.environ.get("TERMUX_VERSION"))


def _hex_to_rgb(h):
    return [int(h[i:i + 2], 16) for i in (1, 3, 5)]


def _rgb_to_256(rgb):
    def level(v):
        return 0 if v < 48 else 1 if v < 115 else (v - 35) // 40
    r, g, b = rgb
    return 16 + 36 * level(r) + 6 * level(g) + level(b)


def _color_code(rgb, ground):
    if TRUECOLOR:
        return f"\x1b[{ground};2;{';'.join(map(str, rgb))}m"
    return f"\x1b[{ground};5;{_rgb_to_256(rgb)}m"


def fg(h):
    return _color_code(_hex_to_rgb(h), 38)


def bg(h):
    return _color_code(_hex_to_rgb(h), 48)


BOLD = "\x1b[1m"
RESET = "\x1b[0m"


class _Colors:
    """Named theme colours as foreground styles: c.title, c.dim, ..."""
    def __init__(self, colors):
        for name, value in colors.items():
            setattr(self, name, fg(value))


c = _Colors(theme["colors"])


def gradient_at(t, stops=theme["gradient"]):
    """Colour at position t (0..1) along the theme gradient."""
    pts = [_hex_to_rgb(s) for s in stops]
    x = min(max(t, 0), 1) * (len(pts) - 1)
    i = min(int(x), len(pts) - 2)
    f = x - i
    return [round(a + (b - a) * f) for a, b in zip(pts[i], pts[i + 1])]


def gradient_fg(t):
    return _color_code(gradient_at(t), 38)


# ---------- width ----------

def char_width(ch):
    """Columns a character takes: 0 for joiners/accents, 2 for CJK and emoji, else 1."""
    cp = ord(ch)
    if cp == 0x200D or 0x300 <= cp <= 0x36F or 0xFE00 <= cp <= 0xFE0F:
        return 0
    if (0x1100 <= cp <= 0x115F or 0x2E80 <= cp <= 0xA4CF or 0xAC00 <= cp <= 0xD7A3
            or 0xF900 <= cp <= 0xFAFF or 0xFE30 <= cp <= 0xFE4F or 0xFF00 <= cp <= 0xFF60
            or 0xFFE0 <= cp <= 0xFFE6 or 0x1F300 <= cp <= 0x1FAFF or 0x20000 <= cp <= 0x3FFFD):
        return 2
    return 1


def width(s):
    return sum(char_width(ch) for ch in s)


def line_width(line):
    return sum(width(t) for t, _ in line)


def cut(line, max_w):
    """Cuts a line to max_w columns, ending in "…" if anything was dropped."""
    if line_width(line) <= max_w:
        return line
    out, room = [], max_w - 1
    for text, style in line:
        part = ""
        for ch in text:
            w = char_width(ch)
            if w > room:
                break
            part += ch
            room -= w
        if part:
            out.append((part, style))
        if len(part) < len(text):
            break
    out.append(("…", c.dim))
    return out


def fit(line, w, pad_style=""):
    """Cuts or pads a line to exactly w columns (padding takes pad_style, e.g. a background)."""
    line = cut(line, w)
    gap = w - line_width(line)
    return line + [(" " * gap, pad_style)] if gap > 0 else line


def wrap(text, w):
    """Word-wraps plain text to lines of at most w columns."""
    lines, cur = [], ""
    for word in text.split():
        if cur and width(cur) + 1 + width(word) > w:
            lines.append(cur)
            cur = ""
        while width(word) > w:  # a single word longer than the line: hard-break it
            lines.append((cur + " " if cur else "") + word[:w])
            word, cur = word[w:], ""
        cur = f"{cur} {word}" if cur else word
    if cur:
        lines.append(cur)
    return lines or [""]


def render(line):
    return "".join(style + text + RESET if style else text for text, style in line)


# ---------- shapes ----------

def box(body, w, title=(), color=None):
    """A rounded box around body lines, w columns wide in total, with an optional title."""
    color = color or c.border
    inner = w - 4
    title = list(title)
    title_w = line_width(title)
    if title_w:
        top = [("╭─ ", color), *title, (" " + "─" * max(0, w - title_w - 5) + "╮", color)]
    else:
        top = [("╭" + "─" * (w - 2) + "╮", color)]
    return [top, *[[("│ ", color), *fit(l, inner), (" │", color)] for l in body],
            [("╰" + "─" * (w - 2) + "╯", color)]]


def center(line, w):
    gap = max(0, (w - line_width(line)) // 2)
    return [(" " * gap, ""), *line] if gap else line


def spread(left, right, w):
    """Puts right at the far end of a w-wide line that starts with left."""
    gap = w - line_width(left) - line_width(right)
    return [*left, (" " * gap, ""), *right] if gap >= 1 else cut(left, w)


# ---------- screen ----------

def screen_size():
    size = shutil.get_terminal_size((80, 24))
    return size.columns, size.lines


def paint(lines):
    """Draws the whole screen: home, every line, clearing the rest of each line and below.
    \\r\\n so it works whatever the terminal's newline setting is."""
    w, h = screen_size()
    out = [render(cut(l, w)) + "\x1b[K" for l in lines[:h]]
    sys.stdout.write("\x1b[H" + "\r\n".join(out) + "\x1b[J")
    sys.stdout.flush()


ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l"  # separate screen (like vim) + hide cursor
ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l"
