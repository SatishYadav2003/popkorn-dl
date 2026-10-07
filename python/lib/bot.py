"""Talking to the bot. How it formats its replies (button data, pager, /start
payload, result text) is described in shared/bot.json."""
import asyncio
import re

from . import telegram as tg
from .config import FILE_TIMEOUT, SEARCH_TIMEOUT
from .shared import bot_format as F

PAGER = re.compile(F["pagerText"])
RESULT = re.compile(F["resultText"], re.I)
QUALITY = re.compile(F["qualityTag"], re.I)
EXTENSION = re.compile(F["extensionTag"], re.I)
UNITS = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}


def _data(b):
    return (b.data or b"").decode("utf-8", "replace")


def _buttons(msg):
    return [b for row in (msg.buttons or []) for b in row]


def file_buttons(msg):
    return [b for b in _buttons(msg) if _data(b).startswith(F["fileButtonPrefix"])]


def page_info(msg):
    """(current, total) from the bot's '2 / 30' button; (1, 1) when there's no pager."""
    for b in _buttons(msg):
        m = PAGER.match(b.text)
        if _data(b) == F["pagerData"] and m:
            return int(m[1]), int(m[2])
    return 1, 1


def nav_button(msg, word):
    """The bot's 'Next ⏩' / '⏪ Previous' button, if this page has one."""
    return next((b for b in _buttons(msg)
                 if _data(b).startswith(F["navDataPrefix"]) and word in b.text.lower()), None)


def describe_result(text):
    """"1.31 GB ● Avengers Endgame 2019 720p ... mkv" ->
    {size: "1.31 GB", bytes, name, title: "Avengers Endgame 2019 720p ...", quality: "720p", ext: "MKV"}"""
    m = RESULT.match(text)
    name = (m[3] if m else text).strip()
    ext = EXTENSION.search(name)
    quality = QUALITY.search(name)
    return {
        "size": f"{m[1]} {m[2].upper()}" if m else "",
        "bytes": float(m[1]) * UNITS[m[2].upper()] if m else None,
        "name": name,
        "title": name[:ext.start()].strip() if ext else name,
        "quality": quality[1].lower() if quality else "",
        "ext": ext[1].upper() if ext else "",
    }


async def send_search(query, trail):
    """Sends the search; returns the bot's first result page, or None."""
    waiter = asyncio.create_task(tg.wait_for(lambda m: bool(file_buttons(m)), SEARCH_TIMEOUT, trail))
    await asyncio.sleep(0)  # let the handler register before we send
    trail.add((await tg.client.send_message(tg.bot, query)).id)
    return await waiter


async def turn_page(msg, direction, trail):
    """Tap Next/Previous; the bot edits the same message. Returns the new page, or None."""
    button = nav_button(msg, F["nextWord"] if direction == "next" else F["prevWord"])
    if not button:
        return None
    want = page_info(msg)[0] + (1 if direction == "next" else -1)
    waiter = asyncio.create_task(
        tg.wait_for(lambda m: m.id == msg.id and page_info(m)[0] == want, SEARCH_TIMEOUT, trail)
    )
    await asyncio.sleep(0)
    await button.click()
    return await waiter


async def request_file(button, trail):
    """Gets the file from the bot and keeps a copy in Saved Messages, since the bot
    deletes its own after ~1 min. Returns (saved message, name, size), or None."""
    # Tapping a result just hands back t.me/<bot>?start=file_<id>, so we send that
    # /start ourselves. Clicking isn't an option: Telegram rejects taps on buttons
    # from a page the bot has already paged away from.
    start = F["startPrefix"] + _data(button)[len(F["fileButtonPrefix"]):]

    waiter = asyncio.create_task(tg.wait_for(lambda m: m.file is not None, FILE_TIMEOUT, trail))
    await asyncio.sleep(0)
    trail.add((await tg.client.send_message(tg.bot, f"/start {start}")).id)
    msg = await waiter
    if not msg:
        return None

    saved = await tg.client.forward_messages("me", msg)
    return saved, msg.file.name or f"{start}.mkv", msg.file.size
