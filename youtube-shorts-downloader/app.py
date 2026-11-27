"""
YouTube Shorts Downloader
-------------------------
Paste a YouTube channel link (or @handle, or a single Shorts link) and
download every Short from that channel — one by one or all together as a ZIP.

Backend: Flask + yt-dlp. Run with:  python app.py   then open http://localhost:5000
"""

import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
import yt_dlp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_ROOT = os.environ.get("DOWNLOAD_ROOT") or os.path.join(tempfile.gettempdir(), "shorts-downloader")
MAX_SHORTS = int(os.environ.get("MAX_SHORTS", "500"))       # max shorts listed per channel
MAX_PER_JOB = int(os.environ.get("MAX_PER_JOB", "200"))     # max shorts per ZIP job
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", "3600"))

os.makedirs(DOWNLOAD_ROOT, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
QUALITY_FORMATS = {
    # mp4 output so it plays everywhere; falls back gracefully
    "best": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "720": "bv*[height<=1280][ext=mp4]+ba[ext=m4a]/b[height<=1280]/bv*+ba/b",
    "480": "bv*[height<=854][ext=mp4]+ba[ext=m4a]/b[height<=854]/bv*+ba/b",
    "audio": "ba[ext=m4a]/ba",
}

jobs = {}           # job_id -> dict
jobs_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# URL helpers
# --------------------------------------------------------------------------- #
def normalize_input(raw: str):
    """Return ("video", video_id) or ("channel", shorts_tab_url)."""
    text = (raw or "").strip()
    if not text:
        raise ValueError("Please paste a YouTube channel link.")

    # bare @handle
    if re.fullmatch(r"@[\w.\-]{2,100}", text):
        return "channel", f"https://www.youtube.com/{text}/shorts"

    # bare channel id
    if re.fullmatch(r"UC[\w-]{22}", text):
        return "channel", f"https://www.youtube.com/channel/{text}/shorts"

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
        return "channel", f"https://www.youtube.com{cm.group(1)}/shorts"

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
def list_channel_shorts(shorts_url: str, limit: int):
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
    channel["title"] = re.sub(r"\s*-\s*Shorts$", "", channel["title"])

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
            "url": f"https://www.youtube.com/shorts/{vid}",
        })
    return channel, shorts


def get_single_video(video_id: str):
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/shorts/{video_id}", download=False)
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
        "url": f"https://www.youtube.com/shorts/{video_id}",
    }
    return channel, [short]


# --------------------------------------------------------------------------- #
# Downloading
# --------------------------------------------------------------------------- #
def download_one(video_id: str, out_dir: str, quality: str, progress_hook=None) -> str:
    """Download a single short into out_dir. Returns the final file path."""
    fmt = QUALITY_FORMATS.get(quality, QUALITY_FORMATS["best"])
    opts = {
        "quiet": True,
        "no_warnings": True,
        "format": fmt,
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
        info = ydl.extract_info(f"https://www.youtube.com/shorts/{video_id}", download=True)
        path = None
        for d in info.get("requested_downloads") or []:
            path = d.get("filepath") or path
        path = path or ydl.prepare_filename(info)
    if not path or not os.path.exists(path):
        # merged file may have a different extension
        for f in os.listdir(out_dir):
            if f"[{video_id}]" in f:
                path = os.path.join(out_dir, f)
                break
    if not path or not os.path.exists(path):
        raise RuntimeError("Download finished but the file was not found.")
    return path


def run_job(job_id: str):
    job = jobs[job_id]
    work_dir = job["dir"]
    files_dir = os.path.join(work_dir, "files")
    os.makedirs(files_dir, exist_ok=True)

    for idx, vid in enumerate(job["ids"]):
        if job["cancelled"]:
            break
        item = job["items"][vid]
        item["status"] = "downloading"
        job["current"] = vid

        def hook(d, item=item):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes") or 0
                item["progress"] = round(done * 100 / total, 1) if total else item.get("progress", 0)
            elif d.get("status") == "finished":
                item["progress"] = 100

        try:
            path = download_one(vid, files_dir, job["quality"], hook)
            item["status"] = "done"
            item["progress"] = 100
            item["file"] = os.path.basename(path)
            job["done"] += 1
        except Exception as exc:  # keep going with the rest
            item["status"] = "error"
            item["error"] = str(exc).replace("ERROR: ", "")[:300]
            job["failed"] += 1

    job["current"] = None
    if job["cancelled"]:
        job["status"] = "cancelled"
        return

    # build zip
    if job["done"]:
        job["status"] = "zipping"
        zip_name = safe_filename(job["name"], "shorts") + ".zip"
        zip_path = os.path.join(work_dir, zip_name)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for f in sorted(os.listdir(files_dir)):
                zf.write(os.path.join(files_dir, f), arcname=f)
        shutil.rmtree(files_dir, ignore_errors=True)
        job["zip"] = zip_path
        job["status"] = "finished"
    else:
        job["status"] = "failed"
    job["finished_at"] = time.time()


def cleanup_loop():
    while True:
        time.sleep(300)
        now = time.time()
        with jobs_lock:
            stale = [j for j, v in jobs.items() if now - v["created_at"] > JOB_TTL_SECONDS]
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


@app.get("/api/shorts")
def api_shorts():
    try:
        kind, value = normalize_input(request.args.get("url", ""))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    limit = min(int(request.args.get("limit", MAX_SHORTS) or MAX_SHORTS), MAX_SHORTS)
    try:
        if kind == "video":
            channel, shorts = get_single_video(value)
        else:
            channel, shorts = list_channel_shorts(value, limit)
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc).replace("ERROR: ", "")
        if "does not have a shorts tab" in msg.lower() or "This channel does not have" in msg:
            return jsonify(error="This channel has no Shorts."), 404
        return jsonify(error=f"Couldn't read that channel: {msg[:300]}"), 502
    return jsonify(channel=channel, shorts=shorts, count=len(shorts))


@app.get("/api/download/<video_id>")
def api_download_single(video_id):
    if not VIDEO_ID_RE.match(video_id):
        abort(400)
    quality = request.args.get("quality", "best")
    tmp = tempfile.mkdtemp(dir=DOWNLOAD_ROOT)
    try:
        path = download_one(video_id, tmp, quality)
    except Exception as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        return jsonify(error=str(exc).replace("ERROR: ", "")[:300]), 502

    response = send_file(path, as_attachment=True, download_name=os.path.basename(path))
    response.call_on_close(lambda: shutil.rmtree(tmp, ignore_errors=True))
    return response


@app.post("/api/jobs")
def api_create_job():
    data = request.get_json(silent=True) or {}
    ids = [v for v in data.get("ids", []) if isinstance(v, str) and VIDEO_ID_RE.match(v)]
    ids = list(dict.fromkeys(ids))  # dedupe, keep order
    if not ids:
        return jsonify(error="No shorts selected."), 400
    if len(ids) > MAX_PER_JOB:
        return jsonify(error=f"You can download at most {MAX_PER_JOB} shorts at once."), 400

    titles = data.get("titles") or {}
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id,
        "name": str(data.get("name") or "shorts")[:100],
        "quality": data.get("quality") if data.get("quality") in QUALITY_FORMATS else "best",
        "ids": ids,
        "items": {v: {"id": v, "title": str(titles.get(v, v))[:200], "status": "queued", "progress": 0}
                  for v in ids},
        "status": "running",
        "done": 0,
        "failed": 0,
        "current": None,
        "cancelled": False,
        "zip": None,
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
        "current": job["current"],
        "items": [job["items"][v] | {} for v in job["ids"]],
        "zip_ready": bool(job["zip"]),
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
    if not job or not job.get("zip") or not os.path.exists(job["zip"]):
        abort(404)
    return send_file(job["zip"], as_attachment=True, download_name=os.path.basename(job["zip"]))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"\n  ▶  Open http://localhost:{port} in your browser\n")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
