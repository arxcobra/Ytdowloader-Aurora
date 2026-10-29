# ✦ Aurora — YouTube Downloader

A macOS-styled web app with a real Python backend. Paste a YouTube link, pick
MP3 or MP4 and a quality, select individual videos / Shorts / whole playlists,
choose a download folder, and watch live progress.

Runs entirely on your computer — files never leave your machine.

## Requirements

- Python 3.9+
- `yt-dlp` and `imageio-ffmpeg` (bundles ffmpeg for MP3 + MP4 merging)

```bash
pip install -r requirements.txt
```

> If you already have ffmpeg on your PATH, `imageio-ffmpeg` is optional — the
> server uses whatever it finds first (`AURORA_FFMPEG` env var → PATH → bundle).

## Run

```bash
python3 server.py            # http://127.0.0.1:8765
python3 server.py --port 9000
```

Then open http://127.0.0.1:8765 in your browser.

## Features

- **Analyze** any YouTube URL — video, Short, playlist, or channel — and see
  title, thumbnail, runtime, and the qualities that actually exist for it.
- **MP3 audio** at 128/192/256/320 kbps or **MP4 video** up to the source's
  maximum resolution (best, 4K, 1440p, 1080p, 720p, …).
- **Multi-select**: pick any combination of playlist videos and Shorts, or
  paste several URLs at once (space/newline separated).
- **Folder picker**: browse drives and folders, create a subfolder, or jump
  straight to Home / Downloads. Everything saves there directly.
- **Live queue**: per-item progress, speed, ETA and per-item errors. Up to
  three videos download simultaneously within a job, and several jobs run in
  parallel on top of that.
- **Open folder** / **Show in folder** to jump to your files.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/api/health` | engine + ffmpeg status |
| `POST` | `/api/analyze` | `{url}` → metadata, kinds, qualities, playlist entries |
| `POST` | `/api/download` | `{items, format, quality, output_dir}` → starts a job |
| `GET`  | `/api/jobs` | all jobs with live progress |
| `POST` | `/api/jobs/cancel` | `{id}` → cancel a job |
| `GET`  | `/api/browse?path=` | folder listing (localhost only) |
| `POST` | `/api/mkdir` | `{parent, name}` → create a folder (localhost only) |
| `GET`  | `/api/open?path=` | reveal a path in the OS file manager (localhost only) |

Folder browsing, mkdir and open are **refused for non-loopback clients** — the
server is bound to `127.0.0.1` by default. Pass `--host 0.0.0.0` only if you
understand that anyone on your network could reach it.

## Notes

- Playlists and channels are capped at 300 entries per analysis.
- Downloads use the selected folder; use **Change** in the footer to switch it.
  The choice is remembered in the browser (localStorage) across reloads.
- Only download content you have the right to save. YouTube's Terms of Service
  still apply.

## Layout

```
server.py           # stdlib HTTP server + yt-dlp engine (no framework)
static/index.html   # UI shell
static/style.css    # macOS-inspired design system + motion
static/app.js       # analyze, selection, folder picker, live queue
```
