"""Port of node/lib/moviebox/browse.js — navigate MovieBox search, seasons, episodes,
qualities; download or stream the chosen video."""
import re

import httpx

from ..config import download_dir
from ..shared import strings, fmt, theme
from ..library import scan_local, marker_for, marker_for_prefix, discard_partial
from ..ui import ui
from . import catalog
from .dash import parse_manifest, Cdn
from .download import download
from .stream import stream

S = theme["symbols"]


def _pad2(n: int) -> str:
    return str(n).zfill(2)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]', "", s)).strip()


def _codec_name(c: str) -> str:
    if re.match(r"^(hev|hvc)", c):
        return "HEVC"
    if c.startswith("avc"):
        return "H.264"
    return c.upper()


def _base_name(t: dict, se: int, ep: int) -> str:
    """The file name without quality and extension: "The Flash S05E21" or "The Flash (2023)"."""
    if t["series"]:
        return _clean(f"{t['title']} S{_pad2(se)}E{_pad2(ep)}")
    year_part = f" ({t['year']})" if t.get("year") else ""
    return _clean(f"{t['title']}{year_part}")


async def browse(query: str) -> bool:
    """Browse search results, seasons, episodes; True once something was downloaded/streamed."""
    page = 1
    while True:
        try:
            found = await ui.busy(fmt(strings["searching"], query=query), catalog.search(query, page))
        except Exception as e:
            ui.notify("error", str(e))
            return False
        if not found["titles"]:
            if page == 1:
                ui.notify("warning", fmt(strings["nothingFound"], query=query))
                return False
            ui.notify("warning", strings["pageFailed"])
            page -= 1
            continue
        items = [
            {
                "title": f"{t['title']} ({t['year']})" if t.get("year") else t["title"],
                "size": strings["series"] if t["series"] else strings["movie"],
                "quality": f"★ {t['rating']}" if t.get("rating") else "",
                "ext": t.get("genre", ""),
            }
            for t in found["titles"]
        ]
        choice = await ui.pick_result(query, items, page, page + 1 if found["hasMore"] else page, "browse")
        if choice["action"] == "back":
            return False
        if choice["action"] == "next":
            page += 1
        elif choice["action"] == "prev":
            page -= 1
        elif await _open_title(found["titles"][choice["index"]]):
            return True


async def _open_title(t: dict) -> bool:
    if not t["series"]:
        return await _pick_quality(t, 0, 0, t["title"])
    try:
        lst = await ui.busy(strings["gettingVideo"], catalog.seasons(t["id"]))
    except Exception as e:
        ui.notify("error", str(e))
        return False
    if not lst:
        ui.notify("warning", strings["noVideo"])
        return False
    while True:
        items = [
            {
                "title": fmt(strings["season"], n=s["season"]),
                "size": fmt(strings["episodes"], n=s["episodes"]),
                "quality": f"{s['best']}p" if s.get("best") else "",
            }
            for s in lst
        ]
        choice = await ui.pick_result(t["title"], items, 1, 1, "browse")
        if choice["action"] == "back":
            return False
        if choice["action"] == "open" and await _pick_episode(t, lst[choice["index"]]):
            return True


async def _pick_episode(t: dict, s: dict) -> bool:
    header = f"{t['title']} {S['dot']} {fmt(strings['season'], n=s['season'])}"
    sel = 0
    while True:
        local = scan_local()
        items = [
            {
                "title": fmt(strings["episode"], n=i + 1),
                "size": f"S{_pad2(s['season'])}E{_pad2(i + 1)}",
                "marker": marker_for_prefix(_base_name(t, s["season"], i + 1), local),
            }
            for i in range(s["episodes"])
        ]
        choice = await ui.pick_result(header, items, 1, 1, "browse", sel)
        if choice["action"] == "back":
            return False
        sel = choice["index"]
        ep = choice["index"] + 1
        ep_header = f"{header} {S['dot']} {fmt(strings['episode'], n=ep)}"
        if await _pick_quality(t, s["season"], ep, ep_header):
            return True


async def _pick_quality(t: dict, se: int, ep: int, header: str) -> bool:
    """Show the qualities for a movie or episode; let the user download or stream."""
    video = None
    try:
        video = await ui.busy(strings["gettingVideo"], _find_video(t, se, ep))
    except Exception as e:
        ui.notify("error", str(e))
        return False
    if not video:
        ui.notify("warning", strings["noVideo"])
        return False

    manifest = video["manifest"]
    title = (f"{header} {S['dot']} {video['episode_title']}"
             if video.get("episode_title") and t["series"] else header)
    dubs = await catalog.dub_info(t["id"], se, ep)

    while True:
        local = scan_local()
        options = [
            {**video, "rep": rep, "name": f"{_base_name(t, se, ep)} {rep['height']}p.mp4"}
            for rep in manifest["video"]
        ]
        items = [
            {
                "title": f"{opt['rep']['height']}p",
                "size": f"~{round((opt['rep']['bandwidth'] + manifest['audio']['bandwidth']) / 8 * manifest['duration'] / 1024 / 1024)} MB",
                "quality": _codec_name(opt["rep"]["codecs"]),
                "ext": "mp4",
                "marker": marker_for({"name": opt["name"]}, local),
            }
            for opt in options
        ]
        choice = await ui.pick_result(title, items, 1, 1, "results")
        if choice["action"] == "back":
            return False
        if choice["action"] == "discard":
            marker = items[choice["index"]].get("marker")
            discard_partial(marker["file"] if marker else None)
            ui.notify("info", fmt(strings["discarded"], name=options[choice["index"]]["name"]))
            continue
        if choice["action"] == "subtitle_only":
            subs = video.get("subtitles") or []
            if not subs:
                ui.notify("warning", "No subtitles available")
                continue
            sub = await _pick_subtitle(subs, title)
            if not sub or sub == "back":
                continue
            srt_name = f"{_base_name(t, se, ep)}.{sub.get('lang_code') or sub['lang']}.srt"
            await _download_subtitle_only(sub, srt_name, video["cdn"])
            continue
        if choice["action"] == "stream":
            picked = options[choice["index"]]
            if await stream(picked):
                return True
            continue
        if choice["action"] != "download":
            continue

        picked = options[choice["index"]]
        final_video = dict(picked)

        # Dub: offer audio language selection if dubs are available.
        if dubs:
            dub_choice = await _pick_dub(dubs, title)
            if dub_choice == "back":
                continue
            if dub_choice is not None:
                try:
                    dub_info_result = await ui.busy(
                        strings["gettingVideo"],
                        catalog.play_info(t["id"], se, ep, dub_choice)
                    )
                    if dub_info_result:
                        dub_source = {"cookie": dub_info_result["cookie"]}

                        async def _dub_refresh(_ds=dub_source, _dc=dub_choice):
                            fresh = await catalog.play_info(t["id"], se, ep, _dc)
                            if fresh:
                                _ds["cookie"] = fresh["cookie"]

                        dub_source["refresh"] = _dub_refresh
                        dub_cdn = Cdn(dub_source)
                        dub_xml = await dub_cdn.text(dub_info_result["mpd"])
                        dub_manifest = parse_manifest(dub_xml, dub_info_result["mpd"])
                        dub_rep = next(
                            (r for r in dub_manifest["video"] if r["height"] == picked["rep"]["height"]),
                            dub_manifest["video"][0]
                        )
                        final_video = {
                            **picked,
                            "cdn": dub_cdn,
                            "manifest": dub_manifest,
                            "rep": dub_rep,
                            "name": f"{_base_name(t, se, ep)} {dub_rep['height']}p.mp4",
                        }
                except Exception:
                    pass  # keep original if dub fetch fails

        # Subtitle: always from the original playInfo.
        sub_choice = await _pick_subtitle(video.get("subtitles") or [], title)
        if sub_choice == "back":
            continue
        if await download({**final_video, "subtitle": sub_choice}):
            return True


async def _find_video(t: dict, se: int, ep: int) -> dict | None:
    """Where the video is and what qualities it has, or None."""
    info = await catalog.play_info(t["id"], se, ep)
    if not info:
        return None
    source = {"cookie": info["cookie"]}

    async def _refresh():
        fresh = await catalog.play_info(t["id"], se, ep)
        if fresh:
            source["cookie"] = fresh["cookie"]

    source["refresh"] = _refresh
    cdn = Cdn(source)
    xml = await cdn.text(info["mpd"])
    manifest = parse_manifest(xml, info["mpd"])
    return {
        "cdn": cdn,
        "manifest": manifest,
        "mpd_url": info["mpd"],
        "episode_title": info.get("episode_title", ""),
        "subtitles": info.get("subtitles", []),
    }


async def _pick_dub(dubs: list, header: str):
    """Show a dub language picker. Returns None (original), a dub id, or "back"."""
    items = [{"title": "Original (no dub)", "size": ""}] + [
        {"title": d["lang"], "size": ""} for d in dubs
    ]
    choice = await ui.pick_result(header, items, 1, 1, "browse")
    if choice["action"] == "back":
        return "back"
    if choice["action"] == "open":
        if choice["index"] == 0:
            return None
        return dubs[choice["index"] - 1]["id"]
    return "back"


async def _pick_subtitle(subtitles: list, header: str):
    """Show a subtitle picker. Returns None, a subtitle dict, or "back"."""
    items = [{"title": "None", "size": ""}] + [
        {"title": s["lang"], "size": s.get("lang_code", "")} for s in subtitles
    ]
    choice = await ui.pick_result(header, items, 1, 1, "browse")
    if choice["action"] == "back":
        return "back"
    if choice["action"] == "open":
        if choice["index"] == 0:
            return None
        return subtitles[choice["index"] - 1]
    return "back"


async def _download_subtitle_only(sub: dict, srt_name: str, cdn):
    """Fetch SRT and write it to the downloads folder."""
    import pathlib
    srt_content = None
    for use_cookie in [True, False]:
        try:
            headers = {"Cookie": cdn.source["cookie"]} if use_cookie else {}
            async with httpx.AsyncClient(timeout=15.0) as c:
                resp = await c.get(sub["url"], headers=headers)
                if resp.status_code == 200:
                    srt_content = resp.text
                    break
        except Exception:
            pass
    if not srt_content:
        ui.notify("warning", strings.get("subtitleFailed", "Subtitle download failed"))
        return
    out = pathlib.Path(download_dir) / srt_name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(srt_content, encoding="utf-8")
    ui.notify("success", fmt(strings.get("subtitleSaved", "Subtitle saved: {name}"), name=srt_name))
