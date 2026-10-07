# POPKORN

A full-screen terminal app that does the clicking for you in the **@iPapkornX2bot** Telegram bot.

Doing it by hand in Telegram means typing a name, scrolling the result pages,
tapping a file, tapping the `/start` link the bot sends back, and then waiting
for the download. This script runs the same steps from a terminal on a Mac or in
Termux on Android. You type a name, pick a result with the arrow keys, and the file either downloads
with a progress bar or streams straight into a video player without being saved.
Afterwards it clears its own messages out of your Telegram.

The Node version has a second source: press **Tab** on the search screen to
search **MovieBox** instead of the bot (see [MovieBox](#moviebox-node-only)).

The same app exists in two versions, **Node.js** and **Python**. They look and
behave the same (their screens are pixel-identical), and one line in `.env`
decides which one runs. Everything that isn't code (colours, logo, on-screen
text, the bot's reply format, timeouts) lives once in `shared/` and both read it.

---

## What it looks like

POPKORN takes over the whole terminal, like `vim` or `htop` do, and gives it
back exactly as it was when you quit. The colours are its own "popcorn" theme:
a butter-yellow → orange → red gradient on the logo and progress bar, orange
for whatever has focus, teal for info, green for success.

**Home**: the logo, a search box, and where downloads go:

```
     ██████╗  ██████╗ ██████╗ ██╗  ██╗ ██████╗ ██████╗ ███╗   ██╗
     ██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝██╔═══██╗██╔══██╗████╗  ██║
     ██████╔╝██║   ██║██████╔╝█████╔╝ ██║   ██║██████╔╝██╔██╗ ██║
     ██╔═══╝ ██║   ██║██╔═══╝ ██╔═██╗ ██║   ██║██╔══██╗██║╚██╗██║
     ██║     ╚██████╔╝██║     ██║  ██╗╚██████╔╝██║  ██║██║ ╚████║
     ╚═╝      ╚═════╝ ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝
                                                            v1.0.0
     ╭──────────────────────────────────────────────────────────────╮
     │ ❱ the flash s05e21▏                          [Enter] Search │
     ╰──────────────────────────────────────────────────────────────╯
                     Connected to @iPapkornX2bot
                  Downloads go to …/popkorn-dl/downloads

                         Telegram   ✔ MovieBox

                 [Enter] Search   [Esc] Quit   [Tab] Source
```

On a phone the logo switches to a compact two-line version, and on very narrow
screens to plain text.

**Results**: one page of the bot's results, with a scrollbar when they don't fit:

```
  ❱ the flash s05e21                     Item 2 of 7 • Page 1/1

     1 The Flash 2014 S05E21 The Girl With the Red Lightning 720p
       208.21 MB  720p  MKV  ✔ have
                                                                 ▲
  ▌  2 The Flash 2014 S05E21 720p WEB DL 2CH x265 HEVC PSA      ┃   ← highlighted
  ▌    208.21 MB  720p  MKV                                      ┃
                                                                 │
     3 the flash 2014 s05e21 720p bluray x265 10bit pahe in      ▼
       231.70 MB  720p  MKV  ↺ 45%

  [↑↓] Move  [Enter] Download  [s] Stream  [←→] Page  [Esc] Back
```

**Downloading**: a box with a gradient bar, then back to Home with a toast:

```
          ╭─ ↓ Downloading ─────────────────────────────────╮
          │ Avengers.Endgame.2019.720p.BluRay.x264.mp4       │
          │                                                  │
          │ ██████████████████████▌░░░░░░░░░░░░░░░░░░░░░░░░░ │
          │ 44%  658/1463 MB  4.7 MB/s • 2:51 left           │
          ╰──────────────────────────────────────────────────╯
```

Messages (saved, already downloaded, errors) pop up as **toasts** in the
bottom-right corner and fade after a few seconds: green `✔ DONE`, teal
`ℹ INFO`, amber `! NOTE`, red `✖ ERROR`.

| Key | Where | What happens |
|---|---|---|
| type, Enter | Home | search |
| Tab | Home | switch between Telegram and MovieBox (Node only) |
| Esc | Home | clears what you typed; on an empty box, quits |
| ↑ / ↓ | Results | move through the list |
| `1`–`9`, `0` | Results | jump straight to item 1–9, or 10 |
| Enter | Results | download the highlighted file, then back to Home |
| Enter | MovieBox title / season / episode lists | open it |
| `s` | Results | stream it to a video player instead, nothing saved (see [Streaming](#streaming-watch-without-downloading)) |
| ← / → | Results | previous / next page, the same as the bot's buttons |
| `x`, then `y` | Results, on a `↺` item | discard the half-done download (see below) |
| Esc | Results | back to Home for a new search (in MovieBox, back one list) |
| Enter | Streaming | stop streaming |
| Ctrl+C | anywhere | quit; a download in progress resumes next time |

**Markers:** `✔ have` means the file is already in `downloads/`. `↺ 45%` means
you started it and stopped, and picking it resumes from there. They're found by
matching the result's name and size against what's on disk, so a different
release with a similar name isn't marked.

**Discarding a half-done download (Node):** on an item marked `↺`, press `x`;
the footer asks *Discard this partial download?* and `y` throws it away (any
other key keeps it). That deletes its pieces and record from
`downloads/.incomplete/` (the folder too, once empty), and for a Telegram file
also the Saved Messages copy it was resuming from. The marker disappears, and
picking the item again starts from 0%. A finished (`✔ have`) file is never
touched. Piped input: type the number with `x`, e.g. `2x`.

Everything fits a phone screen: long names wrap, the key hints go onto two
lines, and the download stats split in two when the line is too narrow.

**Colours on a Mac:** the theme is 24-bit colour. Terminals that say they
support it (`COLORTERM=truecolor`, as Termux, iTerm2 and most modern terminals
do) get the exact colours; others get the nearest of the standard 256.

**Without a keyboard** (input piped in from another program), POPKORN prints a
plain numbered list instead, and you type a number (`2`), a number with `s` to
stream (`2s`), `n`/`p` for pages, or a blank line to go back. `/m` and `/t`
switch the search between MovieBox and Telegram.

---

## How it works

```
 you type "avengers"
        │
        ▼
 script sends "avengers" to the bot ──► bot replies with a page of result buttons
        │                                (each button hides  file#<id>)
        │  ← / →  ──► presses the bot's Next/Previous button, the bot edits the same message
        ▼
 you pick a result
        │
        ▼
 script sends "/start file_<id>"  ──► bot sends the actual file
        │                             (the same thing tapping the button + link does)
        ▼
 file is forwarded to your Saved Messages   (the bot deletes its own copy after a while,
        │                                    so the download needs a copy that stays put)
        ▼
 parallel download from Saved Messages ──► downloads/<file name>
        │   (4 pieces at a time, like the Telegram app: ~5 MB/s instead of ~1)
        ▼
 clean-up: deletes the script's messages from the bot chat and the Saved Messages copy
```

A few details worth knowing:

- **Your own Telegram account does the talking.** The script logs in as you
  (the same way a new Telegram app on another phone would), so the bot sees
  normal messages from you. That's why it needs your API id, hash and phone number.
- **Pages work like in Telegram.** The script shows one page at a time and asks
  the bot for the next page only when you press →.
- **It doesn't tap the result buttons.** Tapping a result only returns a link
  that holds `/start file_<id>`, so the script sends that `/start` itself. This
  also means a file from page 1 still downloads after you've paged to page 5.
  Telegram would reject a tap on a button that's no longer on screen.
- **Files you already have are skipped.** If a file with the same name and size
  is already in `downloads/`, it says `already downloaded` and doesn't fetch it again.
- **Downloads resume.** If you press Ctrl+C or the connection drops, pick the
  same file again and it carries on from where it stopped (see below).

### Resuming a stopped download

The file is fetched in 0.5 MB pieces, 4 at a time. While it downloads, two
files sit in a hidden folder, `downloads/.incomplete/`, so `downloads/` itself
only ever shows finished files:

| File | What it is |
|---|---|
| `<name>.part` | the file being filled in, already at its full size |
| `<name>.part.json` | the record: `done` lists the pieces already on disk, `saved` the Saved Messages copies to delete at the end |

The folder name starts with a `.` and the folder holds a `.nomedia`, so neither
file managers nor video players show the half-done files.

A piece goes into the record only **after** it has been written to disk. So if
the download stops halfway, the record never claims a piece that isn't there.
The worst case is that a piece gets downloaded twice.

To resume, search again and pick the **same file** (it shows `↺ 45%`). The
download box says `Resuming: 172/417 pieces already here`, and fetches only the
missing pieces. The record is used only if the file size still matches, so a
different file with the same name starts fresh. When every piece is in, `.part`
is moved into `downloads/` under its real name and the record is deleted. If no
other stopped download is waiting, `.incomplete/` is removed as well. Anything
directly in `downloads/` is always complete.

If the connection drops mid-download, a red toast says `Download stopped: …
Pick it again to resume.` and you're back on the same page of results, so you
can pick it again straight away.

Each try leaves a copy of the file in Saved Messages. The record keeps track of
them, and when the download finally completes, all of them are deleted.

### Streaming: watch without downloading

Press `s` on a result (or type `3s` without arrow keys) and POPKORN shows a
link instead of downloading:

```
  ╭─ ▶ Streaming ──────────────────────────────╮
  │ The.Flash.2014.S05E21.720p.WEB-DL.mkv       │
  │                                             │
  │ Open this link in a video player on this    │
  │ device:                                     │
  │                                             │
  │ http://127.0.0.1:8080/46542f.mkv            │
  │                                             │
  │ VLC: More → Stream • MX / Next Player:      │
  │ Network stream                              │
  ╰─────────────────────────────────────────────╯
                  [Enter] Stop
```

The link is short on purpose, so it copies easily on a phone, and it's new for
every stream: an old link saved in the player gets a "not found" instead of
quietly playing whatever is streaming now.

Open that link in any video player on the **same device**:
- **VLC:** More → Stream → paste the link
- **MX Player / Next Player:** menu → Network stream → paste the link
- **Mac:** VLC → File → Open Network

How it works: the script runs a tiny web server on your device. The player asks
it for a piece of the file ("bytes 0–2 MB", or "from 900 MB" when you skip
ahead), the script fetches exactly that piece from Telegram and passes it
straight on. Nothing is written to disk, and seeking works.

Things to know:
- `127.0.0.1` means "this device", so the player has to be on the same phone or
  Mac as the script.
- Keep the script open while watching, because it is the server. Press Enter
  when you're done. It stops, and the temporary Saved Messages copy is deleted.
- If you rewind, that part is fetched again, since nothing is kept.
- It needs roughly 0.3–0.5 MB/s for 720p. If Telegram slows your account down,
  playback buffers.
- The link uses port `8080`, or another free port if that one is busy.
- Nothing extra to install. It uses only what comes with Node.js and Python.

### Clean-up: what gets deleted, and what doesn't

The script deletes **only messages it sent itself or that the bot sent in reply
to it**. Anything you did by hand in the Telegram app is left alone.

| When | Deleted |
|---|---|
| a download finishes | the `/start …` message, the bot's file message, and the Saved Messages copy |
| you leave a search (pick a file, Esc, or quit) | your search text and the bot's result list |
| a download fails or you press Ctrl+C | bot chat is cleaned, but the **Saved Messages copy is kept** until the download is resumed and finishes |
| you stop streaming (Enter) | bot chat and the Saved Messages copy, since nothing is kept |
| you discard a half-done download (`x`, `y`) | the Saved Messages copy it was resuming from, with the local pieces |

Two things the script can't clean:

- About a minute after sending a file, the bot posts *"Your Request Has Been
  Deleted…"*. That arrives after the script has finished cleaning up, so you
  have to clear it by hand.
- If the app is killed outright (phone kills Termux, terminal closed), there's
  no chance to clean up; the messages of that search stay.

---

## MovieBox (Node only)

MovieBox is a streaming app with its own catalogue of movies and series. POPKORN
talks to MovieBox's server the way the MovieBox Android app does, worked out by
the open-source [MovieBox-TUI](https://github.com/mesamirh/MovieBox-TUI) project.
No Telegram is involved, so nothing is sent to or deleted from your chats.

**Lists:** titles for the search (movie or series, year, rating, genre) →
for a series, its seasons → that season's episodes → the qualities on offer
(1080p / 720p / 480p, with an estimated size). On the quality list, Enter
downloads and `s` streams, as with the bot. Episodes you already have, or started,
get the same `✔ have` / `↺ 60%` markers.

**How it gets the video:**

1. **Signed requests.** The server only answers requests that look like they
   come from the app: the app's name and version, a made-up phone model and
   device id (new each run), and an `x-tr-signature` header, an HMAC-MD5 of the
   request made with a key taken out of the app. It first logs in as a guest
   and gets a token, like opening the app without an account.
2. **The real address is in a cookie.** For each episode the server sends a
   `url`, but that's a 1 MB placeholder clip, the same for every title. The real
   video's folder is written (base64) inside the signed cookie it sends along,
   and the CDN only answers requests carrying that cookie (without it: 403).
3. **DASH.** That folder holds a manifest (`index.mpd`) and the video cut into
   5-second pieces, one set per quality plus one for the audio. A 42-minute
   episode is about 500 video pieces and 500 audio pieces.

The website (`moviebox.ph`) wasn't used: from India it doesn't load, and its
own play endpoint returned no video for anything tried.

**Downloading:** 6 pieces at a time. The CDN slows each request down after
96 KB, so every piece is fetched as several 95 KB byte ranges side by side
(as MovieBox-TUI does). Each piece is saved as its own file in
`downloads/.incomplete/<name>.parts/` the moment it's complete, so a stopped
download resumes with only the missing pieces. At the end the video and audio
pieces are joined into one `.mp4` by the script itself, no ffmpeg needed: the
pieces are already MP4 fragments, so joining means writing one header that
describes both tracks, an index so players can seek, and then the pieces in
order. The video track is tagged `hvc1`, so Apple players take it too. Files
are named like `The Flash S05E21 1080p.mp4`.

**Streaming:** the CDN wants the cookie, which a video player can't send, so the
local server stands in between and gives the player an **HLS** link
(`http://127.0.0.1:8080/f21e29.m3u8`). HLS rather than DASH because nearly every
player (VLC, MX, Next Player, mpv, iPhone) plays it. Only the quality you
picked is listed, so the player doesn't drop to a lower one by itself. Seeking
works: the player asks for the piece at that time, and the server fetches it.

**Quality:** the same titles as anywhere else, but strongly compressed. 1080p is
about 1 Mbit/s HEVC (an episode ≈ 340 MB), lower than a typical WEB-DL from the
bot.

**If it stops working:** MovieBox can change its app, its signing key or its
servers at any time. Everything about how it talks to them (hosts, key, app
identity, paths) is in `shared/moviebox.json`, so that's the file to update,
usually from a newer MovieBox-TUI. This uses MovieBox's private app interface,
which is against MovieBox's terms. MovieBox-TUI also sends a made-up Indian IP
address in `X-Forwarded-For`; POPKORN doesn't.

---

## Folder layout

```
popkorn-dl/
├── README.md
├── run.sh              ← the only thing you run; picks node/ or python/ from .env
├── shared/             ← read by both versions, so it's written once:
│   ├── theme.json        colours, gradient, logo art, symbols
│   ├── strings.json      every on-screen text and key hint
│   ├── bot.json          how the bot formats its replies
│   ├── moviebox.json     how the MovieBox app talks to its server (Node only)
│   └── settings.json     timeouts, piece size, workers, stream port
├── .env                ← your settings and secrets (not shared)
├── .env.example        ← template for .env
├── downloads/          ← finished files land here (default)
│   └── .incomplete/      half-done downloads + resume records (hidden, removed when empty);
│                         a MovieBox one is a <name>.parts/ folder of pieces
├── node/
│   ├── popkorn.js            entry point: login, search loop, page browsing
│   ├── lib/                  one file per job (see below)
│   │   └── moviebox/         the MovieBox source (Node only, see below)
│   ├── package.json          dependencies: telegram (gramjs), big-integer
│   ├── popkorn.node-session  your Telegram login for the Node version (secret)
│   ├── node_modules/         installed automatically on first run
│   └── .nomedia              hides this folder from Android video players
└── python/
    ├── popkorn.py            entry point: login, search loop, page browsing
    ├── lib/                  one file per job, same names as node/lib
    ├── requirements.txt      dependency: telethon
    ├── popkorn.session       your Telegram login for the Python version (secret)
    ├── .deps/                installed automatically on first run
    └── .nomedia              hides this folder from Android video players
```

Both versions are split the same way, file for file, so a change in one is easy
to mirror in the other:

| Module (`lib/…`) | Job |
|---|---|
| `shared` | loads the `shared/*.json` files |
| `config` | paths, plus the numbers from `shared/settings.json` |
| `telegram` | logging in, and waiting for the bot's reply |
| `input` | reading whole lines (login code, piped input) |
| `bot` | talking to the bot, using the format in `shared/bot.json` |
| `library` | what's already on disk, for the ✔ / ↺ markers |
| `term` | colours, gradient, text width, boxes, drawing the screen |
| `view` | what each screen looks like (home, results, download, stream, toasts) |
| `ui/tui` | the full-screen app: keys, redraws, spinner, toasts |
| `ui/plain` | the numbered-list version for piped input |
| `cleanup` | deleting the script's own messages afterwards |
| `resume` | reading and writing the `.part.json` record |
| `download` | the 4-at-a-time download to disk |
| `stream` | the local web server for watching without downloading |

The MovieBox source is in `node/lib/moviebox/` only:

| Module | Job |
|---|---|
| `api` | signing requests like the app, guest login, trying the next host |
| `catalog` | search, seasons, and finding the manifest inside the signed cookie |
| `dash` | reading the manifest, fetching pieces in 95 KB ranges, renewing the cookie on 403 |
| `mux` | joining video and audio pieces into one MP4 |
| `download` | the 6-at-a-time, resumable piece download, then the join |
| `stream` | the local HLS server |
| `browse` | the lists: titles → seasons → episodes → qualities |

**What's shared and what isn't:** Node and Python can't run each other's code,
so logic and drawing exist in both. Everything that's data (the look, the text,
the bot's format, the numbers) is in `shared/` once. To change a colour or a
message, edit the JSON and both versions pick it up. To change behaviour,
change both `lib/` folders.

**Why the `.nomedia` files?** `node_modules` has hundreds of `.d.ts` code files,
and Android video players read `.ts` as a video format. Without `.nomedia`,
players like Next Player fill up with "videos" of length 0 named `array-like`,
`big-integer` and so on. `downloads/` has no `.nomedia`, so your files still
show up in the player.

---

## Setup (one time)

### 1. Get your Telegram API id and hash

1. Open <https://my.telegram.org> and log in with your phone number.
2. Go to **API development tools**.
3. Fill the form with anything. Only `api_id` and `api_hash` matter:
   title `MyDownloader`, short name `mydl`, platform `Desktop`, URL blank.
4. Copy the **api_id** and **api_hash**.

`api_id`/`api_hash` tell Telegram *which app* is connecting. Your phone number
and the code tell it *which account* is connecting. Telegram needs both.

### 2. Create `.env`

```bash
cp .env.example .env
```

Then fill it in:

```bash
RUNTIME=node                 # node or python
TG_API_ID=12345678
TG_API_HASH=0123456789abcdef0123456789abcdef
TG_PHONE=+91XXXXXXXXXX       # with country code
BOT_USERNAME=iPapkornX2bot
DOWNLOAD_DIR=                # optional, blank = popkorn-dl/downloads
```

### 3. Have Node.js or Python installed

- **Node version:** `node` and `npm` (Termux: `pkg install nodejs`)
- **Python version:** `python3` with `pip` (Termux: `pkg install python`)

You only need the one that `RUNTIME` points at.

---

## Running it

```bash
bash run.sh
```

On a Mac `./run.sh` works too. On Android shared storage use `bash run.sh`,
because files there can't be marked executable.

**First run** installs the dependencies by itself:
- Node: `npm install` into `node/node_modules`
- Python: `pip install` into `python/.deps`

**First login** (once per version): the script asks for the code Telegram sends
to your **Telegram app** (not SMS), and for your 2-step verification password if
you have one. The login is then saved in the session file and never asked again.

> The first login has to be typed in a real terminal: Mac Terminal app or Termux.
> It can't take the code through a pipe or a non-interactive shell.

### Switching between Node and Python

Change one line in `.env`:

```bash
RUNTIME=python   # or node
```

Each version keeps its own login session, so switching to a version for the
first time asks for a code once. Don't run both versions at the same time.

---

## Moving it to the phone (Termux)

Copy only the code and settings, not `node_modules`, `.deps` or `downloads`.
They're big, they're tied to the machine, and `run.sh` reinstalls the
dependencies anyway.

**One-time setup on the phone:**

```bash
pkg install nodejs openssh   # or python for the Python version
termux-setup-storage         # lets Termux use phone storage
passwd                       # set an SSH password
sshd                         # start the SSH server (port 8022)
```

**From the Mac** (2 password prompts: one to create the folder, one to copy):

```bash
cd ~/Desktop/"Satish Coding"/popkorn-dl && \
ssh -p 8022 <termux-user>@<phone-ip> 'mkdir -p storage/shared/satish/popkorn-dl' && \
scp -P 8022 -r README.md .env .env.example .gitignore run.sh node python \
    <termux-user>@<phone-ip>:storage/shared/satish/popkorn-dl/
```

> Delete `node/node_modules` and `python/.deps` on the Mac before copying, because
> `scp -r node python` copies everything inside those folders. They come back
> automatically on the Mac's next run.

The session files are copied as well, so the phone doesn't need a new login.
Find the Termux user with `whoami` and the phone IP with `ifconfig` in Termux.

**On the phone:**

```bash
cd ~/storage/shared/satish/popkorn-dl && bash run.sh
```

Files download to `popkorn-dl/downloads`, which is in phone storage and visible
in your file manager and video player. To use another folder, set
`DOWNLOAD_DIR=/sdcard/Download/popkorn` in `.env`.

**Why the install looks unusual on Android:** shared storage (`/sdcard`)
can't hold symlinks or run programs. So Node installs with
`--no-bin-links --ignore-scripts`, and Python installs into a plain `.deps`
folder and runs with Termux's own `python3` instead of a venv. `run.sh` already
does this, so there's nothing to set up.

---

## Troubleshooting

| Problem | Cause / fix |
|---|---|
| `bash: ./run.sh: Permission denied` | You're on Android shared storage. Use `bash run.sh`. |
| `❌ .env missing` / `TG_… is empty` | Create `.env` from `.env.example` and fill every value. |
| `EOFError` / login code can't be typed | The first login was run without a real terminal. Run it in Terminal/Termux directly. |
| Asks for the login code again | The session was ended in Telegram → Settings → Devices, or the session file was deleted. Enter the code once. |
| `database is locked` (Python) | Two copies of the Python version ran at once on the same session. Close one. |
| `😕 nothing found` | The bot had no results, or didn't answer within 15 s. Try a simpler name. |
| `❌ download stopped …` | The connection dropped. Pick the same file again and it resumes. |
| `❌ bot didn't send the file` | The bot didn't answer `/start` within 30 s. Try again or pick another file. |
| `⚠️ page didn't load, try again` | The bot was slow to switch pages. Press ←/→ again. |
| Fake 0-length "videos" in the player | `.nomedia` is missing from `node/` or `python/`, or the player cache is stale. Add the file and refresh the player. |
| Slow downloads | The phone's CPU and network matter. Expect roughly 4–6 MB/s on good Wi-Fi. If it suddenly drops to a few KB/s while other internet is fine, Telegram has slowed your account after a lot of downloading. It recovers on its own after a while. |
| Player can't open the stream link | The player must be on the same device as the script, and the script must still be waiting at `Enter = stop streaming`. |
| MovieBox: `MovieBox answered 403` / nothing found for everything | MovieBox changed its app or key. Update `shared/moviebox.json` (see [MovieBox](#moviebox-node-only)). |
| MovieBox: `MovieBox has no video for this one` | That title or episode has no video on MovieBox right now. |
| MovieBox: `the video server answered 403` | The cookie couldn't be renewed. Pick the quality again; the download resumes. |

### If the bot changes

The script depends on how this bot formats its replies:

- result buttons carry `file#<id>`
- the pager shows `2 / 30`, and the Next/Previous buttons carry data starting with `next_`
- `/start file_<id>` returns the file

If the bot changes any of these, searches will come back empty or downloads will
fail. All of it is described in `shared/bot.json`, which both versions read, so
that's usually the only file to update.

---

## Security

- **`.env`, `popkorn.node-session` and `popkorn.session` are your Telegram
  account.** Anyone who has a session file can use your Telegram. Never share them,
  and don't send the folder to anyone as it is.
- Phone shared storage can be read by other apps that have storage permission.
- If a session file leaks, end that session in Telegram → Settings → Devices.
- Termux's SSH server is open to anyone on the same Wi-Fi. Use a strong password,
  and stop it with `pkill sshd` when you're done copying.

---

## Tech notes

| | Node.js | Python |
|---|---|---|
| Telegram library | [`telegram`](https://www.npmjs.com/package/telegram) (gramjs)¹ | [`telethon`](https://pypi.org/project/Telethon/) |
| Code | `node/popkorn.js` + `node/lib/` | `python/popkorn.py` + `python/lib/` |
| Stream server | built-in `http` | built-in `asyncio` |
| Session | `node/popkorn.node-session` (string session) | `python/popkorn.session` (SQLite) |
| Installed to | `node/node_modules` | `python/.deps` |

Both read the same numbers from `shared/settings.json`: 15 s wait for results,
30 s wait for the file, 512 KB download pieces, 4 in parallel (more than 4 didn't
make it faster), stream port 8080. MovieBox (Node only) fetches 6 pieces at
a time in 95 KB ranges.

¹ The `telegram` npm package is archived. Its maintained, largely compatible
fork is [`teleproto`](https://www.npmjs.com/package/teleproto). It still works,
so nothing has been changed yet.
