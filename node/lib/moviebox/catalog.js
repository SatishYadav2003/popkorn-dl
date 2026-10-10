// What MovieBox has: titles for a search, a series' seasons, and where an
// episode's (or a movie's) video is.
const { request } = require("./api");
const { movieboxApp: mb, fmt } = require("../shared");

const PER_PAGE = 15;

// Movies and series matching `query`, one entry per title: the server lists a
// series once per season, all with the same id.
async function search(query, page) {
  const data = await request("POST", mb.paths.search, { keyword: query, page, perPage: PER_PAGE, subjectType: 0 });
  const seen = new Map();
  const titles = [];
  for (const group of data.results || []) {
    for (const s of group.subjects || []) {
      if (!mb.types[s.subjectType]) continue;
      const year = (s.releaseDate || "").slice(0, 4);
      const known = seen.get(s.subjectId);
      if (known) {
        // Another season of a series already listed: keep the year it started.
        if (year && (!known.year || year < known.year)) known.year = year;
        continue;
      }
      const title = {
        id: s.subjectId,
        series: s.subjectType === 2,
        title: s.title.replace(/\s+S\d+$/, ""),
        year,
        genre: s.genre || "",
        rating: s.imdbRatingValue || "",
      };
      seen.set(s.subjectId, title);
      titles.push(title);
    }
  }
  return { titles, hasMore: Boolean(data.pager?.hasMore) };
}

// [{ season, episodes, best }] where best is the highest resolution on offer.
async function seasons(id) {
  const data = await request("GET", fmt(mb.paths.seasons, { id }));
  return (data.seasons || []).map((s) => ({
    season: s.se,
    episodes: s.maxEp,
    best: Math.max(0, ...(s.resolutions || []).map((r) => r.resolution)),
  }));
}

// The folder the signed cookie opens up. Two kinds are in use:
//   Edge-Cache-Cookie=urlprefix=<base64 url>:sign=…:t=…
//   CloudFront-Policy=<base64 JSON whose Statement[0].Resource is "<url>/*">; CloudFront-Signature=…
function cookieFolder(cookie) {
  const prefix = /urlprefix=([^:;]+)/.exec(cookie)?.[1];
  if (prefix) return Buffer.from(prefix, "base64url").toString();
  const policy = /CloudFront-Policy=([^;]+)/.exec(cookie)?.[1];
  if (policy) {
    try {
      const json = Buffer.from(policy.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64").toString();
      return JSON.parse(json).Statement[0].Resource;
    } catch {
      // not the policy we know
    }
  }
  return null;
}

// The DASH manifest for one episode (se/ep 0 for a movie) and the cookie the CDN
// wants with every request, or null if there's no video.
//
// The plain `url` the server sends is a short placeholder clip, the same for every
// title; the real video's address is inside the signed cookie.
// When dubId is set, re-fetches with that dub's audio stream.
async function playInfo(id, se = 0, ep = 0, dubId = null) {
  let path = fmt(mb.paths.play, { id, se, ep });
  if (dubId != null) path += `&dubId=${dubId}`;
  const data = await request("GET", path);
  const subtitles = (data.subTitleList || []).map((s) => ({
    lang: s.language || s.lang || "Unknown",
    langCode: s.languageCode || s.langCode || "",
    url: s.url || s.srtUrl || "",
  })).filter((s) => s.url);
  for (const st of data.streams || []) {
    const cookie = (st.signCookie || "").split(";").map((s) => s.trim()).filter(Boolean).join("; ");
    const folder = cookieFolder(cookie);
    if (!folder?.startsWith("http")) continue;
    return { mpd: folder.replace(/\*$/, "").replace(/\/?$/, "/index.mpd"), cookie, episodeTitle: data.title || "", subtitles };
  }
  return null;
}

// Available audio dub languages for one episode/movie.
// Returns [] on any error — this is an optional feature.
async function dubInfo(id, se = 0, ep = 0) {
  try {
    const data = await request("GET", fmt(mb.paths.dubInfo, { id, se, ep }));
    return (data.dubList || data.dubs || [])
      .map((d) => ({ id: d.dubId || d.id, lang: d.language || d.lang || "Unknown" }))
      .filter((d) => d.id);
  } catch {
    return [];
  }
}

module.exports = { search, seasons, playInfo, dubInfo };
