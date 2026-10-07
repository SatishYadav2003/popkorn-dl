"""Watching without downloading: a tiny local HTTP server that a video player can
play and seek in. Each byte range the player asks for is fetched from Telegram
right then and passed straight through; nothing is written to disk.
"""
import asyncio
import re
import secrets
from pathlib import PurePath
from urllib.parse import unquote

from . import telegram as tg
from .bot import request_file
from .cleanup import clear_trail, delete_saved
from .config import CHUNK, STREAM_PORT
from .shared import fmt, strings
from .ui import ui

MIME = {".mkv": "video/x-matroska", ".mp4": "video/mp4", ".webm": "video/webm", ".avi": "video/x-msvideo"}


def parse_range(header, size):
    """"bytes=START-END" (either side optional) -> (start, end); None without a Range
    header, "invalid" when it can't be served."""
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header or "")
    if not m or (m[1] == "" and m[2] == ""):
        return None
    if m[1] == "":  # "bytes=-N": the last N bytes
        start, end = max(0, size - int(m[2])), size - 1
    else:
        start, end = int(m[1]), size - 1 if m[2] == "" else min(int(m[2]), size - 1)
    return (start, end) if start <= end else "invalid"


async def pipe_range(writer, saved_id, start, end):
    """Sends bytes start..end from Telegram to the player."""
    # Re-read the message each time: the file reference inside it expires after a
    # while, and a player opens a new request for every seek anyway.
    fresh = await tg.client.get_messages("me", ids=saved_id)
    pos = start // CHUNK * CHUNK  # Telegram only serves whole aligned pieces
    async for data in tg.client.iter_download(fresh.media, offset=pos, request_size=CHUNK):
        lo, hi = max(start - pos, 0), min(end + 1 - pos, len(data))
        if hi > lo:
            writer.write(data[lo:hi])
            await writer.drain()  # waits for the player; raises once it has hung up
        pos += len(data)
        if pos > end:
            break


async def start_server(name, size, saved_id, slug):
    """Serves the file at /<slug> only. Returns (server, set of running request tasks)."""
    ctype = MIME.get(PurePath(name).suffix.lower(), "application/octet-stream")
    tasks = set()

    async def handle(reader, writer):
        task = asyncio.current_task()
        tasks.add(task)
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1").split("\r\n")
            method, target = (head[0].split(" ") + ["", ""])[:2]
            # Only this stream's own link. Every stream uses the same port, so without this
            # an old link saved in the player would quietly play whatever is streaming now.
            if unquote(target.split("?", 1)[0]) != f"/{slug}":
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                return
            headers = {k.strip().lower(): v.strip() for k, _, v in (h.partition(":") for h in head[1:] if h)}
            rng = parse_range(headers.get("range"), size)
            if rng == "invalid":
                writer.write(f"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\n"
                             "Content-Length: 0\r\nConnection: close\r\n\r\n".encode())
                return
            start, end = rng or (0, size - 1)
            lines = [
                f"HTTP/1.1 {'206 Partial Content' if rng else '200 OK'}",
                f"Content-Type: {ctype}",
                "Accept-Ranges: bytes",
                f"Content-Length: {end - start + 1}",
                "Connection: close",
            ]
            if rng:
                lines.append(f"Content-Range: bytes {start}-{end}/{size}")
            writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
            if method != "HEAD":
                await pipe_range(writer, saved_id, start, end)
            await writer.drain()
        except Exception:
            pass  # player seeked or closed mid-request; it simply asks again
        finally:
            tasks.discard(task)
            writer.close()

    try:
        server = await asyncio.start_server(handle, "127.0.0.1", STREAM_PORT)
    except OSError:  # port taken: let the OS pick one
        server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, tasks


def make_slug(name):
    """A short, new-every-time link name such as "k3f9a1.mkv": short enough to copy on a
    phone, and different per stream so a link from an earlier stream stops working."""
    return secrets.token_hex(3) + (PurePath(name).suffix.lower() or ".mkv")


async def stream(button):
    """Serves the file on a local link until it's stopped. True if it streamed."""
    trail = set()
    saved = None
    try:
        file = await ui.busy(strings["requesting"], request_file(button, trail))
        if not file:
            ui.notify("error", strings["botNoFile"])
            return False
        saved, name, size = file
        slug = make_slug(name)
        server, tasks = await start_server(name, size, saved.id, slug)
        port = server.sockets[0].getsockname()[1]
        await ui.stream_view(name, f"http://127.0.0.1:{port}/{slug}")
        server.close()
        for task in list(tasks):
            task.cancel()
        ui.notify("info", fmt(strings["streamEnded"], name=name))
        return True
    except Exception as e:
        ui.notify("error", fmt(strings["streamStopped"], reason=e))
        return False
    finally:
        # Nothing is kept: the Saved Messages copy was only there to stream from.
        if saved:
            await delete_saved([saved.id])
        await clear_trail(trail)
