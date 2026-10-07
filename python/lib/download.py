"""Downloading a file to disk: 4 pieces at a time, resumable."""
import asyncio
import shutil

from . import telegram as tg
from .bot import request_file
from .cleanup import clear_trail
from .config import CHUNK, WORKERS, download_dir, incomplete_dir
from .resume import read_record, write_record
from .shared import fmt, strings
from .ui import ui


async def fetch_parallel(media, size, target, saved_id, view):
    """Download in CHUNK-sized pieces with WORKERS requests in flight, like the Telegram app does.

    Each finished piece is recorded, so after Ctrl+C or a dropped connection the next
    try only fetches what's missing. Progress goes to view (from ui.start_download).
    Returns every Saved Messages copy used for this file.
    """
    incomplete_dir.mkdir(parents=True, exist_ok=True)
    (incomplete_dir / ".nomedia").touch()  # keep video players out
    part = incomplete_dir / (target.name + ".part")
    rec_file = incomplete_dir / (target.name + ".part.json")
    chunks = (size + CHUNK - 1) // CHUNK

    def chunk_bytes(i):
        return min(CHUNK, size - i * CHUNK)

    rec = read_record(rec_file, part, size)
    if not rec:
        rec = {"size": size, "chunk": CHUNK, "done": [], "saved": []}
        with open(part, "wb") as f:
            f.truncate(size)
    if saved_id not in rec["saved"]:
        rec["saved"].append(saved_id)
    write_record(rec_file, rec)

    done = set(rec["done"])
    todo = iter([i for i in range(chunks) if i not in done])
    downloaded = sum(chunk_bytes(i) for i in done)
    if done:
        view.resumed(len(done), chunks, downloaded)

    async def worker(f):
        nonlocal downloaded
        for i in todo:  # shared iterator: each piece goes to exactly one worker
            async for data in tg.client.iter_download(media, offset=i * CHUNK, request_size=CHUNK, limit=1):
                f.seek(i * CHUNK)
                f.write(data)
                downloaded += len(data)
                view.progress(downloaded, size)
            # Only after the piece is on disk; recording it first would let a Ctrl+C
            # mark a piece as done while the file still has zeros there.
            f.flush()
            done.add(i)
            rec["done"] = sorted(done)
            write_record(rec_file, rec)

    with open(part, "r+b") as f:
        await asyncio.gather(*(worker(f) for _ in range(WORKERS)))
    if len(done) != chunks or part.stat().st_size != size:
        raise RuntimeError(f"incomplete, {len(done)}/{chunks} pieces")
    part.rename(target)
    rec_file.unlink()
    # Drop the folder too, unless another stopped download is still waiting in it.
    if all(f.name == ".nomedia" for f in incomplete_dir.iterdir()):
        shutil.rmtree(incomplete_dir, ignore_errors=True)
    return rec["saved"]


async def fetch_file(button, trail):
    file = await ui.busy(strings["requesting"], request_file(button, trail))
    if not file:
        ui.notify("error", strings["botNoFile"])
        return False
    saved, name, size = file
    target = download_dir / name
    saved_ids = [saved.id]
    if target.exists() and target.stat().st_size == size:
        ui.notify("success", fmt(strings["alreadyHave"], name=name))
    else:
        download_dir.mkdir(parents=True, exist_ok=True)
        view = ui.start_download(name, size)
        try:
            saved_ids = await fetch_parallel(saved.media, size, target, saved.id, view)
        finally:
            ui.end_download()
        ui.notify("success", fmt(strings["saved"], name=name))
    # Only once the file is safely on disk; if the download failed it stays in Saved
    # Messages. After a resume this also removes the copies left by earlier tries.
    await tg.client.delete_messages("me", saved_ids, revoke=True)
    return True


async def download(button):
    """True once the file is on disk."""
    trail = set()
    try:
        return await fetch_file(button, trail)
    except Exception as e:
        ui.notify("error", fmt(strings["downloadStopped"], reason=e))
        return False
    finally:
        await clear_trail(trail)
