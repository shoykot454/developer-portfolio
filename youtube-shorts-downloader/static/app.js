(() => {
  const $ = (s) => document.querySelector(s);
  const form = $("#search"), urlInput = $("#url"), goBtn = $("#go");
  const statusEl = $("#status"), results = $("#results"), grid = $("#grid");
  const selectAll = $("#selectAll"), quality = $("#quality"), dlAll = $("#dlAll");
  const jobBox = $("#job"), jobText = $("#jobText"), jobBar = $("#jobBar");
  const zipLink = $("#zipLink"), cancelBtn = $("#cancelJob");
  const tpl = $("#cardTpl");

  let shorts = [], channel = {}, cards = new Map(), pollTimer = null, jobId = null;

  const fmtViews = (n) => {
    if (n == null) return "";
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B views";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
    return n + " views";
  };
  const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");

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
    showStatus('<span class="spinner"></span>চ্যানেলের Shorts খোঁজা হচ্ছে… (বড় চ্যানেলে একটু সময় লাগতে পারে)');
    try {
      const res = await fetch("/api/shorts?url=" + encodeURIComponent(url));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      if (!data.shorts.length) throw new Error("এই চ্যানেলে কোনো Shorts পাওয়া যায়নি।");
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
    $("#chTitle").textContent = channel.title || "Shorts";
    $("#chCount").textContent = `${shorts.length} টি Shorts`;
    selectAll.checked = true;
    jobBox.hidden = true;

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
      cb.addEventListener("change", () => { node.classList.toggle("off", !cb.checked); updateCount(); });
      node.querySelector(".dl").addEventListener("click", () => downloadSingle(s, node));
      cards.set(s.id, node);
      frag.appendChild(node);
    }
    grid.appendChild(frag);
    results.hidden = false;
    updateCount();
  }

  function selectedIds() {
    return shorts.filter((s) => cards.get(s.id).querySelector(".pick input").checked).map((s) => s.id);
  }
  function updateCount() {
    const n = selectedIds().length;
    dlAll.textContent = `সিলেক্টেড ${n} টি ডাউনলোড (ZIP)`;
    dlAll.disabled = n === 0 || !!jobId;
    selectAll.checked = n === shorts.length;
    selectAll.indeterminate = n > 0 && n < shorts.length;
  }
  selectAll.addEventListener("change", () => {
    for (const node of cards.values()) {
      node.querySelector(".pick input").checked = selectAll.checked;
      node.classList.toggle("off", !selectAll.checked);
    }
    updateCount();
  });

  function setCardState(node, text, cls) {
    const el = node.querySelector(".state");
    el.textContent = text || "";
    el.className = "state" + (cls ? " " + cls : "");
  }

  // Single download: the server downloads, then streams the file back.
  async function downloadSingle(s, node) {
    const btn = node.querySelector(".dl");
    btn.disabled = true;
    setCardState(node, "সার্ভারে প্রস্তুত হচ্ছে…", "run");
    try {
      const res = await fetch(`/api/download/${s.id}?quality=${quality.value}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Download failed");
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
      const name = m ? decodeURIComponent(m[1]) : `${s.id}.mp4`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      setCardState(node, "✓ ডাউনলোড হয়েছে", "ok");
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
        body: JSON.stringify({ ids, titles, quality: quality.value, name: `${channel.title || "channel"} shorts` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start");
      jobId = data.id;
      jobBox.hidden = false;
      zipLink.hidden = true;
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
        if (it.status === "done") setCardState(node, "✓ সম্পন্ন", "ok");
        else if (it.status === "error") setCardState(node, "✗ " + (it.error || "ব্যর্থ"), "err");
        else if (it.status === "downloading") { setCardState(node, `ডাউনলোড হচ্ছে… ${Math.round(it.progress || 0)}%`, "run"); partial = (it.progress || 0) / 100; }
      }
      const finished = job.done + job.failed;
      jobBar.style.width = `${((finished + partial) / job.total) * 100}%`;
      const failTxt = job.failed ? ` · ${job.failed} টি ব্যর্থ` : "";

      if (job.status === "running") {
        jobText.textContent = `ডাউনলোড হচ্ছে… ${finished} / ${job.total}${failTxt}`;
      } else if (job.status === "zipping") {
        jobText.textContent = `ZIP বানানো হচ্ছে… (${job.done} টি ফাইল)`;
      } else {
        endJob();
        if (job.status === "finished") {
          jobBar.style.width = "100%";
          jobText.textContent = `✓ ${job.done} টি Shorts রেডি${failTxt}`;
          zipLink.href = `/api/jobs/${job.id}/zip`;
          zipLink.hidden = false;
          zipLink.click(); // start saving automatically
        } else if (job.status === "cancelled") {
          jobText.textContent = "বাতিল করা হয়েছে";
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
    pollTimer = setTimeout(poll, 1200);
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
