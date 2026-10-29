#!/usr/bin/env python3
"""
Aurora — YouTube Downloader (local web app backend)

Pure Python standard-library HTTP server. Uses `yt-dlp` as a library for
extraction/downloading and the bundled ffmpeg from `imageio-ffmpeg` for
MP3 conversion and MP4 stream merging.

Run:  python3 server.py  [--port 8765] [--host 127.0.0.1]
"""

import argparse
import json
import os
import queue
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Windows consoles default to cp1252, which cannot print ✦ / arrows / ☐ etc.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# A windowed (PyInstaller --noconsole) build has no std streams at all.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = sys.stdout

# Frozen into an exe, the bundled files live in the temporary extraction
# folder (sys._MEIPASS) rather than next to server.py.
FROZEN = bool(getattr(sys, "frozen", False))
BASE_DIR = (
    Path(getattr(sys, "_MEIPASS", ""))
    if FROZEN
    else Path(__file__).resolve().parent
)

# --------------------------------------------------------------------------
# yt-dlp + ffmpeg bootstrap
# --------------------------------------------------------------------------

try:
    import yt_dlp
    from yt_dlp.utils import DownloadError, ExtractorError
except Exception as _e:  # pragma: no cover
    sys.stderr.write(
        "\n[error] yt-dlp is required.  Install it with:\n"
        "        pip install yt-dlp\n\n"
    )
    raise


def find_ffmpeg():
    """Locate an ffmpeg binary: env override -> PATH -> bundle."""
    env = os.environ.get("AURORA_FFMPEG") or os.environ.get("FFMPEG")
    if env and Path(env).exists():
        return env
    which = shutil.which("ffmpeg")
    if which:
        return which
    # bundled next to the app (PyInstaller --collect-all imageio_ffmpeg)
    if FROZEN:
        for pattern in ("imageio_ffmpeg/binaries/ffmpeg*", "ffmpeg*.exe", "ffmpeg*"):
            hits = sorted(BASE_DIR.glob(pattern))
            if hits:
                return str(hits[-1])
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG_PATH = find_ffmpeg()

DEFAULT_DOWNLOAD_DIR = str(Path.home() / "Downloads")

# Client IP whitelist for the folder browser (security: never expose the
# filesystem to a remote request).
LOCAL_IPS = {"127.0.0.1", "::1", "localhost"}


def is_local(request):
    ip = request.client_address[0]
    return ip in LOCAL_IPS or ip.startswith("127.") or ip.startswith("::ffff:127.")


# --------------------------------------------------------------------------
# Analyze: turn a URL into a structured, UI-friendly object
# --------------------------------------------------------------------------

MAX_PLAYLIST_ITEMS = 300

QUALITY_OPTIONS = [
    {"id": "best", "label": "Best available", "detail": "highest resolution"},
    {"id": "2160", "label": "2160p", "detail": "4K"},
    {"id": "1440", "label": "1440p", "detail": "QHD"},
    {"id": "1080", "label": "1080p", "detail": "Full HD"},
    {"id": "720", "label": "720p", "detail": "HD"},
    {"id": "480", "label": "480p", "detail": "SD"},
    {"id": "360", "label": "360p", "detail": "low"},
    {"id": "240", "label": "240p", "detail": "very low"},
    {"id": "144", "label": "144p", "detail": "minimum"},
]

AUDIO_BITRATES = [
    {"id": "320K", "label": "320 kbps", "detail": "best"},
    {"id": "256K", "label": "256 kbps", "detail": "high"},
    {"id": "192K", "label": "192 kbps", "detail": "standard"},
    {"id": "128K", "label": "128 kbps", "detail": "compact"},
]

EXTENSION_RE = re.compile(r"\.(webm|m4a|mp4|mkv|mp3|opus|ogg|avi|mov)(\?|$)", re.I)


def normalize_url(raw):
    """Accept bare IDs, youtu.be links, handle @handles and search-free forms."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return f"https://www.youtube.com/watch?v={raw}"
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if raw.startswith("youtu.be/") or raw.startswith("www.youtu.be/"):
        return "https://" + raw
    if raw.startswith("youtube.com/") or raw.startswith("www.youtube.com/"):
        return "https://" + raw
    if raw.startswith("@"):
        return f"https://www.youtube.com/{raw}"
    return raw


def is_portrait(info):
    """True when the video's video streams are taller than they are wide.

    Shorts are vertical; a 19-second landscape clip is not a Short, so
    duration alone is not enough to classify one.
    """
    for f in info.get("formats") or []:
        w, h = f.get("width"), f.get("height")
        if w and h and f.get("vcodec") not in (None, "none"):
            return h > w
    w, h = info.get("width"), info.get("height")
    return bool(w and h and h > w)


def detect_kind(url, info):
    """Classify a result as playlist / channel / short / video / live."""
    ie = (info.get("extractor_key") or info.get("extractor") or "").lower()
    itype = info.get("_type") or ""
    path = urllib.parse.urlparse(url).path or ""

    if itype in ("playlist", "multi_video") or "playlist" in ie or "tab" in ie:
        if "channel" in ie or "/channel/" in url or "/@" in url or "/c/" in url or "/user/" in url:
            return "channel"
        return "playlist"
    dur = info.get("duration")
    if "/shorts/" in path:
        return "short"
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        return "live"
    if dur is not None and dur <= 60 and not info.get("is_live"):
        # only a vertical clip that is at most a minute long is a Short
        if not info.get("formats") or is_portrait(info):
            return "short"
    return "video"


def summarize_entry(e):
    """Flatten one playlist/channel entry for the selection grid."""
    if not isinstance(e, dict):
        return None
    eid = e.get("id")
    url = e.get("url") or e.get("webpage_url") or ""
    if eid and not url.startswith("http"):
        url = f"https://www.youtube.com/watch?v={eid}"
    if not url.startswith("http"):
        return None
    dur = e.get("duration")
    kind = "video"
    if e.get("is_live"):
        kind = "live"
    elif "/shorts/" in url:
        # a Shorts tab is extracted flat, so duration is unknown — the URL
        # itself is the only reliable signal
        kind = "short"
    elif dur is not None and dur <= 60:
        kind = "short"
    return {
        "id": eid or url,
        "url": url,
        "title": e.get("title") or "Untitled",
        "duration": dur,
        "thumbnail": thumb_for(e),
        "kind": kind,
        "index": e.get("playlist_index"),
        "channel": e.get("channel") or e.get("uploader"),
    }


def thumb_for(info):
    t = info.get("thumbnail")
    if t:
        return t
    thumbs = info.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url")
    vid = info.get("id")
    if vid and info.get("extractor_key", "").lower() == "youtube":
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    return None


def base_opts():
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "ignoreerrors": True,
        "skip_download": True,
        "socket_timeout": 20,
        "retries": 3,
        "player_client": None,
    }
    if FFMPEG_PATH:
        opts["ffmpeg_location"] = FFMPEG_PATH
    return opts


def analyze(url):
    """Return a normalized analysis payload for the UI."""
    url = normalize_url(url)
    if not url:
        raise ValueError("Please paste a YouTube URL.")

    # Pass 1: cheap flat extraction (playlists/channels expand without per-video cost)
    flat_opts = dict(base_opts())
    flat_opts["playlistend"] = MAX_PLAYLIST_ITEMS
    flat_opts["extract_flat"] = "in_playlist"

    try:
        with yt_dlp.YoutubeDL(flat_opts) as ydl:
            flat = ydl.extract_info(url, download=False)
    except (DownloadError, ExtractorError) as e:
        raise ValueError(clean_error(str(e)))

    if flat is None:
        raise ValueError("That URL could not be read. Check the link and try again.")

    kind = detect_kind(url, flat)
    result = {
        "url": url,
        "kind": kind,
        "title": flat.get("title") or flat.get("playlist_title") or "Untitled",
        "channel": flat.get("channel") or flat.get("uploader"),
        "thumbnail": thumb_for(flat),
        "duration": flat.get("duration"),
        "count": flat.get("playlist_count") or flat.get("n_entries"),
        "entries": [],
        "video": None,
        "audio_options": AUDIO_BITRATES,
        "video_options": QUALITY_OPTIONS,
    }

    if kind in ("playlist", "channel"):
        entries = []
        for e in flat.get("entries") or []:
            s = summarize_entry(e)
            if s:
                entries.append(s)
        entries = [e for e in entries if e["url"]]
        entries.sort(key=lambda e: e["index"] or 0)
        result["entries"] = entries[:MAX_PLAYLIST_ITEMS]
        result["count"] = len(result["entries"])
        if not result["entries"]:
            raise ValueError("No downloadable videos were found at that link.")
        # Playlist total runtime
        total = sum(e["duration"] for e in result["entries"] if e.get("duration"))
        result["total_duration"] = total or None
        return result

    # Single video: pass 2 gets the real format list so we can offer real qualities
    info = flat
    try:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            info = ydl.extract_info(url, download=False) or flat
    except (DownloadError, ExtractorError):
        info = flat  # fall back to flat data rather than failing outright

    heights = set()
    for f in info.get("formats") or []:
        h = f.get("height")
        vcodec = f.get("vcodec")
        if h and vcodec and vcodec != "none":
            heights.add(int(h))

    opts = [q for q in QUALITY_OPTIONS if q["id"] == "best" or (q["id"].isdigit() and int(q["id"]) in heights)]
    if not any(o["id"] == "best" for o in opts):
        opts.insert(0, QUALITY_OPTIONS[0])

    kind = detect_kind(url, info)
    result.update(
        {
            "kind": kind,
            "title": info.get("title") or "Untitled",
            "channel": info.get("channel") or info.get("uploader"),
            "thumbnail": thumb_for(info),
            "duration": info.get("duration"),
            "count": 1,
            "video_options": opts,
            "video": {
                "id": info.get("id"),
                "url": info.get("webpage_url") or url,
                "title": info.get("title") or "Untitled",
                "duration": info.get("duration"),
                "thumbnail": thumb_for(info),
                "kind": kind,
                "view_count": info.get("view_count"),
                "upload_date": info.get("upload_date"),
                "channel": info.get("channel") or info.get("uploader"),
                "description": (info.get("description") or "")[:400],
                "heights": sorted(heights, reverse=True),
            },
        }
    )
    result["entries"] = [summarize_entry(result["video"])] if result["video"] else []
    return result


def clean_error(msg):
    """Strip yt-dlp's noisy prefixes for display."""
    msg = re.sub(r"^ERROR:\s*", "", msg.strip())
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    if "The playlist does not exist" in msg:
        return "That playlist doesn't exist or is private."
    if "This video is unavailable" in msg or "Video unavailable" in msg:
        return "That video is unavailable (private, deleted, or region-locked)."
    if "Private video" in msg:
        return "That video is private."
    if "sign in" in msg.lower() and "age" in msg.lower():
        return "That video is age-restricted and can't be fetched."
    if "Unable to download" in msg and "webpage" in msg:
        return "YouTube didn't respond. Check your connection and try again."
    return msg[:400]


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------

def format_selector(fmt, quality):
    """Build a yt-dlp -f selector for the requested format/quality."""
    if fmt == "audio":
        return "bestaudio/best"
    if quality in (None, "", "best"):
        return "bestvideo*+bestaudio/best"
    h = int(quality)
    return (
        f"bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={h}]+bestaudio/best[height<={h}]/best"
    )


class Job:
    def __init__(self, jid, payload):
        self.id = jid
        self.created = time.time()
        self.output_dir = payload.get("output_dir") or DEFAULT_DOWNLOAD_DIR
        self.fmt = payload.get("format", "video")
        self.quality = payload.get("quality")
        self.items = payload.get("items") or []
        self.status = "queued"  # queued | processing | done | error | cancelled
        self.error = None
        self.cancel = threading.Event()
        self.lock = threading.Lock()
        self.current = None
        self.active = 0  # items downloading right now
        self.completed = []  # list of {title, path, size}
        self.total = len(self.items)
        self.results = []  # per-item results for the queue UI
        for it in self.items:
            self.results.append(
                {
                    "url": it.get("url"),
                    "title": it.get("title") or "Untitled",
                    "thumbnail": it.get("thumbnail"),
                    "kind": it.get("kind", "video"),
                    # a batch can mix MP3 audio and MP4 video in one job
                    "format": it.get("format") or self.fmt,
                    "status": "queued",
                    "percent": 0,
                    "speed": None,
                    "eta": None,
                    "stage": "Waiting",
                    "path": None,
                    "size": None,
                    "error": None,
                }
            )

    # -- progress helpers --------------------------------------------------
    def _index_for(self, url):
        for i, r in enumerate(self.results):
            if r["url"] == url and r["status"] in ("queued", "downloading"):
                return i
        return None

    def snapshot(self):
        with self.lock:
            done = sum(1 for r in self.results if r["status"] == "done")
            failed = sum(1 for r in self.results if r["status"] == "error")
            overall = 0
            if self.results:
                overall = sum(r["percent"] for r in self.results) / len(self.results)
            return {
                "id": self.id,
                "status": self.status,
                "error": self.error,
                "total": self.total,
                "done": done,
                "failed": failed,
                "percent": round(overall, 1),
                "output_dir": self.output_dir,
                "format": self.fmt,
                "quality": self.quality,
                "current": self.current,
                "items": self.results,
                "created": self.created,
            }


class JobManager:
    def __init__(self):
        self.jobs = {}
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.workers = []
        for i in range(3):  # parallel downloads
            t = threading.Thread(target=self._worker, daemon=True, name=f"dl-{i}")
            t.start()
            self.workers.append(t)

    def add(self, payload):
        jid = f"j{int(time.time() * 1000)%100000000}"
        job = Job(jid, payload)
        with self.lock:
            self.jobs[jid] = job
        self.q.put(job)
        return job

    def get(self, jid):
        with self.lock:
            return self.jobs.get(jid)

    def all(self):
        with self.lock:
            return sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)

    def _worker(self):
        while True:
            job = self.q.get()
            if job.cancel.is_set():
                job.status = "cancelled"
                continue
            self._run(job)

    # -- the actual download ------------------------------------------------
    def _run(self, job):
        job.status = "processing"
        outdir = job.output_dir
        Path(outdir).mkdir(parents=True, exist_ok=True)

        template = str(Path(outdir) / "%(title).180B [%(id)s].%(ext)s")

        def one(i, item):
            """Download exactly one selected video / Short."""
            # A batch can mix MP3 and MP4 ("Download all" across several
            # cards), so the format is resolved per item, falling back to the
            # job-level choice.
            raw_fmt = item.get("format")
            fmt = raw_fmt if raw_fmt in ("video", "audio") else job.fmt
            raw_q = item.get("quality")
            quality = raw_q if isinstance(raw_q, str) and raw_q else job.quality
            audio = fmt == "audio"
            try:
                selector = format_selector(fmt, quality)
            except Exception:  # malformed client value -> fall back to best
                selector = format_selector(fmt, None)
                quality = None

            if job.cancel.is_set():
                with job.lock:
                    rec = job.results[i]
                    if rec["status"] in ("queued", "downloading"):
                        rec["status"] = "cancelled"
                        rec["stage"] = "Cancelled"
                return

            with job.lock:
                rec = job.results[i]
                rec["status"] = "downloading"
                rec["stage"] = "Connecting"
                job.current = rec["title"]

            def hook(d, _i=i):
                rec = job.results[_i]
                with job.lock:
                    if d.get("status") == "downloading":
                        total = d.get("total_bytes") or d.get("total_bytes_estimate")
                        got = d.get("downloaded_bytes") or 0
                        if total:
                            rec["percent"] = min(99.0, round(got * 100 / total, 1))
                        if d.get("speed"):
                            rec["speed"] = f"{d['speed'] / 1048576:.1f} MB/s"
                        if d.get("eta") is not None:
                            rec["eta"] = int(d["eta"])
                        rec["stage"] = "Downloading"
                    elif d.get("status") == "finished":
                        rec["percent"] = 99.0
                        rec["stage"] = "Processing"
                        rec["speed"] = None
                        rec["eta"] = None
                    elif d.get("status") == "processing":
                        rec["stage"] = d.get("filename") and "Converting" or "Processing"

            opts = dict(base_opts())
            opts.pop("skip_download", None)
            opts.update({
                "format": selector,
                "outtmpl": template,
                "noplaylist": True,
                "progress_hooks": [hook],
                "merge_output_format": "mp4" if not audio else None,
                "postprocessors": [],
            })
            if audio:
                opts["postprocessors"].append({
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    # yt-dlp parses this with float_or_none -> bare number only
                    "preferredquality": re.sub(r"\D", "", quality or "192") or "192",
                })
                if FFMPEG_PATH:
                    opts["format"] = "bestaudio/best"
            if opts.get("merge_output_format") is None:
                opts.pop("merge_output_format", None)

            final_path = {"path": None, "size": None}
            try:
                before_files = set(os.listdir(outdir))
            except Exception:
                before_files = set()

            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(item["url"], download=True)
                    resolved = resolve_output(info, ydl, outdir, before_files)
                    if resolved:
                        final_path["path"] = resolved
                        try:
                            final_path["size"] = Path(resolved).stat().st_size
                        except OSError:
                            final_path["size"] = None

                with job.lock:
                    rec = job.results[i]
                    rec["status"] = "done"
                    rec["percent"] = 100.0
                    rec["stage"] = "Saved"
                    rec["path"] = final_path["path"]
                    rec["size"] = final_path["size"]
                    job.completed.append(
                        {"title": rec["title"], "path": final_path["path"], "size": final_path["size"]}
                    )
            except (DownloadError, ExtractorError) as e:
                with job.lock:
                    rec = job.results[i]
                    rec["status"] = "error"
                    rec["stage"] = "Failed"
                    rec["error"] = clean_error(str(e))
            except Exception as e:  # unexpected
                traceback.print_exc()
                with job.lock:
                    rec = job.results[i]
                    rec["status"] = "error"
                    rec["stage"] = "Failed"
                    rec["error"] = str(e)[:300]

        # Fan the selected items out over a small pool so several videos,
        # Shorts or playlist entries download at the same time.
        pending = list(enumerate(job.items))
        gate = threading.Lock()

        def runner():
            while True:
                with gate:
                    if not pending:
                        return
                    i, item = pending.pop(0)
                if job.cancel.is_set():
                    with job.lock:
                        rec = job.results[i]
                        if rec["status"] == "queued":
                            rec["status"] = "cancelled"
                            rec["stage"] = "Cancelled"
                    continue
                with job.lock:
                    job.active += 1
                try:
                    one(i, item)
                finally:
                    with job.lock:
                        job.active -= 1
                        if job.active <= 0:
                            job.current = None

        workers = max(1, min(3, len(job.items)))
        threads = [threading.Thread(target=runner, daemon=True) for _ in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        with job.lock:
            job.current = None
            job.active = 0
            for r in job.results:
                if r["status"] in ("queued", "downloading"):
                    r["status"] = "cancelled" if job.cancel.is_set() else "error"
                    r["stage"] = "Cancelled" if job.cancel.is_set() else "Failed"
                    if r["status"] == "error" and not r["error"]:
                        r["error"] = "Interrupted before it finished"
            if any(r["status"] == "cancelled" for r in job.results):
                job.status = "cancelled"
            elif any(r["status"] == "error" for r in job.results):
                job.status = "error"
            else:
                job.status = "done"


def sanitize(name):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:150] or "download"


def resolve_output(info, ydl, outdir, before_files):
    """Find the file yt-dlp actually wrote.

    yt-dlp rewrites titles into OS-safe forms (on Windows ``|`` becomes a
    full-width ``｜``) and changes the extension while converting/merging, so
    guessing the name never works. Ask yt-dlp first, then diff the folder.
    """
    info = info or {}

    # 1. The authoritative path yt-dlp records after post-processing.
    for entry in info.get("requested_downloads") or []:
        fp = entry.get("filepath")
        if fp and Path(fp).is_file():
            return str(fp)

    # 2. prepare_filename gives the template path; the suffix may have changed.
    try:
        fp = ydl.prepare_filename(info)
        if fp:
            p = Path(fp)
            if p.is_file():
                return str(p)
            for ext in ("mp3", "mp4", "m4a", "mkv", "webm", "opus", "ogg", "mov"):
                cand = p.with_suffix(f".{ext}")
                if cand.is_file():
                    return str(cand)
    except Exception:
        pass

    # 3. Fall back to whatever appeared in the folder during this download.
    try:
        fresh = {
            n
            for n in os.listdir(outdir)
            if n not in before_files and not n.endswith((".part", ".ytdl", ".tmp"))
        }
        if fresh:
            newest = max(
                (Path(outdir) / n for n in fresh),
                key=lambda p: p.stat().st_mtime,
            )
            if newest.is_file():
                return str(newest)
    except Exception:
        pass

    return None


MANAGER = JobManager()


# --------------------------------------------------------------------------
# Folder browser
# --------------------------------------------------------------------------

def drives():
    """List Windows drive letters (or POSIX roots)."""
    out = []
    if os.name == "nt":
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            root = f"{letter}:\\"
            if Path(root).exists():
                out.append({"path": root, "label": f"{letter}:"})
    else:
        out.append({"path": "/", "label": "Root"})
    return out


def browse(path=None):
    if not path:
        path = str(Path.home())
    p = Path(path).expanduser()
    if not p.exists() or not p.is_dir():
        raise ValueError("That folder does not exist.")

    entries = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if not child.is_dir():
                continue
            name = child.name
            if name.startswith((".", "$")):
                continue
            entries.append({"name": name, "path": str(child)})
    except PermissionError:
        raise ValueError("You don't have permission to open that folder.")

    parent = None
    try:
        parent = str(p.parent) if p.parent != p else None
    except Exception:
        parent = None

    return {
        "path": str(p),
        "parent": parent,
        "drives": drives() if os.name == "nt" else [{"path": "/", "label": "/"}],
        "dirs": entries,
        "home": str(Path.home()),
        "default": DEFAULT_DOWNLOAD_DIR,
    }


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

STATIC_DIR = BASE_DIR / "static"


class Handler(BaseHTTPRequestHandler):
    server_version = "Aurora/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):
        if "/api/jobs" in (args[0] if args else ""):
            return  # keep polling noise out of the console
        sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message, status=400):
        self._json({"error": message}, status)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # -- routes ------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            if path == "/api/health":
                return self._json(
                    {
                        "ok": True,
                        "yt_dlp": getattr(yt_dlp, "version", None) and yt_dlp.version.__version__,
                        "ffmpeg": bool(FFMPEG_PATH),
                        "download_dir": DEFAULT_DOWNLOAD_DIR,
                    }
                )

            if path == "/api/jobs":
                return self._json({"jobs": [j.snapshot() for j in MANAGER.all()]})

            if path.startswith("/api/jobs/"):
                job = MANAGER.get(path.rsplit("/", 1)[-1])
                if not job:
                    return self._error("Unknown job", 404)
                return self._json(job.snapshot())

            if path == "/api/browse":
                if not is_local(self):
                    return self._error("Folder browsing is only available on this computer.", 403)
                qs = urllib.parse.parse_qs(parsed.query)
                return self._json(browse(qs.get("path", [None])[0]))

            if path == "/api/open":
                if not is_local(self):
                    return self._error("Not allowed.", 403)
                qs = urllib.parse.parse_qs(parsed.query)
                target = qs.get("path", [""])[0]
                if target and Path(target).exists():
                    import subprocess

                    if os.name == "nt":
                        os.startfile(target)  # noqa: S606
                    elif sys.platform == "darwin":
                        subprocess.Popen(["open", target])
                    else:
                        subprocess.Popen(["xdg-open", target])
                    return self._json({"ok": True})
                return self._error("Path not found", 404)

            if path in ("/terms", "/terms.html"):
                return self._static("/terms.html")
            if path in ("/conditions", "/conditions.html"):
                return self._static("/conditions.html")

            # static files
            return self._static(path)

        except ValueError as e:
            return self._error(str(e))
        except Exception as e:
            traceback.print_exc()
            return self._error(f"Server error: {e}", 500)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        payload = self._body()
        try:
            if path == "/api/analyze":
                data = analyze(payload.get("url", ""))
                return self._json(data)

            if path == "/api/download":
                items = payload.get("items") or []
                items = [i for i in items if isinstance(i, dict) and i.get("url")]
                if not items:
                    return self._error("Select at least one video first.")
                outdir = payload.get("output_dir") or DEFAULT_DOWNLOAD_DIR
                outdir = str(Path(outdir).expanduser())
                try:
                    Path(outdir).mkdir(parents=True, exist_ok=True)
                except Exception:
                    return self._error("That download folder isn't usable. Pick another one.")
                fmt = payload.get("format") or "video"
                if fmt not in ("video", "audio"):
                    return self._error("Choose MP3 audio or MP4 video.")
                job = MANAGER.add(
                    {
                        "items": items,
                        "output_dir": outdir,
                        "format": fmt,
                        "quality": payload.get("quality"),
                    }
                )
                return self._json({"job": job.snapshot()})

            if path == "/api/mkdir":
                if not is_local(self):
                    return self._error("Not allowed.", 403)
                parent = payload.get("parent") or str(Path.home())
                name = sanitize((payload.get("name") or "").strip())
                if not name or name == "_":
                    return self._error("Enter a folder name.")
                target = Path(parent).expanduser() / name
                try:
                    target.mkdir(parents=True, exist_ok=True)
                except Exception:
                    return self._error("Couldn't create that folder.")
                return self._json({"path": str(target)})

            if path == "/api/jobs/cancel":
                job = MANAGER.get(payload.get("id", ""))
                if not job:
                    return self._error("Unknown job", 404)
                job.cancel.set()
                return self._json({"ok": True})

            return self._error("Not found", 404)
        except ValueError as e:
            return self._error(str(e))
        except Exception as e:
            traceback.print_exc()
            return self._error(f"Server error: {e}", 500)

    # -- static ------------------------------------------------------------
    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = urllib.parse.unquote(path.lstrip("/"))
        if ".." in rel or rel.startswith(("/","\\", "~")):
            return self._error("Forbidden", 403)
        fpath = (STATIC_DIR / rel).resolve()
        if not str(fpath).startswith(str(STATIC_DIR.resolve())):
            return self._error("Forbidden", 403)
        if not fpath.is_file():
            # SPA fallback
            fpath = STATIC_DIR / "index.html"
            if not fpath.is_file():
                return self._error("Not found", 404)

        data = fpath.read_bytes()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".webp": "image/webp",
            ".ico": "image/x-icon",
            ".woff2": "font/woff2",
        }.get(fpath.suffix.lower(), "application/octet-stream")

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description="Aurora YouTube downloader")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True

    print()
    print("  ✦ Aurora — YouTube Downloader")
    print("  ─────────────────────────────")
    print(f"  yt-dlp  : {getattr(yt_dlp.version, '__version__', 'unknown')}")
    print(f"  ffmpeg  : {FFMPEG_PATH or 'NOT FOUND (MP3/merging will fail)'}")
    print(f"  saving  : {DEFAULT_DOWNLOAD_DIR}")
    print(f"  open    : http://{args.host}:{args.port}")
    print()
    if not FFMPEG_PATH:
        print("  ⚠ ffmpeg not found — install it or `pip install imageio-ffmpeg`")
        print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye")
        server.server_close()


if __name__ == "__main__":
    main()
