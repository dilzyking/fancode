// ============================================================
//  FANCODE HLS PROXY — Cloudflare Worker (full version)
//  Hardcoded stream + optional web player page.
// ============================================================

// 👇 PASTE YOUR FULL FANCODE M3U8 URL HERE
const STREAM_URL =
  "https://in-mc-flive.fancode.com/mumbai/4248491_hindi_hls_ed24a8186993836_1ta-di_h264/1080p.m3u8?hdntl=Expires=1789392659~_GO=Generated~acl=/mumbai/4248491_hindi_hls_ed24a8186993836_1ta-di_h264/*~Signature=AWDec-HByQhk68qSCnCZyABpf45aQQnnay5WKHnruoErrGrN-vafHAIvAttH8kmxylYL3z2vHk2KCGSXRBizd32DMxwF";

// Required headers to bypass Fancode hotlink protection
const REFERER = "https://www.fancode.com/";
const ORIGIN  = "https://www.fancode.com";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ---------- Root page: serve a small web player ----------
    if (reqUrl.pathname === "/" && !reqUrl.searchParams.has("url")) {
      return new Response(PLAYER_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ---------- Proxy endpoint ----------
    // /?url=...        → fetch that URL
    // (no ?url param)  → fetch the hardcoded STREAM_URL
    const target = reqUrl.searchParams.get("url") || STREAM_URL;

    let upstream;
    try {
      upstream = await fetch(target, {
        method: "GET",
        headers: {
          "Referer": REFERER,
          "Origin": ORIGIN,
          "User-Agent": UA,
          "Accept": "*/*",
        },
        redirect: "follow",
      });
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, {
        status: 502,
        headers: CORS,
      });
    }

    if (!upstream.ok) {
      return new Response("Upstream error: " + upstream.status, {
        status: upstream.status,
        headers: CORS,
      });
    }

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const isM3U8 =
      contentType.includes("mpegurl") ||
      target.split("?")[0].endsWith(".m3u8");

    // ---------- Playlist: rewrite child URLs through this Worker ----------
    if (isM3U8) {
      const text = await upstream.text();
      const base = new URL(target);
      const workerOrigin = reqUrl.origin;

      const rewritten = text
        .split("\n")
        .map((rawLine) => {
          const line = rawLine.trim();
          if (line === "" || line.startsWith("#")) return rawLine;

          // Resolve relative to upstream base, then route via this Worker
          const absolute = new URL(line, base).toString();
          return `${workerOrigin}/?url=${encodeURIComponent(absolute)}`;
        })
        .join("\n");

      return new Response(rewritten, {
        headers: {
          ...CORS,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
      });
    }

    // ---------- Segments / keys: stream straight through ----------
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": contentType || "video/mp2t",
        "Cache-Control": "public, max-age=60",
      },
    });
  },
};

// ============================================================
//  Built-in web player (served at "/")
// ============================================================
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Fancode Live Player</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;background:#000;height:100%;overflow:hidden;font-family:system-ui,sans-serif}
  #v{width:100vw;height:100vh;display:block;background:#000}
  #msg{position:absolute;top:16px;left:16px;color:#fff;background:rgba(0,0,0,.6);padding:8px 14px;border-radius:8px;font-size:13px;z-index:10}
</style>
</head>
<body>
  <video id="v" controls autoplay playsinline></video>
  <div id="msg">Loading stream…</div>

  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
  <script>
    const video = document.getElementById('v');
    const msg   = document.getElementById('msg');
    const src   = location.origin + '/?url=' + encodeURIComponent(location.origin + '/stream.m3u8');

    // Simpler: point directly at the root, which the Worker maps to STREAM_URL
    const streamSrc = location.origin + '/';

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, enableWorker: true });
      hls.loadSource(streamSrc);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { msg.style.display='none'; video.play().catch(()=>{}); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) msg.textContent = 'Stream error: ' + data.details;
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS native HLS
      video.src = streamSrc;
      video.addEventListener('loadedmetadata', () => { msg.style.display='none'; });
    } else {
      msg.textContent = 'HLS not supported in this browser';
    }
  </script>
</body>
</html>`;
