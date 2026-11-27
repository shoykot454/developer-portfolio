(() => {
  const $ = (s) => document.querySelector(s);
  const form = $("#search"), urlInput = $("#url"), goBtn = $("#go");
  const statusEl = $("#status"), results = $("#results"), grid = $("#grid");
  const selectAll = $("#selectAll"), quality = $("#quality"), dlAll = $("#dlAll");
  const jobBox = $("#job"), jobText = $("#jobText"), jobBar = $("#jobBar");
  const zipLink = $("#zipLink"), cancelBtn = $("#cancelJob");
  const openFolder = $("#openFolder"), jobFolder = $("#jobFolder"), zipAll = $("#zipAll");
  const tpl = $("#cardTpl");

  let shorts = [], channel = {}, cards = new Map(), pollTimer = null, jobId = null;

  // Which channel tab we work with: "shorts" or "videos" (regular long videos).
  let mode = "shorts", listed = "shorts";
  try { if (localStorage.getItem("ytdl-mode") === "videos") mode = "videos"; } catch (e) {}
  const word = (t = listed) => (t === "videos" ? "ভিডিও" : "Shorts");

  function applyMode() {
    document.querySelectorAll(".tab").forEach((b) => {
      const on = b.dataset.type === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on);
    });
    goBtn.textContent = mode === "videos" ? "ভিডিও খুঁজুন" : "Shorts খুঁজুন";
    quality.value = mode === "videos" ? "1080" : "best"; // long videos in 4K can be huge
  }
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.type === mode || jobId) return;
      mode = b.dataset.type;
      try { localStorage.setItem("ytdl-mode", mode); } catch (e) {}
      applyMode();
      if (urlInput.value.trim()) form.requestSubmit(); // re-list the same channel
      else results.hidden = true;
    })
  );
  applyMode();

  const fmtViews = (n) => {
    if (n == null) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B views";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
    return n + " views";
  };
  const fmtDur = (s) => {
    if (!s) return "";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(Math.floor(s % 60)).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  function showStatus(html, isError = false) {
    statusEl.hidden = false;
    statusEl.className = "status" + (isError ? " error" : "");
    statusEl.innerHTML = html;
  }
  const hideStatus = () => (statusEl.hidden = true);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    goBtn.disabled = true;
    results.hidden = true;
    const type = mode;
    showStatus(`<span class="spinner"></span>চ্যানেলের ${word(type)} খোঁজা হচ্ছে… (বড় চ্যানেলে একটু সময় লাগতে পারে)`);
    try {
      const res = await fetch(`/api/list?type=${type}&url=` + encodeURIComponent(url));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      if (!data.shorts.length) throw new Error(`এই চ্যানেলে কোনো ${word(type)} পাওয়া যায়নি।`);
      listed = data.type || type;
      if (listed !== mode) {           // a single link decides by itself: Short or long video
        mode = listed;
        applyMode();
      }
      shorts = data.shorts;
      channel = data.channel || {};
      render();
      hideStatus();
    } catch (err) {
      showStatus(err.message, true);
    } finally {
      goBtn.disabled = false;
    }
  });

  function render() {
    grid.innerHTML = "";
    cards.clear();
    $("#chTitle").textContent = channel.title || word();
    grid.classList.toggle("landscape", listed === "videos");
    const had = shorts.filter((s) => s.downloaded).length;
    $("#chCount").textContent = had
      ? `${shorts.length} টি ${word()} · ${shorts.length - had} টি নতুন · ${had} টি আগে নামানো`
      : `${shorts.length} টি ${word()}`;
    jobBox.hidden = true;
    if (had === shorts.length) showStatus(`✓ এই চ্যানেলের সব ${word()} আগেই নামানো আছে — নতুন কিছু নেই।`);

    const frag = document.createDocumentFragment();
    for (const s of shorts) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector(".thumb").href = s.url;
      const img = node.querySelector("img");
      img.src = s.thumbnail || `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`;
      img.alt = s.title;
      img.onerror = () => { img.onerror = null; img.src = `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`; };
      node.querySelector(".dur").textContent = fmtDur(s.duration);
      node.querySelector(".title").textContent = s.title;
      node.querySelector(".title").title = s.title;
      node.querySelector(".views").textContent = fmtViews(s.views);
      const cb = node.querySelector(".pick input");
      if (s.downloaded) markDownloaded(node, "✓ আগে নামানো");
      cb.addEventListener("change", () => { node.classList.toggle("off", !cb.checked); updateCount(); });
      node.querySelector(".dl").addEventListener("click", () => downloadSingle(s, node));
      cards.set(s.id, node);
      frag.appendChild(node);
    }
    grid.appendChild(frag);
    results.hidden = false;
    updateCount();
  }

  // Already-downloaded shorts start unchecked, so only new ones get downloaded.
  function markDownloaded(node, text) {
    node.classList.add("had", "off");
    node.querySelector(".pick input").checked = false;
    setCardState(node, text, "ok");
  }

  function selectedIds() {
    return shorts.filter((s) => cards.get(s.id).querySelector(".pick input").checked).map((s) => s.id);
  }
  function updateCount() {
    const n = selectedIds().length;
    dlAll.textContent = `সিলেক্টেড ${n} টি ডাউনলোড`;
    const had = shorts.filter((s) => s.downloaded).length;
    zipAll.hidden = had === 0;
    zipAll.textContent = `📦 নামানো ${had} টি ZIP হিসেবে নিন`;
    dlAll.disabled = n === 0 || !!jobId;
    const fresh = shorts.filter((s) => !cards.get(s.id).classList.contains("had"));
    const freshSel = fresh.filter((s) => cards.get(s.id).querySelector(".pick input").checked).length;
    selectAll.checked = fresh.length > 0 && freshSel === fresh.length;
    selectAll.indeterminate = freshSel > 0 && freshSel < fresh.length;
  }
  // "সব সিলেক্ট" selects every NEW short; already-downloaded ones can still be ticked by hand.
  selectAll.addEventListener("change", () => {
    for (const node of cards.values()) {
      const cb = node.querySelector(".pick input");
      if (node.classList.contains("had")) { if (!selectAll.checked) cb.checked = false; }
      else cb.checked = selectAll.checked;
      node.classList.toggle("off", !cb.checked);
    }
    updateCount();
  });

  function setCardState(node, text, cls) {
    const el = node.querySelector(".state");
    el.textContent = text || "";
    el.className = "state" + (cls ? " " + cls : "");
  }

  // ZIP of everything already downloaded from this channel — works any time (even after cancel).
  zipAll.addEventListener("click", () => {
    const ids = shorts.filter((s) => s.downloaded).map((s) => s.id);
    if (!ids.length) return;
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/zip";
    for (const [k, v] of [["ids", ids.join(",")], ["name", `${channel.title || "channel"} ${listed}`]]) {
      const input = document.createElement("input");
      input.type = "hidden"; input.name = k; input.value = v;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
    showStatus(`<span class="spinner"></span>${ids.length} টি ভিডিওর ZIP বানানো হচ্ছে… বড় হলে কয়েক মিনিট লাগতে পারে, তারপর ডাউনলোড নিজে থেকে শুরু হবে।`);
    setTimeout(hideStatus, 15000);
  });

  // Single download: saved to the channel folder; skipped if it was downloaded before.
  async function downloadSingle(s, node) {
    const btn = node.querySelector(".dl");
    btn.disabled = true;
    setCardState(node, "ডাউনলোড হচ্ছে…", "run");
    try {
      const res = await fetch(`/api/download/${s.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: quality.value, type: listed, channel: channel.title || "channel", title: s.title }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Download failed");
      s.downloaded = true;
      markDownloaded(node, data.status === "skipped" ? "✓ আগেই নামানো ছিল (আবার নামানো হয়নি)" : "✓ ফোল্ডারে সেভ হয়েছে");
      const link = document.createElement("a");
      link.href = `/api/file/${s.id}`;
      link.textContent = " · ফাইল নিন";
      link.className = "filelink";
      node.querySelector(".state").appendChild(link);
      updateCount();
    } catch (err) {
      setCardState(node, "✗ " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  // Bulk download: start a job on the server, poll progress, then offer the ZIP.
  dlAll.addEventListener("click", async () => {
    const ids = selectedIds();
    if (!ids.length) return;
    const titles = Object.fromEntries(shorts.filter((s) => ids.includes(s.id)).map((s) => [s.id, s.title]));
    dlAll.disabled = true;
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, titles, quality: quality.value, type: listed, channel: channel.title || "channel", name: `${channel.title || "channel"} ${listed}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start");
      jobId = data.id;
      jobBox.hidden = false;
      zipLink.hidden = true;
      openFolder.hidden = true;
      jobFolder.hidden = true;
      cancelBtn.hidden = false;
      jobBar.style.width = "0%";
      jobText.textContent = `ডাউনলোড শুরু হচ্ছে… 0 / ${ids.length}`;
      for (const node of cards.values()) setCardState(node, "");
      ids.forEach((id) => setCardState(cards.get(id), "অপেক্ষায়…", "run"));
      poll();
    } catch (err) {
      showStatus(err.message, true);
      updateCount();
    }
  });

  async function poll() {
    clearTimeout(pollTimer);
    if (!jobId) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || "Job lost");

      let partial = 0;
      for (const it of job.items) {
        const node = cards.get(it.id);
        if (!node) continue;
        if (it.status === "done" || it.status === "skipped") {
          const s = shorts.find((x) => x.id === it.id);
          if (s) s.downloaded = true;
          markDownloaded(node, it.status === "done" ? "✓ সম্পন্ন" : "✓ আগেই নামানো ছিল (আবার নামানো হয়নি)");
        }
        else if (it.status === "error") setCardState(node, "✗ " + (it.error || "ব্যর্থ"), "err");
        else if (it.status === "downloading") { setCardState(node, `ডাউনলোড হচ্ছে… ${Math.round(it.progress || 0)}%`, "run"); partial += (it.progress || 0) / 100; }
      }
      jobFolder.hidden = false;
      jobFolder.textContent = "সেভ হচ্ছে: " + job.folder;
      updateCount();
      const finished = job.done + job.failed;
      jobBar.style.width = `${((finished + partial) / job.total) * 100}%`;
      const failTxt = job.failed ? ` · ${job.failed} টি ব্যর্থ` : "";

      if (job.status === "running") {
        jobText.textContent = `ডাউনলোড হচ্ছে… ${finished} / ${job.total}${failTxt}`;
      } else {
        endJob();
        if (job.status === "finished") {
          jobBar.style.width = "100%";
          const skipTxt = job.skipped ? ` · ${job.skipped} টি আগেই ছিল, আবার নামানো হয়নি` : "";
          jobText.textContent = `✓ ${job.new} টি নতুন ${word()} সেভ হয়েছে${skipTxt}${failTxt}`;
          jobFolder.textContent = "ফোল্ডার: " + job.folder;
          openFolder.hidden = false;
          openFolder.onclick = () => fetch(`/api/jobs/${job.id}/open`, { method: "POST" });
          zipLink.href = `/api/jobs/${job.id}/zip`;
          zipLink.hidden = false;
        } else if (job.status === "cancelled") {
          jobText.textContent = job.done
            ? `বাতিল করা হয়েছে — তার আগে ${job.done} টি সেভ হয়েছে`
            : "বাতিল করা হয়েছে";
          if (job.done) {
            jobFolder.textContent = "ফোল্ডার: " + job.folder;
            openFolder.hidden = false;
            openFolder.onclick = () => fetch(`/api/jobs/${job.id}/open`, { method: "POST" });
            zipLink.href = `/api/jobs/${job.id}/zip`;
            zipLink.hidden = false;
          }
        } else {
          jobText.textContent = "কোনো ভিডিও ডাউনলোড করা যায়নি";
        }
        return;
      }
    } catch (err) {
      jobText.textContent = err.message;
      endJob();
      return;
    }
    pollTimer = setTimeout(poll, 1500);
  }

  function endJob() {
    jobId = null;
    cancelBtn.hidden = true;
    updateCount();
  }

  cancelBtn.addEventListener("click", async () => {
    if (!jobId) return;
    cancelBtn.disabled = true;
    await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
    cancelBtn.disabled = false;
  });
})();
