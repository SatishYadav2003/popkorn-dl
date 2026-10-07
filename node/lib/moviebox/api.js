// Talking to MovieBox's server the way its Android app does. The server only answers
// requests that carry the app's identity and a signature made with the key inside the
// app; this is MovieBox-TUI's crypto.rs and client.rs, in JS. Host list, key and app
// identity are in shared/moviebox.json.
const crypto = require("crypto");
const { movieboxApp: mb } = require("../shared");

const KEY = Buffer.from(mb.signingKeyHex, "hex");
const JSON_TYPE = "application/json";
// Statuses where another host may do better; anything else is the answer.
const RETRY = new Set([403, 406, 407, 429, 500, 502, 503, 504]);

const hex = (n) => crypto.randomBytes(n / 2).toString("hex");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// One made-up device per run, like a fresh install of the app.
const a = mb.app;
const USER_AGENT =
  `${a.package}/${a.versionCode} (Linux; U; Android ${a.android}; en_US; ${a.model}; ` +
  `Build/${a.build}; Cronet/135.0.7012.3)`;
const CLIENT_INFO = JSON.stringify({
  package_name: a.package, version_name: a.versionName, version_code: a.versionCode,
  os: "android", os_version: a.android, install_ch: "ps", device_id: hex(32), install_store: "ps",
  gaid: [hex(8), hex(4), hex(4), hex(4), hex(12)].join("-"), brand: a.brand, model: a.model,
  system_language: "en", net: "NETWORK_WIFI", region: "US",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sp_code: "40401", "X-Play-Mode": "2",
});

// x-tr-signature: HMAC-MD5 over the method, content types, body and the path with
// its query sorted by key.
function sign(method, url, body, ts) {
  const u = new URL(url);
  const query = [...u.searchParams].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [
    method, JSON_TYPE, JSON_TYPE,
    body ? Buffer.byteLength(body) : "", ts, body ? md5(body) : "",
    u.pathname + (query ? `?${query}` : ""),
  ].join("\n");
  return `${ts}|2|${crypto.createHmac("md5", KEY).update(canonical).digest("base64")}`;
}

function headers(method, url, body, token) {
  const ts = Date.now();
  return {
    "User-Agent": USER_AGENT,
    Accept: JSON_TYPE,
    "Content-Type": JSON_TYPE,
    "x-client-token": `${ts},${md5([...String(ts)].reverse().join(""))}`,
    "x-tr-signature": sign(method, url, body, ts),
    "x-client-info": CLIENT_INFO,
    "x-client-status": "0",
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

let hostIdx = 0; // the host that answered last, tried first next time
let token = null;

// Tries each host in turn until one answers; returns the reply's `data`.
async function call(method, path, body, auth) {
  let lastError;
  for (let i = 0; i < mb.hosts.length; i++) {
    const idx = (hostIdx + i) % mb.hosts.length;
    const url = mb.hosts[idx] + path;
    try {
      const res = await fetch(url, {
        method,
        headers: headers(method, url, body, auth),
        body,
        signal: AbortSignal.timeout(12000),
      });
      if (RETRY.has(res.status)) {
        lastError = new Error(`MovieBox answered ${res.status}`);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`MovieBox answered ${res.status}`), { status: res.status });
      hostIdx = idx;
      const json = await res.json();
      return json.data ?? json;
    } catch (err) {
      if (err.status) throw err;
      lastError = err; // network trouble: next host
    }
  }
  throw lastError;
}

// A guest login, like opening the app without an account.
async function login() {
  const data = await call("POST", mb.paths.login, "{}");
  if (!data?.token) throw new Error("MovieBox gave no login token");
  token = data.token;
}

// Signed, logged-in request; logs in (again) when needed.
async function request(method, path, payload) {
  if (!token) await login();
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  try {
    return await call(method, path, body, token);
  } catch (err) {
    if (err.status !== 401) throw err;
    await login();
    return call(method, path, body, token);
  }
}

module.exports = { request, USER_AGENT };
