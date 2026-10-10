"""Line-by-line version of the UI for when input is piped in (no keyboard):
prints results as a numbered list and reads typed answers."""
import re
import sys
import time

from ..input import ask
from ..shared import fmt, strings, theme
from ..term import wrap

S = theme["symbols"]
ICON = {"info": S["info"], "success": S["success"], "warning": S["warning"], "error": S["error"]}


class Plain:
    def start(self, bot, dir):
        print(f"🍿 {fmt(strings['connected'], bot=bot)}. {fmt(strings['downloadsTo'], dir=dir)}")

    def stop(self):
        pass

    async def ask_query(self):
        result = (await ask("\n🔎 Search (blank = quit): ")) or None
        if result is None:
            return None
        return result, "telegram"

    async def busy(self, text, awaitable):
        return await awaitable

    async def pick_result(self, query, items, page, total, mode="browse", sel=0):
        print(f"\n  📄 Page {page}/{total}\n")
        for i, it in enumerate(items):
            label = f"  [{i + 1}] "
            marker = it.get("marker")
            prefix = (f"{S['have']} {strings['have']} " if marker and marker["kind"] == "have"
                      else f"{S['partial']} {marker['pct']}% " if marker else "")
            name = it.get("name") or it.get("title") or ""
            size = it.get("size") or ""
            for j, line in enumerate(wrap(f"{prefix}{size} ● {name}", 78 - len(label))):
                print((" " * len(label) if j else label) + line)
            print()
        keys = ["number = download/open", "number+s = stream (e.g. 3s)"]
        if page < total:
            keys.append("n = next page")
        if page > 1:
            keys.append("p = previous page")
        keys.append("blank = back")
        while True:
            ans = (await ask(f"  ({', '.join(keys)}): ")).lower()
            if not ans:
                return {"action": "back", "index": None}
            if ans == "n" and page < total:
                return {"action": "next", "index": None}
            if ans == "p" and page > 1:
                return {"action": "prev", "index": None}
            m = re.fullmatch(r"(\d+)(s?)", ans)
            if m and 1 <= int(m[1]) <= len(items):
                action = "stream" if m[2] else ("open" if mode == "browse" else "download")
                return {"action": action, "index": int(m[1]) - 1}
            print("  ❌ invalid choice")

    def notify(self, kind, text):
        print(f"\n  {ICON.get(kind, '')} {text}")

    def start_download(self, name, size):
        print(f"\n  {S['download']} {name}\n")
        started = time.monotonic()
        state = {"start_bytes": 0}

        class View:
            def resumed(self, done, total, nbytes):
                state["start_bytes"] = nbytes
                print("  " + fmt(strings["resuming"], done=done, total=total) + "\n")

            def progress(self, nbytes, _size=None):
                pct = nbytes * 100 // size if size else 0
                speed = (nbytes - state["start_bytes"]) / max(time.monotonic() - started, 0.001)
                sys.stdout.write(f"\r  {pct:3d}%  {speed / 1024 / 1024:.1f} MB/s\x1b[K")
                sys.stdout.flush()

        return View()

    def end_download(self):
        print()

    async def stream_view(self, name, url):
        print(f"\n  {S['stream']} {name}\n\n  {strings['streamHelp']}\n  {fmt(strings['streamPlayers'])}\n\n  {url}\n")
        await ask("  (Enter = stop streaming): ")
