const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildDidlLite } = require('../dlna/metadata');
const { setAvTransportUri, play, stop, getTransportInfo } = require('../upnp/soap');
const { fetchMovieMetadata, extractMovieTitle } = require('./metadataFetcher');

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function safeBasename(filePath) {
  return path.basename(filePath || '').replace(/[<>"'`]/g, '');
}

function isLikelyMovie(media) {
  if (!media || !media.filePath) {
    return false;
  }

  if (/\.d\.ts$/i.test(media.filePath)) {
    return false;
  }

  const ext = path.extname(media.filePath).toLowerCase();
  const videoExts = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.mts']);
  return videoExts.has(ext);
}

function buildPageHtml(rendererName) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NovaBox</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0f172a;
      --surface: rgba(30, 41, 59, 0.7);
      --surface-2: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #fb923c;
      --accent-strong: #f97316;
      --danger: #ef4444;
      --stroke: rgba(255, 255, 255, 0.1);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Raleway', system-ui, -apple-system, Segoe UI, sans-serif;
      background-image:
        radial-gradient(circle at 14% 18%, rgba(59, 130, 246, 0.12) 0, transparent 38%),
        radial-gradient(circle at 85% 82%, rgba(249, 115, 22, 0.1) 0, transparent 35%),
        linear-gradient(160deg, #0b1222 0%, #0f172a 55%, #121f37 100%);
      padding: 24px;
    }

    .app {
      max-width: 1600px;
      margin: 0 auto;
    }

    .topbar {
      display: flex;
      gap: 16px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .brand h1 {
      margin: 0;
      font-size: clamp(2rem, 3vw, 2.8rem);
      letter-spacing: 0.02em;
      font-weight: 900;
      background: linear-gradient(90deg, #60a5fa, #818cf8);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .subtitle {
      color: var(--muted);
      font-size: 0.95rem;
    }

    .controls {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .neu-btn {
      background: rgba(255, 255, 255, 0.03);
      box-shadow: 6px 6px 12px rgba(0, 0, 0, 0.4), -6px -6px 12px rgba(255, 255, 255, 0.04);
      backdrop-filter: blur(10px);
      color: var(--accent);
      border-radius: 1rem;
      border: 1px solid rgba(255, 255, 255, 0.04);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 0.76rem;
      cursor: pointer;
      transition: all 0.2s ease-in-out;
      padding: 12px 18px;
      min-height: 46px;
    }

    .neu-btn:hover {
      color: var(--accent-strong);
      background: rgba(255, 255, 255, 0.06);
      transform: translateY(-1px);
    }

    .neu-btn:active {
      box-shadow: inset 4px 4px 10px rgba(0, 0, 0, 0.4), inset -4px -4px 10px rgba(255, 255, 255, 0.02);
    }

    .neu-btn.danger {
      color: #fca5a5;
    }

    .status {
      background: var(--surface);
      border: 1px solid var(--stroke);
      border-radius: 0.9rem;
      padding: 14px 16px;
      color: var(--text);
      margin-bottom: 20px;
      backdrop-filter: blur(10px);
      min-height: 52px;
      display: flex;
      align-items: center;
    }

    .grid {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
      justify-content: flex-start;
    }

    .movie-card {
      width: 500px;
      height: 500px;
      max-width: 100%;
      background: #1e293b;
      border-radius: 0;
      position: relative;
      cursor: pointer;
      overflow: hidden;
      border: 10px solid white;
      transition: transform 0.28s ease, box-shadow 0.28s ease;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
      flex-shrink: 0;
    }

    .movie-card:hover {
      transform: scale(1.03);
      box-shadow: 0 28px 56px rgba(30, 64, 175, 0.25);
    }

    .movie-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .placeholder {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #64748b;
      background: linear-gradient(145deg, #1e293b, #0f172a);
      font-size: 72px;
      font-weight: 800;
    }

    .movie-overlay {
      position: absolute;
      inset: 0;
      z-index: 5;
      opacity: 0;
      transition: opacity 0.28s ease;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      gap: 16px;
      padding: 28px;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(4px);
    }

    .movie-card:hover .movie-overlay {
      opacity: 1;
    }

    .movie-title {
      margin: 0;
      color: #fff;
      font-size: clamp(1.3rem, 2.2vw, 2rem);
      font-weight: 800;
      line-height: 1.2;
      text-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
      word-break: break-word;
    }

    .movie-meta {
      color: #93c5fd;
      font-size: 0.9rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .movie-plot {
      margin: 0;
      color: #e2e8f0;
      font-size: 1rem;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 5;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .empty {
      width: 100%;
      margin-top: 110px;
      text-align: center;
      color: #64748b;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .empty .icon {
      font-size: 54px;
      opacity: 0.5;
    }

    .empty .main {
      font-size: 2rem;
      font-weight: 800;
      color: #94a3b8;
    }

    .empty .sub {
      font-size: 1.05rem;
      color: #64748b;
    }

    @media (max-width: 920px) {
      body { padding: 14px; }
      .topbar { align-items: flex-start; }
      .controls { width: 100%; }
      .neu-btn { flex: 1 1 180px; }
      .grid { justify-content: center; }
      .movie-card {
        width: min(92vw, 500px);
        height: min(92vw, 500px);
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <h1>NovaBox</h1>
        <div class="subtitle">Target Renderer: <strong>${rendererName}</strong></div>
      </div>
      <div class="controls">
        <button class="neu-btn" id="refreshBtn">Rescan Library</button>
        <button class="neu-btn" id="addFolderBtn">Add Media Folder</button>
        <button class="neu-btn danger" id="stopBtn">Stop Cast</button>
      </div>
    </header>

    <div class="status" id="statusBox">Loading media library...</div>
    <section id="grid" class="grid"></section>
  </div>

  <script>
    const statusBox = document.getElementById('statusBox');
    const grid = document.getElementById('grid');
    const refreshBtn = document.getElementById('refreshBtn');
    const addFolderBtn = document.getElementById('addFolderBtn');
    const stopBtn = document.getElementById('stopBtn');

    function setStatus(message, isError) {
      statusBox.textContent = message;
      statusBox.style.borderColor = isError ? 'rgba(239, 68, 68, 0.7)' : 'rgba(255, 255, 255, 0.1)';
      statusBox.style.color = isError ? '#fecaca' : '#f8fafc';
      statusBox.style.background = isError ? 'rgba(127, 29, 29, 0.45)' : 'rgba(30, 41, 59, 0.7)';
    }

    function formatSize(bytes) {
      if (!Number.isFinite(bytes)) return 'Unknown size';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return value.toFixed(value >= 10 || unit === 0 ? 0 : 1) + ' ' + units[unit];
    }

    function createEmptyState(noFolders) {
      const empty = document.createElement('div');
      empty.className = 'empty';

      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = 'i';

      const main = document.createElement('div');
      main.className = 'main';
      main.textContent = noFolders ? 'Your library is empty' : 'No movies found';

      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = noFolders
        ? 'Click "Add Media Folder" to select your default media directory.'
        : 'Click "Rescan Library" to refresh your selected media folders.';

      empty.appendChild(icon);
      empty.appendChild(main);
      empty.appendChild(sub);
      return empty;
    }

    async function castItem(item, button) {
      button.disabled = true;
      setStatus('Casting ' + (item.movieTitle || item.name) + '...');
      try {
        const response = await fetch('/api/cast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        setStatus('Now playing on ${rendererName}: ' + (item.movieTitle || item.name));
      } catch (error) {
        setStatus('Cast failed: ' + error.message, true);
      } finally {
        button.disabled = false;
      }
    }

    function renderItems(items, noFolders) {
      grid.innerHTML = '';

      if (!items.length) {
        grid.appendChild(createEmptyState(noFolders));
        return;
      }

      for (const item of items) {
        const card = document.createElement('article');
        card.className = 'movie-card';

        if (item.posterUrl) {
          const img = document.createElement('img');
          img.src = item.posterUrl;
          img.alt = item.movieTitle || item.name;
          img.onerror = () => {
            img.remove();
            const fallback = document.createElement('div');
            fallback.className = 'placeholder';
            fallback.textContent = '▶';
            card.insertBefore(fallback, card.firstChild);
          };
          card.appendChild(img);
        } else {
          const fallback = document.createElement('div');
          fallback.className = 'placeholder';
          fallback.textContent = '▶';
          card.appendChild(fallback);
        }

        const overlay = document.createElement('div');
        overlay.className = 'movie-overlay';

        const title = document.createElement('h3');
        title.className = 'movie-title';
        title.textContent = item.movieTitle || item.name;

        const meta = document.createElement('div');
        meta.className = 'movie-meta';
        const parts = [];
        if (item.year) parts.push(item.year);
        if (item.imdbRating) parts.push('IMDb ' + item.imdbRating + '/10');
        parts.push(formatSize(item.size));
        meta.textContent = parts.join(' • ');

        const plot = document.createElement('p');
        plot.className = 'movie-plot';
        plot.textContent = item.plot || 'No synopsis available for this title.';

        const playButton = document.createElement('button');
        playButton.className = 'neu-btn';
        playButton.textContent = 'Play';
        playButton.addEventListener('click', (event) => {
          event.stopPropagation();
          castItem(item, playButton);
        });

        overlay.appendChild(title);
        overlay.appendChild(meta);
        overlay.appendChild(plot);
        overlay.appendChild(playButton);

        card.addEventListener('click', () => castItem(item, playButton));
        card.appendChild(overlay);
        grid.appendChild(card);
      }
    }

    async function loadLibrary(forceRefresh = false) {
      setStatus(forceRefresh ? 'Refreshing media library...' : 'Loading media library...');
      try {
        const url = forceRefresh ? '/api/library?refresh=1' : '/api/library';
        const response = await fetch(url);
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        renderItems(result.items, result.noFolders);
        if (result.noFolders) {
          setStatus('No media folder selected. Click "Add Media Folder" to choose your default folder.');
        } else {
          setStatus('Found ' + result.items.length + ' movie(s). Select one to cast.');
        }
      } catch (error) {
        renderItems([], false);
        setStatus('Library load failed: ' + error.message, true);
      }
    }

    refreshBtn.addEventListener('click', () => loadLibrary(true));

    addFolderBtn.addEventListener('click', async () => {
      addFolderBtn.disabled = true;
      setStatus('Opening folder picker...');
      try {
        let response = await fetch('/api/media-folders/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        let result = await response.json();

        if (!response.ok || !result.ok) {
          const manualPath = window.prompt('Enter full folder path to add:');
          if (!manualPath) {
            throw new Error(result.error || 'No folder selected.');
          }

          response = await fetch('/api/media-folders/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: manualPath }),
          });
          result = await response.json();
        }

        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        await loadLibrary(true);
        setStatus('Folder added. Total folders: ' + result.folderCount + '. Movies indexed: ' + result.movieCount + '.');
      } catch (error) {
        setStatus('Add folder failed: ' + error.message, true);
      } finally {
        addFolderBtn.disabled = false;
      }
    });

    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      setStatus('Stopping playback...');
      try {
        const response = await fetch('/api/stop', { method: 'POST' });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        setStatus('Playback stopped on renderer.');
      } catch (error) {
        setStatus('Stop failed: ' + error.message, true);
      } finally {
        stopBtn.disabled = false;
      }
    });

    loadLibrary(false);
  </script>
</body>
</html>`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function castMediaItem(renderer, mediaServer, media) {
  const mediaUrl = mediaServer.getMediaUrl(media.id);
  const metadata = buildDidlLite({
    title: media.name,
    filePath: media.filePath,
    mediaUrl,
  });

  try {
    await setAvTransportUri(renderer, mediaUrl, metadata);
  } catch (err) {
    const message = String(err && err.message ? err.message : '');
    if (message.includes('errorCode>714</errorCode>') || message.includes('Illegal MIME-type')) {
      await setAvTransportUri(renderer, mediaUrl, '');
    } else {
      throw err;
    }
  }

  await play(renderer);

  // Renderer state can lag behind Play by ~1s.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const info = await getTransportInfo(renderer);
  const state = info
    && info['s:Envelope']
    && info['s:Envelope']['s:Body']
    && info['s:Envelope']['s:Body']['u:GetTransportInfoResponse']
    && info['s:Envelope']['s:Body']['u:GetTransportInfoResponse']['CurrentTransportState'];

  return {
    mediaUrl,
    transportState: state || 'unknown',
  };
}

function createCastUiServer({
  mediaServer,
  renderer,
  uiHost = '127.0.0.1',
  uiPort = 8787,
  chooseMediaFolder,
  onMediaFoldersChanged,
}) {
  let server = null;

  const getMovieItems = () => mediaServer.library
    .filter(isLikelyMovie)
    .map((item) => {
      let size = null;
      try {
        size = fs.statSync(item.filePath).size;
      } catch (err) {
        size = null;
      }

      return {
        id: item.id,
        name: safeBasename(item.name),
        mimeType: item.mimeType,
        size,
      };
    });

  const metadataMap = new Map();

  const getMovieItemsWithMetadata = async () => {
    const items = getMovieItems();
    const result = [];

    for (const item of items) {
      if (metadataMap.has(item.id)) {
        result.push({
          ...item,
          ...metadataMap.get(item.id),
        });
      } else {
        const movieTitle = extractMovieTitle(item.name);
        const metadata = await fetchMovieMetadata(movieTitle);
        const enriched = {
          ...item,
          movieTitle,
          posterUrl: metadata.posterUrl,
          year: metadata.year,
          plot: metadata.plot,
          imdbRating: metadata.imdbRating,
        };
        metadataMap.set(item.id, {
          movieTitle,
          posterUrl: metadata.posterUrl,
          year: metadata.year,
          plot: metadata.plot,
          imdbRating: metadata.imdbRating,
        });
        result.push(enriched);
      }
    }

    return result;
  };

  async function handleRequest(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && parsed.pathname === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(buildPageHtml(safeBasename(renderer.friendlyName || 'Unknown Renderer')));
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/library') {
      try {
        if (parsed.searchParams.get('refresh') === '1') {
          await mediaServer.buildLibrary();
          metadataMap.clear();
        }
        const noFolders = mediaServer.getRootDirs().length === 0;
        const items = noFolders ? [] : await getMovieItemsWithMetadata();
        sendJson(res, 200, {
          ok: true,
          noFolders,
          items,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/cast') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const mediaId = String(payload.id || '');
        const media = mediaServer.getMediaById(mediaId);

        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Media item not found.' });
          return;
        }

        const result = await castMediaItem(renderer, mediaServer, media);
        sendJson(res, 200, {
          ok: true,
          media: {
            id: media.id,
            name: media.name,
          },
          transportState: result.transportState,
          mediaUrl: result.mediaUrl,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/stop') {
      try {
        await stop(renderer);
        sendJson(res, 200, {
          ok: true,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/media-folders/add') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        let folderPath = String(payload.path || '').trim();

        if (!folderPath && typeof chooseMediaFolder === 'function') {
          folderPath = String(await chooseMediaFolder() || '').trim();
        }

        if (!folderPath) {
          sendJson(res, 400, {
            ok: false,
            error: 'No media folder selected.',
          });
          return;
        }

        const added = mediaServer.addRootDir(folderPath);
        await mediaServer.buildLibrary();
        metadataMap.clear();

        if (typeof onMediaFoldersChanged === 'function') {
          onMediaFoldersChanged(mediaServer.getRootDirs());
        }

        sendJson(res, 200, {
          ok: true,
          added,
          folderPath,
          folderCount: mediaServer.getRootDirs().length,
          movieCount: getMovieItems().length,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  }

  return {
    start: async () => {
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          sendJson(res, 500, {
            ok: false,
            error: error.message,
          });
        });
      });

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(uiPort), uiHost, () => resolve());
      });

      const address = server.address();
      return {
        host: uiHost,
        port: address.port,
      };
    },
    stop: () => {
      if (!server) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        server.close(() => {
          server = null;
          resolve();
        });
      });
    },
  };
}

module.exports = {
  createCastUiServer,
};
