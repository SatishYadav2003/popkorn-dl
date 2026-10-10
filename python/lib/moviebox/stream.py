"""Port of node/lib/moviebox/stream.js — local HLS proxy server for DASH video."""
import asyncio
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from ..config import STREAM_PORT
from ..shared import strings, fmt
from ..ui import ui
from .dash import segment_url


def _file_of(rep: dict, n: int) -> str:
    """A segment's file name on the CDN (they all sit next to the manifest)."""
    return re.sub(r"^.*/", "", segment_url(rep, n))


def _media_playlist(rep: dict) -> str:
    """One track's HLS playlist: its init segment, then every segment with its length."""
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        f"#EXT-X-TARGETDURATION:{int(rep['seg_seconds']) + 1}",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        f'#EXT-X-MAP:URI="{_file_of(rep, -1)}"',
    ]
    for i, seg in enumerate(rep["segments"]):
        lines.append(f"#EXTINF:{seg['duration']:.3f},")
        lines.append(_file_of(rep, i))
    lines += ["#EXT-X-ENDLIST", ""]
    return "\n".join(lines)


def _main_playlist(rep: dict, audio: dict, slug: str) -> str:
    """The main playlist the link points at."""
    return "\n".join([
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="{slug}/audio.m3u8"',
        f'#EXT-X-STREAM-INF:BANDWIDTH={rep["bandwidth"] + audio["bandwidth"]},RESOLUTION={rep["width"]}x{rep["height"]},AUDIO="audio"',
        f"{slug}/video.m3u8",
        "",
    ])


async def stream(video: dict) -> bool:
    """Serves the video on a local HLS link until it's stopped. True if it streamed."""
    try:
        slug = os.urandom(3).hex()
        cdn = video["cdn"]
        rep = video["rep"]
        manifest = video["manifest"]
        mpd_url = video["mpd_url"]
        base = re.sub(r"[^/]*$", "", mpd_url)
        video_init_file = _file_of(rep, -1)

        playlists = {
            f"/{slug}.m3u8": _main_playlist(rep, manifest["audio"], slug),
            f"/{slug}/video.m3u8": _media_playlist(rep),
            f"/{slug}/audio.m3u8": _media_playlist(manifest["audio"]),
        }
        cache = {}
        cache_lock = threading.Lock()
        loop = asyncio.get_event_loop()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass  # silence access log

            def do_HEAD(self):
                self._handle("HEAD")

            def do_GET(self):
                self._handle("GET")

            def _handle(self, method: str):
                path = self.path.split("?")[0]
                if path in playlists:
                    body = playlists[path].encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if method != "HEAD":
                        self.wfile.write(body)
                    return

                m = re.match(r"^/([^/]+)/([\w.\-]+\.m4s)$", path)
                if not m or m.group(1) != slug:
                    self.send_response(404)
                    self.end_headers()
                    return

                file = m.group(2)
                with cache_lock:
                    data = cache.get(file)

                if data is None:
                    try:
                        fut = asyncio.run_coroutine_threadsafe(
                            cdn.segment(base + file), loop
                        )
                        data = fut.result(timeout=30)
                        # HEVC retag: "hev1" -> "hvc1" so Apple players accept it too.
                        if file == video_init_file:
                            idx = data.find(b"hev1")
                            if idx >= 0:
                                ba = bytearray(data)
                                ba[idx:idx + 4] = b"hvc1"
                                data = bytes(ba)
                        with cache_lock:
                            cache[file] = data
                            if len(cache) > 8:
                                oldest = next(iter(cache))
                                del cache[oldest]
                    except Exception:
                        self.send_response(502)
                        self.end_headers()
                        return

                rng = self.headers.get("Range", "")
                rm = re.match(r"bytes=(\d+)-(\d*)$", rng)
                start = int(rm.group(1)) if rm else 0
                end = (int(rm.group(2)) if rm and rm.group(2) else len(data) - 1)
                end = min(end, len(data) - 1)
                chunk = data[start:end + 1]
                code = 206 if rm else 200
                self.send_response(code)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(len(chunk)))
                if rm:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                self.end_headers()
                if method != "HEAD":
                    self.wfile.write(chunk)

        port = STREAM_PORT or 0
        server = HTTPServer(("127.0.0.1", port), Handler)
        actual_port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()

        url = f"http://127.0.0.1:{actual_port}/{slug}.m3u8"
        await ui.stream_view(video["name"], url)
        server.shutdown()
        ui.notify("info", fmt(strings["streamEnded"], name=video["name"]))
        return True
    except Exception as e:
        ui.notify("error", fmt(strings["streamStopped"], reason=str(e)))
        return False
