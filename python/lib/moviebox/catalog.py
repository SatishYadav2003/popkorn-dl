"""Port of node/lib/moviebox/catalog.js — search, seasons, play info, dub info."""
import base64
import json
import re

from .api import request, _MB
from ..shared import fmt


def _fmt_path(template: str, **kw) -> str:
    """Replace {key} placeholders in a path template."""
    for k, v in kw.items():
        template = template.replace("{" + k + "}", str(v))
    return template


async def search(query: str, page: int) -> dict:
    """Movies and series matching query, one entry per title."""
    PER_PAGE = 15
    data = await request("POST", _MB["paths"]["search"], {
        "keyword": query, "page": page, "perPage": PER_PAGE, "subjectType": 0
    })
    seen = {}
    titles = []
    for group in (data or {}).get("results", []):
        for s in group.get("subjects", []):
            if str(s.get("subjectType")) not in _MB["types"]:
                continue
            year = (s.get("releaseDate") or "")[:4]
            sid = s["subjectId"]
            if sid in seen:
                # Another season of a series already listed: keep the year it started.
                if year and (not seen[sid]["year"] or year < seen[sid]["year"]):
                    seen[sid]["year"] = year
                continue
            title = {
                "id": sid,
                "series": s.get("subjectType") == 2,
                "title": re.sub(r"\s+S\d+$", "", s.get("title", "")),
                "year": year,
                "genre": s.get("genre", ""),
                "rating": s.get("imdbRatingValue", ""),
            }
            seen[sid] = title
            titles.append(title)
    return {"titles": titles, "hasMore": bool((data or {}).get("pager", {}).get("hasMore"))}


async def seasons(id: int) -> list:
    """[{ season, episodes, best }] where best is the highest resolution on offer."""
    data = await request("GET", _fmt_path(_MB["paths"]["seasons"], id=id))
    return [
        {
            "season": s["se"],
            "episodes": s["maxEp"],
            "best": max([0] + [r.get("resolution", 0) for r in s.get("resolutions", [])]),
        }
        for s in (data or {}).get("seasons", [])
    ]


def _cookie_folder(cookie: str) -> str | None:
    """The folder the signed cookie opens up."""
    m = re.search(r"urlprefix=([^:;]+)", cookie)
    if m:
        try:
            # urlsafe base64 — pad to multiple of 4
            raw = m.group(1)
            pad = (4 - len(raw) % 4) % 4
            return base64.urlsafe_b64decode(raw + "=" * pad).decode()
        except Exception:
            pass
    m = re.search(r"CloudFront-Policy=([^;]+)", cookie)
    if m:
        try:
            raw = m.group(1).replace("-", "+").replace("_", "/").replace("~", "=")
            pad = (4 - len(raw) % 4) % 4
            obj = json.loads(base64.b64decode(raw + "=" * pad))
            return obj["Statement"][0]["Resource"]
        except Exception:
            pass
    return None


async def play_info(id: int, se: int = 0, ep: int = 0, dub_id=None) -> dict | None:
    """The DASH manifest URL and CDN cookie for one episode/movie, or None if no video."""
    path = _fmt_path(_MB["paths"]["play"], id=id, se=se, ep=ep)
    if dub_id is not None:
        path += f"&dubId={dub_id}"
    data = await request("GET", path)
    subtitles = [
        {
            "lang": s.get("language") or s.get("lang") or "Unknown",
            "lang_code": s.get("languageCode") or s.get("langCode") or "",
            "url": s.get("url") or s.get("srtUrl") or "",
        }
        for s in (data or {}).get("subTitleList", [])
        if s.get("url") or s.get("srtUrl")
    ]
    for st in (data or {}).get("streams", []):
        cookie = "; ".join(p.strip() for p in (st.get("signCookie") or "").split(";") if p.strip())
        folder = _cookie_folder(cookie)
        if not folder or not folder.startswith("http"):
            continue
        mpd = folder.rstrip("*").rstrip("/") + "/index.mpd"
        return {
            "mpd": mpd,
            "cookie": cookie,
            "episode_title": (data or {}).get("title", ""),
            "subtitles": subtitles,
        }
    return None


async def dub_info(id: int, se: int = 0, ep: int = 0) -> list:
    """Available audio dub languages; returns [] on any error."""
    try:
        path = _fmt_path(_MB["paths"]["dubInfo"], id=id, se=se, ep=ep)
        data = await request("GET", path)
        return [
            {
                "id": d.get("dubId") or d.get("id"),
                "lang": d.get("language") or d.get("lang") or "Unknown",
            }
            for d in (data or {}).get("dubList") or (data or {}).get("dubs") or []
            if d.get("dubId") or d.get("id")
        ]
    except Exception:
        return []
