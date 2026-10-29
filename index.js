/*
  Aurora — Freebuff Sites preview worker.

  The download engine is Python (yt-dlp + ffmpeg) and cannot run in Workers:
  the runtime does not execute Python, spawn subprocesses, or load native
  binaries. So this worker serves the static interface and answers the API
  with an explicit explanation instead of pretending to work.

  Asset rule: the browser is never given a redirect. Cloudflare canonicalises
  /index.html -> /, and rewriting / back to /index.html loops forever, so
  redirects are resolved here by trying the next candidate instead.
*/

const HOSTED = {
  error:
    "The download engine runs on your own computer. This hosted preview serves the interface only — run it locally with: python3 server.py",
  hosted: true,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function candidatesFor(path) {
  const out = [path];
  if (path.endsWith(".html")) {
    // Assets canonicalises /index.html -> /; try the bare form ourselves.
    out.push(path === "/index.html" ? "/" : path.slice(0, -".html".length));
  } else if (!path.includes(".")) {
    if (path !== "/") out.push(path + ".html");
    out.push("/index.html");
  }
  return [...new Set(out)];
}

async function fetchAsset(request, env, url, path) {
  for (const candidate of candidatesFor(path)) {
    const res = await env.ASSETS.fetch(new Request(new URL(candidate, url.origin), request));
    // 304 must be passed through: it answers the browser's If-None-Match
    // revalidation. Dropping it (as a "redirect") makes every repeat load
    // fall through to the synthetic 404 below.
    if (res.status === 304) return res;
    if (res.status >= 300 && res.status < 400) continue; // genuine redirect
    if (res.status === 404) continue;
    return res;
  }
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      // health answers 200 so the UI can tell "preview mode" apart
      // from a broken engine.
      if (path === "/api/health") {
        return json({
          ok: false,
          ffmpeg: false,
          yt_dlp: null,
          download_dir: null,
          hosted: true,
        });
      }
      return json(HOSTED, 501);
    }

    return fetchAsset(request, env, url, path);
  },
};
