"""
YouTube & Facebook Downloader
-----------------------------
YouTube: paste a channel link (or @handle, or one video link) and download every
Short — or every regular (long) video — from that channel.
Facebook: paste one or many Reel / video links and download them all.
Each video is downloaded only once.

Backend: Flask + yt-dlp. Run with:  python app.py   then open http://localhost:5000
"""

import os
import re
import json
import shutil
import tempfile
import threading
import time
import subprocess
import sys
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
import yt_dlp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_ROOT = os.environ.get("DOWNLOAD_ROOT") or os.path.join(tempfile.gettempdir(), "shorts-downloader")
# Bulk downloads are saved here, one sub-folder per channel (kept after the app stops).
SAVE_DIR = os.environ.get("SAVE_DIR") or os.path.join(os.path.expanduser("~"), "Downloads", "YouTube Shorts")
VIDEOS_DIR = os.environ.get("VIDEOS_DIR") or os.path.join(os.path.dirname(SAVE_DIR), "YouTube Videos")
FB_REELS_DIR = os.environ.get("FB_REELS_DIR") or os.path.join(os.path.dirname(SAVE_DIR), "Facebook Reels")
FB_VIDEOS_DIR = os.environ.get("FB_VIDEOS_DIR") or os.path.join(os.path.dirname(SAVE_DIR), "Facebook Videos")
TAB_DIRS = {                 # tab -> where its downloads go
    "shorts": SAVE_DIR, "videos": VIDEOS_DIR,
    "fb_reels": FB_REELS_DIR, "fb_videos": FB_VIDEOS_DIR,
}
MAX_SHORTS = int(os.environ.get("MAX_SHORTS", "5000"))      # max shorts listed per channel
MAX_PER_JOB = int(os.environ.get("MAX_PER_JOB", "5000"))    # max shorts per bulk job
CONCURRENCY = max(1, int(os.environ.get("CONCURRENCY", "3")))  # parallel downloads
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", "21600"))

os.makedirs(DOWNLOAD_ROOT, exist_ok=True)

APP_VERSION = "3.1 · YouTube + Facebook"

app = Flask(__name__, static_folder="static", static_url_path="/static")


@app.after_request
def no_stale_pages(resp):
    """Never let the browser keep an old copy of the page after an update."""
    if request.path == "/" or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.get("/api/version")
def api_version():
    return jsonify(version=APP_VERSION)

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")             # YouTube video id
ITEM_ID_RE = re.compile(r"^(?:[A-Za-z0-9_-]{11}|fb_\d{12,30})$")  # YouTube id or "fb_<facebook id>"
FB_URL_RE = re.compile(r"(?:https?://)?(?:[\w-]+\.)?(?:facebook\.com|fb\.watch)/[^\s\"'<>]+", re.I)
# quality -> (format, format_sort). "res" is the smaller side, so 720 means 720p
# for both landscape videos and vertical Shorts. Output is merged to MP4.
QUALITY_FORMATS = {
    "best": ("bv*+ba/b", ["res", "ext:mp4:m4a"]),
    "1080": ("bv*+ba/b", ["res:1080", "ext:mp4:m4a"]),
    "720": ("bv*+ba/b", ["res:720", "ext:mp4:m4a"]),
    "480": ("bv*+ba/b", ["res:480", "ext:mp4:m4a"]),
    "audio": ("ba[ext=m4a]/ba", []),
}


def tab_of(value) -> str:
    return value if value in TAB_DIRS else "shorts"


def is_fb_url(url) -> bool:
    return isinstance(url, str) and bool(FB_URL_RE.fullmatch(url.strip())) and url.startswith("http")


def source_url(item_id: str, url: str = None) -> str:
    """The page yt-dlp should download an item from."""
    if item_id.startswith("fb_"):
        return url if is_fb_url(url) else f"https://www.facebook.com/watch/?v={item_id[3:]}"
    return video_url(item_id, "videos")


def video_url(video_id: str, tab: str = "shorts") -> str:
    return (f"https://www.youtube.com/shorts/{video_id}" if tab == "shorts"
            else f"https://www.youtube.com/watch?v={video_id}")

jobs = {}           # job_id -> dict
jobs_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# URL helpers
# --------------------------------------------------------------------------- #
def normalize_input(raw: str):
    """Return ("video", video_id) or ("channel", channel_base_url) — add "/shorts" or "/videos" to it."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Please paste a YouTube channel link.")

    # bare @handle
    if re.fullmatch(r"@[\w.\-]{2,100}", text):
        return "channel", f"https://www.youtube.com/{text}"

    # bare channel id
    if re.fullmatch(r"UC[\w-]{22}", text):
        return "channel", f"https://www.youtube.com/channel/{text}"

    if not re.match(r"^https?://", text):
        text = "https://" + text

    m = re.match(r"^https?://(?:www\.|m\.)?(?:youtube\.com|youtu\.be)(/[^?#]*)?(\?[^#]*)?", text, re.I)
    if not m:
        raise ValueError("That doesn't look like a YouTube link.")

    host_is_short = "youtu.be" in text.lower().split("/")[2]
    path = (m.group(1) or "/").rstrip("/")
    query = m.group(2) or ""

    # single video links
    if host_is_short and re.fullmatch(r"/[A-Za-z0-9_-]{11}", path):
        return "video", path[1:]
    sm = re.fullmatch(r"/shorts/([A-Za-z0-9_-]{11})", path)
    if sm:
        return "video", sm.group(1)
    if path == "/watch":
        vm = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", query)
        if vm:
            return "video", vm.group(1)

    # channel links: /@handle, /channel/UC..., /c/name, /user/name (+ optional tab)
    cm = re.match(r"^(/@[^/]+|/channel/[^/]+|/c/[^/]+|/user/[^/]+)", path)
    if cm:
        return "channel", f"https://www.youtube.com{cm.group(1)}"

    raise ValueError("Please paste a channel link like https://www.youtube.com/@name")


def best_thumb(entry):
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        # prefer portrait / largest
        thumbs = sorted(thumbs, key=lambda t: (t.get("height") or 0) * (t.get("width") or 0))
        return thumbs[-1].get("url")
    vid = entry.get("id")
    return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else None


def safe_filename(name: str, fallback: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", name or "").strip()
    name = re.sub(r"\s+", " ", name)[:120].strip(" .")
    return name or fallback


# --------------------------------------------------------------------------- #
# Listing shorts
# --------------------------------------------------------------------------- #
def list_channel_shorts(shorts_url: str, limit: int, tab: str = "shorts"):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "playlistend": limit,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(shorts_url, download=False)

    channel = {
        "title": info.get("channel") or info.get("uploader") or info.get("title") or "",
        "url": info.get("channel_url") or info.get("uploader_url") or shorts_url,
        "id": info.get("channel_id") or info.get("id"),
    }
    channel["title"] = re.sub(r"\s*-\s*(Shorts|Videos)$", "", channel["title"])

    shorts = []
    for e in info.get("entries") or []:
        if not e:
            continue
        vid = e.get("id")
        if not vid or not VIDEO_ID_RE.match(vid):
            continue
        shorts.append({
            "id": vid,
            "title": e.get("title") or vid,
            "thumbnail": best_thumb(e),
            "views": e.get("view_count"),
            "duration": e.get("duration"),
            "url": video_url(vid, tab),
        })
    return channel, shorts


def detect_tab(info, is_shorts_link: bool) -> str:
    """Is a single video a Short or a regular (long) video?"""
    if is_shorts_link:
        return "shorts"
    w, h, dur = info.get("width") or 0, info.get("height") or 0, info.get("duration") or 0
    return "shorts" if (h > w > 0 and 0 < dur <= 180) else "videos"


def get_single_video(video_id: str, is_shorts_link: bool = False):
    """Look up one video. Returns (channel, [video], tab) — tab says where it gets saved."""
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(video_url(video_id, "videos"), download=False)
    tab = detect_tab(info, is_shorts_link)
    channel = {
        "title": info.get("channel") or info.get("uploader") or "",
        "url": info.get("channel_url") or "",
        "id": info.get("channel_id"),
    }
    short = {
        "id": video_id,
        "title": info.get("title") or video_id,
        "thumbnail": info.get("thumbnail") or best_thumb(info),
        "views": info.get("view_count"),
        "duration": info.get("duration"),
        "url": video_url(video_id, tab),
    }
    return channel, [short], tab


# --------------------------------------------------------------------------- #
# Downloading
# --------------------------------------------------------------------------- #
def download_one(video_id: str, out_dir: str, quality: str, progress_hook=None, url: str = None) -> str:
    """Download a single video/short into out_dir. Returns the final file path."""
    fmt, sort = QUALITY_FORMATS.get(quality, QUALITY_FORMATS["best"])
    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": fmt,
        "format_sort": sort,
        "outtmpl": os.path.join(out_dir, "%(title).100B [%(id)s].%(ext)s"),
        "noplaylist": True,
        "restrictfilenames": False,
        "windowsfilenames": True,
        "retries": 3,
        "fragment_retries": 3,
        "concurrent_fragment_downloads": 4,
    }
    if quality != "audio":
        opts["merge_output_format"] = "mp4"
    if progress_hook:
        opts["progress_hooks"] = [progress_hook]

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(source_url(video_id, url), download=True)
        path = None
        for d in info.get("requested_downloads") or []:
            path = d.get("filepath") or path
        path = path or ydl.prepare_filename(info)
    if not path or not os.path.exists(path):
        # merged file may have a different extension
        raw_id = video_id[3:] if video_id.startswith("fb_") else video_id
        for f in os.listdir(out_dir):
            if f"[{raw_id}]" in f:
                path = os.path.join(out_dir, f)
                break
    if not path or not os.path.exists(path):
        raise RuntimeError("Download finished but the file was not found.")
    return path


# --------------------------------------------------------------------------- #
# Download history: every video is downloaded only once
# --------------------------------------------------------------------------- #
HISTORY_FILE = os.path.join(SAVE_DIR, ".downloaded.json")
# "<title> [<id>].<ext>" — 11 chars = YouTube, 12+ digits = Facebook
MEDIA_RE = re.compile(r"\[([A-Za-z0-9_-]{11}|\d{12,30})\]\.(mp4|m4a|webm|mkv|mp3|opus)$", re.I)
history = {}                 # video_id -> {"path", "title", "channel", "at"}
history_lock = threading.Lock()
in_flight = {}               # video_id -> threading.Event (download running right now)


def _save_history():
    os.makedirs(SAVE_DIR, exist_ok=True)
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(history, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, HISTORY_FILE)


def load_history():
    """Load the history file and add any videos already sitting in SAVE_DIR."""
    try:
        with open(HISTORY_FILE, encoding="utf-8") as fh:
            history.update(json.load(fh))
    except (OSError, ValueError):
        pass
    changed = False
    for base in dict.fromkeys(TAB_DIRS.values()):
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for f in files:
                m = MEDIA_RE.search(f)
                if not m:
                    continue
                vid, path = m.group(1), os.path.join(root, f)
                if len(vid) >= 12:
                    vid = "fb_" + vid
                entry = history.get(vid)
                if not entry or not os.path.exists(entry.get("path", "")):
                    history[vid] = {"path": path, "title": f[: m.start()].strip(),
                                    "channel": os.path.basename(root), "at": time.time()}
                    changed = True
    if changed:
        _save_history()


def existing_file(video_id: str):
    entry = history.get(video_id)
    if entry and os.path.exists(entry.get("path", "")):
        return entry["path"]
    return None


def ensure_downloaded(video_id, folder, quality, title="", channel="", progress_hook=None, url=None):
    """Download a video unless it was downloaded before. Returns (path, "done"|"skipped")."""
    while True:
        with history_lock:
            path = existing_file(video_id)
            if path:
                return path, "skipped"
            event = in_flight.get(video_id)
            owner = event is None
            if owner:
                event = in_flight[video_id] = threading.Event()
        if not owner:            # same video is downloading in another job: wait, then re-check
            event.wait()
            continue
        try:
            os.makedirs(folder, exist_ok=True)
            path = download_one(video_id, folder, quality, progress_hook, url)
            with history_lock:
                history[video_id] = {"path": path, "title": title, "channel": channel, "at": time.time()}
                _save_history()
            return path, "done"
        finally:
            with history_lock:
                in_flight.pop(video_id, None)
            event.set()


load_history()


def run_job(job_id: str):
    job = jobs[job_id]
    folder = job["folder"]
    lock = threading.Lock()

    def work(vid):
        if job["cancelled"]:
            return
        item = job["items"][vid]
        item["status"] = "downloading"

        def hook(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes") or 0
                if total:
                    item["progress"] = round(done * 100 / total, 1)
            elif d.get("status") == "finished":
                item["progress"] = 100

        try:
            path, how = ensure_downloaded(vid, folder, job["quality"], item["title"], job["channel"], hook,
                                          item.get("url"))
            item.update(status=how, progress=100, path=path, file=os.path.basename(path))
            with lock:
                job["done"] += 1
        except Exception as exc:  # keep going with the rest
            item["status"] = "error"
            item["error"] = str(exc).replace("ERROR: ", "")[:300]
            with lock:
                job["failed"] += 1

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        list(pool.map(work, job["ids"]))

    if job["cancelled"]:
        job["status"] = "cancelled"
    else:
        job["status"] = "finished" if job["done"] else "failed"
    job["finished_at"] = time.time()


def build_zip(job):
    """Pack the job's files into a ZIP (on demand; can be several GB)."""
    with job["zip_lock"]:
        if job.get("zip") and os.path.exists(job["zip"]):
            return job["zip"]
        files = [it["path"] for it in job["items"].values() if it.get("path")]
        zip_path = os.path.join(job["dir"], safe_filename(job["name"], "shorts") + ".zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for full in files:
                if os.path.exists(full):
                    zf.write(full, arcname=os.path.basename(full))
        job["zip"] = zip_path
        return zip_path


def cleanup_loop():
    """Forget old jobs and delete their temporary ZIPs (saved videos are kept)."""
    while True:
        time.sleep(300)
        now = time.time()
        with jobs_lock:
            stale = [j for j, v in jobs.items()
                     if v["status"] != "running" and now - v["created_at"] > JOB_TTL_SECONDS]
            for j in stale:
                shutil.rmtree(jobs[j]["dir"], ignore_errors=True)
                jobs.pop(j, None)


threading.Thread(target=cleanup_loop, daemon=True).start()


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "index.html")


@app.get("/api/list")
@app.get("/api/shorts")
def api_shorts():
    tab = tab_of(request.args.get("type"))
    raw_url = request.args.get("url", "")
    try:
        kind, value = normalize_input(raw_url)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    limit = min(int(request.args.get("limit", MAX_SHORTS) or MAX_SHORTS), MAX_SHORTS)
    try:
        if kind == "video":
            channel, shorts, tab = get_single_video(value, "/shorts/" in raw_url.lower())
        else:
            channel, shorts = list_channel_shorts(f"{value}/{tab}", limit, tab)
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc).replace("ERROR: ", "")
        if "does not have a" in msg.lower():
            what = "লম্বা ভিডিও" if tab == "videos" else "Shorts"
            return jsonify(error=f"এই চ্যানেলে কোনো {what} নেই।"), 404
        return jsonify(error=f"Couldn't read that channel: {msg[:300]}"), 502
    for sh in shorts:
        sh["downloaded"] = sh["id"] in history
    return jsonify(channel=channel, shorts=shorts, count=len(shorts), type=tab, single=kind == "video",
                   downloaded=sum(sh["downloaded"] for sh in shorts))


@app.post("/api/download/<video_id>")
def api_download_single(video_id):
    """Save one short to the channel folder (skipped if it was downloaded before)."""
    if not ITEM_ID_RE.match(video_id):
        abort(400)
    data = request.get_json(silent=True) or {}
    quality = data.get("quality") if data.get("quality") in QUALITY_FORMATS else "best"
    channel = safe_filename(str(data.get("channel") or ""), "channel")
    try:
        path, how = ensure_downloaded(video_id, os.path.join(TAB_DIRS[tab_of(data.get("type"))], channel), quality,
                                      str(data.get("title") or "")[:200], channel, url=data.get("url"))
    except Exception as exc:
        return jsonify(error=str(exc).replace("ERROR: ", "")[:300]), 502
    return jsonify(status=how, file=os.path.basename(path), folder=os.path.dirname(path))


@app.get("/api/file/<video_id>")
def api_get_file(video_id):
    """Send an already-downloaded file to the browser (e.g. when using the site from a phone)."""
    path = existing_file(video_id) if ITEM_ID_RE.match(video_id) else None
    if not path:
        abort(404)
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


# --------------------------------------------------------------------------- #
# Facebook: one or many Reel / video links
# --------------------------------------------------------------------------- #
def fb_links(text: str):
    """Pull every Facebook link out of pasted text (one per line, or mixed with other text)."""
    out = []
    for u in FB_URL_RE.findall(text or ""):
        u = u.rstrip(").,;!]}>")
        if not u.lower().startswith("http"):
            u = "https://" + u
        out.append(u)
    return list(dict.fromkeys(out))


def fb_friendly_error(msg: str) -> str:
    low = msg.lower()
    if any(k in low for k in ("login", "log in", "logged", "private", "cookies", "registered", "only available",
                              "not available", "unavailable", "permission")):
        return "ভিডিওটা প্রাইভেট বা লগইন ছাড়া দেখা যায় না"
    if "unsupported url" in low or "no video" in low:
        return "এই লিঙ্কে কোনো ভিডিও পাওয়া যায়নি"
    return msg[:200]


def fb_lookup(url: str):
    """Read one Facebook link (no download). Returns a card dict."""
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") in ("playlist", "multi_video"):   # a post with several videos: take the first
        info = next((e for e in info.get("entries") or [] if e), None) or {}
    raw_id = str(info.get("id") or "")
    if not raw_id.isdigit() or not 12 <= len(raw_id) <= 30:
        raise RuntimeError("এই লিঙ্কে কোনো ভিডিও পাওয়া যায়নি")
    page = info.get("webpage_url") or url
    w, h, dur = info.get("width") or 0, info.get("height") or 0, info.get("duration") or 0
    is_reel = "/reel" in url.lower() or "/reel" in page.lower() or (
        "/videos/" not in url.lower() and "watch" not in url.lower() and h > w > 0 and 0 < dur <= 90)
    title = (info.get("title") or "").strip()
    uploader = info.get("uploader") or info.get("channel") or ""
    generic = (not title or title == uploader or len(title) < 4
               or re.match(r"^(video|reels?|watch)\b.*\bby\b|.*\|\s*facebook$", title, re.I))
    if generic:   # Facebook often titles things "Video by <page>": use the post text instead
        desc = (info.get("description") or "").strip().split("\n")[0][:100]
        title = desc or title or "Facebook video"
    return {
        "id": "fb_" + raw_id,
        "title": title[:200],
        "thumbnail": info.get("thumbnail") or (best_thumb(info) if info.get("thumbnails") else None),
        "views": info.get("view_count"),
        "duration": dur or None,
        "url": page if is_fb_url(page) else url,
        "uploader": info.get("uploader") or info.get("channel") or "",
        "reel": is_reel,
    }


@app.post("/api/fb/list")
def api_fb_list():
    data = request.get_json(silent=True) or {}
    want = data.get("type") if data.get("type") in ("fb_reels", "fb_videos") else "fb_reels"
    links = fb_links(str(data.get("links") or ""))[:MAX_SHORTS]
    if not links:
        return jsonify(error="কোনো ফেসবুক লিঙ্ক পাওয়া যায়নি। facebook.com/reel/… বা …/videos/… লিঙ্ক দিন।"), 400

    def one(u):
        try:
            return fb_lookup(u), None
        except Exception as exc:
            return None, {"url": u, "error": fb_friendly_error(str(exc).replace("ERROR: ", ""))}

    items, failed, seen = [], [], set()
    with ThreadPoolExecutor(max_workers=4) as pool:
        for item, err in pool.map(one, links):
            if err:
                failed.append(err)
            elif item["id"] not in seen:
                seen.add(item["id"])
                items.append(item)
    if not items:
        msg = failed[0]["error"] if failed else "কোনো ভিডিও পাওয়া যায়নি"
        return jsonify(error=f"কোনো লিঙ্ক খোলা যায়নি — {msg}", failed=failed), 502

    # all Reels -> Reels tab, all regular videos -> Videos tab, mixed -> the tab the user picked
    reels = sum(1 for i in items if i["reel"])
    tab = "fb_reels" if reels == len(items) else "fb_videos" if reels == 0 else want
    uploaders = [i["uploader"] for i in items if i["uploader"]]
    page = max(set(uploaders), key=uploaders.count) if uploaders else "Facebook"
    for i in items:
        i["downloaded"] = i["id"] in history
    return jsonify(channel={"title": page}, shorts=items, count=len(items), type=tab, failed=failed,
                   downloaded=sum(i["downloaded"] for i in items))


@app.post("/api/jobs")
def api_create_job():
    data = request.get_json(silent=True) or {}
    ids = [v for v in data.get("ids", []) if isinstance(v, str) and ITEM_ID_RE.match(v)]
    ids = list(dict.fromkeys(ids))  # dedupe, keep order
    if not ids:
        return jsonify(error="No shorts selected."), 400
    if len(ids) > MAX_PER_JOB:
        return jsonify(error=f"You can download at most {MAX_PER_JOB} shorts at once."), 400

    titles = data.get("titles") or {}
    urls = data.get("urls") or {}
    job_id = uuid.uuid4().hex
    channel_name = safe_filename(str(data.get("channel") or ""), "channel")
    job = {
        "id": job_id,
        "name": str(data.get("name") or "shorts")[:100],
        "quality": data.get("quality") if data.get("quality") in QUALITY_FORMATS else "best",
        "ids": ids,
        "items": {v: {"id": v, "title": str(titles.get(v, v))[:200], "status": "queued", "progress": 0,
                      "url": urls.get(v) if is_fb_url(urls.get(v)) else None}
                  for v in ids},
        "status": "running",
        "done": 0,
        "failed": 0,
        "cancelled": False,
        "zip": None,
        "zip_lock": threading.Lock(),
        "channel": channel_name,
        "folder": os.path.join(TAB_DIRS[tab_of(data.get("type"))], channel_name),
        "dir": tempfile.mkdtemp(prefix=f"job-{job_id[:8]}-", dir=DOWNLOAD_ROOT),
        "created_at": time.time(),
    }
    with jobs_lock:
        jobs[job_id] = job
    threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
    return jsonify(id=job_id), 201


def public_job(job):
    return {
        "id": job["id"],
        "status": job["status"],
        "total": len(job["ids"]),
        "done": job["done"],
        "failed": job["failed"],
        "skipped": sum(1 for it in job["items"].values() if it["status"] == "skipped"),
        "new": sum(1 for it in job["items"].values() if it["status"] == "done"),
        "folder": job["folder"],
        "items": [{k: v for k, v in job["items"][i].items() if k != "path"} for i in job["ids"]],
    }


@app.get("/api/jobs/<job_id>")
def api_job_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify(error="Job not found (it may have expired)."), 404
    return jsonify(public_job(job))


@app.post("/api/jobs/<job_id>/cancel")
def api_job_cancel(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404)
    job["cancelled"] = True
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>/zip")
def api_job_zip(job_id):
    job = jobs.get(job_id)
    if not job or job["status"] not in ("finished", "cancelled") or not job["done"]:
        abort(404)
    path = build_zip(job)
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


@app.post("/api/zip")
def api_zip_downloaded():
    """ZIP every already-downloaded short in the given list (works any time, even after cancel)."""
    raw = request.form.get("ids") or (request.get_json(silent=True) or {}).get("ids") or ""
    ids = raw.split(",") if isinstance(raw, str) else raw
    paths = [p for p in (existing_file(v) for v in ids if isinstance(v, str) and ITEM_ID_RE.match(v)) if p]
    if not paths:
        return jsonify(error="এখনো কোনো ভিডিও নামানো হয়নি।"), 404
    name = safe_filename(request.form.get("name") or "shorts", "shorts") + ".zip"
    tmp = tempfile.mkdtemp(dir=DOWNLOAD_ROOT)
    zip_path = os.path.join(tmp, name)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for p in dict.fromkeys(paths):
            zf.write(p, arcname=os.path.basename(p))
    response = send_file(zip_path, as_attachment=True, download_name=name)
    response.call_on_close(lambda: shutil.rmtree(tmp, ignore_errors=True))
    return response


@app.post("/api/jobs/<job_id>/open")
def api_job_open_folder(job_id):
    """Open the download folder in the file manager (works when running on your own PC)."""
    job = jobs.get(job_id)
    if not job:
        abort(404)
    os.makedirs(job["folder"], exist_ok=True)
    if not os.path.isdir(job["folder"]):
        abort(404)
    try:
        if sys.platform.startswith("win"):
            os.startfile(job["folder"])  # noqa: S606 - local desktop use
        elif sys.platform == "darwin":
            subprocess.Popen(["open", job["folder"]])
        else:
            subprocess.Popen(["xdg-open", job["folder"]])
    except Exception as exc:
        return jsonify(error=str(exc)), 500
    return jsonify(ok=True)


def _already_running(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


if __name__ == "__main__":
    import webbrowser
    port = int(os.environ.get("PORT", "5000"))
    url = f"http://localhost:{port}"
    open_browser = os.environ.get("OPEN_BROWSER") == "1"   # set by "Start Downloader.bat"
    if _already_running(port):
        # double-clicked again while it is already running: just show the page
        print(f"\n  ▶  The downloader is already running — opening {url}\n")
        if open_browser:
            webbrowser.open(url)
        sys.exit(0)
    if open_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\n  ▶  Video Downloader — version {APP_VERSION}")
    print(f"  ▶  Open {url} in your browser  (keep this window open while you use it)")
    print(f"  ▶  Shorts are saved to: {SAVE_DIR}")
    print(f"  ▶  Videos are saved to: {VIDEOS_DIR}")
    print(f"  ▶  Facebook Reels / Videos: {FB_REELS_DIR} / {FB_VIDEOS_DIR}\n")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
