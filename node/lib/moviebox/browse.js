// Finding a video on MovieBox, one list at a time: titles for the search, then
// (for a series) seasons and episodes, then the qualities on offer, where it can be
// downloaded or streamed. Esc goes back up one list.
const { strings, fmt, theme } = require("../shared");
const { scanLocal, markerFor, markerForPrefix, discardPartial } = require("../library");
const catalog = require("./catalog");
const { parseManifest, Cdn } = require("./dash");
const { download } = require("./download");
const { stream } = require("./stream");
const ui = require("../ui");

const S = theme.symbols;
const pad2 = (n) => String(n).padStart(2, "0");
const clean = (s) => s.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
const codecName = (c) => (/^(hev|hvc)/.test(c) ? "HEVC" : /^avc/.test(c) ? "H.264" : c.toUpperCase());

// The file a download gets, without the quality and extension:
// "The Flash S05E21" or "The Flash (2023)".
const baseName = (t, se, ep) => clean(t.series ? `${t.title} S${pad2(se)}E${pad2(ep)}` : `${t.title}${t.year ? ` (${t.year})` : ""}`);

// True once something was downloaded or streamed (back to a new search).
async function browse(query) {
  let page = 1;
  while (true) {
    let found;
    try {
      found = await ui.busy(fmt(strings.searching, { query }), catalog.search(query, page));
    } catch (err) {
      ui.notify("error", err.message);
      return false;
    }
    if (!found.titles.length) {
      ui.notify("warning", page > 1 ? strings.pageFailed : fmt(strings.nothingFound, { query }));
      if (page === 1) return false;
      page--;
      continue;
    }
    const items = found.titles.map((t) => ({
      title: t.year ? `${t.title} (${t.year})` : t.title,
      size: t.series ? strings.series : strings.movie,
      quality: t.rating ? `★ ${t.rating}` : "",
      ext: t.genre,
    }));
    const choice = await ui.pickResult(query, items, page, found.hasMore ? page + 1 : page, "browse");
    if (choice.action === "back") return false;
    if (choice.action === "next") page++;
    else if (choice.action === "prev") page--;
    else if (await openTitle(found.titles[choice.index])) return true;
  }
}

async function openTitle(t) {
  if (!t.series) return pickQuality(t, 0, 0, t.title);
  const list = await ui.busy(strings.gettingVideo, catalog.seasons(t.id)).catch((err) => ui.notify("error", err.message));
  if (!list?.length) {
    ui.notify("warning", strings.noVideo);
    return false;
  }
  while (true) {
    const items = list.map((s) => ({
      title: fmt(strings.season, { n: s.season }),
      size: fmt(strings.episodes, { n: s.episodes }),
      quality: s.best ? `${s.best}p` : "",
    }));
    const choice = await ui.pickResult(t.title, items, 1, 1, "browse");
    if (choice.action === "back") return false;
    if (choice.action === "open" && (await pickEpisode(t, list[choice.index]))) return true;
  }
}

async function pickEpisode(t, s) {
  const header = `${t.title} ${S.dot} ${fmt(strings.season, { n: s.season })}`;
  let sel = 0;
  while (true) {
    const local = scanLocal();
    const items = Array.from({ length: s.episodes }, (_, i) => ({
      title: fmt(strings.episode, { n: i + 1 }),
      size: `S${pad2(s.season)}E${pad2(i + 1)}`,
      marker: markerForPrefix(baseName(t, s.season, i + 1), local),
    }));
    const choice = await ui.pickResult(header, items, 1, 1, "browse", sel);
    if (choice.action === "back") return false;
    sel = choice.index;
    const ep = choice.index + 1;
    if (await pickQuality(t, s.season, ep, `${header} ${S.dot} ${fmt(strings.episode, { n: ep })}`)) return true;
  }
}

// The qualities of one movie or episode; download or stream the one picked.
async function pickQuality(t, se, ep, header) {
  let video;
  try {
    video = await ui.busy(strings.gettingVideo, findVideo(t, se, ep));
  } catch (err) {
    ui.notify("error", err.message);
    return false;
  }
  if (!video) {
    ui.notify("warning", strings.noVideo);
    return false;
  }
  const { manifest } = video;
  const title = video.episodeTitle && t.series ? `${header} ${S.dot} ${video.episodeTitle}` : header;
  // Fetch dubs silently; empty array means no dub option shown.
  const dubs = await catalog.dubInfo(t.id, se, ep).catch(() => []);
  while (true) {
    const local = scanLocal();
    const options = manifest.video.map((rep) => ({ ...video, rep, name: `${baseName(t, se, ep)} ${rep.height}p.mp4` }));
    const items = options.map(({ rep, name }) => ({
      title: `${rep.height}p`,
      size: `~${Math.round(((rep.bandwidth + manifest.audio.bandwidth) / 8) * manifest.duration / 1024 / 1024)} MB`,
      quality: codecName(rep.codecs),
      ext: "mp4",
      marker: markerFor({ name }, local),
    }));
    const choice = await ui.pickResult(title, items, 1, 1, "results");
    if (choice.action === "back") return false;
    if (choice.action === "discard") {
      discardPartial(items[choice.index].marker.file);
      ui.notify("info", fmt(strings.discarded, { name: options[choice.index].name }));
      continue;
    }
    if (choice.action === "subtitleOnly") {
      if (!video.subtitles?.length) {
        ui.notify("warning", "No subtitles available");
        continue;
      }
      const sub = await pickSubtitle(video.subtitles, title);
      if (!sub || sub === "back") continue;
      const srtName = `${baseName(t, se, ep)}.${sub.langCode || sub.lang}.srt`;
      await downloadSubtitleOnly(sub, srtName, video.cdn);
      continue;
    }
    if (choice.action === "stream") {
      const picked = options[choice.index];
      if (await stream(picked)) return true;
      continue;
    }
    if (choice.action !== "download") continue;
    const picked = options[choice.index];

    // Dub step: offer audio language selection if dubs are available.
    let finalVideo = { ...picked };
    if (dubs.length > 0) {
      const dubChoice = await pickDub(dubs, title);
      if (dubChoice === "back") continue;
      if (dubChoice !== null) {
        try {
          const dubInfoResult = await ui.busy(strings.gettingVideo, catalog.playInfo(t.id, se, ep, dubChoice));
          if (dubInfoResult) {
            const dubSource = {
              cookie: dubInfoResult.cookie,
              refresh: async () => {
                const f = await catalog.playInfo(t.id, se, ep, dubChoice);
                if (f) dubSource.cookie = f.cookie;
              },
            };
            const dubCdn = new Cdn(dubSource);
            const dubManifest = parseManifest(await dubCdn.text(dubInfoResult.mpd), dubInfoResult.mpd);
            const dubRep = dubManifest.video.find((v) => v.height === picked.rep.height) || dubManifest.video[0];
            finalVideo = {
              ...picked,
              cdn: dubCdn,
              manifest: dubManifest,
              rep: dubRep,
              name: `${baseName(t, se, ep)} ${dubRep.height}p.mp4`,
            };
          }
        } catch {
          // Keep original if dub fetch fails.
        }
      }
    }

    // Subtitle step: always use subtitles from the original playInfo response.
    const subChoice = await pickSubtitle(video.subtitles || [], title);
    if (subChoice === "back") continue;
    if (await download({ ...finalVideo, subtitle: subChoice })) return true;
  }
}

// Where the video is and what qualities it has, or null if MovieBox has none.
async function findVideo(t, se, ep) {
  const info = await catalog.playInfo(t.id, se, ep);
  if (!info) return null;
  const source = {
    cookie: info.cookie,
    // The signed cookie runs out; a fresh one comes from asking again.
    refresh: async () => {
      const fresh = await catalog.playInfo(t.id, se, ep);
      if (fresh) source.cookie = fresh.cookie;
    },
  };
  const cdn = new Cdn(source);
  const manifest = parseManifest(await cdn.text(info.mpd), info.mpd);
  return { cdn, manifest, mpdUrl: info.mpd, episodeTitle: info.episodeTitle, subtitles: info.subtitles || [] };
}

// Subtitle-only download: fetch the SRT and write it to the downloads folder.
async function downloadSubtitleOnly(sub, srtName, cdn) {
  const { downloadDir } = require("../config");
  const fs = require("fs");
  const path = require("path");
  let srtContent;
  try {
    const res = await fetch(sub.url, { headers: { Cookie: cdn.source.cookie }, signal: AbortSignal.timeout(15000) });
    if (res.ok) srtContent = await res.text();
  } catch {}
  if (!srtContent) {
    try {
      const res = await fetch(sub.url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) srtContent = await res.text();
    } catch {}
  }
  if (!srtContent) {
    ui.notify("warning", strings.subtitleFailed);
    return;
  }
  fs.mkdirSync(downloadDir, { recursive: true });
  const dest = path.join(downloadDir, srtName);
  fs.writeFileSync(dest, srtContent);
  ui.notify("success", fmt(strings.subtitleSaved, { name: srtName }));
}

// Show a dub language picker. Returns null (keep original), a dub id, or "back".
async function pickDub(dubs, header) {
  const items = [
    { title: "Original (no dub)", size: "" },
    ...dubs.map((d) => ({ title: d.lang, size: "" })),
  ];
  const choice = await ui.pickResult(header, items, 1, 1, "browse");
  if (choice.action === "back") return "back";
  if (choice.index === 0) return null;
  return dubs[choice.index - 1].id;
}

// Show a subtitle language picker. Returns null (none), a subtitle object, or "back".
async function pickSubtitle(subtitles, header) {
  const items = [
    { title: "None", size: "" },
    ...subtitles.map((s) => ({ title: s.lang, size: s.langCode })),
  ];
  const choice = await ui.pickResult(header, items, 1, 1, "browse");
  if (choice.action === "back") return "back";
  if (choice.index === 0) return null;
  return subtitles[choice.index - 1];
}

module.exports = { browse };
