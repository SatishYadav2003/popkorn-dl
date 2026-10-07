"""The files in ../../shared/, which the Node version reads too: colours and logo,
on-screen text, the bot's reply format, and the numbers both versions use."""
import json
import re
from pathlib import Path

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "shared"


def _load(name):
    return json.loads((SHARED_DIR / f"{name}.json").read_text(encoding="utf-8"))


theme = _load("theme")
strings = _load("strings")
bot_format = _load("bot")
settings = _load("settings")


def fmt(template, **values):
    """fmt("Saved {name}", name="x.mkv") -> "Saved x.mkv"; {dot} is the theme's separator."""
    def fill(m):
        key = m[1]
        if key in values:
            return str(values[key])
        return theme["symbols"]["dot"] if key == "dot" else m[0]
    return re.sub(r"\{(\w+)\}", fill, template)
