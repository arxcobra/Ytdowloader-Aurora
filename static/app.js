/* =========================================================================
   Aurora — frontend controller
   Vanilla JS, no build step. Talks to the local Python backend.
   ========================================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  cards: [],     // { data, format, quality, selected:Set }
  dest: null,    // download folder
  jobs: [],      // last snapshot
  inflight: false,
  timer: null,
  folderPath: null,
  folderPickResolve: null,
  qnodes: new Map(), // job:index -> element
  seenJobStatus: new Map(), // job id -> last known status
  celebrated: new Set(),    // job ids already accounted for
  pendingDone: new Map(),   // finished jobs waiting for the batch to go idle
  startedAt: Date.now() / 1000,
  doneTimer: null,
  hosted: false,   // true when served from Freebuff Sites (no local engine)
};

/* ------------------------------------------------------------------ utils */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtDur(sec) {
  if (sec === null || sec === undefined) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function fmtSize(b) {
  if (!b && b !== 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtEta(s) {
  if (s === null || s === undefined) return "";
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s left`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
}

function toast(msg, kind = "info", ms = 3800) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="ico">${kind === "success" ? "✓" : kind === "error" ? "⚠" : "✦"}</span><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 340);
  }, ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ health */
async function checkHealth() {
  try {
    const h = await api("/api/health");
    const pill = $("#enginePill");
    if (h.hosted) {
      // served from Freebuff Sites: the Python engine is not running here
      state.hosted = true;
      pill.classList.add("bad");
      $("#engineText").textContent = "preview only";
      toast(
        "Hosted preview — the download engine runs on your own computer. " +
        "Start it locally with python3 server.py to download.",
        "info",
        9000
      );
      return;
    }
    if (h.ok && h.ffmpeg) {
      pill.classList.add("ok");
      $("#engineText").textContent = "engine ready";
    } else {
      pill.classList.add("bad");
      $("#engineText").textContent = h.ok ? "no ffmpeg" : "offline";
      if (!h.ffmpeg) toast("ffmpeg is missing — MP3 and MP4 merging won't work.", "error", 7000);
    }
  } catch (_) {
    $("#enginePill").classList.add("bad");
    $("#engineText").textContent = "offline";
  }
}

/* ------------------------------------------------------------------ analyze */
/*
  Pasting several links at once used to break: a single-line <input> strips
  line breaks, so three URLs came back as one glued string. Now we split on
  whitespace/commas/semicolons AND on the start of every URL we can see, so
  `…watch?v=abchttps://youtube.com/shorts/xyz` becomes two links.
*/
const SCHEME_RE = /^https?:\/\//i;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const DOMAIN_RE = /\.[a-z]{2,}/i;
const HOST_PREFIX_RE = /^(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com)\//i;

function splitUrls(raw) {
  let text = String(raw || "").trim();
  if (!text) return [];

  // 1. every common separator behaves like a line break
  text = text.replace(/[\r\n\t;|,]+/g, " ");

  // 2. unglue links that lost their separator: cut before a scheme (or a
  //    bare YouTube host) that is glued to the end of the previous link.
  //    The lookbehind keeps "https://www.youtube.com" in one piece.
  text = text.replace(/(?<=[A-Za-z0-9_])(https?:[/][/])/gi, " $1");
  text = text.replace(
    /(?<=\w)((?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com))/gi,
    " $1"
  );

  // 3. keep real links, add https:// to bare hosts, drop stray words
  const out = [];
  text.split(/\s+/).forEach((tok) => {
    if (!tok) return;
    if (SCHEME_RE.test(tok)) { out.push(tok); return; }
    if (HOST_PREFIX_RE.test(tok)) { out.push(`https://${tok}`); return; }
    if (ID_RE.test(tok) || DOMAIN_RE.test(tok)) out.push(tok);
  });
  return out;
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

function updateLinkCount() {
  const el = $("#linkCount");
  if (!el) return;
  const n = splitUrls($("#urlInput").value).length;
  if (n > 1) {
    el.hidden = false;
    el.innerHTML = `<b>${n}</b> links found — every one will be analyzed <span class="hintkey">Enter</span>`;
  } else {
    el.hidden = true;
  }
}

async function analyzeForm(e) {
  e.preventDefault();
  const urls = splitUrls($("#urlInput").value);
  if (!urls.length) {
    toast("No YouTube links found — paste a video, Short or playlist link.", "error");
    return;
  }

  const btn = $("#analyzeBtn");
  btn.classList.add("busy");
  btn.disabled = true;

  try {
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const data = await api("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          return { url, data };
        } catch (err) {
          toast(err.message, "error", 6000);
          return null;
        }
      })
    );

    results.filter(Boolean).forEach(({ url, data }) => {
      const existing = state.cards.find((c) => c.data.url === data.url);
      const card = {
        data,
        format: "video",
        quality: "best",
        selected: new Set(),
      };
      data.entries.forEach((en) => card.selected.add(en.url));
      if (existing) Object.assign(existing, card);
      else state.cards.push(card);
    });

    if (state.cards.length) {
      $("#urlInput").value = "";
      autoGrow($("#urlInput"));
      updateLinkCount();
      renderResults();
      setTimeout(() => $("#results").scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ render results */
function renderResults() {
  const root = $("#results");
  root.innerHTML = "";
  if (!state.cards.length) return;
  if (state.cards.length > 1) root.appendChild(buildBatchBar());
  state.cards.forEach((card, idx) => root.appendChild(buildCard(card, idx)));
  // cards are attached now, so destination labels can resolve
  updateDestLabels();
}

/* One button that queues every selected item across every card. */
function batchCounts() {
  return {
    links: state.cards.length,
    items: state.cards.reduce((s, c) => s + c.selected.size, 0),
    audio: state.cards.filter((c) => c.format === "audio").length,
  };
}

function updateBatchBar(scope) {
  const bar = scope && scope.classList.contains("batch-bar") ? scope : $(".batch-bar");
  if (!bar) return;
  const { links, items, audio } = batchCounts();
  const note = $("[data-role=\"batchnote\"]", bar);
  if (note) {
    note.innerHTML = `<b>${links}</b> links · <b>${items}</b> item${items === 1 ? "" : "s"} selected`
      + (audio ? ` · ${audio} card${audio > 1 ? "s" : ""} as MP3` : "");
  }
  const btn = $("[data-act=\"dl-all\"]", bar);
  if (btn) btn.disabled = items === 0;
}

function buildBatchBar() {
  const el = document.createElement("div");
  el.className = "batch-bar";
  el.innerHTML = `
    <span class="batch-note" data-role="batchnote"></span>
    <button type="button" class="primary-btn" data-act="dl-all">
      <span class="label">Download all</span>
      <span class="spinner" aria-hidden="true"></span>
    </button>`;
  $("[data-act=\"dl-all\"]", el).addEventListener("click", () => downloadAll(el));
  updateBatchBar(el);
  return el;
}

async function downloadAll(scope) {
  const items = [];
  state.cards.forEach((card) => {
    card.data.entries
      .filter((en) => card.selected.has(en.url))
      .forEach((en) => items.push({
        url: en.url, title: en.title, thumbnail: en.thumbnail, kind: en.kind,
        format: card.format, quality: card.quality,
      }));
  });
  if (!items.length) { toast("Select at least one video.", "error"); return; }

  if (!state.dest) {
    try { const b = await api("/api/browse"); state.dest = b.path || b.default; }
    catch (_) { /* reported below if the job is rejected */ }
  }

  const btn = $("[data-act=\"dl-all\"]", scope);
  btn.classList.add("busy");
  btn.disabled = true;
  try {
    await api("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        format: items.every((i) => i.format === "audio") ? "audio" : "video",
        quality: "best",
        output_dir: state.dest,
      }),
    });
    const audioN = items.filter((i) => i.format === "audio").length;
    toast(`Queued ${items.length} items${audioN ? ` (${audioN} as MP3)` : ""} → ${state.dest}`, "success");
    $("#queueSection").hidden = false;
    await pollJobs();
    setTimeout(() => $("#queueSection").scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  } catch (err) {
    toast(err.message, "error", 6000);
  } finally {
    btn.classList.remove("busy");
    updateBatchBar(scope);
  }
}

function kindBadge(kind) {
  const map = {
    video: ["Video", ""],
    short: ["Short", "short"],
    playlist: ["Playlist", "playlist"],
    channel: ["Channel", "channel"],
    live: ["Live", "live"],
  };
  const [label, cls] = map[kind] || map.video;
  return `<span class="badge ${cls}">${label}</span>`;
}

function buildCard(card, idx) {
  const d = card.data;
  const isMulti = d.kind === "playlist" || d.kind === "channel";
  const el = document.createElement("article");
  el.className = "card";
  el.style.animationDelay = `${idx * 0.07}s`;

  const metaBits = [];
  if (d.channel) metaBits.push(esc(d.channel));
  if (d.count > 1) metaBits.push(`${d.count} items`);
  if (d.total_duration) metaBits.push(`≈ ${fmtDur(d.total_duration)} total`);
  else  if (d.duration && d.count === 1) metaBits.push(fmtDur(d.duration));

  el.innerHTML = `
    <div class="card-media">
      ${kindBadge(d.kind)}
      ${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
      ${d.duration && d.count === 1 ? `<span class="duration-chip">${fmtDur(d.duration)}</span>` : ""}
    </div>
    <div class="card-body">
      <h3 class="card-title">${esc(d.title)}</h3>
      <div class="card-meta">${metaBits.join(' <span class="sep">·</span> ')}</div>

      <div class="options">
        <div class="opt-group">
          <span class="opt-label">Format</span>
          <div class="segmented" data-role="format">
            <span class="thumb" aria-hidden="true"></span>
            <button type="button" data-val="video" class="active">▶︎ MP4 Video</button>
            <button type="button" data-val="audio">♫ MP3 Audio</button>
          </div>
        </div>

        <div class="opt-group" data-role="quality-group">
          <span class="opt-label">Quality</span>
          <div class="pills" data-role="quality"></div>
        </div>

        ${isMulti ? `
        <div class="opt-group">
          <span class="opt-label">Choose what to download</span>
          <div class="select-bar">
            <button type="button" class="ghost-btn small" data-act="all">Select all</button>
            <button type="button" class="ghost-btn small" data-act="none">None</button>
            <button type="button" class="ghost-btn small" data-act="invert">Invert</button>
            <button type="button" class="ghost-btn small" data-act="shorts">Only Shorts</button>
            <span class="count-note" data-role="count"></span>
          </div>
          <div class="entry-list" data-role="entries"></div>
        </div>` : ""}

        <div class="opt-group">
          <span class="opt-label">Save to</span>
          <div class="dest-row">
            <svg class="dest-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5Z"/></svg>
            <span class="dest-path" data-role="dest">—</span>
            <button type="button" class="ghost-btn small" data-act="browse">Choose folder…</button>
          </div>
        </div>
      </div>

      <div class="card-foot">
        <span class="dl-summary" data-role="summary"></span>
        <button type="button" class="primary-btn" data-act="download">
          <span class="label">Download</span>
          <span class="spinner" aria-hidden="true"></span>
        </button>
      </div>
    </div>`;

  // segmented control sliding thumb
  const seg = $('[data-role="format"]', el);
  const thumb = $(".thumb", seg);
  const moveThumb = () => {
    const active = $("button.active", seg);
    if (!active) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft - seg.clientLeft}px)`;
  };
  $$("button", seg).forEach((b) => b.addEventListener("click", () => {
    $$("button", seg).forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    card.format = b.dataset.val;
    card.quality = card.format === "audio" ? "192K" : "best";
    renderQuality(el, card);
    updateSummary(el, card);
    requestAnimationFrame(moveThumb);
  }));

  // quality pills
  function renderQuality(scope, c) {
    const wrap = $('[data-role="quality"]', scope);
    const opts = c.format === "audio" ? c.data.audio_options : c.data.video_options;
    wrap.innerHTML = "";
    opts.forEach((o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill-btn" + (c.quality === o.id ? " active" : "");
      b.innerHTML = `${esc(o.label)}${o.detail && o.detail !== o.label ? ` <span class="hint">${esc(o.detail)}</span>` : ""}`;
      b.addEventListener("click", () => {
        c.quality = o.id;
        $$(".pill-btn", wrap).forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        updateSummary(scope, c);
      });
      wrap.appendChild(b);
    });
    if (!opts.some((o) => o.id === c.quality)) {
      c.quality = opts[0]?.id || "best";
      $$(".pill-btn", wrap)[0]?.classList.add("active");
    }
  }

  // entries (playlist / channel)
  const entriesWrap = $('[data-role="entries"]', el);
  if (entriesWrap) {
    d.entries.forEach((en, i) => {
      const row = document.createElement("div");
      row.className = "entry" + (card.selected.has(en.url) ? " sel" : "");
      row.style.setProperty("--i", i);
      row.innerHTML = `
        <span class="check"><svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></svg></span>
        ${en.thumbnail ? `<img class="entry-thumb" src="${esc(en.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}
        <span class="entry-main">
          <div class="entry-title">${esc(en.title)}</div>
          <div class="entry-sub">${en.channel ? esc(en.channel) : ""} ${en.kind === "short" ? '<span class="tag">Short</span>' : ""}</div>
        </span>
        <span class="entry-dur">${fmtDur(en.duration)}</span>`;
      row.addEventListener("click", () => {
        if (card.selected.has(en.url)) card.selected.delete(en.url);
        else card.selected.add(en.url);
        row.classList.toggle("sel", card.selected.has(en.url));
        updateSummary(el, card);
      });
      entriesWrap.appendChild(row);
    });

    $$("[data-act]", el).forEach((btn) => {
      const act = btn.dataset.act;
      if (!["all", "none", "invert", "shorts"].includes(act)) return;
      btn.addEventListener("click", () => {
        if (act === "all") card.selected = new Set(d.entries.map((x) => x.url));
        if (act === "none") card.selected = new Set();
        if (act === "invert")
          card.selected = new Set(d.entries.filter((x) => !card.selected.has(x.url)).map((x) => x.url));
        if (act === "shorts")
          card.selected = new Set(d.entries.filter((x) => x.kind === "short").map((x) => x.url));
        $$(".entry", entriesWrap).forEach((r, i) =>
          r.classList.toggle("sel", card.selected.has(d.entries[i].url)));
        updateSummary(el, card);
      });
    });
  }

  // generic actions
  $$("[data-act]", el).forEach((btn) => {
    const act = btn.dataset.act;
    if (act === "browse") btn.addEventListener("click", () => openFolderPicker(card, el));
    if (act === "download") btn.addEventListener("click", () => startDownload(card, el));
  });

  renderQuality(el, card);
  requestAnimationFrame(moveThumb);
  window.addEventListener("resize", moveThumb);
  updateSummary(el, card);
  updateDestLabels();
  return el;
}

function updateSummary(scope, card) {
  const count = card.selected.size;
  const isAudio = card.format === "audio";
  const q = (isAudio ? card.data.audio_options : card.data.video_options)
    .find((o) => o.id === card.quality);
  const multi = card.data.kind === "playlist" || card.data.kind === "channel";

  const sum = $('[data-role="summary"]', scope);
  const cnt = $('[data-role="count"]', scope);
  const dl = $('[data-act="download"]', scope);

  if (multi && cnt) cnt.textContent = `${count} of ${card.data.entries.length} selected`;
  if (sum) {
    sum.innerHTML = count
      ? `<b>${count}</b> item${count > 1 ? "s" : ""} · ${isAudio ? "MP3" : "MP4"} ${q ? esc(q.label) : ""}`
      : "Nothing selected yet";
  }
  if (dl) dl.disabled = count === 0;
  updateBatchBar();
}

function updateDestLabels() {
  const p = state.dest || "—";
  $("#saveToPath").textContent = p;
  $$('[data-role="dest"]').forEach((n) => (n.textContent = p));
}

/* ------------------------------------------------------------------ download */
async function startDownload(card, scope) {
  if (!state.dest) {
    try {
      const b = await api("/api/browse");
      state.dest = b.path || b.default;
    } catch (_) { /* handled below */ }
  }

  const items = card.data.entries
    .filter((en) => card.selected.has(en.url))
    .map((en) => ({ url: en.url, title: en.title, thumbnail: en.thumbnail, kind: en.kind }));

  if (!items.length) { toast("Select at least one video.", "error"); return; }

  const btn = $('[data-act="download"]', scope);
  btn.classList.add("busy");
  btn.disabled = true;

  try {
    await api("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        format: card.format,
        quality: card.quality,
        output_dir: state.dest,
      }),
    });
    const fmt = card.format === "audio" ? "MP3" : "MP4";
    toast(`Queued ${items.length} item${items.length > 1 ? "s" : ""} as ${fmt} → ${state.dest}`, "success");
    $("#queueSection").hidden = false;
    await pollJobs();
    setTimeout(() => $("#queueSection").scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  } catch (err) {
    toast(err.message, "error", 6000);
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
    updateSummary(scope, card);
  }
}

/* ------------------------------------------------------------------ queue */
const STATUS_LABEL = {
  queued: "Waiting",
  processing: "Processing",
  downloading: "Downloading",
  done: "Saved",
  error: "Failed",
  cancelled: "Cancelled",
};

function statusMarkup(r) {
  const st = r.status;
  const spinning = st === "downloading" || st === "processing";
  return `<span class="qstatus ${st}"><span class="mini"></span>${spinning ? "" : "✓"} ${esc(
    st === "error" ? `Failed — ${r.error || "error"}` : STATUS_LABEL[st] || st
  )}</span>`;
}

function renderQueue() {
  const list = $("#queueList");
  const jobs = state.jobs;
  const seen = new Set();

  jobs.forEach((job) => {
    const mixed = new Set(job.items.map((i) => i.format || job.format)).size > 1;
    job.items.forEach((r, i) => {
      const key = `${job.id}:${i}`;
      seen.add(key);
      let node = state.qnodes.get(key);

      if (!node) {
        node = document.createElement("div");
        node.className = "qitem";
        node.innerHTML = `
          ${r.thumbnail ? `<img class="qthumb" src="${esc(r.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="qthumb"></span>'}
          <span class="qmain">
            <div class="qtitle">${esc(r.title)}</div>
            <div class="qsub" data-f="sub"></div>
            <div class="qbar"><span class="qfill" data-f="fill"></span></div>
            <div class="qpath" data-f="path"></div>
          </span>`;
        state.qnodes.set(key, node);
        list.appendChild(node);
      }

      const done = r.status === "done";
      const bad = r.status === "error";
      node.classList.toggle("done", done);
      node.classList.toggle("error", bad);
      node.style.animationDelay = "0s";

      const sub = $('[data-f="sub"]', node);
      const bits = [`<span class="qstatus ${r.status}"><span class="mini"></span>${
        r.status === "downloading" || r.status === "processing" ? "" : "✓"} ${esc(
        r.status === "error" ? `Failed — ${r.error || "error"}` : STATUS_LABEL[r.status] || r.status
      )}</span>`];
      if (r.stage && r.status === "downloading") bits.push(esc(r.stage));
      if (r.status === "downloading") {
        bits.push(`${r.percent}%`);
        if (r.speed) bits.push(esc(r.speed));
        if (r.eta !== null && r.eta !== undefined) bits.push(fmtEta(r.eta));
      }
      if (r.size && done) bits.push(fmtSize(r.size));
      if (mixed && r.format) bits.push(r.format === "audio" ? "MP3" : "MP4");
      sub.innerHTML = bits.join('<span class="muted">·</span>');

      $('[data-f="fill"]', node).style.width = `${r.percent || 0}%`;

      const pathEl = $('[data-f="path"]', node);
      if (done && r.path) {
        const name = r.path.split(/[\\/]/).pop();
        pathEl.innerHTML = `${esc(name)} · <a href="#" data-open="${esc(r.path)}">Show in folder</a>`;
      } else if (bad) {
        pathEl.innerHTML = "";
      } else {
        pathEl.textContent = "";
      }
    });
  });

  // remove stale nodes
  for (const [key, node] of state.qnodes) {
    if (!seen.has(key)) { node.remove(); state.qnodes.delete(key); }
  }

  const all = jobs.flatMap((j) => j.items);
  const done = all.filter((r) => r.status === "done").length;
  const failed = all.filter((r) => r.status === "error").length;
  const active = jobs.some((j) => ["queued", "processing"].includes(j.status));

  $("#queueSummary").textContent = all.length
    ? `${done}/${all.length} saved${failed ? ` · ${failed} failed` : ""}`
    : "";

  return active;
}

/*
   One self-rescheduling loop. Every completion path schedules exactly one
   next tick, and `inflight` only prevents overlapping fetches — it must not
   block a scheduled tick, or the loop dies after its first pass.
*/
async function tick() {
  if (state.inflight) return;
  state.inflight = true;
  let next = 4000; // idle interval
  try {
    const data = await api("/api/jobs");
    state.jobs = data.jobs || [];
    const active = renderQueue();
    renderOverall(state.jobs);
    detectCompletions(state.jobs);
    $("#queueSection").hidden = !(state.jobs.length || $("#queueList").children.length);
    next = active ? 700 : 4000;
  } catch (_) {
    next = 3000;
  } finally {
    state.inflight = false;
    clearTimeout(state.timer);
    state.timer = setTimeout(tick, next);
  }
}

function startPolling() {
  clearTimeout(state.timer);
  state.timer = null;
  tick();
}

async function pollJobs() {
  // force a fresh pass right now (used after queueing a download)
  if (!state.inflight) return tick();
}

/* ------------------------------------------------------------------ folder picker */
function openFolderPicker(card, scope) {
  const modal = $("#folderModal");
  modal.hidden = false;
  $("#folderNewName").value = "";
  loadFolder(state.folderPath || state.dest || null);
}

function closeFolderPicker() {
  $("#folderModal").hidden = true;
}

async function loadFolder(path) {
  try {
    const data = await api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    state.folderPath = data.path;
    $("#folderPath").textContent = data.path;
    $("#folderHome").dataset.path = data.home;

    const drives = $("#folderDrives");
    drives.innerHTML = "";
    (data.drives || []).forEach((d) => {
      const b = document.createElement("button");
      b.className = "drive-btn";
      b.textContent = d.label;
      b.addEventListener("click", () => loadFolder(d.path));
      drives.appendChild(b);
    });

    const list = $("#folderList");
    list.innerHTML = "";
    if (!data.dirs.length) {
      list.innerHTML = '<div class="empty-note">No subfolders here</div>';
    } else {
      data.dirs.forEach((d, i) => {
        const row = document.createElement("div");
        row.className = "folder-row";
        row.style.setProperty("--i", i);
        row.innerHTML = `<span class="ico">📁</span><span>${esc(d.name)}</span>`;
        row.addEventListener("dblclick", () => loadFolder(d.path));
        row.addEventListener("click", () => {
          $$(".folder-row", list).forEach((x) => x.style.background = "");
          row.style.background = "rgba(10,132,255,.28)";
          list.dataset.selected = d.path;
        });
        list.appendChild(row);
      });
    }
    delete list.dataset.selected;
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------- completion banner */
let audioCtx = null;
let lastChime = 0;

/* One short chime — a single sound event, throttled so a burst of jobs
   finishing together never stacks into noise. */
function playChime() {
  const now = Date.now();
  if (now - lastChime < 1500) return;
  lastChime = now;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.02;
    [[880, 0], [1318.51, 0.13]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.42);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.45);
    });
  } catch (_) { /* audio blocked — the banner still shows */ }
}

function hideDone() {
  const el = $("#doneOverlay");
  if (!el || el.hidden) return;
  el.classList.add("out");
  setTimeout(() => { el.hidden = true; el.classList.remove("out"); }, 340);
}

function celebrate(job) {
  const el = $("#doneOverlay");
  const saved = job.done || 0;
  const total = job.total || 1;
  const failed = job.failed || 0;
  $("#doneSub").textContent = total > 1
    ? `${saved} of ${total} files saved${failed ? ` · ${failed} failed` : ""}`
    : saved === 1 && total === 1
      ? "1 file saved"
      : `${saved} file${saved === 1 ? "" : "s"} saved`;
  const where = job.output_dir || "your download folder";
  $("#doneHover").textContent = `Saved to ${where}`;
  $("#doneCard").setAttribute("title", `Saved to ${where}`);
  el.hidden = false;
  el.classList.remove("out");
  playChime();
  clearTimeout(state.doneTimer);
  state.doneTimer = setTimeout(hideDone, 8000);
}

/*
  Call once per poll. Jobs that finish are parked, and the banner only fires
  once nothing is still running — three queued jobs should say "work
  completed" once, when the whole batch is actually done.
*/
function detectCompletions(jobs) {
  jobs.forEach((job) => {
    const prev = state.seenJobStatus.get(job.id);
    state.seenJobStatus.set(job.id, job.status);
    if (job.status !== "done") return;
    // only jobs that started in this session — never the historical list
    if (job.created <= state.startedAt) return;
    if (prev === "done") return;
    state.celebrated.add(job.id);
    state.pendingDone.set(job.id, job);
  });

  const active = jobs.some((j) => ["queued", "processing"].includes(j.status));
  if (active || !state.pendingDone.size) return;

  const list = [...state.pendingDone.values()];
  state.pendingDone.clear();
  celebrate({
    total: list.reduce((s, j) => s + (j.total || 0), 0),
    done: list.reduce((s, j) => s + (j.done || 0), 0),
    failed: list.reduce((s, j) => s + (j.failed || 0), 0),
    output_dir: list[0].output_dir,
    jobs: list.length,
  });
}

/* ------------------------------------------------------- overall progress */
function renderOverall(jobs) {
  const bar = $("#overallBar");
  if (!bar) return;
  const active = jobs.filter((j) => ["queued", "processing"].includes(j.status));
  if (!active.length) { bar.hidden = true; return; }

  const items = active.flatMap((j) => j.items);
  const total = items.length || 1;
  const pct = items.reduce((s, i) => s + (i.percent || 0), 0) / total;
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;
  const running = items.filter((i) => i.status === "downloading").length;

  bar.hidden = false;
  bar.classList.remove("complete");
  $("#overallFill").style.width = `${Math.max(2, pct).toFixed(1)}%`;
  $("#overallPct").textContent = `${Math.round(pct)}%`;
  $("#overallLabel").textContent = running
    ? `Downloading ${running} item${running > 1 ? "s" : ""}…`
    : "Waiting in queue…";

  const bits = [`${done}/${items.length} saved`];
  if (failed) bits.push(`${failed} failed`);
  const live = items.find((i) => i.status === "downloading");
  if (live) {
    bits.push(esc(live.title));
    if (live.speed) bits.push(esc(live.speed));
    if (live.eta !== null && live.eta !== undefined) bits.push(fmtEta(live.eta));
  }
  $("#overallMeta").innerHTML = bits.join('<span class="muted">·</span>');
}

const DEST_KEY = "aurora.dest";

async function ensureDest() {
  // remember the folder the user picked, even across reloads
  const saved = localStorage.getItem(DEST_KEY);
  if (saved) {
    state.dest = saved;
    updateDestLabels();
    return saved;
  }
  try {
    const b = await api("/api/browse");
    state.dest = b.path || b.default;
  } catch (_) {
    state.dest = null;
  }
  updateDestLabels();
  return state.dest;
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $("#analyzeForm").addEventListener("submit", analyzeForm);

  // multi-link input: grows with content, Enter analyzes, Shift+Enter new line
  const input = $("#urlInput");
  const grow = () => autoGrow(input);
  grow();
  input.addEventListener("input", () => { grow(); updateLinkCount(); });
  input.addEventListener("paste", () => setTimeout(() => { grow(); updateLinkCount(); }, 0));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("#analyzeForm").requestSubmit();
    }
  });

  $("#pasteBtn").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { input.value = text.trim(); grow(); updateLinkCount(); input.focus(); }
      else toast("Clipboard is empty.", "info");
    } catch (_) {
      toast("Clipboard access denied — press ⌘V / Ctrl+V instead.", "info");
      input.focus();
    }
  });

  // completion banner
  $("#doneClose").addEventListener("click", hideDone);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#doneOverlay").hidden) hideDone();
  });

  // folder picker chrome
  $("#folderClose").addEventListener("click", closeFolderPicker);
  $("#folderCancel").addEventListener("click", closeFolderPicker);
  $("#folderModal").addEventListener("click", (e) => {
    if (e.target === $("#folderModal")) closeFolderPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#folderModal").hidden) closeFolderPicker();
  });

  $("#folderHome").addEventListener("click", (e) => loadFolder(e.currentTarget.dataset.path || null));
  $("#folderUp").addEventListener("click", () => {
    if (!state.folderPath) return;
    const p = state.folderPath.replace(/[\\/]+$/, "").split(/[\\/]/);
    p.pop();
    loadFolder(p.length ? p.join(state.folderPath.includes("\\") ? "\\" : "/") : null);
  });
  $("#folderDefault").addEventListener("click", async () => {
    const b = await api("/api/browse");
    loadFolder(b.default);
  });
  $("#folderNew").addEventListener("click", async () => {
    const name = $("#folderNewName").value.trim();
    if (!name) { toast("Type a name for the new folder first.", "info"); return; }
    try {
      const r = await api("/api/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: state.folderPath, name }),
      });
      $("#folderNewName").value = "";
      await loadFolder(r.path);
      toast("Folder created.", "success");
    } catch (err) { toast(err.message, "error"); }
  });

  $("#folderSelect").addEventListener("click", async () => {
    const list = $("#folderList");
    const picked = list.dataset.selected;
    let target = picked || state.folderPath;
    const name = $("#folderNewName").value.trim();
    if (name) {
      try {
        const r = await api("/api/mkdir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parent: target, name }),
        });
        target = r.path;
      } catch (err) { toast(err.message, "error"); return; }
    }
    if (!target) return;
    state.dest = target;
    try { localStorage.setItem(DEST_KEY, target); } catch (_) { /* private mode */ }
    closeFolderPicker();
    updateDestLabels();
    toast(`Saving to ${target}`, "success");
  });

  $("#changeDirBtn").addEventListener("click", () => openFolderPicker());
  $("#openFolderBtn").addEventListener("click", async () => {
    if (!state.dest) return;
    try {
      await api(`/api/open?path=${encodeURIComponent(state.dest)}`);
    } catch (err) { toast(err.message, "error"); }
  });

  // "Show in folder" links inside queue
  $("#queueList").addEventListener("click", async (e) => {
    const a = e.target.closest("[data-open]");
    if (!a) return;
    e.preventDefault();
    try {
      await api(`/api/open?path=${encodeURIComponent(a.dataset.open)}`);
    } catch (err) { toast(err.message, "error"); }
  });
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  wire();
  await checkHealth();
  if (state.hosted) {
    // Interface-only preview: there is no engine to poll or folder to read,
    // so don't hammer the API with requests that can only return 501.
    return;
  }
  await ensureDest();
  startPolling();
}

document.addEventListener("DOMContentLoaded", boot);
