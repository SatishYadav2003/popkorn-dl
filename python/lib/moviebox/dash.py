"""Port of node/lib/moviebox/dash.js — parse DASH manifests and fetch CDN segments."""
import asyncio
import math
import re
from typing import Any

import httpx

from .api import USER_AGENT
from ..shared import settings

# The CDN slows a request down once it has sent 96 KB, so a segment comes fastest as
# several small byte ranges fetched side by side (MovieBox-TUI does the same).
RANGE = settings.get("movieboxRange", 98304)


def _seconds(iso: str) -> float:
    """Parse ISO 8601 duration "PT42M20.0S" -> 2540.0"""
    m = re.match(r"PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?", iso or "")
    if not m:
        return 0.0
    return (float(m.group(1) or 0) * 3600
            + float(m.group(2) or 0) * 60
            + float(m.group(3) or 0))


def _attrs(tag: str) -> dict:
    return dict(re.findall(r'([\w:]+)="([^"]*)"', tag))


def _expand_timeline(body: str, timescale: int) -> list:
    """Expand <SegmentTimeline><S t? d r?/>...</SegmentTimeline> into {time, duration} per segment."""
    segs = []
    t = 0
    for m in re.finditer(r'<S\b([^>]*/?)>', body):
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if "t" in a:
            t = int(a["t"])
        d = int(a["d"])
        r = int(a.get("r", 0))
        for _ in range(r + 1):
            segs.append({"time": t, "duration": d / timescale})
            t += d
    return segs


def parse_manifest(xml: str, mpd_url: str) -> dict:
    """{ duration, video: [rep, best first], audio: rep }"""
    mpd_m = re.search(r"<MPD[^>]*>", xml)
    if not mpd_m:
        raise ValueError("Invalid DASH manifest")
    duration = _seconds(_attrs(mpd_m.group()).get("mediaPresentationDuration", ""))
    base = re.sub(r"[^/]*$", "", mpd_url)
    video = []
    audio = None

    for set_m in re.finditer(r"(<AdaptationSet[^>]*>)([\s\S]*?)</AdaptationSet>", xml):
        set_tag, body = set_m.group(1), set_m.group(2)
        set_attrs = _attrs(set_tag)
        body_no_reps = re.sub(r"<Representation[\s\S]*?</Representation>", "", body)
        set_tpl_m = re.search(r"<SegmentTemplate[^>]*>", body_no_reps)
        set_timeline_m = re.search(r"<SegmentTimeline>([\s\S]*?)</SegmentTimeline>", body_no_reps)

        for rep_m in re.finditer(r"(<Representation[^>]*>)([\s\S]*?)</Representation>", body):
            rep_tag, rep_body = rep_m.group(1), rep_m.group(2)
            rep = _attrs(rep_tag)
            tpl_m = re.search(r"<SegmentTemplate[^>]*>", rep_body) or set_tpl_m
            if not tpl_m:
                raise ValueError("this video's format isn't supported yet")
            tpl = _attrs(tpl_m.group())
            timescale = int(tpl.get("timescale", 1))
            start = int(tpl.get("startNumber", 1))

            timeline_m = re.search(r"<SegmentTimeline>([\s\S]*?)</SegmentTimeline>", rep_body)
            timeline_body = (timeline_m.group(1) if timeline_m
                             else set_timeline_m.group(1) if set_timeline_m else None)

            if timeline_body is not None:
                segments = _expand_timeline(timeline_body, timescale)
            else:
                d_units = int(tpl.get("duration", 0))
                if not d_units:
                    raise ValueError("this video's format isn't supported yet")
                seg_sec = d_units / timescale
                count = math.ceil(duration / seg_sec - 1e-6)
                segments = [
                    {"time": i * d_units, "duration": min(seg_sec, duration - i * seg_sec)}
                    for i in range(count)
                ]

            rep_id = rep["id"]

            def fill(s, _rep_id=rep_id):
                return base + s.replace("$RepresentationID$", _rep_id)

            entry = {
                "id": rep_id,
                "height": int(rep.get("height", 0)),
                "width": int(rep.get("width", 0)),
                "bandwidth": int(rep.get("bandwidth", 0)),
                "codecs": rep.get("codecs", ""),
                "init": fill(tpl["initialization"]),
                "media": fill(tpl["media"]),
                "start": start,
                "count": len(segments),
                "seg_seconds": max((s["duration"] for s in segments), default=0),
                "segments": segments,
            }
            mime = rep.get("mimeType") or set_attrs.get("mimeType") or ""
            kind = set_attrs.get("contentType") or mime.split("/")[0]
            if kind == "video":
                video.append(entry)
            elif kind == "audio" and audio is None:
                audio = entry

    if not video or audio is None:
        raise ValueError("the manifest has no video or no audio")
    video.sort(key=lambda r: (-r["height"], -r["bandwidth"]))
    return {"duration": duration, "video": video, "audio": audio}


def segment_url(rep: dict, n: int) -> str:
    """URL of segment n (0-based); -1 is the init segment."""
    if n < 0:
        return rep["init"]
    number = rep["start"] + n
    time = rep["segments"][n]["time"] if rep.get("segments") else 0
    url = rep["media"]
    url = re.sub(
        r"\$Number(?:%0(\d+)d)?\$",
        lambda m: str(number).zfill(int(m.group(1) or 0)),
        url,
    )
    url = url.replace("$Time$", str(time))
    return url


class Cdn:
    """Fetches from the CDN with the signed cookie. source is {cookie, refresh()}."""

    def __init__(self, source: dict):
        self.source = source
        self._refreshing = None
        self._client = httpx.AsyncClient(timeout=30.0)

    async def get(self, url: str, range_bytes: tuple | None = None) -> httpx.Response:
        for attempt in range(5):
            cookie = self.source["cookie"]
            headers = {"Cookie": cookie, "User-Agent": USER_AGENT}
            if range_bytes:
                headers["Range"] = f"bytes={range_bytes[0]}-{range_bytes[1]}"
            try:
                resp = await self._client.get(url, headers=headers)
            except Exception as e:
                if attempt >= 4:
                    raise
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            if resp.status_code in (200, 206):
                return resp
            if resp.status_code == 403 and attempt < 2:
                # Every request waiting on a 403 shares one refresh.
                if cookie == self.source["cookie"]:
                    if self._refreshing is None:
                        self._refreshing = asyncio.create_task(self._do_refresh())
                    await self._refreshing
                continue
            if resp.status_code >= 500 and attempt < 4:
                continue
            raise Exception(f"the video server answered {resp.status_code}")
        raise Exception("CDN request failed after retries")

    async def _do_refresh(self):
        try:
            await self.source["refresh"]()
        finally:
            self._refreshing = None

    async def text(self, url: str) -> str:
        resp = await self.get(url)
        return resp.text

    async def segment(self, url: str) -> bytes:
        """A whole segment: the first RANGE bytes tell the total, the rest come in parallel."""
        first = await self.get(url, (0, RANGE - 1))
        head = first.content
        cr = first.headers.get("content-range", "")
        m = re.search(r"/(\d+)$", cr)
        total = int(m.group(1)) if m else 0
        if first.status_code != 206 or not total or total <= len(head):
            return head
        ranges = []
        at = len(head)
        while at < total:
            end = min(at + RANGE, total) - 1
            ranges.append((at, end))
            at = end + 1
        parts = await asyncio.gather(*[self._fetch_range(url, r) for r in ranges])
        return head + b"".join(parts)

    async def _fetch_range(self, url: str, r: tuple) -> bytes:
        resp = await self.get(url, r)
        return resp.content
