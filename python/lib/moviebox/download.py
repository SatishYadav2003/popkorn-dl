"""Port of node/lib/moviebox/download.js — download DASH segments and mux into MP4."""
import asyncio
import os
import subprocess
from pathlib import Path

import httpx

from ..config import download_dir, incomplete_dir
from ..resume import write_record
from ..shared import strings, fmt
from ..ui import ui
from .dash import segment_url
from .mux import mux

# Number of parallel segment fetches.
try:
    from ..shared import settings
    WORKERS = settings.get("movieboxWorkers", 4)
except Exception:
    WORKERS = 4


async def download(video: dict) -> bool:
    """True once the file is on disk. video = {name, cdn, manifest, rep, subtitle?}"""
    name = video["name"]
    target = Path(download_dir) / name
    if target.exists():
        ui.notify("success", fmt(strings["alreadyHave"], name=name))
        return True
    try:
        await _fetch_all(video, str(target))
        ui.notify("success", fmt(strings["saved"], name=name))
        return True
    except Exception as e:
        ui.notify("error", fmt(strings["downloadStopped"], reason=str(e)))
        return False


async def _fetch_all(video: dict, target: str):
    name = video["name"]
    cdn = video["cdn"]
    manifest = video["manifest"]
    rep = video["rep"]
    subtitle = video.get("subtitle")

    tracks = {"video": rep, "audio": manifest["audio"]}
    parts_dir = Path(incomplete_dir) / (name + ".parts")
    rec_file = Path(incomplete_dir) / (name + ".part.json")
    parts_dir.mkdir(parents=True, exist_ok=True)
    (Path(incomplete_dir) / ".nomedia").write_text("")  # keep video players out

    def seg_file(kind: str, i: int) -> Path:
        suffix = "-init" if i < 0 else str(i).zfill(5)
        return parts_dir / f"{kind[0]}{suffix}.m4s"

    # Every piece as (kind, index); init segments first.
    pieces = []
    for kind in ["video", "audio"]:
        pieces.append((kind, -1))
        for i in range(tracks[kind]["count"]):
            pieces.append((kind, i))

    rec = {"size": len(pieces), "chunk": 1, "done": []}
    done_set = set()
    bytes_done = 0
    for n, (kind, i) in enumerate(pieces):
        f = seg_file(kind, i)
        if f.exists():
            done_set.add(n)
            bytes_done += f.stat().st_size
            rec["done"].append(n)

    todo = [(kind, i, n) for n, (kind, i) in enumerate(pieces) if n not in done_set]
    estimate = int((rep["bandwidth"] + manifest["audio"]["bandwidth"]) / 8 * manifest["duration"])
    view = ui.start_download(name, estimate)
    if done_set:
        view.resumed(len(done_set), len(pieces), bytes_done)
    write_record(rec_file, rec)

    lock = asyncio.Lock()
    failed = None
    idx = 0

    async def worker():
        nonlocal idx, bytes_done, failed
        while True:
            async with lock:
                if failed or idx >= len(todo):
                    return
                kind, i, n = todo[idx]
                idx += 1
            try:
                data = await cdn.segment(segment_url(tracks[kind], i))
                tmp = str(seg_file(kind, i)) + ".tmp"
                Path(tmp).write_bytes(data)
                os.replace(tmp, seg_file(kind, i))
                async with lock:
                    bytes_done += len(data)
                    view.progress(bytes_done)
                    rec["done"].append(n)
                    write_record(rec_file, rec)
            except Exception as e:
                async with lock:
                    if failed is None:
                        failed = e

    try:
        await asyncio.gather(*[worker() for _ in range(WORKERS)])
    finally:
        ui.end_download()

    if failed:
        raise failed

    # Joining: run in executor so the spinner can still draw.
    part = Path(incomplete_dir) / (name + ".part")
    await ui.busy(
        strings["joining"],
        asyncio.get_event_loop().run_in_executor(None, lambda: mux(
            str(part),
            lambda kind: seg_file(kind, -1).read_bytes(),
            lambda kind, i: seg_file(kind, i).read_bytes(),
            {"video": rep["count"], "audio": manifest["audio"]["count"]},
            manifest["duration"],
        ))
    )

    Path(download_dir).mkdir(parents=True, exist_ok=True)
    os.replace(part, target)
    import shutil
    shutil.rmtree(parts_dir, ignore_errors=True)
    try:
        rec_file.unlink()
    except FileNotFoundError:
        pass
    # Drop the folder too, unless another stopped download is still waiting.
    try:
        if all(f == ".nomedia" for f in os.listdir(incomplete_dir)):
            shutil.rmtree(incomplete_dir, ignore_errors=True)
    except FileNotFoundError:
        pass

    if subtitle:
        await _embed_subtitle(target, subtitle, cdn)


async def _embed_subtitle(video_path: Path, subtitle: dict, cdn):
    """Embed subtitle SRT via ffmpeg; fall back to saving .srt alongside if not available."""
    srt_content = None
    for use_cookie in [True, False]:
        try:
            headers = {}
            if use_cookie:
                headers["Cookie"] = cdn.source["cookie"]
            async with httpx.AsyncClient(timeout=15.0) as c:
                resp = await c.get(subtitle["url"], headers=headers)
                if resp.status_code == 200:
                    srt_content = resp.text
                    break
        except Exception:
            pass

    if not srt_content:
        ui.notify("warning", strings.get("subtitleFailed", "Subtitle download failed"))
        return

    video_path = Path(video_path)
    srt_path = str(video_path) + ".tmp.srt"
    tmp_mp4 = str(video_path) + ".tmp.mp4"
    Path(srt_path).write_text(srt_content, encoding="utf-8")
    try:
        subprocess.run(
            ["ffmpeg", "-i", str(video_path), "-i", srt_path,
             "-c", "copy", "-c:s", "mov_text", "-y", tmp_mp4],
            check=True, capture_output=True,
        )
        os.replace(tmp_mp4, video_path)
        ui.notify("info", f"Subtitle embedded ({subtitle['lang']})")
    except (subprocess.CalledProcessError, FileNotFoundError):
        lang_code = subtitle.get("lang_code") or subtitle["lang"]
        srt_final = str(video_path).replace(".mp4", f".{lang_code}.srt")
        os.replace(srt_path, srt_final)
        ui.notify("warning", "ffmpeg not found — subtitle saved separately")
    finally:
        for p in [srt_path, tmp_mp4]:
            try:
                os.unlink(p)
            except OSError:
                pass
