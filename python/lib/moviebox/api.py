"""Port of node/lib/moviebox/api.js — talks to MovieBox's server the way
its Android app does: signed requests with HMAC-MD5, guest login, host failover."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any
from urllib.parse import urlparse, parse_qsl

import httpx

import pathlib
_ROOT = pathlib.Path(__file__).parents[3]
with open(_ROOT / "shared" / "moviebox.json") as _f:
    _MB = json.load(_f)

KEY = bytes.fromhex(_MB["signingKeyHex"])
JSON_TYPE = "application/json"
# Statuses where another host may do better; anything else is the answer.
RETRY_STATUSES = {403, 406, 407, 429, 500, 502, 503, 504}


def _hex(n: int) -> str:
    return os.urandom(n // 2).hex()


def _md5(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


# One made-up device per run, like a fresh install of the app.
_app = _MB["app"]
USER_AGENT = (
    f"{_app['package']}/{_app['versionCode']} (Linux; U; Android {_app['android']}; "
    f"en_US; {_app['model']}; Build/{_app['build']}; Cronet/135.0.7012.3)"
)
_CLIENT_INFO = json.dumps({
    "package_name": _app["package"],
    "version_name": _app["versionName"],
    "version_code": _app["versionCode"],
    "os": "android",
    "os_version": _app["android"],
    "install_ch": "ps",
    "device_id": _hex(32),
    "install_store": "ps",
    "gaid": "-".join([_hex(8), _hex(4), _hex(4), _hex(4), _hex(12)]),
    "brand": _app["brand"],
    "model": _app["model"],
    "system_language": "en",
    "net": "NETWORK_WIFI",
    "region": "US",
    "timezone": "Asia/Kolkata",
    "sp_code": "40401",
    "X-Play-Mode": "2",
})


def _sign(method: str, url: str, body: str | None, ts: int) -> str:
    """x-tr-signature: HMAC-MD5 over the method, content types, body and the path
    with its query sorted by key."""
    parsed = urlparse(url)
    query = "&".join(f"{k}={v}" for k, v in sorted(parse_qsl(parsed.query)))
    path_qs = parsed.path + (f"?{query}" if query else "")
    body_len = str(len(body.encode())) if body else ""
    body_md5 = _md5(body) if body else ""
    canonical = "\n".join([method, JSON_TYPE, JSON_TYPE, body_len, str(ts), body_md5, path_qs])
    sig = hmac.new(KEY, canonical.encode(), hashlib.md5).digest()
    return f"{ts}|2|{base64.b64encode(sig).decode()}"


def _headers(method: str, url: str, body: str | None, token: str | None) -> dict:
    ts = int(time.time() * 1000)
    rev_md5 = _md5("".join(reversed(str(ts))))
    h = {
        "User-Agent": USER_AGENT,
        "Accept": JSON_TYPE,
        "Content-Type": JSON_TYPE,
        "x-client-token": f"{ts},{rev_md5}",
        "x-tr-signature": _sign(method, url, body, ts),
        "x-client-info": _CLIENT_INFO,
        "x-client-status": "0",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


_host_idx = 0
_token: str | None = None
_client = httpx.AsyncClient(timeout=12.0)


async def _call(method: str, path: str, body: str | None, auth: str | None) -> Any:
    global _host_idx
    last_err = None
    for i in range(len(_MB["hosts"])):
        idx = (_host_idx + i) % len(_MB["hosts"])
        url = _MB["hosts"][idx] + path
        try:
            resp = await _client.request(
                method, url,
                headers=_headers(method, url, body, auth),
                content=body.encode() if body else None,
            )
            if resp.status_code in RETRY_STATUSES:
                last_err = Exception(f"MovieBox answered {resp.status_code}")
                continue
            resp.raise_for_status()
            _host_idx = idx
            data = resp.json()
            return data.get("data", data)
        except httpx.HTTPStatusError:
            raise
        except Exception as e:
            last_err = e
    raise last_err


async def _login():
    global _token
    data = await _call("POST", _MB["paths"]["login"], "{}", None)
    if not data or not data.get("token"):
        raise Exception("MovieBox gave no login token")
    _token = data["token"]


async def request(method: str, path: str, payload: Any = None) -> Any:
    """Signed, logged-in request; logs in (again) when needed."""
    global _token
    if not _token:
        await _login()
    body = json.dumps(payload) if payload is not None else None
    try:
        return await _call(method, path, body, _token)
    except httpx.HTTPStatusError as e:
        if e.response.status_code != 401:
            raise
        await _login()
        return await _call(method, path, body, _token)
