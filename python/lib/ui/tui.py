"""The full-screen app: keeps the screen state, redraws it, and turns key presses
into answers for popkorn.py. Drawing itself is in ../view.py."""
import asyncio
import os
import signal
import sys
import termios
import time

from .. import view
from ..shared import fmt, strings
from ..term import ALT_SCREEN_OFF, ALT_SCREEN_ON, paint, screen_size

TOAST_SECONDS = {"info": 4, "success": 5, "warning": 6, "error": 8}

# Escape sequences the arrow keys send (two variants, depending on the terminal).
SEQUENCES = {
    "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down",
    "\x1b[C": "right", "\x1bOC": "right", "\x1b[D": "left", "\x1bOD": "left",
}
SINGLE = {"\r": "enter", "\n": "enter", "\x1b": "escape", "\x7f": "backspace", "\x08": "backspace",
          "\x03": "ctrl-c", "\x15": "ctrl-u"}


def split_keys(data):
    """Turns what was read from the terminal into keys: "up", "enter", or a typed character."""
    keys, i = [], 0
    while i < len(data):
        seq = next((s for s in SEQUENCES if data.startswith(s, i)), None)
        if seq:
            keys.append(SEQUENCES[seq])
            i += len(seq)
        elif data[i] == "\x1b" and i + 1 < len(data) and data[i + 1] in "[O":
            i += 3  # some other escape sequence we don't use; skip it
        else:
            keys.append(SINGLE.get(data[i], data[i]))
            i += 1
    return keys


class Tui:
    def __init__(self):
        self.s = {"screen": "home", "query": "", "busy": None, "frame": 0, "toasts": [], "bot": "", "dir": ""}
        self.answer = None  # the future for the question currently on screen
        self.active = False
        self.last_paint = 0

    def start(self, bot, dir):
        self.s.update(bot=bot, dir=dir)
        self.active = True
        self.fd = sys.stdin.fileno()
        self.saved_tty = termios.tcgetattr(self.fd)
        raw = termios.tcgetattr(self.fd)
        # Keys arrive one by one, unechoed, and Ctrl+C comes in as a key instead of a
        # signal, so the screen can be put back before quitting.
        raw[3] &= ~(termios.ICANON | termios.ECHO | termios.ISIG)
        termios.tcsetattr(self.fd, termios.TCSADRAIN, raw)
        sys.stdout.write(ALT_SCREEN_ON)
        loop = asyncio.get_running_loop()
        loop.add_reader(self.fd, self._read)
        loop.add_signal_handler(signal.SIGWINCH, self.draw)
        # Ticks the spinner, the download stats and expiring toasts.
        self.ticker = asyncio.create_task(self._tick())
        self.draw()

    def stop(self):
        if not self.active:
            return
        self.active = False
        loop = asyncio.get_running_loop()
        loop.remove_reader(self.fd)
        loop.remove_signal_handler(signal.SIGWINCH)
        self.ticker.cancel()
        termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved_tty)
        sys.stdout.write(ALT_SCREEN_OFF)
        sys.stdout.flush()

    # ---------- drawing ----------

    def draw(self):
        if not self.active:
            return
        w, h = screen_size()
        screens = {"home": view.home_screen, "results": view.results_screen,
                   "download": view.download_screen, "stream": view.stream_screen}
        paint(screens[self.s["screen"]](self.s, w, h))
        self.last_paint = time.monotonic()

    async def _tick(self):
        while True:
            await asyncio.sleep(0.1)
            now = time.monotonic()
            before = len(self.s["toasts"])
            self.s["toasts"] = [t for t in self.s["toasts"] if t["until"] > now]
            if self.s["busy"]:
                self.s["frame"] += 1
            if self.s["busy"] or self.s["screen"] == "download" or len(self.s["toasts"]) != before:
                self.draw()

    # ---------- keys ----------

    def _read(self):
        data = os.read(self.fd, 1024).decode("utf-8", "replace")
        for key in split_keys(data):
            self._key(key)

    def _key(self, key):
        if key == "ctrl-c":
            self.stop()
            signal.raise_signal(signal.SIGINT)  # same clean-up as Ctrl+C anywhere else
            return
        handler = {"home": self._home_key, "results": self._results_key, "stream": self._stream_key}.get(self.s["screen"])
        if handler and self.answer and not self.answer.done() and not self.s["busy"]:
            handler(key)

    def _home_key(self, key):
        s = self.s
        if key == "enter":
            if s["query"].strip():
                return self._reply(s["query"].strip())
        elif key == "escape":
            if s["query"]:
                s["query"] = ""
            else:
                return self._reply(None)
        elif key == "backspace":
            s["query"] = s["query"][:-1]
        elif key == "ctrl-u":
            s["query"] = ""
        elif len(key) == 1 and key >= " ":
            s["query"] += key
        self.draw()

    def _results_key(self, key):
        s = self.s
        n = len(s["items"])
        if key == "up":
            s["sel"] = (s["sel"] - 1) % n
        elif key == "down":
            s["sel"] = (s["sel"] + 1) % n
        elif key == "right" and s["page"] < s["total"]:
            return self._reply(("next", None))
        elif key == "left" and s["page"] > 1:
            return self._reply(("prev", None))
        elif key == "enter":
            return self._reply(("download", s["sel"]))
        elif key == "s":
            return self._reply(("stream", s["sel"]))
        elif key in ("escape", "backspace"):
            return self._reply(("back", None))
        elif len(key) == 1 and key.isdigit():
            # 1-9 and 0 (for 10) jump straight to an item
            i = 9 if key == "0" else int(key) - 1
            if i < n:
                s["sel"] = i
        self.draw()

    def _stream_key(self, key):
        if key in ("enter", "escape"):
            self._reply(True)

    async def _ask(self, screen):
        """Shows a screen and waits for a key handler to answer."""
        self.s["screen"] = screen
        self.answer = asyncio.get_running_loop().create_future()
        self.draw()
        return await self.answer

    def _reply(self, value):
        if self.answer and not self.answer.done():
            self.answer.set_result(value)

    # ---------- what popkorn.py and the modules call ----------

    async def ask_query(self):
        """The search text, or None to quit."""
        self.s["query"] = ""
        return await self._ask("home")

    async def busy(self, text, awaitable):
        """Shows a spinner with text while awaitable runs; returns its result."""
        self.s["busy"] = text
        self.draw()
        try:
            return await awaitable
        finally:
            self.s["busy"] = None
            self.draw()

    async def pick_result(self, query, items, page, total):
        """items: [{title, size, quality, ext, marker}]; returns (action, index)."""
        self.s.update(query=query, items=items, page=page, total=total, sel=0, top=0)
        return await self._ask("results")

    def notify(self, kind, text):
        self.s["toasts"].append({"kind": kind, "text": text, "until": time.monotonic() + TOAST_SECONDS.get(kind, 5)})
        self.draw()

    def start_download(self, name, size):
        """Switches to the download screen; returns hooks the downloader reports to."""
        d = {"name": name, "size": size, "bytes": 0, "start_bytes": 0, "started_at": time.monotonic(), "note": ""}
        self.s["download"] = d
        self.s["screen"] = "download"
        self.draw()
        tui = self

        class View:
            def resumed(self, done, total, nbytes):
                d["note"] = fmt(strings["resuming"], done=done, total=total)
                d["bytes"] = d["start_bytes"] = nbytes
                tui.draw()

            def progress(self, nbytes, _size=None):
                # Redraws at most ~10 times a second; _tick covers the rest.
                d["bytes"] = nbytes
                if time.monotonic() - tui.last_paint > 0.1:
                    tui.draw()

        return View()

    def end_download(self):
        self.s["screen"] = "home"
        self.draw()

    async def stream_view(self, name, url):
        """Shows the link until Enter."""
        self.s["stream"] = {"name": name, "url": url}
        await self._ask("stream")
        self.s["screen"] = "home"
        self.draw()
