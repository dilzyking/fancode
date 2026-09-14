// ============================================================
//  FANCODE HLS PROXY — Cloudflare Worker
//  Manifest : https://<your-worker>.workers.dev/worker.m3u8
//  Segments : https://<your-worker>.workers.dev/seg.ts?url=...
//  Player   : https://<your-worker>.workers.dev/
// ============================================================

const STREAM_URL =
  "https://in-mc-flive.fancode.com/mumbai/4248491_hindi_hls_ed24a8186993836_1ta-di_h264/1080p.m3u8?hdntl=Expires=1789392659~_GO=Generated~acl=/mumbai/4248491_hindi_hls_ed24a8186993836_1ta-di_h264/*~Signature=AWDec-HByQhk68qSCnCZyABpf45aQQnnay5WKHnruoErrGrN-vafHAIvAttH8kmxylYL3z2vHk2KCGSXRBizd32DMxwF";

const REFERER = "https://www.fancode.com/";
const ORIGIN  = "https://www.fancode.com";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ---- /worker.m3u8 → rewritten playlist ----
    if (reqUrl.pathname === "/worker.m3u8") {
      const sub = reqUrl.searchParams.get("url");
      return proxyPlaylist(sub || STREAM_URL, reqUrl.origin);
    }

    // ---- /seg.ts?url=... → segment/key binary ----
    if (reqUrl.pathname === "/seg.ts") {
      const target = reqUrl.searchParams.get("url");
      if (!target) return new Response("Missing ?url=", { status: 400, headers: CORS });
      return proxyBinary(target);
    }

    // ---- / → Plyr HTML player ----
    if (reqUrl.pathname === "/" || reqUrl.pathname === "") {
      return new Response(PLAYER_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found. Use /worker.m3u8", { status: 404, headers: CORS });
  },
};

/* ============================================================
   REWRITE THE M3U8
   ============================================================ */
async function proxyPlaylist(target, workerOrigin) {
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        "Referer": REFERER,
        "Origin": ORIGIN,
        "User-Agent": UA,
        "Accept": "*/*",
      },
      redirect: "follow",
    });
  } catch (e) {
    return m3u8("# fetch failed: " + e.message, 502);
  }

  if (!upstream.ok) {
    return m3u8(`# upstream ${upstream.status}`, upstream.status);
  }

  const text = await upstream.text();
  const base = new URL(target);

  const rewritten = text
    .split("\n")
    .map((rawLine) => {
      const line = rawLine.trim();

      if (line === "") return rawLine;

      // Rewrite URI="..." inside tags (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA)
      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = new URL(uri, base).toString();
          return `URI="${workerOrigin}/seg.ts?url=${encodeURIComponent(abs)}"`;
        });
      }

      const abs = new URL(line, base).toString();

      // Sub-playlist
      if (abs.split("?")[0].endsWith(".m3u8")) {
        return `${workerOrigin}/worker.m3u8?url=${encodeURIComponent(abs)}`;
      }

      // Segment / key / init
      return `${workerOrigin}/seg.ts?url=${encodeURIComponent(abs)}`;
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

/* ---------- Stream a segment / key ---------- */
async function proxyBinary(target) {
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        "Referer": REFERER,
        "Origin": ORIGIN,
        "User-Agent": UA,
        "Accept": "*/*",
      },
      redirect: "follow",
    });
  } catch (e) {
    return new Response("fetch failed: " + e.message, { status: 502, headers: CORS });
  }

  const ct = upstream.headers.get("content-type") || "video/mp2t";
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...CORS,
      "Content-Type": ct,
      "Cache-Control": "public, max-age=60",
    },
  });
}

function m3u8(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl" },
  });
}

/* ============================================================
   Plyr player (served at "/")
   ============================================================ */
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Fancode Live · Plyr</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css">
<style>
  html,body{margin:0;background:#000;height:100%;overflow:hidden;font-family:system-ui,sans-serif}
  #v{width:100vw;height:100vh;display:block;background:#000}
  .plyr{--plyr-color-main:#3b82f6;width:100vw;height:100vh}
  #msg{position:absolute;top:16px;left:16px;z-index:10;color:#fff;
       background:rgba(0,0,0,.65);padding:8px 14px;border-radius:8px;font-size:13px}
  #msg.error{background:rgba(220,38,38,.9)}
</style>
</head>
<body>
  <video id="v" playsinline controls></video>
  <div id="msg">Loading…</div>

  <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>

  <script>
    const video = document.getElementById('v');
    const msg   = document.getElementById('msg');
    const SRC   = location.origin + '/worker.m3u8';

    const fail = (t) => { msg.textContent = t; msg.classList.add('error'); msg.style.display='block'; };
    let hls = null;

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true, enableWorker: true, backBufferLength: 30 });
      hls.loadSource(SRC);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { msg.style.display = 'none'; });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) { fail('Network error — retrying…'); hls.startLoad(); }
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { fail('Media error — recovering…'); hls.recoverMediaError(); }
        else { fail('Error: ' + d.details); hls.destroy(); }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = SRC;
      video.addEventListener('loadedmetadata', () => { msg.style.display = 'none'; });
      video.addEventListener('error', () => fail('Native HLS error'));
    } else {
      fail('HLS not supported');
    }

    const player = new Plyr(video, {
      controls: ['play-large','restart','play','progress','current-time','duration',
                 'mute','volume','captions','settings','pip','airplay','fullscreen'],
      settings: ['captions','quality','speed'],
      autoplay: true, muted: false, seekTime: 10,
      keyboard: { focused: true, global: true },
    });

    player.on('ready', () => {
      msg.style.display = 'none';
      player.play().catch(()=>{});
    });

    if (hls) {
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        try {
          const levels = data.levels
            .map((l, i) => ({ label: l.height ? l.height + 'p' : ('Level ' + i), value: i }))
            .reverse();
          levels.unshift({ label: 'Auto', value: -1 });
          player.options.quality = { default: -1, options: levels.map(l => l.value) };
          player.quality = -1;
          player.on('qualitychange', () => { hls.currentLevel = player.quality; });
        } catch(e) {}
      });
    }
  </script>
</body>
</html>`;
