// ============================================================
//  FANCODE HLS PROXY — Cloudflare Worker (retry + Plyr)
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

    // ---- /worker.m3u8 → rewritten playlist (never cached) ----
    if (reqUrl.pathname === "/worker.m3u8") {
      const sub = reqUrl.searchParams.get("url");
      const resp = await proxyPlaylist(sub || STREAM_URL, reqUrl.origin);
      resp.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
      resp.headers.set("CDN-Cache-Control", "no-store");
      return resp;
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
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    return new Response("Not found. Use /worker.m3u8", { status: 404, headers: CORS });
  },
};

/* ============================================================
   Fetch with retry — handles transient 403/429/5xx from Fancode
   ============================================================ */
async function fetchWithRetry(url, attempt = 1) {
  const maxAttempts = 4;
  try {
    const res = await fetch(url, {
      headers: {
        "Referer": REFERER,
        "Origin": ORIGIN,
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      redirect: "follow",
      cf: {
        cacheTtl: 0,
        cacheEverything: false,
        mirage: false,
      },
    });

    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 150 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    return res;
  } catch (e) {
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 150 * attempt));
      return fetchWithRetry(url, attempt + 1);
    }
    throw e;
  }
}

/* ============================================================
   Rewrite an m3u8
   ============================================================ */
async function proxyPlaylist(target, workerOrigin) {
  let upstream;
  try {
    upstream = await fetchWithRetry(target);
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

      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = new URL(uri, base).toString();
          return `URI="${workerOrigin}/seg.ts?url=${encodeURIComponent(abs)}"`;
        });
      }

      const abs = new URL(line, base).toString();
      if (abs.split("?")[0].endsWith(".m3u8")) {
        return `${workerOrigin}/worker.m3u8?url=${encodeURIComponent(abs)}`;
      }
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

/* ============================================================
   Stream a segment / key
   ============================================================ */
async function proxyBinary(target) {
  let upstream;
  try {
    upstream = await fetchWithRetry(target);
  } catch (e) {
    return new Response("fetch failed: " + e.message, { status: 502, headers: CORS });
  }

  if (!upstream.ok) {
    return new Response("upstream " + upstream.status, {
      status: upstream.status,
      headers: CORS,
    });
  }

  const ct = upstream.headers.get("content-type") || "video/mp2t";
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": ct,
      "Cache-Control": "public, max-age=30",
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
   Built-in Plyr web player (served at "/")
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
  #msg{
    position:absolute;top:16px;left:16px;z-index:10;
    color:#fff;background:rgba(0,0,0,.65);
    padding:8px 14px;border-radius:8px;font-size:13px;
  }
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
    const ok   = () => { msg.style.display = 'none'; msg.classList.remove('error'); };

    let hls = null;
    let retries = 0;
    const MAX_RETRIES = 10;

    function startHls() {
      if (hls) { try { hls.destroy(); } catch(e){} hls = null; }

      hls = new Hls({
        lowLatencyMode: true,
        enableWorker: true,
        backBufferLength: 30,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 6,
        levelLoadingRetryDelay: 500,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 500,
      });

      hls.loadSource(SRC);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        ok();
        retries = 0;
        player.play().catch(()=>{});
      });

      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;

        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (retries < MAX_RETRIES) {
            retries++;
            fail('Network error — reconnecting (' + retries + '/' + MAX_RETRIES + ')…');
            setTimeout(() => { hls && hls.startLoad(); }, 800);
          } else {
            fail('Network error — reloading player…');
            setTimeout(() => { retries = 0; startHls(); }, 1500);
          }
        } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
          fail('Media error — recovering…');
          hls.recoverMediaError();
        } else {
          fail('Error: ' + d.details);
          if (retries < MAX_RETRIES) {
            retries++;
            setTimeout(() => { startHls(); }, 1500);
          }
        }
      });
    }

    /* Plyr first, then HLS on the Plyr-owned element */
    const player = new Plyr(video, {
      controls: ['play-large','restart','play','progress','current-time','duration',
                 'mute','volume','captions','settings','pip','airplay','fullscreen'],
      settings: ['captions','quality','speed'],
      autoplay: true,
      muted: false,
      seekTime: 10,
      keyboard: { focused: true, global: true },
    });

    player.on('ready', () => {
      if (window.Hls && Hls.isSupported()) {
        startHls();

        setTimeout(() => {
          if (!hls || !hls.levels || !hls.levels.length) return;
          try {
            const levels = hls.levels
              .map((l, i) => ({ label: l.height ? l.height + 'p' : ('Level ' + i), value: i }))
              .reverse();
            levels.unshift({ label: 'Auto', value: -1 });
            player.options.quality = { default: -1, options: levels.map(l => l.value) };
            player.quality = -1;
            player.on('qualitychange', () => { if (hls) hls.currentLevel = player.quality; });
          } catch(e){}
        }, 1000);

      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = SRC;
        video.addEventListener('loadedmetadata', ok);
        video.addEventListener('error', () => fail('Native HLS error'));
      } else {
        fail('HLS not supported');
      }
    });

    /* Force a reload when user hits play after an error */
    player.on('play', () => {
      if (hls && hls.media && hls.media.readyState < 2) {
        hls.startLoad();
      }
    });
  </script>
</body>
</html>`;
