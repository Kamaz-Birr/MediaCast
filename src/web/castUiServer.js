const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildDidlLite } = require('../dlna/metadata');
const { setAvTransportUri, play, stop, getTransportInfo } = require('../upnp/soap');
const { discoverRenderers } = require('../upnp/discovery');
const {
  fetchMovieMetadata,
  fetchSeriesMetadata,
  fetchEpisodeMetadata,
  extractMovieTitle,
} = require('./metadataFetcher');

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

const CATEGORY_MOVIES = 'movies';
const CATEGORY_TV_SHOWS = 'tv-shows';
const CATEGORY_ANIME_MOVIES = 'anime-movies';
const CATEGORY_ANIME_SHOWS = 'anime-shows';

function splitPathParts(filePath) {
  return path.resolve(filePath).split(/[\\/]+/).filter(Boolean);
}

function categoryFromPath(filePath) {
  const parts = splitPathParts(filePath);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const hasPart = (phrase) => lowerParts.some((part) => part === phrase || part.includes(phrase));

  if (hasPart('anime shows')) {
    return CATEGORY_ANIME_SHOWS;
  }
  if (hasPart('tv shows')) {
    return CATEGORY_TV_SHOWS;
  }
  if (hasPart('anime')) {
    return CATEGORY_ANIME_MOVIES;
  }
  if (hasPart('movies')) {
    return CATEGORY_MOVIES;
  }

  return CATEGORY_MOVIES;
}

function normalizeSeriesFolderName(input) {
  const cleaned = String(input || '')
    .replace(/[._]+/g, ' ')
    .replace(/\b(?:tv\s*shows?)\b/gi, ' ')
    .replace(/\banime\s*shows?\b/gi, ' ')
    .replace(/\bseason\s*\d{1,2}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || String(input || '').trim();
}

function extractSeriesName(filePath, category) {
  const parts = splitPathParts(filePath);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const folderName = category === CATEGORY_ANIME_SHOWS ? 'anime shows' : 'tv shows';
  const index = lowerParts.findIndex((part) => part === folderName || part.includes(folderName));

  if (index >= 0 && parts[index + 1]) {
    return normalizeSeriesFolderName(safeBasename(parts[index + 1]));
  }

  return normalizeSeriesFolderName(safeBasename(path.basename(path.dirname(filePath))));
}

function extractSeasonEpisodeInfo(filePath) {
  const filename = path.basename(filePath, path.extname(filePath));
  const normalized = filename.replace(/[._-]+/g, ' ');

  let seasonNumber = null;
  let episodeNumber = null;

  let match = normalized.match(/\bS(\d{1,2})\s*E(\d{1,3})\b/i);
  if (match) {
    seasonNumber = Number(match[1]);
    episodeNumber = Number(match[2]);
  } else {
    match = normalized.match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (match) {
      seasonNumber = Number(match[1]);
      episodeNumber = Number(match[2]);
    } else {
      const parent = path.basename(path.dirname(filePath));
      const seasonFromFolder = parent.match(/season\s*(\d{1,2})/i);
      if (seasonFromFolder) {
        seasonNumber = Number(seasonFromFolder[1]);
      }

      const episodeFromName = normalized.match(/\bE(?:pisode)?\s*(\d{1,3})\b/i)
        || normalized.match(/\b(?:Ep|Episode)\s*(\d{1,3})\b/i);
      if (episodeFromName) {
        episodeNumber = Number(episodeFromName[1]);
      }
    }
  }

  const seasonLabel = Number.isFinite(seasonNumber)
    ? `Season ${String(seasonNumber).padStart(2, '0')}`
    : 'Season Unknown';

  const seasonSort = Number.isFinite(seasonNumber) ? seasonNumber : 999;
  const episodeSort = Number.isFinite(episodeNumber) ? episodeNumber : 9999;

  return {
    seasonLabel,
    seasonNumber,
    episodeNumber,
    seasonSort,
    episodeSort,
  };
}

function extractSeriesTitleFromEpisodeName(fileName) {
  const baseName = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  const normalized = baseName.replace(/[._]+/g, ' ');
  const match = normalized.match(/^(.*?)(?:\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{1,3}\b)/i);
  if (!match || !match[1]) {
    return '';
  }

  return match[1]
    .replace(/[-:]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function metadataLooksResolved(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  return Boolean(
    metadata.tmdbId
    || metadata.imdbId
    || metadata.plot
    || metadata.imdbRating
    || metadata.year,
  );
}

async function fetchSeriesMetadataWithFallback(candidates) {
  const uniqueCandidates = Array.from(new Set((Array.isArray(candidates) ? candidates : [])
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0)));

  let firstMetadata = null;
  for (const candidate of uniqueCandidates) {
    const metadata = await fetchSeriesMetadata(candidate);
    if (!firstMetadata) {
      firstMetadata = metadata;
    }
    if (metadataLooksResolved(metadata)) {
      return {
        metadata,
        matchedTitle: candidate,
      };
    }
  }

  return {
    metadata: firstMetadata || {
      title: uniqueCandidates[0] || 'Unknown Show',
      posterUrl: null,
      plot: null,
      imdbRating: null,
      year: null,
      tmdbId: null,
      imdbId: null,
    },
    matchedTitle: uniqueCandidates[0] || 'Unknown Show',
  };
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

    .button-row {
      display: flex;
      gap: 10px;
      margin-top: 12px;
    }

    .neu-btn.watched, .neu-btn.secondary.watched {
      background: #22c55e;
      color: #fff;
      border-color: #22c55e;
      font-weight: 700;
      box-shadow: 0 2px 8px 0 rgba(34,197,94,0.12);
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

    .renderer-dropdown {
      position: relative;
      min-width: 280px;
      display: inline-block;
    }

    .renderer-dropdown-btn {
      min-height: 46px;
      min-width: 280px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      border-radius: 1rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 10px 14px;
      font-weight: 700;
      letter-spacing: 0.02em;
      backdrop-filter: blur(10px);
      outline: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      cursor: pointer;
      transition: border-color 0.18s, box-shadow 0.18s;
    }

    .renderer-dropdown-btn[aria-expanded="true"] {
      border-color: rgba(96, 165, 250, 0.85);
      box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.22);
    }

    .dropdown-arrow {
      margin-left: 10px;
      font-size: 1.1em;
      transition: transform 0.28s cubic-bezier(.4, 2, .6, 1);
    }

    .renderer-dropdown-btn[aria-expanded="true"] .dropdown-arrow {
      transform: rotate(-180deg);
    }

    .renderer-dropdown-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: 110%;
      background: rgba(30, 41, 59, 0.98);
      border-radius: 1rem;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
      margin: 0;
      padding: 0.5em 0;
      list-style: none;
      z-index: 100;
      opacity: 0;
      transform: translateY(-10px) scale(0.985);
      transform-origin: top center;
      pointer-events: none;
      transition: opacity 0.38s cubic-bezier(0.2, 0.9, 0.2, 1), transform 0.38s cubic-bezier(0.2, 0.9, 0.2, 1);
      max-height: 320px;
      overflow-y: auto;
      will-change: opacity, transform;
    }

    .renderer-dropdown-menu.open {
      opacity: 1;
      transform: translateY(0) scaleY(1);
      pointer-events: auto;
    }

    .renderer-dropdown-menu li {
      padding: 12px 18px;
      color: var(--text);
      font-weight: 600;
      cursor: pointer;
      transition: background 0.18s;
      border: none;
      background: none;
      outline: none;
      font-size: 1rem;
      display: flex;
      align-items: center;
      opacity: 0;
      transform: translateX(-10px);
    }

    .renderer-dropdown-menu.open li {
      animation: renderer-dropdown-item-in 360ms cubic-bezier(0.16, 0.84, 0.34, 1) forwards;
      animation-delay: calc(var(--item-index, 0) * 24ms);
    }

    @keyframes renderer-dropdown-item-in {
      from {
        opacity: 0;
        transform: translateX(-12px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .renderer-dropdown-menu,
      .renderer-dropdown-menu li,
      .dropdown-arrow {
        transition: none;
        animation: none;
      }

      .renderer-dropdown-menu li {
        opacity: 1;
        transform: none;
      }
    }

    .renderer-dropdown-menu li.selected {
      background: rgba(96, 165, 250, 0.13);
      color: #bae6fd;
    }

    .renderer-dropdown-menu li:hover {
      background: rgba(251, 146, 60, 0.13);
      color: #fed7aa;
    }

    .categories {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .category-btn {
      border: 1px solid var(--stroke);
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.62);
      color: var(--text);
      padding: 10px 14px;
      font-size: 0.82rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 160ms ease;
    }

    .category-btn.active {
      background: rgba(251, 146, 60, 0.18);
      border-color: rgba(251, 146, 60, 0.8);
      color: #fed7aa;
    }

    .category-btn:hover {
      border-color: rgba(255, 255, 255, 0.45);
      transform: translateY(-1px);
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

    .neu-btn.secondary {
      color: #93c5fd;
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

    .movie-card.watched-media {
      filter: grayscale(0.95);
      opacity: 0.78;
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.6);
    }

    .movie-card:hover {
      transform: scale(1.03);
      box-shadow: 0 28px 56px rgba(30, 64, 175, 0.25);
    }

    .movie-card.watched-media:hover {
      transform: scale(1.015);
      box-shadow: 0 18px 30px rgba(15, 23, 42, 0.68);
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

    .watched-check {
      position: absolute;
      top: 12px;
      left: 12px;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      background: #16a34a;
      color: #ffffff;
      display: grid;
      place-items: center;
      font-size: 20px;
      font-weight: 900;
      z-index: 9;
      border: 2px solid #ffffff;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.42);
      pointer-events: none;
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

    .group-section {
      width: 100%;
      margin-bottom: 34px;
    }

    .group-title {
      margin: 0 0 14px;
      color: #cbd5e1;
      font-size: 1.3rem;
      font-weight: 800;
      letter-spacing: 0.01em;
    }

    .group-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
    }

    .episodes-block {
      width: 100%;
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid rgba(148, 163, 184, 0.25);
    }

    .episodes-title {
      margin: 0 0 12px;
      color: #cbd5e1;
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .season-section {
      margin: 0 0 26px;
    }

    .season-title {
      margin: 0 0 12px;
      color: #93c5fd;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
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
        <div class="subtitle">Target Renderer: <strong id="targetRendererName">${rendererName}</strong></div>
      </div>
      <div class="controls">
        <div class="renderer-dropdown">
          <button id="rendererDropdownBtn" class="renderer-dropdown-btn" aria-haspopup="listbox" aria-expanded="false">
            <span id="rendererDropdownLabel">${rendererName}</span>
            <span class="dropdown-arrow">▼</span>
          </button>
          <ul id="rendererDropdownMenu" class="renderer-dropdown-menu" tabindex="-1" role="listbox" aria-label="Select target renderer"></ul>
        </div>
        <button class="neu-btn secondary" id="refreshRenderersBtn">Refresh Renderers</button>
        <button class="neu-btn" id="refreshBtn">Rescan Library</button>
        <button class="neu-btn" id="addFolderBtn">Add Media Folder</button>
        <button class="neu-btn secondary" id="backBtn" style="display:none">Back</button>
        <button class="neu-btn danger" id="stopBtn">Stop Cast</button>
      </div>
    </header>

    <div class="categories" id="categoryTabs">
      <button class="category-btn active" data-category="movies">Movies</button>
      <button class="category-btn" data-category="tv-shows">TV Shows</button>
      <button class="category-btn" data-category="anime-movies">Anime Movies</button>
      <button class="category-btn" data-category="anime-shows">Anime Shows</button>
    </div>

    <div class="status" id="statusBox">Loading media library...</div>
    <section id="grid" class="grid"></section>
  </div>

  <script>
    const CATEGORY_LABELS = {
      'movies': 'Movies',
      'tv-shows': 'TV Shows',
      'anime-movies': 'Anime Movies',
      'anime-shows': 'Anime Shows',
    };

    let currentCategory = 'movies';
    let currentGroupedData = [];
    let selectedShowName = null;
    let expandedSeasonName = null;
    let currentRendererName = '${rendererName}';
    const watchedItemIds = new Set();
    const statusBox = document.getElementById('statusBox');
    const grid = document.getElementById('grid');
    const categoryTabs = document.getElementById('categoryTabs');
    const targetRendererName = document.getElementById('targetRendererName');
    const rendererDropdownBtn = document.getElementById('rendererDropdownBtn');
    const rendererDropdownMenu = document.getElementById('rendererDropdownMenu');
    const rendererDropdownLabel = document.getElementById('rendererDropdownLabel');
    const refreshRenderersBtn = document.getElementById('refreshRenderersBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const addFolderBtn = document.getElementById('addFolderBtn');
    const backBtn = document.getElementById('backBtn');
    const stopBtn = document.getElementById('stopBtn');

    function isShowCategory(category) {
      return category === 'tv-shows' || category === 'anime-shows';
    }

    function setStatus(message, isError) {
      statusBox.textContent = message;
      statusBox.style.borderColor = isError ? 'rgba(239, 68, 68, 0.7)' : 'rgba(255, 255, 255, 0.1)';
      statusBox.style.color = isError ? '#fecaca' : '#f8fafc';
      statusBox.style.background = isError ? 'rgba(127, 29, 29, 0.45)' : 'rgba(30, 41, 59, 0.7)';
    }

    function setCurrentRendererName(name) {
      currentRendererName = String(name || '').trim() || 'Unknown Renderer';
      if (targetRendererName) {
        targetRendererName.textContent = currentRendererName;
      }
      if (rendererDropdownLabel) {
        rendererDropdownLabel.textContent = currentRendererName;
      }
    }

    function formatRendererLabel(item) {
      if (!item || typeof item !== 'object') {
        return 'Unknown Renderer';
      }
      const friendly = item.friendlyName || 'Unknown Renderer';
      const details = [item.modelName, item.manufacturer].filter(Boolean).join(' • ');
      return details ? (friendly + ' (' + details + ')') : friendly;
    }

    async function loadRenderers(forceRefresh = false) {
      try {
        const params = new URLSearchParams();
        if (forceRefresh) {
          params.set('refresh', '1');
        }

        const url = '/api/renderers' + (params.toString() ? ('?' + params.toString()) : '');
        const response = await fetch(url);
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        const renderers = Array.isArray(result.renderers) ? result.renderers : [];
        rendererDropdownMenu.innerHTML = '';

        if (!renderers.length) {
          const emptyItem = document.createElement('li');
          emptyItem.textContent = 'No renderers found';
          emptyItem.tabIndex = -1;
          rendererDropdownMenu.appendChild(emptyItem);
          rendererDropdownBtn.disabled = true;
          setCurrentRendererName('No Renderer Selected');
          return;
        }

        rendererDropdownBtn.disabled = false;
        const selectedKey = result.selectedKey || (renderers[0] && renderers[0].key) || '';

        renderers.forEach((rendererItem, index) => {
          const item = document.createElement('li');
          const key = rendererItem.key || '';
          item.dataset.key = key;
          item.textContent = formatRendererLabel(rendererItem);
          item.tabIndex = 0;
          item.setAttribute('role', 'option');
          item.style.setProperty('--item-index', String(index));

          if (key === selectedKey) {
            item.classList.add('selected');
          }

          item.addEventListener('click', async () => {
            await handleRendererPick(key);
          });

          item.addEventListener('keydown', async (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              await handleRendererPick(key);
            }
          });

          rendererDropdownMenu.appendChild(item);
        });

        const selected = renderers.find((entry) => entry.key === selectedKey) || renderers[0];
        setCurrentRendererName(selected && selected.friendlyName ? selected.friendlyName : '${rendererName}');
      } catch (error) {
        setStatus('Renderer list failed: ' + error.message, true);
      }
    }

    async function selectRenderer(rendererKey) {
      const key = String(rendererKey || '').trim();
      if (!key) {
        return;
      }

      const response = await fetch('/api/renderers/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || ('HTTP ' + response.status));
      }

      const name = result.renderer && result.renderer.friendlyName
        ? result.renderer.friendlyName
        : '${rendererName}';
      setCurrentRendererName(name);
      setStatus('Target renderer set to ' + name + '.');
    }

    function openRendererDropdown() {
      if (rendererDropdownBtn.disabled) {
        return;
      }
      rendererDropdownBtn.setAttribute('aria-expanded', 'true');
      rendererDropdownMenu.classList.add('open');
    }

    function closeRendererDropdown() {
      rendererDropdownBtn.setAttribute('aria-expanded', 'false');
      rendererDropdownMenu.classList.remove('open');
    }

    async function handleRendererPick(key) {
      try {
        await selectRenderer(key);
        closeRendererDropdown();
        await loadRenderers(false);
      } catch (error) {
        setStatus('Renderer select failed: ' + error.message, true);
      }
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

    function createEmptyState(noFolders, category) {
      const empty = document.createElement('div');
      empty.className = 'empty';

      const icon = document.createElement('div');
      icon.className = 'icon';
      icon.textContent = 'i';

      const main = document.createElement('div');
      main.className = 'main';
      main.textContent = noFolders
        ? 'Your library is empty'
        : 'No titles found in ' + (CATEGORY_LABELS[category] || 'this category');

      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = noFolders
        ? 'Click "Add Media Folder" to select your default media directory.'
        : 'Place files under the expected folder names (Movies, TV Shows, Anime, Anime Shows) and click "Rescan Library".';

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
        if (result.rendererName) {
          setCurrentRendererName(result.rendererName);
        }
        setStatus('Now playing on ' + currentRendererName + ': ' + (item.movieTitle || item.name));
      } catch (error) {
        setStatus('Cast failed: ' + error.message, true);
      } finally {
        button.disabled = false;
      }
    }

    function setWatchedCardState(card, watchedButton, isWatched) {
      card.classList.toggle('watched-media', isWatched);
      watchedButton.classList.toggle('watched', isWatched);
      watchedButton.textContent = isWatched ? 'Unmark' : 'Watched';

      const existingBadge = card.querySelector('.watched-check');
      if (isWatched && !existingBadge) {
        const badge = document.createElement('div');
        badge.className = 'watched-check';
        badge.textContent = '✓';
        card.appendChild(badge);
      }

      if (!isWatched && existingBadge) {
        existingBadge.remove();
      }
    }

    function createMovieCard(item) {
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

        // Watched button
        const watchedButton = document.createElement('button');
        watchedButton.className = 'neu-btn secondary';
        watchedButton.textContent = 'Watched';
        watchedButton.addEventListener('click', async (event) => {
          event.stopPropagation();
          const watchedKey = item.watchedKey || item.filePath || item.id;
          if (!watchedKey) {
            return;
          }

          const isCurrentlyWatched = watchedItemIds.has(watchedKey);
          watchedButton.disabled = true;
          try {
            const response = await fetch('/api/watched', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: watchedKey, watched: !isCurrentlyWatched }),
            });
            const result = await response.json();
            if (!response.ok || !result.ok) {
              throw new Error(result.error || ('HTTP ' + response.status));
            }

            if (result.watched) {
              watchedItemIds.add(watchedKey);
              setWatchedCardState(card, watchedButton, true);
            } else {
              watchedItemIds.delete(watchedKey);
              setWatchedCardState(card, watchedButton, false);
            }
          } catch (error) {
            setStatus('Watched update failed: ' + error.message, true);
          } finally {
            watchedButton.disabled = false;
          }
        });

        const buttonRow = document.createElement('div');
        buttonRow.className = 'button-row';
        buttonRow.appendChild(playButton);
        buttonRow.appendChild(watchedButton);

        overlay.appendChild(title);
        overlay.appendChild(meta);
        overlay.appendChild(plot);
        overlay.appendChild(buttonRow);

        const watchedKey = item.watchedKey || item.filePath || item.id;
        setWatchedCardState(card, watchedButton, watchedItemIds.has(watchedKey));

        card.addEventListener('click', () => castItem(item, playButton));
        card.appendChild(overlay);
        return card;
    }

    function getGroupRepresentative(group) {
      if (!group) return null;
      if (Array.isArray(group.seasons) && group.seasons.length > 0) {
        for (const season of group.seasons) {
          if (season.items && season.items.length > 0) {
            return season.items[0];
          }
        }
      }
      return (group.items && group.items[0]) || null;
    }

    function getGroupEpisodeCount(group) {
      if (!group) return 0;
      if (Array.isArray(group.seasons) && group.seasons.length > 0) {
        return group.seasons.reduce((total, season) => total + ((season.items || []).length), 0);
      }
      return (group.items || []).length;
    }

    function getSeasonRepresentative(season) {
      return (season && season.items && season.items[0]) || null;
    }

    function setBackButton(visible, label) {
      backBtn.style.display = visible ? 'inline-flex' : 'none';
      backBtn.textContent = label || 'Back';
    }

    function createShowCard(group) {
      const representative = getGroupRepresentative(group);
      const card = document.createElement('article');
      card.className = 'movie-card';

      const posterUrl = group.posterUrl || (representative && representative.posterUrl);
      if (posterUrl) {
        const img = document.createElement('img');
        img.src = posterUrl;
        img.alt = group.displayTitle || group.name;
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
      title.textContent = group.displayTitle || group.name;

      const meta = document.createElement('div');
      meta.className = 'movie-meta';
      const metaParts = [];
      if (group.year || (representative && representative.year)) metaParts.push(group.year || representative.year);
      if (group.imdbRating || (representative && representative.imdbRating)) {
        metaParts.push('IMDb ' + (group.imdbRating || representative.imdbRating) + '/10');
      }
      metaParts.push(getGroupEpisodeCount(group) + ' episodes');
      meta.textContent = metaParts.join(' • ');

      const plot = document.createElement('p');
      plot.className = 'movie-plot';
      plot.textContent = group.plot || (representative && representative.plot) || 'No synopsis available for this show.';

      const viewButton = document.createElement('button');
      viewButton.className = 'neu-btn';
      viewButton.textContent = 'View';
      viewButton.addEventListener('click', (event) => {
        event.stopPropagation();
        selectedShowName = group.name;
        expandedSeasonName = null;
        renderSelectedShowPage();
      });

      overlay.appendChild(title);
      overlay.appendChild(meta);
      overlay.appendChild(plot);
      overlay.appendChild(viewButton);

      card.addEventListener('click', () => {
        selectedShowName = group.name;
        expandedSeasonName = null;
        renderSelectedShowPage();
      });
      card.appendChild(overlay);
      return card;
    }

    function createSeasonCard(showName, season) {
      const representative = getSeasonRepresentative(season);
      const card = document.createElement('article');
      card.className = 'movie-card';

      if (representative && representative.posterUrl) {
        const img = document.createElement('img');
        img.src = representative.posterUrl;
        img.alt = season.name;
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
      title.textContent = season.name;

      const meta = document.createElement('div');
      meta.className = 'movie-meta';
      meta.textContent = ((season.items || []).length) + ' episodes';

      const plot = document.createElement('p');
      plot.className = 'movie-plot';
      plot.textContent = expandedSeasonName === season.name
        ? 'Click to hide episodes.'
        : 'Click to view all episodes in this season.';

      const viewButton = document.createElement('button');
      viewButton.className = 'neu-btn';
      viewButton.textContent = 'Episodes';
      viewButton.addEventListener('click', (event) => {
        event.stopPropagation();
        expandedSeasonName = expandedSeasonName === season.name ? null : season.name;
        renderSelectedShowPage();
      });

      overlay.appendChild(title);
      overlay.appendChild(meta);
      overlay.appendChild(plot);
      overlay.appendChild(viewButton);

      card.addEventListener('click', () => {
        expandedSeasonName = expandedSeasonName === season.name ? null : season.name;
        renderSelectedShowPage();
      });
      card.appendChild(overlay);
      return card;
    }

    function renderItems(items, noFolders, category, container) {
      const target = container || grid;
      target.innerHTML = '';

      if (!items.length) {
        target.appendChild(createEmptyState(noFolders, category));
        return;
      }

      for (const item of items) {
        target.appendChild(createMovieCard(item));
      }
    }

    function renderGroupedItems(groups, noFolders, category) {
      grid.innerHTML = '';

      if (!groups.length) {
        grid.appendChild(createEmptyState(noFolders, category));
        return;
      }

      for (const group of groups) {
        grid.appendChild(createShowCard(group));
      }
    }

    function renderSelectedShowPage() {
      if (!selectedShowName) {
        renderGroupedItems(currentGroupedData, false, currentCategory);
        setBackButton(false);
        return;
      }

      const selected = currentGroupedData.find((group) => group.name === selectedShowName);
      if (!selected) {
        selectedShowName = null;
        renderGroupedItems(currentGroupedData, false, currentCategory);
        setBackButton(false);
        return;
      }

      setBackButton(true, 'Back to ' + (CATEGORY_LABELS[currentCategory] || 'Shows'));
      grid.innerHTML = '';

      const section = document.createElement('section');
      section.className = 'group-section';

      const showTitle = document.createElement('h2');
      showTitle.className = 'group-title';
      showTitle.textContent = selected.displayTitle || selected.name;
      section.appendChild(showTitle);

      const seasonGrid = document.createElement('div');
      seasonGrid.className = 'group-grid';
      const seasons = Array.isArray(selected.seasons) ? selected.seasons : [];
      for (const season of seasons) {
        seasonGrid.appendChild(createSeasonCard(selected.name, season));
      }
      section.appendChild(seasonGrid);

      if (expandedSeasonName) {
        const expandedSeason = seasons.find((season) => season.name === expandedSeasonName);
        if (expandedSeason) {
          const episodesBlock = document.createElement('div');
          episodesBlock.className = 'episodes-block';

          const episodesTitle = document.createElement('h3');
          episodesTitle.className = 'episodes-title';
          episodesTitle.textContent = expandedSeason.name + ' Episodes';

          const episodesGrid = document.createElement('div');
          episodesGrid.className = 'group-grid';
          for (const item of (expandedSeason.items || [])) {
            episodesGrid.appendChild(createMovieCard(item));
          }

          episodesBlock.appendChild(episodesTitle);
          episodesBlock.appendChild(episodesGrid);
          section.appendChild(episodesBlock);
        }
      }

      grid.appendChild(section);
      const seasonCount = seasons.length;
      const episodeCount = getGroupEpisodeCount(selected);
      setStatus('Viewing ' + selected.name + ' • ' + seasonCount + ' season(s) • ' + episodeCount + ' episode(s).');
    }

    function countGroupedItems(groups) {
      return (groups || []).reduce((total, group) => {
        if (Array.isArray(group.seasons) && group.seasons.length > 0) {
          return total + group.seasons.reduce((seasonTotal, season) => seasonTotal + ((season.items || []).length), 0);
        }
        return total + ((group.items || []).length);
      }, 0);
    }

    function syncActiveCategoryButton() {
      const buttons = categoryTabs.querySelectorAll('[data-category]');
      buttons.forEach((button) => {
        button.classList.toggle('active', button.dataset.category === currentCategory);
      });
    }

    async function loadLibrary(forceRefresh = false) {
      setStatus(forceRefresh ? 'Refreshing media library...' : 'Loading media library...');
      try {
        const params = new URLSearchParams({ category: currentCategory });
        if (forceRefresh) {
          params.set('refresh', '1');
        }
        const url = '/api/library?' + params.toString();
        const response = await fetch(url);
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        watchedItemIds.clear();
        const watchedKeys = Array.isArray(result.watchedKeys) ? result.watchedKeys : [];
        for (const watchedKey of watchedKeys) {
          if (typeof watchedKey === 'string' && watchedKey.length > 0) {
            watchedItemIds.add(watchedKey);
          }
        }

        const hasGroups = Array.isArray(result.groups) && result.groups.length > 0;

        if (hasGroups) {
          currentGroupedData = result.groups;
          if (isShowCategory(currentCategory)) {
            if (selectedShowName) {
              renderSelectedShowPage();
            } else {
              renderGroupedItems(result.groups, result.noFolders, currentCategory);
            }
          } else {
            renderGroupedItems(result.groups, result.noFolders, currentCategory);
          }
        } else {
          currentGroupedData = [];
          renderItems(result.items || [], result.noFolders, currentCategory);
        }

        if (result.noFolders) {
          setStatus('No media folder selected. Click "Add Media Folder" to choose your default folder.');
        } else {
          const total = hasGroups
            ? countGroupedItems(result.groups)
            : (result.items || []).length;
          const categoryName = CATEGORY_LABELS[currentCategory] || 'Titles';
          if (isShowCategory(currentCategory)) {
            setStatus('Showing ' + (result.groups || []).length + ' show(s) in ' + categoryName + '.');
          } else {
            setStatus('Showing ' + total + ' item(s) in ' + categoryName + '.');
          }
        }
      } catch (error) {
        currentGroupedData = [];
        selectedShowName = null;
        expandedSeasonName = null;
        setBackButton(false);
        renderItems([], false, currentCategory);
        setStatus('Library load failed: ' + error.message, true);
      }
    }

    refreshBtn.addEventListener('click', () => loadLibrary(true));

    refreshRenderersBtn.addEventListener('click', async () => {
      refreshRenderersBtn.disabled = true;
      setStatus('Refreshing renderer list...');
      try {
        await loadRenderers(true);
      } finally {
        refreshRenderersBtn.disabled = false;
      }
    });

    rendererDropdownBtn.addEventListener('click', () => {
      const isOpen = rendererDropdownMenu.classList.contains('open');
      if (isOpen) {
        closeRendererDropdown();
      } else {
        openRendererDropdown();
      }
    });

    rendererDropdownBtn.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openRendererDropdown();
      }
    });

    document.addEventListener('click', (event) => {
      if (!rendererDropdownMenu.contains(event.target) && !rendererDropdownBtn.contains(event.target)) {
        closeRendererDropdown();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeRendererDropdown();
      }
    });

    categoryTabs.addEventListener('click', (event) => {
      const button = event.target.closest('[data-category]');
      if (!button) {
        return;
      }
      currentCategory = button.dataset.category;
      selectedShowName = null;
      expandedSeasonName = null;
      setBackButton(false);
      syncActiveCategoryButton();
      loadLibrary(false);
    });

    backBtn.addEventListener('click', () => {
      if (!selectedShowName) {
        setBackButton(false);
        return;
      }
      selectedShowName = null;
      expandedSeasonName = null;
      renderGroupedItems(currentGroupedData, false, currentCategory);
      const categoryName = CATEGORY_LABELS[currentCategory] || 'Shows';
      setStatus('Back to ' + categoryName + '. Showing ' + currentGroupedData.length + ' show(s).');
      setBackButton(false);
    });

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
        if (result.rendererName) {
          setCurrentRendererName(result.rendererName);
        }
        setStatus('Playback stopped on ' + currentRendererName + '.');
      } catch (error) {
        setStatus('Stop failed: ' + error.message, true);
      } finally {
        stopBtn.disabled = false;
      }
    });

    setBackButton(false);
    syncActiveCategoryButton();
    loadRenderers(true);
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
  initialWatchedKeys = [],
  onWatchedKeysChanged,
}) {
  let server = null;
  let selectedRenderer = renderer || null;
  let availableRenderers = selectedRenderer ? [selectedRenderer] : [];
  const watchedMediaKeys = new Set(
    (Array.isArray(initialWatchedKeys) ? initialWatchedKeys : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0),
  );

  const rendererKey = (item) => String((item && (item.udn || item.location)) || '').trim();

  const toRendererSummary = (item) => ({
    key: rendererKey(item),
    friendlyName: safeBasename(item && item.friendlyName ? item.friendlyName : 'Unknown Renderer'),
    manufacturer: safeBasename(item && item.manufacturer ? item.manufacturer : ''),
    modelName: safeBasename(item && item.modelName ? item.modelName : ''),
    udn: safeBasename(item && item.udn ? item.udn : ''),
    location: item && item.location ? String(item.location) : '',
  });

  const mergeRendererLists = (items) => {
    const merged = new Map();

    const addRenderer = (entry) => {
      if (!entry) {
        return;
      }
      const key = rendererKey(entry);
      if (!key) {
        return;
      }
      if (!merged.has(key)) {
        merged.set(key, entry);
      }
    };

    (Array.isArray(items) ? items : []).forEach(addRenderer);
    (Array.isArray(availableRenderers) ? availableRenderers : []).forEach(addRenderer);
    if (selectedRenderer) {
      addRenderer(selectedRenderer);
    }

    availableRenderers = Array.from(merged.values());

    if (selectedRenderer) {
      const selectedKey = rendererKey(selectedRenderer);
      if (selectedKey && merged.has(selectedKey)) {
        selectedRenderer = merged.get(selectedKey);
      }
    }

    if (!selectedRenderer && availableRenderers.length > 0) {
      selectedRenderer = availableRenderers[0];
    }

    return availableRenderers;
  };

  const refreshRendererList = async (timeoutMs = 3500) => {
    const discovered = await discoverRenderers(timeoutMs);
    return mergeRendererLists(discovered);
  };

  const findRendererByKey = (key) => {
    const needle = String(key || '').trim();
    if (!needle) {
      return null;
    }

    return availableRenderers.find((item) => rendererKey(item) === needle) || null;
  };

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
        filePath: item.filePath,
        watchedKey: item.filePath,
        mimeType: item.mimeType,
        size,
      };
    });

  const metadataMap = new Map();

  const enrichItemsWithMetadata = async (items) => {
    const result = [];

    for (const item of items) {
      if (metadataMap.has(item.id)) {
        result.push({
          ...item,
          ...metadataMap.get(item.id),
        });
      } else {
        const category = categoryFromPath(item.filePath);
        const showName = category === CATEGORY_TV_SHOWS || category === CATEGORY_ANIME_SHOWS
          ? extractSeriesName(item.filePath, category)
          : null;
        const seasonInfo = (category === CATEGORY_TV_SHOWS || category === CATEGORY_ANIME_SHOWS)
          ? extractSeasonEpisodeInfo(item.filePath)
          : null;
        const isShowCategory = category === CATEGORY_TV_SHOWS || category === CATEGORY_ANIME_SHOWS;
        const fallbackSeriesTitle = extractSeriesTitleFromEpisodeName(item.name);
        const searchTitle = showName || fallbackSeriesTitle || extractMovieTitle(item.name);
        const displayTitle = showName
          ? safeBasename(path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim())
          : searchTitle;

        const seriesResult = isShowCategory
          ? await fetchSeriesMetadataWithFallback([searchTitle, fallbackSeriesTitle, extractMovieTitle(item.name)])
          : null;
        const metadata = isShowCategory
          ? seriesResult.metadata
          : await fetchMovieMetadata(searchTitle);
        const seriesLookupTitle = isShowCategory ? (seriesResult.matchedTitle || searchTitle) : searchTitle;
        const episodeMetadata = (isShowCategory
          && seasonInfo
          && Number.isFinite(seasonInfo.seasonNumber)
          && Number.isFinite(seasonInfo.episodeNumber))
          ? await fetchEpisodeMetadata(seriesLookupTitle, seasonInfo.seasonNumber, seasonInfo.episodeNumber, displayTitle)
          : null;

        const episodeTitle = (episodeMetadata && episodeMetadata.title) || displayTitle;
        const episodePoster = (episodeMetadata && episodeMetadata.posterUrl) || metadata.posterUrl;
        const episodePlot = (episodeMetadata && episodeMetadata.plot) || metadata.plot;
        const episodeRating = (episodeMetadata && episodeMetadata.imdbRating) || metadata.imdbRating;
        const episodeYear = (episodeMetadata && episodeMetadata.year) || metadata.year;
        const enriched = {
          ...item,
          movieTitle: episodeTitle,
          showName,
          showDisplayTitle: isShowCategory ? (metadata.title || showName) : null,
          showPosterUrl: isShowCategory ? metadata.posterUrl : null,
          showPlot: isShowCategory ? metadata.plot : null,
          showImdbRating: isShowCategory ? metadata.imdbRating : null,
          showYear: isShowCategory ? metadata.year : null,
          seasonLabel: seasonInfo ? seasonInfo.seasonLabel : null,
          seasonNumber: seasonInfo ? seasonInfo.seasonNumber : null,
          episodeNumber: seasonInfo ? seasonInfo.episodeNumber : null,
          seasonSort: seasonInfo ? seasonInfo.seasonSort : null,
          episodeSort: seasonInfo ? seasonInfo.episodeSort : null,
          posterUrl: episodePoster,
          year: episodeYear,
          plot: episodePlot,
          imdbRating: episodeRating,
        };
        metadataMap.set(item.id, {
          movieTitle: episodeTitle,
          showName,
          showDisplayTitle: isShowCategory ? (metadata.title || showName) : null,
          showPosterUrl: isShowCategory ? metadata.posterUrl : null,
          showPlot: isShowCategory ? metadata.plot : null,
          showImdbRating: isShowCategory ? metadata.imdbRating : null,
          showYear: isShowCategory ? metadata.year : null,
          seasonLabel: seasonInfo ? seasonInfo.seasonLabel : null,
          seasonNumber: seasonInfo ? seasonInfo.seasonNumber : null,
          episodeNumber: seasonInfo ? seasonInfo.episodeNumber : null,
          seasonSort: seasonInfo ? seasonInfo.seasonSort : null,
          episodeSort: seasonInfo ? seasonInfo.episodeSort : null,
          posterUrl: episodePoster,
          year: episodeYear,
          plot: episodePlot,
          imdbRating: episodeRating,
        });
        result.push(enriched);
      }
    }

    return result;
  };

  const getCategoryPayload = async (category) => {
    const items = getMovieItems().filter((item) => categoryFromPath(item.filePath) === category);
    const enrichedItems = await enrichItemsWithMetadata(items);

    if (category === CATEGORY_TV_SHOWS || category === CATEGORY_ANIME_SHOWS) {
      const groupsMap = new Map();

      for (const item of enrichedItems) {
        const showKey = item.showName || 'Unknown Show';
        if (!groupsMap.has(showKey)) {
          groupsMap.set(showKey, new Map());
        }

        const seasonKey = item.seasonLabel || 'Season Unknown';
        const seasonsMap = groupsMap.get(showKey);
        if (!seasonsMap.has(seasonKey)) {
          seasonsMap.set(seasonKey, []);
        }
        seasonsMap.get(seasonKey).push(item);
      }

      const groups = Array.from(groupsMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, seasonsMap]) => {
          const seasons = Array.from(seasonsMap.entries())
            .map(([seasonName, itemsInSeason]) => {
              const sortedItems = [...itemsInSeason].sort((a, b) => {
                const seasonA = Number.isFinite(a.seasonSort) ? a.seasonSort : 999;
                const seasonB = Number.isFinite(b.seasonSort) ? b.seasonSort : 999;
                if (seasonA !== seasonB) {
                  return seasonA - seasonB;
                }

                const epA = Number.isFinite(a.episodeSort) ? a.episodeSort : 9999;
                const epB = Number.isFinite(b.episodeSort) ? b.episodeSort : 9999;
                if (epA !== epB) {
                  return epA - epB;
                }

                return (a.movieTitle || '').localeCompare(b.movieTitle || '');
              });

              const first = sortedItems[0] || {};
              return {
                name: seasonName,
                seasonSort: Number.isFinite(first.seasonSort) ? first.seasonSort : 999,
                items: sortedItems,
              };
            })
            .sort((a, b) => a.seasonSort - b.seasonSort || a.name.localeCompare(b.name));

          const firstWithPoster = enrichedItems.find((item) => (item.showName || 'Unknown Show') === name)
            || {};

          return {
            name,
            displayTitle: (firstWithPoster.showDisplayTitle || firstWithPoster.showName || name),
            posterUrl: firstWithPoster.showPosterUrl || firstWithPoster.posterUrl || null,
            year: firstWithPoster.showYear || firstWithPoster.year || null,
            plot: firstWithPoster.showPlot || firstWithPoster.plot || null,
            imdbRating: firstWithPoster.showImdbRating || firstWithPoster.imdbRating || null,
            seasons,
            items: [],
          };
        });

      return { items: [], groups };
    }

    return { items: enrichedItems, groups: [] };
  };

  async function handleRequest(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && parsed.pathname === '/') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(buildPageHtml(safeBasename((selectedRenderer && selectedRenderer.friendlyName) || 'Unknown Renderer')));
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/renderers') {
      try {
        if (parsed.searchParams.get('refresh') === '1' || availableRenderers.length === 0) {
          await refreshRendererList();
        }

        const selectedKey = rendererKey(selectedRenderer);
        sendJson(res, 200, {
          ok: true,
          selectedKey,
          renderers: availableRenderers.map(toRendererSummary),
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/renderers/select') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const key = String(payload.key || '').trim();

        let selected = findRendererByKey(key);
        if (!selected) {
          await refreshRendererList();
          selected = findRendererByKey(key);
        }

        if (!selected) {
          sendJson(res, 404, {
            ok: false,
            error: 'Renderer not found.',
          });
          return;
        }

        selectedRenderer = selected;
        sendJson(res, 200, {
          ok: true,
          selectedKey: rendererKey(selectedRenderer),
          renderer: toRendererSummary(selectedRenderer),
          renderers: availableRenderers.map(toRendererSummary),
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/library') {
      try {
        if (parsed.searchParams.get('refresh') === '1') {
          await mediaServer.buildLibrary();
          metadataMap.clear();
        }
        const category = String(parsed.searchParams.get('category') || CATEGORY_MOVIES);
        const noFolders = mediaServer.getRootDirs().length === 0;
        const payload = noFolders
          ? { items: [], groups: [] }
          : await getCategoryPayload(category);
        sendJson(res, 200, {
          ok: true,
          noFolders,
          category,
          items: payload.items,
          groups: payload.groups,
          watchedKeys: Array.from(watchedMediaKeys),
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

        if (!selectedRenderer) {
          sendJson(res, 503, { ok: false, error: 'No renderer selected.' });
          return;
        }

        const result = await castMediaItem(selectedRenderer, mediaServer, media);
        sendJson(res, 200, {
          ok: true,
          media: {
            id: media.id,
            name: media.name,
          },
          rendererName: selectedRenderer.friendlyName || 'Unknown Renderer',
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
        if (!selectedRenderer) {
          sendJson(res, 503, {
            ok: false,
            error: 'No renderer selected.',
          });
          return;
        }

        await stop(selectedRenderer);
        sendJson(res, 200, {
          ok: true,
          rendererName: selectedRenderer.friendlyName || 'Unknown Renderer',
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/watched') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const key = String(payload.key || '').trim();
        const watched = Boolean(payload.watched);

        if (!key) {
          sendJson(res, 400, {
            ok: false,
            error: 'Missing watched media key.',
          });
          return;
        }

        if (watched) {
          watchedMediaKeys.add(key);
        } else {
          watchedMediaKeys.delete(key);
        }

        if (typeof onWatchedKeysChanged === 'function') {
          onWatchedKeysChanged(Array.from(watchedMediaKeys));
        }

        sendJson(res, 200, {
          ok: true,
          key,
          watched: watchedMediaKeys.has(key),
          watchedKeys: Array.from(watchedMediaKeys),
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
