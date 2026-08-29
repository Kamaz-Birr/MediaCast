import http from 'http';
import fs from 'fs';
import path from 'path';
import { buildDidlLite } from '../dlna/metadata.js';
import {
  setAvTransportUri,
  setNextAvTransportUri,
  play,
  stop,
  seek,
  getTransportInfo,
  getPositionInfo,
  getMediaInfo,
} from '../upnp/soap.js';
import { discoverRenderers } from '../upnp/discovery.js';
import {
  fetchMovieMetadata,
  fetchSeriesMetadata,
  fetchEpisodeMetadata,
  extractMovieTitle,
} from './metadataFetcher.js';

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

  console.log(`[Categorization] Checking if media is a movie: ${media.filePath}`);

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
const CATEGORY_KIND_MOVIES = 'movies';
const CATEGORY_KIND_SHOWS = 'shows';
const CATEGORY_AUTO = 'auto';

// Categories that ship with the app. Custom ones are appended at runtime.
const BUILT_IN_CATEGORIES = [
  { id: CATEGORY_MOVIES, label: 'Movies', kind: CATEGORY_KIND_MOVIES, builtIn: true },
  { id: CATEGORY_TV_SHOWS, label: 'TV Shows', kind: CATEGORY_KIND_SHOWS, builtIn: true },
  { id: CATEGORY_ANIME_MOVIES, label: 'Anime Movies', kind: CATEGORY_KIND_MOVIES, builtIn: true },
  { id: CATEGORY_ANIME_SHOWS, label: 'Anime Shows', kind: CATEGORY_KIND_SHOWS, builtIn: true },
];

function slugifyCategoryLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function normalizeFolderKey(value) {
  const resolved = path.resolve(String(value || ''));
  const unified = resolved.split('\\').join('/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

const AUTO_NEXT_MIN_CREDITS_WATCH_SEC = 5;
const WATCHED_COMPLETION_PROGRESS = 0.99;

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
      ratingSource: null,
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
      --bg: #070b14;
      --surface: rgba(18, 26, 44, 0.72);
      --glass: rgba(255, 255, 255, 0.045);
      --glass-hi: rgba(255, 255, 255, 0.085);
      --text: #f4f7fc;
      --muted: #8d9db8;
      --faint: #5b6b85;
      --accent: #fb923c;
      --accent-strong: #f97316;
      --brand-a: #60a5fa;
      --brand-b: #a78bfa;
      --success: #22c55e;
      --warn: #facc15;
      --danger: #f87171;
      --stroke: rgba(255, 255, 255, 0.08);
      --stroke-hi: rgba(255, 255, 255, 0.16);
      --shadow-md: 0 12px 30px rgba(0, 0, 0, 0.42);
      --shadow-lg: 0 26px 60px rgba(0, 0, 0, 0.55);
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
      --ease-soft: cubic-bezier(0.4, 0, 0.2, 1);
      --radius: 16px;
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      min-height: 100vh;
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Raleway', system-ui, -apple-system, Segoe UI, sans-serif;
      -webkit-font-smoothing: antialiased;
      padding: 0 clamp(14px, 3vw, 34px) 60px;
      position: relative;
      overflow-x: hidden;
    }

    /* Slow-drifting aurora field behind everything. */
    body::before {
      content: '';
      position: fixed;
      inset: -25vmax;
      z-index: -2;
      background:
        radial-gradient(38vmax 38vmax at 12% 14%, rgba(59, 130, 246, 0.16), transparent 62%),
        radial-gradient(34vmax 34vmax at 88% 82%, rgba(249, 115, 22, 0.13), transparent 60%),
        radial-gradient(30vmax 30vmax at 70% 10%, rgba(167, 139, 250, 0.11), transparent 62%);
      animation: aurora-drift 34s var(--ease-soft) infinite alternate;
      will-change: transform;
    }

    body::after {
      content: '';
      position: fixed;
      inset: 0;
      z-index: -3;
      background: linear-gradient(165deg, #070b14 0%, #0c1322 52%, #0a1120 100%);
    }

    @keyframes aurora-drift {
      from { transform: translate3d(-2%, -1%, 0) scale(1); }
      to   { transform: translate3d(3%, 2%, 0) scale(1.08); }
    }

    .app {
      max-width: 1680px;
      margin: 0 auto;
    }

    /* ---------- Header ---------- */

    .topbar {
      position: sticky;
      top: 0;
      z-index: 60;
      display: flex;
      gap: 18px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      margin: 0 calc(clamp(14px, 3vw, 34px) * -1) 20px;
      padding: 20px clamp(14px, 3vw, 34px) 18px;
      background: linear-gradient(180deg, rgba(7, 11, 20, 0.92), rgba(7, 11, 20, 0.66));
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border-bottom: 1px solid transparent;
      transition: padding 320ms var(--ease), border-color 320ms var(--ease), box-shadow 320ms var(--ease);
    }

    body.scrolled .topbar {
      padding-top: 11px;
      padding-bottom: 11px;
      border-bottom-color: var(--stroke);
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
    }

    .brand {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .brand h1 {
      margin: 0;
      font-size: clamp(1.6rem, 2.4vw, 2.3rem);
      letter-spacing: -0.02em;
      font-weight: 900;
      line-height: 1;
      background: linear-gradient(100deg, var(--brand-a), var(--brand-b) 55%, var(--accent));
      background-size: 220% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      animation: brand-sheen 9s var(--ease-soft) infinite alternate;
      transition: font-size 320ms var(--ease);
    }

    body.scrolled .brand h1 { font-size: clamp(1.3rem, 1.8vw, 1.7rem); }

    @keyframes brand-sheen {
      from { background-position: 0% 50%; }
      to   { background-position: 100% 50%; }
    }

    .subtitle {
      color: var(--muted);
      font-size: 0.86rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .subtitle strong { color: #cfe0f8; font-weight: 800; }

    /* Live dot next to the renderer name. */
    .subtitle::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--success);
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
      animation: live-pulse 2.4s var(--ease-soft) infinite;
      flex: none;
    }

    @keyframes live-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
      70%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
      100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }

    .controls {
      display: flex;
      gap: 9px;
      flex-wrap: wrap;
      align-items: center;
    }

    /* ---------- Buttons ---------- */

    .neu-btn {
      position: relative;
      background: var(--glass);
      border: 1px solid var(--stroke);
      color: var(--accent);
      border-radius: 12px;
      font-family: inherit;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-size: 0.7rem;
      cursor: pointer;
      padding: 11px 16px;
      min-height: 42px;
      backdrop-filter: blur(10px);
      overflow: hidden;
      transition:
        transform 200ms var(--ease),
        background 200ms var(--ease-soft),
        border-color 200ms var(--ease-soft),
        color 200ms var(--ease-soft),
        box-shadow 200ms var(--ease);
    }

    /* Sheen that sweeps across on hover. */
    .neu-btn::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.16) 50%, transparent 70%);
      transform: translateX(-120%);
      transition: transform 620ms var(--ease);
      pointer-events: none;
    }

    .neu-btn:hover::after { transform: translateX(120%); }

    .neu-btn:hover {
      color: #ffd9b3;
      background: var(--glass-hi);
      border-color: rgba(251, 146, 60, 0.5);
      transform: translateY(-2px);
      box-shadow: 0 10px 24px rgba(249, 115, 22, 0.18);
    }

    .neu-btn:active { transform: translateY(0) scale(0.97); }

    .neu-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.45);
    }

    .neu-btn:disabled {
      opacity: 0.55;
      cursor: progress;
      transform: none;
    }

    .neu-btn.secondary { color: #9dc4fb; }
    .neu-btn.secondary:hover {
      color: #d5e7ff;
      border-color: rgba(96, 165, 250, 0.5);
      box-shadow: 0 10px 24px rgba(59, 130, 246, 0.18);
    }

    .neu-btn.danger { color: #fca5a5; }
    .neu-btn.danger:hover {
      color: #fecaca;
      border-color: rgba(248, 113, 113, 0.55);
      box-shadow: 0 10px 24px rgba(239, 68, 68, 0.2);
    }

    .neu-btn.resume {
      color: #fde68a;
      border-color: rgba(250, 204, 21, 0.5);
      background: rgba(250, 204, 21, 0.12);
    }

    .neu-btn.resume:hover {
      color: #fef9c3;
      background: rgba(250, 204, 21, 0.2);
      border-color: rgba(250, 204, 21, 0.8);
      box-shadow: 0 10px 24px rgba(250, 204, 21, 0.2);
    }

    .neu-btn.watched, .neu-btn.secondary.watched {
      background: rgba(34, 197, 94, 0.18);
      color: #bbf7d0;
      border-color: rgba(34, 197, 94, 0.6);
    }

    .neu-btn.watched:hover {
      background: rgba(34, 197, 94, 0.28);
      color: #dcfce7;
      box-shadow: 0 10px 24px rgba(34, 197, 94, 0.2);
    }

    .button-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    /* ---------- Renderer dropdown + sort ---------- */

    .renderer-dropdown {
      position: relative;
      min-width: 230px;
      display: inline-block;
    }

    .renderer-dropdown-btn,
    .sort-select {
      min-height: 42px;
      width: 100%;
      background: var(--glass);
      color: var(--text);
      border-radius: 12px;
      border: 1px solid var(--stroke);
      padding: 10px 14px;
      font-family: inherit;
      font-weight: 700;
      font-size: 0.8rem;
      letter-spacing: 0.02em;
      backdrop-filter: blur(10px);
      outline: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      transition: border-color 200ms var(--ease-soft), box-shadow 200ms var(--ease-soft), background 200ms var(--ease-soft);
    }

    .renderer-dropdown-btn:hover,
    .sort-select:hover { background: var(--glass-hi); border-color: var(--stroke-hi); }

    .renderer-dropdown-btn span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sort-select {
      width: auto;
      min-width: 190px;
      display: inline-flex;
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 20px) calc(50% - 2px),
        calc(100% - 14px) calc(50% - 2px);
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
      padding-right: 36px;
    }

    .sort-select option { background: #131c2f; color: var(--text); }

    .renderer-dropdown-btn[aria-expanded="true"],
    .sort-select:focus-visible {
      border-color: rgba(96, 165, 250, 0.8);
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.22);
    }

    .dropdown-arrow {
      font-size: 0.7em;
      color: var(--muted);
      transition: transform 320ms var(--ease);
      flex: none;
    }

    .renderer-dropdown-btn[aria-expanded="true"] .dropdown-arrow { transform: rotate(-180deg); }

    .renderer-dropdown-menu {
      position: absolute;
      left: 0;
      right: 0;
      top: calc(100% + 8px);
      background: rgba(16, 23, 39, 0.97);
      border-radius: 14px;
      border: 1px solid var(--stroke-hi);
      box-shadow: var(--shadow-lg);
      backdrop-filter: blur(20px);
      margin: 0;
      padding: 6px;
      list-style: none;
      z-index: 100;
      opacity: 0;
      transform: translateY(-8px) scale(0.98);
      transform-origin: top center;
      pointer-events: none;
      transition: opacity 260ms var(--ease), transform 260ms var(--ease);
      max-height: 340px;
      overflow-y: auto;
    }

    .renderer-dropdown-menu.open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }

    .renderer-dropdown-menu li {
      padding: 11px 14px;
      border-radius: 9px;
      color: var(--text);
      font-weight: 600;
      font-size: 0.86rem;
      cursor: pointer;
      transition: background 160ms var(--ease-soft), color 160ms var(--ease-soft), transform 160ms var(--ease);
      display: flex;
      align-items: center;
      opacity: 0;
      transform: translateX(-8px);
    }

    .renderer-dropdown-menu.open li {
      animation: dropdown-item-in 340ms var(--ease) forwards;
      animation-delay: calc(var(--item-index, 0) * 34ms);
    }

    @keyframes dropdown-item-in {
      from { opacity: 0; transform: translateX(-10px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    .renderer-dropdown-menu li.selected {
      background: rgba(96, 165, 250, 0.16);
      color: #cfe4ff;
    }

    .renderer-dropdown-menu li:hover {
      background: rgba(251, 146, 60, 0.16);
      color: #ffd9b3;
      transform: translateX(2px);
    }

    /* ---------- Category tabs ---------- */

    .categories {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .category-btn {
      position: relative;
      isolation: isolate;
      border: 1px solid var(--stroke);
      border-radius: 999px;
      background: var(--glass);
      color: var(--muted);
      padding: 9px 18px;
      font-family: inherit;
      font-size: 0.74rem;
      font-weight: 800;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      cursor: pointer;
      overflow: hidden;
      transition: color 220ms var(--ease-soft), border-color 220ms var(--ease-soft), transform 220ms var(--ease);
    }

    /* Gradient fill grows from the centre when the tab becomes active. */
    .category-btn::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(100deg, rgba(251, 146, 60, 0.26), rgba(167, 139, 250, 0.22));
      transform: scaleX(0);
      transform-origin: center;
      transition: transform 360ms var(--ease);
      z-index: -1;
    }

    .category-btn.active::before { transform: scaleX(1); }

    .category-btn.active {
      color: #ffdcbc;
      border-color: rgba(251, 146, 60, 0.7);
    }

    .category-btn:hover {
      color: var(--text);
      border-color: var(--stroke-hi);
      transform: translateY(-2px);
    }

    .category-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.4);
    }

    /* ---------- Modal ---------- */

    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(3, 6, 12, 0.72);
      backdrop-filter: blur(6px);
      animation: fade-in 200ms var(--ease-soft);
    }

    .modal-backdrop[hidden] { display: none; }

    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .modal {
      width: min(560px, 100%);
      max-height: min(86vh, 760px);
      overflow-y: auto;
      background: linear-gradient(155deg, rgba(24, 33, 54, 0.98), rgba(14, 20, 34, 0.98));
      border: 1px solid var(--stroke-hi);
      border-radius: 20px;
      box-shadow: var(--shadow-lg);
      padding: 26px;
      animation: modal-in 320ms var(--ease);
    }

    @keyframes modal-in {
      from { opacity: 0; transform: translateY(18px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .modal-title {
      margin: 0 0 6px;
      font-size: 1.35rem;
      font-weight: 900;
      letter-spacing: -0.02em;
      color: var(--text);
    }

    .modal-sub {
      margin: 0 0 20px;
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.55;
    }

    .category-choices {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 9px;
      margin-bottom: 16px;
    }

    .category-choice {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 3px;
      text-align: left;
      padding: 13px 15px;
      border-radius: 12px;
      border: 1px solid var(--stroke);
      background: var(--glass);
      color: var(--text);
      font-family: inherit;
      cursor: pointer;
      transition: border-color 200ms var(--ease-soft), background 200ms var(--ease-soft), transform 200ms var(--ease);
    }

    .category-choice:hover {
      background: var(--glass-hi);
      border-color: var(--stroke-hi);
      transform: translateY(-2px);
    }

    .category-choice.selected {
      border-color: rgba(251, 146, 60, 0.8);
      background: rgba(251, 146, 60, 0.14);
      box-shadow: 0 0 0 1px rgba(251, 146, 60, 0.3);
    }

    .category-choice:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.45);
    }

    .category-choice .name {
      font-weight: 800;
      font-size: 0.92rem;
    }

    .category-choice .hint {
      color: var(--muted);
      font-size: 0.74rem;
      font-weight: 600;
    }

    .category-choice.is-new {
      border-style: dashed;
      color: #9dc4fb;
    }

    .category-choice.is-new .name::before { content: '+ '; }

    .new-category {
      border-top: 1px solid var(--stroke);
      padding-top: 16px;
      margin-bottom: 18px;
      animation: section-in 300ms var(--ease);
    }

    .new-category[hidden] { display: none; }

    .field-label {
      display: block;
      margin-bottom: 7px;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .text-input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 11px;
      border: 1px solid var(--stroke);
      background: rgba(6, 11, 22, 0.6);
      color: var(--text);
      font-family: inherit;
      font-size: 0.92rem;
      font-weight: 600;
      outline: none;
      transition: border-color 200ms var(--ease-soft), box-shadow 200ms var(--ease-soft);
    }

    .text-input::placeholder { color: var(--faint); }

    .text-input:focus {
      border-color: rgba(96, 165, 250, 0.8);
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.2);
    }

    .kind-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 9px;
      margin-top: 12px;
    }

    .kind-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 11px;
      border: 1px solid var(--stroke);
      background: var(--glass);
      cursor: pointer;
      transition: border-color 200ms var(--ease-soft), background 200ms var(--ease-soft);
    }

    .kind-option:hover { background: var(--glass-hi); }

    .kind-option input { margin-top: 3px; accent-color: var(--accent); flex: none; }

    .kind-option .name { display: block; font-weight: 800; font-size: 0.85rem; }
    .kind-option .hint { display: block; color: var(--muted); font-size: 0.73rem; font-weight: 600; margin-top: 2px; }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 9px;
      flex-wrap: wrap;
    }

    /* ---------- Status bar ---------- */

    .status {
      position: relative;
      background: var(--surface);
      border: 1px solid var(--stroke);
      border-left: 3px solid var(--brand-a);
      border-radius: 12px;
      padding: 13px 16px;
      color: #dbe6f6;
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 22px;
      backdrop-filter: blur(14px);
      min-height: 50px;
      display: flex;
      align-items: center;
      overflow: hidden;
      transition: border-color 260ms var(--ease-soft), color 260ms var(--ease-soft), background 260ms var(--ease-soft);
    }

    .status.is-busy::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(100deg, transparent 20%, rgba(96, 165, 250, 0.14) 50%, transparent 80%);
      transform: translateX(-100%);
      animation: status-sweep 1.5s var(--ease-soft) infinite;
    }

    @keyframes status-sweep {
      to { transform: translateX(100%); }
    }

    .status.is-error {
      border-left-color: var(--danger);
      color: #fecaca;
      background: rgba(69, 26, 26, 0.5);
    }

    .status.is-playing { border-left-color: var(--accent); color: #ffe2c7; }

    /* ---------- Grid ---------- */

    .grid, .group-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
      gap: clamp(14px, 1.6vw, 22px);
      align-items: start;
    }

    .group-grid { width: 100%; }

    /* ---------- Cards ---------- */

    .movie-card {
      position: relative;
      width: 100%;
      aspect-ratio: 2 / 3;
      background: linear-gradient(150deg, #17203a, #0d1526);
      border: 1px solid var(--stroke);
      border-radius: var(--radius);
      cursor: pointer;
      overflow: hidden;
      box-shadow: var(--shadow-md);
      transform: translateZ(0);
      transition:
        transform 420ms var(--ease),
        box-shadow 420ms var(--ease),
        border-color 420ms var(--ease),
        filter 420ms var(--ease-soft),
        opacity 420ms var(--ease-soft);
      animation: card-in 520ms var(--ease) backwards;
      animation-delay: calc(var(--i, 0) * 42ms);
    }

    /* Episode stills are 16:9, so give those cards a matching frame. */
    .movie-card.is-episode { aspect-ratio: 16 / 10; }

    @keyframes card-in {
      from { opacity: 0; transform: translateY(18px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .movie-card:hover {
      transform: translateY(-8px);
      border-color: rgba(251, 146, 60, 0.45);
      box-shadow: var(--shadow-lg), 0 0 0 1px rgba(251, 146, 60, 0.18);
      z-index: 5;
    }

    .movie-card:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.55);
    }

    .movie-card img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 700ms var(--ease), opacity 460ms var(--ease-soft);
    }

    .movie-card:hover img { transform: scale(1.07); }

    /* Poster fades in once loaded; a shimmer holds the space until then. */
    .movie-card.img-pending img { opacity: 0; }

    .movie-card.img-pending::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 1;
      background:
        linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.07) 45%, transparent 70%),
        linear-gradient(150deg, #17203a, #0d1526);
      background-size: 220% 100%, 100% 100%;
      animation: shimmer 1.5s var(--ease-soft) infinite;
    }

    @keyframes shimmer {
      from { background-position: 120% 0, 0 0; }
      to   { background-position: -120% 0, 0 0; }
    }

    .placeholder {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #3c4a63;
      background: linear-gradient(150deg, #17203a, #0d1526);
      font-size: 54px;
    }

    /* Overlay: title always readable, details reveal on hover. */
    .movie-overlay {
      position: absolute;
      inset: 0;
      z-index: 6;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      gap: 6px;
      padding: 16px 15px 15px;
      text-align: left;
      background: linear-gradient(
        to top,
        rgba(4, 8, 16, 0.96) 0%,
        rgba(4, 8, 16, 0.82) 26%,
        rgba(4, 8, 16, 0.25) 55%,
        transparent 78%
      );
      transition: background 420ms var(--ease-soft);
    }

    .movie-card:hover .movie-overlay {
      background: linear-gradient(
        to top,
        rgba(4, 8, 16, 0.97) 0%,
        rgba(4, 8, 16, 0.93) 42%,
        rgba(5, 10, 20, 0.72) 72%,
        rgba(5, 10, 20, 0.38) 100%
      );
    }

    .movie-title {
      margin: 0;
      color: #fff;
      font-size: 0.98rem;
      font-weight: 800;
      line-height: 1.25;
      letter-spacing: -0.01em;
      text-shadow: 0 2px 12px rgba(0, 0, 0, 0.7);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .movie-meta {
      color: #9dc4fb;
      font-size: 0.73rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
    }

    /* Plot + buttons stay collapsed until hover. */
    .movie-plot, .movie-overlay .button-row, .movie-overlay > .neu-btn {
      opacity: 0;
      transform: translateY(10px);
      max-height: 0;
      overflow: hidden;
      margin-top: 0;
      transition:
        opacity 320ms var(--ease-soft),
        transform 380ms var(--ease),
        max-height 420ms var(--ease),
        margin-top 420ms var(--ease);
    }

    .movie-plot {
      color: #c9d6ea;
      font-size: 0.78rem;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      margin: 0;
    }

    .movie-card:hover .movie-plot {
      opacity: 1;
      transform: translateY(0);
      max-height: 6.4em;
      margin-top: 4px;
      transition-delay: 60ms;
    }

    .movie-card:hover .movie-overlay .button-row,
    .movie-card:hover .movie-overlay > .neu-btn {
      opacity: 1;
      transform: translateY(0);
      max-height: 60px;
      margin-top: 10px;
      transition-delay: 110ms;
    }

    .movie-overlay .neu-btn {
      flex: 1 1 0;
      min-width: 0;
      padding: 9px 8px;
      min-height: 36px;
      font-size: 0.65rem;
      letter-spacing: 0.03em;
      line-height: 1.2;
      overflow: hidden;
    }

    /* ---------- Card badges ---------- */

    .movie-card.watched-media { filter: grayscale(0.9); opacity: 0.72; }
    .movie-card.watched-media:hover { filter: grayscale(0.25); opacity: 1; }

    .watched-check {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: var(--success);
      color: #04140a;
      display: grid;
      place-items: center;
      font-size: 15px;
      font-weight: 900;
      z-index: 9;
      border: 2px solid rgba(255, 255, 255, 0.85);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      pointer-events: none;
      animation: badge-pop 420ms var(--ease) backwards;
    }

    @keyframes badge-pop {
      from { opacity: 0; transform: scale(0.4) rotate(-25deg); }
      to   { opacity: 1; transform: scale(1) rotate(0); }
    }

    .resume-tag {
      position: absolute;
      top: 10px;
      left: 10px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      z-index: 9;
      padding: 5px 10px 5px 7px;
      border-radius: 999px;
      background: rgba(6, 11, 22, 0.82);
      border: 1px solid rgba(250, 204, 21, 0.45);
      backdrop-filter: blur(8px);
      pointer-events: none;
      max-width: calc(100% - 20px);
      animation: badge-pop 420ms var(--ease) backwards;
    }

    .resume-tag .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--warn);
      box-shadow: 0 0 10px rgba(250, 204, 21, 0.8);
      flex: none;
    }

    .resume-tag .label {
      color: #fde68a;
      font-size: 0.66rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Currently casting: accent ring + pulsing dot. */
    .movie-card.now-playing {
      border-color: rgba(251, 146, 60, 0.75);
      box-shadow: var(--shadow-md), 0 0 0 2px rgba(251, 146, 60, 0.35);
    }

    .movie-card.now-playing .resume-tag {
      border-color: rgba(251, 146, 60, 0.6);
    }

    .movie-card.now-playing .resume-tag .dot {
      background: var(--accent);
      box-shadow: 0 0 10px rgba(251, 146, 60, 0.9);
      animation: eq-pulse 1.1s var(--ease-soft) infinite;
    }

    .movie-card.now-playing .resume-tag .label { color: #ffd9b3; }

    @keyframes eq-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(1.45); opacity: 0.65; }
    }

    /* Watch-progress rail along the bottom edge. */
    .progress-rail {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 4px;
      background: rgba(0, 0, 0, 0.55);
      z-index: 8;
      pointer-events: none;
    }

    .progress-rail .progress-fill {
      display: block;
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, var(--warn), var(--accent));
      box-shadow: 0 0 12px rgba(250, 204, 21, 0.6);
      transition: width 620ms var(--ease);
    }

    .movie-card.now-playing .progress-rail .progress-fill {
      background: linear-gradient(90deg, var(--accent), #fdba74);
    }

    /* ---------- Sections ---------- */

    .group-section {
      width: 100%;
      grid-column: 1 / -1;
      margin-bottom: 30px;
      animation: section-in 480ms var(--ease) backwards;
    }

    .group-title {
      margin: 0 0 16px;
      color: var(--text);
      font-size: clamp(1.3rem, 2vw, 1.75rem);
      font-weight: 900;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .group-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, var(--stroke-hi), transparent);
    }

    .episodes-block {
      width: 100%;
      margin-top: 26px;
      padding-top: 22px;
      border-top: 1px solid var(--stroke);
      animation: section-in 480ms var(--ease) backwards;
    }

    @keyframes section-in {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .episodes-title, .season-title {
      margin: 0 0 14px;
      color: #cbd5e1;
      font-size: 1rem;
      font-weight: 800;
      letter-spacing: 0.02em;
    }

    .season-title { color: #9dc4fb; text-transform: uppercase; font-size: 0.88rem; }

    .season-section { margin: 0 0 24px; }

    /* ---------- Empty state ---------- */

    .empty {
      grid-column: 1 / -1;
      margin: 90px auto;
      max-width: 520px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      animation: section-in 520ms var(--ease) backwards;
    }

    .empty .icon {
      width: 78px;
      height: 78px;
      display: grid;
      place-items: center;
      border-radius: 999px;
      background: var(--glass);
      border: 1px solid var(--stroke);
      font-size: 30px;
      font-weight: 900;
      color: var(--faint);
      animation: float-soft 4.5s var(--ease-soft) infinite alternate;
    }

    @keyframes float-soft {
      from { transform: translateY(-5px); }
      to   { transform: translateY(5px); }
    }

    .empty .main { font-size: 1.5rem; font-weight: 800; color: #b6c4da; }
    .empty .sub { font-size: 0.92rem; color: var(--faint); line-height: 1.6; }

    /* ---------- Scrollbar ---------- */

    ::-webkit-scrollbar { width: 11px; height: 11px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      border: 3px solid transparent;
      background-clip: content-box;
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.22); background-clip: content-box; }

    /* ---------- Responsive ---------- */

    @media (max-width: 920px) {
      .topbar { align-items: flex-start; gap: 12px; }
      .controls { width: 100%; }
      .renderer-dropdown { min-width: 100%; }
      .sort-select { flex: 1 1 160px; min-width: 0; }
      .neu-btn { flex: 1 1 140px; }
      .grid, .group-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      .movie-title { font-size: 0.86rem; }
      .movie-plot { display: none; }
      .movie-overlay { padding: 12px 11px 11px; }
      .movie-overlay .button-row { gap: 6px; }
      .movie-overlay .neu-btn {
        font-size: 0.56rem;
        padding: 8px 4px;
        letter-spacing: 0.01em;
      }
    }

    /* Touch devices have no hover, so keep the actions visible. */
    @media (hover: none) {
      .movie-overlay .button-row, .movie-overlay > .neu-btn {
        opacity: 1;
        transform: none;
        max-height: 60px;
        margin-top: 8px;
      }
    }

    /* ---------- Reduced motion ---------- */

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
      }
      .movie-card, .movie-card:hover { transform: none; }
      .movie-card:hover img { transform: none; }
      .renderer-dropdown-menu li { opacity: 1; transform: none; }
      .movie-card.img-pending img { opacity: 1; }
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
        <select id="sortSelect" class="sort-select" aria-label="Sort media">
          <option value="alpha" selected>Sort: Alphabetical</option>
          <option value="recent">Sort: Recently Added</option>
        </select>
        <button class="neu-btn" id="addFolderBtn">Add Media Folder</button>
        <button class="neu-btn secondary" id="backBtn" style="display:none">Back</button>
        <button class="neu-btn danger" id="stopBtn">Stop Cast</button>
      </div>
    </header>

    <div class="categories" id="categoryTabs"></div>

    <div class="status" id="statusBox">Loading media library...</div>
    <section id="grid" class="grid"></section>
  </div>

  <div class="modal-backdrop" id="folderModal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="folderModalTitle">
      <h2 class="modal-title" id="folderModalTitle">Add media folder</h2>
      <p class="modal-sub">Pick the category this folder belongs to. Everything inside it will be filed there.</p>

      <div class="category-choices" id="categoryChoices"></div>

      <div class="new-category" id="newCategoryForm" hidden>
        <label class="field-label" for="newCategoryName">Category name</label>
        <input class="text-input" id="newCategoryName" type="text" maxlength="60" placeholder="Documentaries, Concerts, Kids..." autocomplete="off" />
        <div class="kind-row">
          <label class="kind-option">
            <input type="radio" name="newCategoryKind" value="movies" checked />
            <span>
              <span class="name">Flat list</span>
              <span class="hint">One card per file, like Movies</span>
            </span>
          </label>
          <label class="kind-option">
            <input type="radio" name="newCategoryKind" value="shows" />
            <span>
              <span class="name">Grouped by show</span>
              <span class="hint">Series, seasons and episodes</span>
            </span>
          </label>
        </div>
      </div>

      <div class="modal-actions">
        <button class="neu-btn secondary" id="folderModalCancel">Cancel</button>
        <button class="neu-btn" id="folderModalConfirm">Choose Folder</button>
      </div>
    </div>
  </div>

  <script>
    const CATEGORY_LABELS = {
      'movies': 'Movies',
      'tv-shows': 'TV Shows',
      'anime-movies': 'Anime Movies',
      'anime-shows': 'Anime Shows',
    };
    const CATEGORY_KINDS = {
      'movies': 'movies',
      'tv-shows': 'shows',
      'anime-movies': 'movies',
      'anime-shows': 'shows',
    };
    let availableCategories = [
      { id: 'movies', label: 'Movies', kind: 'movies', builtIn: true },
      { id: 'tv-shows', label: 'TV Shows', kind: 'shows', builtIn: true },
      { id: 'anime-movies', label: 'Anime Movies', kind: 'movies', builtIn: true },
      { id: 'anime-shows', label: 'Anime Shows', kind: 'shows', builtIn: true },
    ];
    let pendingFolderCategory = 'auto';
    const WATCHED_PROGRESS_THRESHOLD = ${WATCHED_COMPLETION_PROGRESS};

    let currentCategory = 'movies';
    let currentSort = 'alpha';
    let currentGroupedData = [];
    let selectedShowName = null;
    let expandedSeasonName = null;
    let currentRendererName = '${rendererName}';
    let lastSeenAutoAdvanceAt = '';
    let activeSessions = [];
    const watchedItemIds = new Set();
    const resumeByKey = new Map();
    const statusBox = document.getElementById('statusBox');
    const grid = document.getElementById('grid');
    // Track active playback state in frontend
    let activePlayback = {
      mediaId: null,
      resumeKey: null,
      rendererName: null,
      positionSec: 0,
      durationSec: null,
      timerInterval: null,
      playButtonRef: null,
      lastUpdate: 0,
      lastStoppedSec: 0,
    };
    const categoryTabs = document.getElementById('categoryTabs');
    const targetRendererName = document.getElementById('targetRendererName');
    const rendererDropdownBtn = document.getElementById('rendererDropdownBtn');
    const rendererDropdownMenu = document.getElementById('rendererDropdownMenu');
    const rendererDropdownLabel = document.getElementById('rendererDropdownLabel');
    const refreshRenderersBtn = document.getElementById('refreshRenderersBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const sortSelect = document.getElementById('sortSelect');
    const addFolderBtn = document.getElementById('addFolderBtn');
    const backBtn = document.getElementById('backBtn');
    const stopBtn = document.getElementById('stopBtn');
    const folderModal = document.getElementById('folderModal');
    const categoryChoices = document.getElementById('categoryChoices');
    const newCategoryForm = document.getElementById('newCategoryForm');
    const newCategoryName = document.getElementById('newCategoryName');
    const folderModalCancel = document.getElementById('folderModalCancel');
    const folderModalConfirm = document.getElementById('folderModalConfirm');
    let isLibraryLoading = false;
    let lastMetadataVersion = 0;

    // Give each card an index so CSS can stagger its entrance animation.
    function applyStagger(root) {
      if (!root) {
        return;
      }
      const cards = root.querySelectorAll('.movie-card');
      for (let index = 0; index < cards.length; index += 1) {
        cards[index].style.setProperty('--i', String(Math.min(index, 22)));
      }
    }

    // Poster swaps in only once it has loaded, so the shimmer covers the gap.
    function attachPosterLoader(card, img) {
      card.classList.add('img-pending');
      const reveal = () => card.classList.remove('img-pending');
      img.addEventListener('load', reveal);
      if (img.complete && img.naturalWidth > 0) {
        reveal();
      }
    }

    function isShowCategory(category) {
      const kind = CATEGORY_KINDS[category];
      if (kind) {
        return kind === 'shows';
      }
      return category === 'tv-shows' || category === 'anime-shows';
    }

    // The category list is owned by the server; the tabs mirror whatever it sends.
    function applyCategories(list) {
      if (!Array.isArray(list) || list.length === 0) {
        return;
      }

      availableCategories = list;
      for (const key of Object.keys(CATEGORY_LABELS)) {
        delete CATEGORY_LABELS[key];
      }
      for (const key of Object.keys(CATEGORY_KINDS)) {
        delete CATEGORY_KINDS[key];
      }
      for (const item of list) {
        CATEGORY_LABELS[item.id] = item.label;
        CATEGORY_KINDS[item.id] = item.kind;
      }

      if (!CATEGORY_LABELS[currentCategory]) {
        currentCategory = list[0].id;
      }

      renderCategoryTabs();
    }

    function renderCategoryTabs() {
      categoryTabs.innerHTML = '';
      for (const item of availableCategories) {
        const button = document.createElement('button');
        button.className = 'category-btn' + (item.id === currentCategory ? ' active' : '');
        button.dataset.category = item.id;
        button.textContent = item.label;
        if (Number.isFinite(Number(item.itemCount))) {
          button.title = item.label + ' - ' + item.itemCount + ' item(s)';
        }
        categoryTabs.appendChild(button);
      }
    }

    function setStatusState(state) {
      statusBox.classList.toggle('is-busy', state === 'busy');
      statusBox.classList.toggle('is-error', state === 'error');
      statusBox.classList.toggle('is-playing', state === 'playing');
    }

    function setStatus(message, isError) {
      const text = String(message || '');
      statusBox.textContent = text;

      // Trailing ellipsis means work in flight, which drives the sweep animation.
      const isBusy = !isError && text.slice(-3) === '...';
      const isPlaying = !isError
        && (text.indexOf('Now playing') === 0 || text.indexOf('Resumed on') === 0);

      if (isError) {
        setStatusState('error');
      } else if (isBusy) {
        setStatusState('busy');
      } else if (isPlaying) {
        setStatusState('playing');
      } else {
        setStatusState('idle');
      }
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

    function formatResumeClock(totalSeconds) {
      const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      if (hours > 0) {
        return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
      }
      return String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
    }

    function clearActivePlaybackTimer() {
      if (activePlayback && activePlayback.timerInterval) {
        clearInterval(activePlayback.timerInterval);
        activePlayback.timerInterval = null;
      }
    }

    function startActivePlaybackTimer() {
      clearActivePlaybackTimer();
      activePlayback.timerInterval = setInterval(() => {
        if (!activePlayback || !activePlayback.mediaId) {
          return;
        }

        activePlayback.positionSec = Math.max(0, Math.floor(Number(activePlayback.positionSec) || 0) + 1);
        activePlayback.lastUpdate = Date.now();

        if (activePlayback.playButtonRef) {
          activePlayback.playButtonRef.textContent = 'Playback ' + formatResumeClock(activePlayback.positionSec);
        }
      }, 1000);
    }

    function resetActivePlaybackState(options = {}) {
      const keepLastStopped = Boolean(options.keepLastStopped);
      const lastStopped = keepLastStopped ? (Number(activePlayback.lastStoppedSec) || 0) : 0;
      clearActivePlaybackTimer();
      activePlayback.mediaId = null;
      activePlayback.resumeKey = null;
      activePlayback.rendererName = null;
      activePlayback.positionSec = 0;
      activePlayback.durationSec = null;
      activePlayback.lastUpdate = 0;
      activePlayback.playButtonRef = null;
      activePlayback.lastStoppedSec = lastStopped;
    }

    function findActiveSessionByMediaId(mediaId) {
      const id = String(mediaId || '').trim();
      if (!id) {
        return null;
      }

      return activeSessions.find((session) => String(session && session.mediaId || '') === id) || null;
    }

    function normalizeClientResumeKey(value) {
      return String(value || '').trim().replace(/\\\\/g, '/').toLowerCase();
    }

    function getResumeInfo(item) {
      const watchedKey = item.watchedKey || item.filePath || item.id;
      const resume = resumeByKey.get(watchedKey);
      if (!resume || watchedItemIds.has(watchedKey)) {
        return null;
      }

      const positionSec = Math.max(0, Math.floor(Number(resume.positionSec) || 0));
      const durationSec = Math.floor(Number(resume.durationSec) || 0);
      const explicitProgress = Number(resume.progress);
      const progress = Number.isFinite(explicitProgress)
        ? explicitProgress
        : (durationSec > 0 ? (positionSec / durationSec) : null);

      if (!positionSec || (Number.isFinite(progress) && progress >= WATCHED_PROGRESS_THRESHOLD)) {
        return null;
      }

      return {
        key: watchedKey,
        positionSec,
        durationSec: durationSec > 0 ? durationSec : null,
        progress: Number.isFinite(progress) ? progress : null,
      };
    }

    function setResumeCardState(card, isResumable) {
      const existingTag = card.querySelector('.resume-tag');
      const watchedKey = card && card.__watchedKey;
      const isWatched = watchedKey ? watchedItemIds.has(watchedKey) : false;
      // Find the item id for this card
      const cardId = card && card.__mediaId;
      const activeSession = findActiveSessionByMediaId(cardId);
      const isCasting = !isWatched && Boolean(activeSession && activeSession.rendererName);
      const isStoppedResume = activePlayback && activePlayback.lastStoppedSec && !isCasting && activePlayback.playButtonRef && activePlayback.playButtonRef.closest('.movie-card') === card;
      const showResumeTag = !isWatched && Boolean(isResumable);

      if (showResumeTag && !existingTag) {
        const tag = document.createElement('div');
        tag.className = 'resume-tag';

        const dot = document.createElement('span');
        dot.className = 'dot';

        const label = document.createElement('span');
        label.className = 'label';
        if (isCasting) {
          label.textContent = 'Playback on ' + activeSession.rendererName;
        } else if (isStoppedResume) {
          label.textContent = 'Resume';
        } else {
          label.textContent = 'Resume';
        }

        tag.appendChild(dot);
        tag.appendChild(label);
        card.appendChild(tag);
      } else if (showResumeTag && existingTag) {
        // Update label if needed
        const label = existingTag.querySelector('.label');
        if (label) {
          if (isCasting) {
            label.textContent = 'Playback on ' + activeSession.rendererName;
          } else if (isStoppedResume) {
            label.textContent = 'Resume';
          } else {
            label.textContent = 'Resume';
          }
        }
      }

      if (!showResumeTag && existingTag) {
        existingTag.remove();
      }

      card.classList.toggle('now-playing', isCasting);
      updateProgressRail(card, isCasting);
    }

    // Thin bar along the card's bottom edge showing how far through it is.
    function updateProgressRail(card, isCasting) {
      const watchedKey = card && card.__watchedKey;
      const resume = watchedKey ? resumeByKey.get(watchedKey) : null;
      const isWatched = watchedKey ? watchedItemIds.has(watchedKey) : false;

      let ratio = 0;
      if (!isWatched && resume) {
        const explicit = Number(resume.progress);
        const position = Number(resume.positionSec);
        const duration = Number(resume.durationSec);
        if (Number.isFinite(explicit) && explicit > 0) {
          ratio = explicit;
        } else if (Number.isFinite(position) && Number.isFinite(duration) && duration > 0) {
          ratio = position / duration;
        }
      }

      const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      let rail = card.querySelector('.progress-rail');

      if (percent <= 0 && !isCasting) {
        if (rail) {
          rail.remove();
        }
        return;
      }

      if (!rail) {
        rail = document.createElement('div');
        rail.className = 'progress-rail';
        const fill = document.createElement('span');
        fill.className = 'progress-fill';
        rail.appendChild(fill);
        card.appendChild(rail);
      }

      const fill = rail.querySelector('.progress-fill');
      if (fill) {
        fill.style.width = percent + '%';
      }
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
      const resumeInfo = getResumeInfo(item);
      let resumeSeconds = resumeInfo ? resumeInfo.positionSec : 0;
      // If lastStoppedSec is set for this item, use it minus 5 seconds (min 0)
      if (activePlayback && activePlayback.lastStoppedSec && activePlayback.playButtonRef === button) {
        resumeSeconds = Math.max(0, activePlayback.lastStoppedSec - 5);
      }
      button.disabled = true;
      setStatus((resumeSeconds > 0 ? 'Resuming ' : 'Casting ') + (item.movieTitle || item.name) + '...');
      try {
        const response = await fetch('/api/cast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, resume: resumeSeconds > 0 }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        if (result.rendererName) {
          setCurrentRendererName(result.rendererName);
        }
        const resumedFromSec = Math.max(0, Math.floor(Number(result.resumedFromSec) || 0));
        // Set active playback state
        activePlayback.mediaId = item.id;
        activePlayback.resumeKey = item.watchedKey || item.filePath || item.id;
        activePlayback.rendererName = result.rendererName || currentRendererName;
        activePlayback.positionSec = resumedFromSec;
        activePlayback.durationSec = resumeInfo && resumeInfo.durationSec ? resumeInfo.durationSec : null;
        activePlayback.lastUpdate = Date.now();
        activePlayback.playButtonRef = button;
        startActivePlaybackTimer();
        if (resumedFromSec > 0) {
          setStatus('Resumed on ' + currentRendererName + ': ' + (item.movieTitle || item.name) + ' at ' + formatResumeClock(resumedFromSec) + '.');
        } else {
          setStatus('Now playing on ' + currentRendererName + ': ' + (item.movieTitle || item.name));
        }
        // Instead of re-rendering the grid, update the badge and play button in place
        // Update resume badge
        const card = button.closest('.movie-card');
        if (card) {
          setResumeCardState(card, true);
        }
        // Play button text is already updated by timer
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
        if (item.seasonNumber !== null && item.seasonNumber !== undefined) {
          card.classList.add('is-episode');
        }
        card.__mediaId = item.id;
        card.__watchedKey = item.watchedKey || item.filePath || item.id;

        if (item.posterUrl) {
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = item.posterUrl;
          img.alt = item.movieTitle || item.name;
          attachPosterLoader(card, img);
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
        if (item.imdbRating) parts.push((item.ratingSource || 'IMDb') + ' ' + item.imdbRating + '/10');
        if (Number.isFinite(item.size)) parts.push(formatSize(item.size));
        meta.textContent = parts.join(' • ');

        const plot = document.createElement('p');
        plot.className = 'movie-plot';
        plot.textContent = item.plot || 'No synopsis available for this title.';

        const playButton = document.createElement('button');
        playButton.className = 'neu-btn';
        playButton.dataset.role = 'play';
        const initialResumeInfo = getResumeInfo(item);
        function updatePlayButtonText() {
            const activeSession = findActiveSessionByMediaId(item.id);
            const isCasting = Boolean(activeSession && activeSession.rendererName);
          if (isCasting) {
              if (activePlayback && activePlayback.mediaId === item.id) {
                playButton.textContent = 'Playback ' + formatResumeClock(activePlayback.positionSec);
              } else {
                playButton.textContent = 'Playback';
              }
            playButton.classList.add('resume');
            // Track the play button for timer updates
              if (activePlayback && activePlayback.mediaId === item.id) {
                activePlayback.playButtonRef = playButton;
              }
          } else if (activePlayback && activePlayback.lastStoppedSec && activePlayback.playButtonRef === playButton) {
            playButton.textContent = 'Resume ' + formatResumeClock(activePlayback.lastStoppedSec);
            playButton.classList.add('resume');
          } else if (initialResumeInfo) {
            playButton.textContent = 'Resume ' + formatResumeClock(initialResumeInfo.positionSec);
            playButton.classList.add('resume');
          } else {
            playButton.textContent = 'Play';
            playButton.classList.remove('resume');
          }
        }
        updatePlayButtonText();
        playButton.addEventListener('click', (event) => {
          event.stopPropagation();
          castItem(item, playButton);
        });

        // Watched button
        const watchedButton = document.createElement('button');
        watchedButton.className = 'neu-btn secondary';
        watchedButton.dataset.role = 'watched';
        watchedButton.textContent = 'Watched';
        watchedButton.addEventListener('click', async (event) => {
          event.stopPropagation();
          const watchedKey = item.watchedKey || item.filePath || item.id;
          const watchedMediaId = String(item.id || '').trim();
          if (!watchedKey) {
            return;
          }

          const isCurrentlyWatched = watchedItemIds.has(watchedKey);
          watchedButton.disabled = true;
          try {
            const response = await fetch('/api/watched', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                key: watchedKey,
                id: watchedMediaId,
                watched: !isCurrentlyWatched,
              }),
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

            // Clear any global last-stopped state to prevent unintended resume.
            activePlayback.lastStoppedSec = 0;

            // Reset local playback memory for this item so next play starts at 00:00.
            if (activePlayback) {
              const isSameItem = activePlayback.resumeKey === watchedKey
                || activePlayback.mediaId === item.id
                || activePlayback.playButtonRef === playButton;

              if (isSameItem) {
                resetActivePlaybackState({ keepLastStopped: false });
              }
            }

            const clearKeys = [
              watchedKey,
              watchedMediaId,
              item.filePath,
            ];
            const normalizedClearKeys = new Set(
              clearKeys.map((key) => normalizeClientResumeKey(key)).filter((key) => key.length > 0),
            );
            for (const existingKey of Array.from(resumeByKey.keys())) {
              const normalizedExisting = normalizeClientResumeKey(existingKey);
              if (normalizedClearKeys.has(normalizedExisting)) {
                resumeByKey.delete(existingKey);
              }
            }
            setResumeCardState(card, false);
            playButton.textContent = 'Play';
            playButton.classList.remove('resume');
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
        // Update resume badge to match play button state
        setResumeCardState(card, Boolean(initialResumeInfo) || Boolean(findActiveSessionByMediaId(item.id)));
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
        img.loading = 'lazy';
        img.src = posterUrl;
        img.alt = group.displayTitle || group.name;
        attachPosterLoader(card, img);
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
        const ratingLabel = group.ratingSource
          || (representative && representative.ratingSource)
          || 'IMDb';
        metaParts.push(ratingLabel + ' ' + (group.imdbRating || representative.imdbRating) + '/10');
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
        img.loading = 'lazy';
        img.src = representative.posterUrl;
        img.alt = season.name;
        attachPosterLoader(card, img);
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

      applyStagger(target);
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

      applyStagger(grid);
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
      applyStagger(section);
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

    async function loadLibrary(forceRefresh = false, options = {}) {
      const silent = Boolean(options && options.silent);
      if (!silent) {
        setStatus(forceRefresh ? 'Refreshing media library...' : 'Loading media library...');
      }
      isLibraryLoading = true;
      try {
        const params = new URLSearchParams({ category: currentCategory });
        params.set('sort', currentSort);
        if (forceRefresh) {
          params.set('refresh', '1');
        }
        const url = '/api/library?' + params.toString();
        const response = await fetch(url);
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        if (Number.isFinite(Number(result.metadataVersion))) {
          lastMetadataVersion = Number(result.metadataVersion);
        }

        applyCategories(result.categories);

        watchedItemIds.clear();
        const watchedKeys = Array.isArray(result.watchedKeys) ? result.watchedKeys : [];
        for (const watchedKey of watchedKeys) {
          if (typeof watchedKey === 'string' && watchedKey.length > 0) {
            watchedItemIds.add(watchedKey);
          }
        }

        resumeByKey.clear();
        const resumePositions = result.resumePositions && typeof result.resumePositions === 'object'
          ? result.resumePositions
          : {};
        for (const [resumeKey, entry] of Object.entries(resumePositions)) {
          const key = String(resumeKey || '').trim();
          const positionSec = Number(entry && entry.positionSec);
          if (!key || !Number.isFinite(positionSec) || positionSec <= 0) {
            continue;
          }

          const durationSec = Number(entry && entry.durationSec);
          const progress = Number(entry && entry.progress);
          resumeByKey.set(key, {
            positionSec,
            durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
            progress: Number.isFinite(progress) ? progress : null,
            updatedAt: entry && entry.updatedAt ? entry.updatedAt : null,
          });
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

        if (!silent) {
          if (result.noFolders) {
            setStatus('No media folder selected. Click "Add Media Folder" to choose your default folder.');
          } else {
            const total = hasGroups
              ? countGroupedItems(result.groups)
              : (result.items || []).length;
            const categoryName = CATEGORY_LABELS[currentCategory] || 'Titles';
            const sortLabel = currentSort === 'recent' ? 'Recently Added' : 'Alphabetical';
            if (isShowCategory(currentCategory)) {
              setStatus('Showing ' + (result.groups || []).length + ' show(s) in ' + categoryName + ' (' + sortLabel + ').');
            } else {
              setStatus('Showing ' + total + ' item(s) in ' + categoryName + ' (' + sortLabel + ').');
            }
          }
        }
      } catch (error) {
        currentGroupedData = [];
        selectedShowName = null;
        expandedSeasonName = null;
        setBackButton(false);
        renderItems([], false, currentCategory);
        setStatus('Library load failed: ' + error.message, true);
      } finally {
        isLibraryLoading = false;
      }
    }

    async function pollMetadataUpdates() {
      if (isLibraryLoading) {
        return;
      }

      try {
        const response = await fetch('/api/library/status');
        const result = await response.json();
        if (!response.ok || !result.ok) {
          return;
        }

        const nextVersion = Number(result.metadataVersion) || 0;
        if (nextVersion > lastMetadataVersion) {
          lastMetadataVersion = nextVersion;
          await loadLibrary(false, { silent: true });
        }
      } catch {
        // Ignore transient polling errors.
      }
    }

    async function pollPlaybackState() {
      try {
        const response = await fetch('/api/playback-state');
        const result = await response.json();
        if (!response.ok || !result.ok) {
          return;
        }

        activeSessions = Array.isArray(result.sessions) ? result.sessions : [];

        const watchedKeys = Array.isArray(result.watchedKeys) ? result.watchedKeys : [];
        watchedItemIds.clear();
        watchedKeys.forEach((key) => {
          const safeKey = String(key || '').trim();
          if (safeKey) {
            watchedItemIds.add(safeKey);
          }
        });

        const resumePositions = result.resumePositions && typeof result.resumePositions === 'object'
          ? result.resumePositions
          : {};
        resumeByKey.clear();
        for (const [resumeKey, entry] of Object.entries(resumePositions)) {
          const key = String(resumeKey || '').trim();
          const positionSec = Number(entry && entry.positionSec);
          if (!key || !Number.isFinite(positionSec) || positionSec <= 0) {
            continue;
          }

          const durationSec = Number(entry && entry.durationSec);
          const progress = Number(entry && entry.progress);
          resumeByKey.set(key, {
            positionSec,
            durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
            progress: Number.isFinite(progress) ? progress : null,
            updatedAt: entry && entry.updatedAt ? entry.updatedAt : null,
          });
        }

        const selectedMediaId = String(result && result.mediaId || '').trim();
        const selectedSession = selectedMediaId
          ? (activeSessions.find((session) => String(session && session.mediaId || '') === selectedMediaId) || null)
          : null;
        if (selectedSession && selectedSession.mediaId) {
          const nextMediaId = String(selectedSession.mediaId);
          const nextPosition = Math.max(0, Math.floor(Number(selectedSession.positionSec) || 0));
          const nextDuration = Number.isFinite(Number(selectedSession.durationSec))
            ? Math.floor(Number(selectedSession.durationSec))
            : null;

          if (activePlayback.mediaId !== nextMediaId) {
            clearActivePlaybackTimer();
            activePlayback.mediaId = nextMediaId;
            activePlayback.resumeKey = selectedSession.resumeKey || null;
            activePlayback.rendererName = selectedSession.rendererName || result.rendererName || currentRendererName;
            activePlayback.positionSec = nextPosition;
            activePlayback.durationSec = nextDuration;
            activePlayback.lastUpdate = Date.now();
            activePlayback.playButtonRef = null;
            startActivePlaybackTimer();
          } else if (Math.abs((Number(activePlayback.positionSec) || 0) - nextPosition) > 2) {
            activePlayback.positionSec = nextPosition;
            activePlayback.durationSec = nextDuration;
            activePlayback.lastUpdate = Date.now();
          }
        } else if (activePlayback.mediaId) {
          resetActivePlaybackState({ keepLastStopped: true });
        }

        const cards = document.querySelectorAll('.movie-card');
        cards.forEach((card) => {
          const cardId = card && card.__mediaId;
          const watchedKey = card && card.__watchedKey;
          const playButton = card ? card.querySelector('button[data-role="play"]') : null;
          const watchedButton = card ? card.querySelector('button[data-role="watched"]') : null;
          const isWatched = watchedKey ? watchedItemIds.has(watchedKey) : false;
          const activeSession = findActiveSessionByMediaId(cardId);
          const hasResumeTag = Boolean(card.querySelector('.resume-tag'));
          const resumeEntry = watchedKey ? resumeByKey.get(watchedKey) : null;
          let resumeInfo = null;
          if (!isWatched && resumeEntry) {
            const positionSec = Math.max(0, Math.floor(Number(resumeEntry.positionSec) || 0));
            const durationSec = Math.floor(Number(resumeEntry.durationSec) || 0);
            const explicitProgress = Number(resumeEntry.progress);
            const progress = Number.isFinite(explicitProgress)
              ? explicitProgress
              : (durationSec > 0 ? (positionSec / durationSec) : null);
            if (positionSec > 0 && (!Number.isFinite(progress) || progress < WATCHED_PROGRESS_THRESHOLD)) {
              resumeInfo = {
                positionSec,
                durationSec: durationSec > 0 ? durationSec : null,
              };
            }
          }

          if (watchedButton) {
            setWatchedCardState(card, watchedButton, isWatched);
          }

          if (playButton) {
            if (isWatched) {
              playButton.textContent = 'Play';
              playButton.classList.remove('resume');
              if (activePlayback && String(activePlayback.mediaId || '') === String(cardId || '')) {
                resetActivePlaybackState({ keepLastStopped: false });
              }
            } else if (activeSession && activeSession.rendererName) {
              if (activePlayback && String(activePlayback.mediaId || '') === String(cardId || '')) {
                playButton.textContent = 'Playback ' + formatResumeClock(activePlayback.positionSec);
                activePlayback.playButtonRef = playButton;
              } else {
                playButton.textContent = 'Playback';
              }
              playButton.classList.add('resume');
            } else if (resumeInfo) {
              playButton.textContent = 'Resume ' + formatResumeClock(resumeInfo.positionSec);
              playButton.classList.add('resume');
            } else {
              playButton.textContent = 'Play';
              playButton.classList.remove('resume');
            }
          }

          setResumeCardState(card, hasResumeTag || Boolean(resumeInfo) || Boolean(activeSession));
        });

        const event = result.autoAdvance;
        if (event && event.at && event.at !== lastSeenAutoAdvanceAt) {
          lastSeenAutoAdvanceAt = event.at;
          const fromTitle = event.fromTitle || 'current episode';
          const toTitle = event.toTitle || 'next episode';
          const rendererName = event.rendererName || result.rendererName || currentRendererName;
          setStatus('Auto-playing next episode on ' + rendererName + ': ' + fromTitle + ' -> ' + toTitle + '.');
        }
      } catch (error) {
        // Ignore transient polling failures to avoid noisy UI.
      }
    }

    refreshBtn.addEventListener('click', () => loadLibrary(true));

    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value === 'recent' ? 'recent' : 'alpha';
      selectedShowName = null;
      expandedSeasonName = null;
      setBackButton(false);
      loadLibrary(false);
    });

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

    addFolderBtn.addEventListener('click', () => {
      openFolderModal();
    });

    function renderCategoryChoices() {
      categoryChoices.innerHTML = '';

      const options = [{
        id: 'auto',
        label: 'Detect automatically',
        hint: 'Sort by folder names (Movies, TV Shows, Anime...)',
      }];

      for (const item of availableCategories) {
        options.push({
          id: item.id,
          label: item.label,
          hint: (item.kind === 'shows' ? 'Grouped by show' : 'Flat list')
            + (Number(item.itemCount) > 0 ? ' - ' + item.itemCount + ' item(s)' : ''),
        });
      }

      for (const option of options) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'category-choice' + (option.id === pendingFolderCategory ? ' selected' : '');
        choice.dataset.choice = option.id;

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = option.label;

        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = option.hint;

        choice.appendChild(name);
        choice.appendChild(hint);
        choice.addEventListener('click', () => {
          pendingFolderCategory = option.id;
          newCategoryForm.hidden = true;
          renderCategoryChoices();
        });
        categoryChoices.appendChild(choice);
      }

      const createChoice = document.createElement('button');
      createChoice.type = 'button';
      createChoice.className = 'category-choice is-new' + (pendingFolderCategory === 'new' ? ' selected' : '');
      createChoice.dataset.choice = 'new';

      const createName = document.createElement('span');
      createName.className = 'name';
      createName.textContent = 'New category';

      const createHint = document.createElement('span');
      createHint.className = 'hint';
      createHint.textContent = 'Name your own group for these files';

      createChoice.appendChild(createName);
      createChoice.appendChild(createHint);
      createChoice.addEventListener('click', () => {
        pendingFolderCategory = 'new';
        newCategoryForm.hidden = false;
        renderCategoryChoices();
        newCategoryName.focus();
      });
      categoryChoices.appendChild(createChoice);
    }

    function openFolderModal() {
      pendingFolderCategory = 'auto';
      newCategoryName.value = '';
      newCategoryForm.hidden = true;
      renderCategoryChoices();
      folderModal.hidden = false;
      folderModalConfirm.focus();
    }

    function closeFolderModal() {
      folderModal.hidden = true;
      addFolderBtn.disabled = false;
    }

    async function createPendingCategory() {
      const label = String(newCategoryName.value || '').trim();
      if (!label) {
        throw new Error('Enter a name for the new category.');
      }

      const kindInput = document.querySelector('input[name="newCategoryKind"]:checked');
      const kind = kindInput ? kindInput.value : 'movies';

      const response = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label, kind: kind }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || ('HTTP ' + response.status));
      }

      applyCategories(result.categories);
      return result.category.id;
    }

    async function submitFolderChoice() {
      folderModalConfirm.disabled = true;
      try {
        let category = pendingFolderCategory;
        if (category === 'new') {
          category = await createPendingCategory();
        }

        closeFolderModal();
        addFolderBtn.disabled = true;
        setStatus('Opening folder picker...');

        let response = await fetch('/api/media-folders/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: category }),
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
            body: JSON.stringify({ path: manualPath, category: category }),
          });
          result = await response.json();
        }

        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        if (Array.isArray(result.categories)) {
          applyCategories(result.categories);
        }

        if (result.category) {
          currentCategory = result.category;
          selectedShowName = null;
          expandedSeasonName = null;
          setBackButton(false);
          syncActiveCategoryButton();
        }

        await loadLibrary(true);
        setStatus(
          'Folder added'
          + (result.categoryLabel ? ' to ' + result.categoryLabel : '')
          + '. Total folders: ' + result.folderCount
          + '. Titles indexed: ' + result.movieCount + '.',
        );
      } catch (error) {
        setStatus('Add folder failed: ' + error.message, true);
      } finally {
        folderModalConfirm.disabled = false;
        addFolderBtn.disabled = false;
      }
    }

    folderModalCancel.addEventListener('click', closeFolderModal);
    folderModalConfirm.addEventListener('click', submitFolderChoice);

    folderModal.addEventListener('click', (event) => {
      if (event.target === folderModal) {
        closeFolderModal();
      }
    });

    newCategoryName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitFolderChoice();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !folderModal.hidden) {
        closeFolderModal();
      }
    });

    window.addEventListener('scroll', () => {
      document.body.classList.toggle('scrolled', window.scrollY > 12);
    }, { passive: true });

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
        // Save last stopped time for resume
        if (activePlayback && activePlayback.mediaId && activePlayback.positionSec) {
          activePlayback.lastStoppedSec = activePlayback.positionSec;
        }
        // Update badge and play button to show resume + last stopped time
        if (activePlayback && activePlayback.playButtonRef) {
          const card = activePlayback.playButtonRef.closest('.movie-card');
          if (card) {
            setResumeCardState(card, true);
          }
          if (typeof activePlayback.lastStoppedSec === 'number') {
            activePlayback.playButtonRef.textContent = 'Resume ' + formatResumeClock(activePlayback.lastStoppedSec);
            activePlayback.playButtonRef.classList.add('resume');
          }
        }
        // Clear active playback state except lastStoppedSec
        resetActivePlaybackState({ keepLastStopped: true });
        // Do not clear lastStoppedSec so resume can use it
      } catch (error) {
        setStatus('Stop failed: ' + error.message, true);
      } finally {
        stopBtn.disabled = false;
      }
    });

    renderCategoryTabs();
    setBackButton(false);
    syncActiveCategoryButton();
    loadRenderers(true);
    loadLibrary(false);
    pollPlaybackState();
    setInterval(pollPlaybackState, 4000);
    setInterval(pollMetadataUpdates, 3000);
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

function parseDlnaClockToSeconds(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'NOT_IMPLEMENTED') {
    return null;
  }

  const match = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return (hours * 3600) + (minutes * 60) + seconds;
}

function formatSecondsAsDlnaClock(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseMediaIdFromPlaylistPath(pathname) {
  const raw = String(pathname || '');
  const match = raw.match(/^\/playlist\/series\/([^/]+)\.m3u$/i);
  if (!match || !match[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function playlistIdFromMedia(media) {
  if (!media || !media.id) {
    return '';
  }
  return `series-${String(media.id).trim()}`;
}

function mediaIdFromTrackUri(trackUri) {
  const raw = String(trackUri || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/^\/media\/([^/]+)/i);
    return match && match[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function castMediaItem(renderer, mediaServer, media, options = {}) {
  const startSeconds = Math.max(0, Math.floor(Number(options.startSeconds) || 0));
  const playlistContext = options.playlistContext && typeof options.playlistContext === 'object'
    ? options.playlistContext
    : null;
  let effectivePlaylistContext = playlistContext;
  const directMediaUrl = mediaServer.getMediaUrl(media.id);
  let mediaUrl = effectivePlaylistContext && effectivePlaylistContext.playlistUrl
    ? String(effectivePlaylistContext.playlistUrl)
    : directMediaUrl;
  const subtitleUrl = await mediaServer.getSubtitleUrl(media.id, { allowDownload: true });
  console.log(`[CastUI] Subtitle for ${media.name}: ${subtitleUrl || 'none'}`);
  let metadata = buildDidlLite({
    title: media.name,
    filePath: effectivePlaylistContext ? `${media.filePath}.m3u` : media.filePath,
    mediaUrl,
    subtitleUrl: effectivePlaylistContext ? null : subtitleUrl,
    upnpClassOverride: effectivePlaylistContext ? 'object.container.playlistContainer' : undefined,
    protocolInfoOverride: effectivePlaylistContext ? 'http-get:*:audio/mpegurl:*' : undefined,
  });

  try {
    // Some renderers keep internal resume/bookmark state per prior item.
    // Reset transport when starting fresh playback.
    if (startSeconds <= 0) {
      try {
        await stop(renderer);
      } catch {
        // Ignore if renderer is already stopped.
      }
    }

    await setAvTransportUri(renderer, mediaUrl, metadata);
  } catch (err) {
    const message = String(err && err.message ? err.message : '');
    if (effectivePlaylistContext && message.includes('errorCode>716</errorCode>')) {
      console.warn('[CastUI] Renderer could not resolve episode playlist URL; falling back to direct media URL.');
      effectivePlaylistContext = null;
      mediaUrl = directMediaUrl;
      metadata = buildDidlLite({
        title: media.name,
        filePath: media.filePath,
        mediaUrl,
        subtitleUrl,
      });
      try {
        await setAvTransportUri(renderer, mediaUrl, metadata);
      } catch (retryErr) {
        const retryMsg = String(retryErr && retryErr.message ? retryErr.message : '');
        if (retryMsg.includes('errorCode>714</errorCode>') || retryMsg.includes('Illegal MIME-type')) {
          await setAvTransportUri(renderer, mediaUrl, '');
        } else {
          throw retryErr;
        }
      }
    } else
    if (message.includes('errorCode>714</errorCode>') || message.includes('Illegal MIME-type')) {
      await setAvTransportUri(renderer, mediaUrl, '');
    } else {
      throw err;
    }
  }

  if (effectivePlaylistContext && Number.isFinite(Number(effectivePlaylistContext.selectedTrackNumber))) {
    await play(renderer);
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      await seek(renderer, String(Math.max(1, Math.floor(Number(effectivePlaylistContext.selectedTrackNumber)))), 'TRACK_NR');
    } catch (err) {
      console.warn(`[CastUI] Playlist track seek failed: ${err.message}`);
    }

    if (startSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        await seek(renderer, formatSecondsAsDlnaClock(startSeconds));
      } catch (err) {
        console.warn(`[CastUI] Resume seek after playlist track select failed: ${err.message}`);
      }
    }
    await play(renderer);
  } else if (startSeconds > 0) {
    await play(renderer);
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      await seek(renderer, formatSecondsAsDlnaClock(startSeconds));
    } catch (err) {
      console.warn(`[CastUI] Resume seek failed: ${err.message}`);
    }
    await play(renderer);
  } else {
    // Force start-at-beginning for non-resume playback.
    await play(renderer);
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      await seek(renderer, '00:00:00');
    } catch (err) {
      console.warn(`[CastUI] Start-from-beginning seek failed: ${err.message}`);
    }
    await play(renderer);
  }

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
    resumedFromSec: startSeconds > 0 ? startSeconds : 0,
    playlistModeUsed: Boolean(effectivePlaylistContext),
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
  initialResumePositions = {},
  onResumePositionsChanged,
  initialCustomCategories = [],
  initialFolderCategories = {},
  onCategoriesChanged,
  allowLanAccess = false,
}) {
  let server = null;
  const requestedUiHost = uiHost;

  // ---- Category registry -------------------------------------------------
  // Built-in categories plus any the user created. Each media root folder may
  // be pinned to one of them; unpinned folders keep the original filename and
  // folder-name heuristics.
  const customCategories = [];
  const folderCategories = new Map();

  const getAllCategories = () => BUILT_IN_CATEGORIES.concat(customCategories);

  const findCategory = (id) => {
    const needle = String(id || '').trim();
    return getAllCategories().find((item) => item.id === needle) || null;
  };

  const categoryKind = (id) => {
    const category = findCategory(id);
    return category ? category.kind : CATEGORY_KIND_MOVIES;
  };

  const isShowsCategory = (id) => categoryKind(id) === CATEGORY_KIND_SHOWS;

  const registerCustomCategory = (label, kind) => {
    const cleanLabel = String(label || '').trim().slice(0, 60);
    if (!cleanLabel) {
      throw new Error('Category name is required.');
    }

    const baseSlug = slugifyCategoryLabel(cleanLabel);
    if (!baseSlug) {
      throw new Error('Category name must contain at least one letter or number.');
    }

    const existing = getAllCategories()
      .find((item) => item.label.toLowerCase() === cleanLabel.toLowerCase());
    if (existing) {
      return existing;
    }

    let id = baseSlug;
    let suffix = 2;
    while (findCategory(id)) {
      id = baseSlug + '-' + suffix;
      suffix += 1;
    }

    const category = {
      id,
      label: cleanLabel,
      kind: kind === CATEGORY_KIND_SHOWS ? CATEGORY_KIND_SHOWS : CATEGORY_KIND_MOVIES,
      builtIn: false,
    };
    customCategories.push(category);
    return category;
  };

  const setFolderCategory = (folderPath, categoryId) => {
    const key = normalizeFolderKey(folderPath);
    if (!key) {
      return;
    }
    if (!categoryId || categoryId === CATEGORY_AUTO || !findCategory(categoryId)) {
      folderCategories.delete(key);
      return;
    }
    folderCategories.set(key, categoryId);
  };

  // Longest matching pinned root wins, so a nested folder can override its parent.
  const assignedRootFor = (filePath) => {
    const target = normalizeFolderKey(filePath);
    let bestKey = '';
    let bestCategory = null;

    for (const [key, categoryId] of folderCategories.entries()) {
      if (target === key || target.startsWith(key + '/')) {
        if (key.length > bestKey.length) {
          bestKey = key;
          bestCategory = categoryId;
        }
      }
    }

    return bestCategory ? { key: bestKey, categoryId: bestCategory } : null;
  };

  const resolveCategory = (filePath) => {
    const assigned = assignedRootFor(filePath);
    if (assigned && findCategory(assigned.categoryId)) {
      return assigned.categoryId;
    }
    return categoryFromPath(filePath);
  };

  // Folders that hold episodes rather than name a show, so we look past them.
  const isSeasonContainerFolder = (folderName) => {
    const normalized = String(folderName || '')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!normalized) {
      return false;
    }

    return /^season\s*\d{1,3}$/.test(normalized)
      || /^s\d{1,3}$/.test(normalized)
      || /^specials?$/.test(normalized)
      || /^(?:disc|disk|part|vol|volume)\s*\d{1,3}$/.test(normalized)
      || /^extras?$/.test(normalized);
  };

  // For pinned folders the show name comes from the folder that actually holds the
  // episodes, stepping past "Season 01"-style containers. That keeps grouping tied to
  // the folder names inside the media folder however deeply the library is nested.
  const seriesNameFor = (filePath, categoryId) => {
    const assigned = assignedRootFor(filePath);
    if (!assigned) {
      return extractSeriesName(filePath, categoryId);
    }

    const rootKey = assigned.key;
    let current = path.dirname(path.resolve(filePath));

    // Walk up while the folder only describes a season/disc, never past the root.
    for (let step = 0; step < 3; step += 1) {
      if (normalizeFolderKey(current) === rootKey) {
        break;
      }
      if (!isSeasonContainerFolder(path.basename(current))) {
        break;
      }

      const parent = path.dirname(current);
      if (!parent || parent === current) {
        break;
      }
      current = parent;
    }

    // Files sitting directly in the media folder group under that folder's name.
    const folderName = path.basename(current);
    return normalizeSeriesFolderName(safeBasename(folderName));
  };

  const persistCategories = () => {
    if (typeof onCategoriesChanged === 'function') {
      onCategoriesChanged({
        customCategories: customCategories.map((item) => ({
          id: item.id,
          label: item.label,
          kind: item.kind,
        })),
        folderCategories: Object.fromEntries(folderCategories.entries()),
      });
    }
  };

  for (const item of (Array.isArray(initialCustomCategories) ? initialCustomCategories : [])) {
    const label = String(item && item.label ? item.label : '').trim();
    const id = String(item && item.id ? item.id : '').trim();
    if (!label || !id || findCategory(id)) {
      continue;
    }
    customCategories.push({
      id,
      label,
      kind: item && item.kind === CATEGORY_KIND_SHOWS ? CATEGORY_KIND_SHOWS : CATEGORY_KIND_MOVIES,
      builtIn: false,
    });
  }

  for (const [folderPath, categoryId] of Object.entries(
    initialFolderCategories && typeof initialFolderCategories === 'object' ? initialFolderCategories : {},
  )) {
    const key = normalizeFolderKey(folderPath);
    if (key && findCategory(String(categoryId || ''))) {
      folderCategories.set(key, String(categoryId));
    }
  }
  const normalizedUiHost = String(uiHost || '').toLowerCase();
  const isLoopbackUiHost = normalizedUiHost === '127.0.0.1' || normalizedUiHost === 'localhost';
  // Binding a loopback host to 0.0.0.0 would silently publish the UI to the whole LAN.
  const serverListenHost = (isLoopbackUiHost && allowLanAccess) ? '0.0.0.0' : uiHost;
  let boundUiPort = Number(uiPort);
  let selectedRenderer = renderer || null;
  let availableRenderers = selectedRenderer ? [selectedRenderer] : [];
  let progressPollTimer = null;
  const activePlaybacks = new Map();
  let lastAutoAdvanceEvent = null;
  const watchedMediaKeys = new Set(
    (Array.isArray(initialWatchedKeys) ? initialWatchedKeys : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0),
  );
  const resumePositions = new Map();

  const trackingKeyFromMedia = (media) => String((media && (media.filePath || media.id)) || '').trim();
  const normalizeResumeKey = (value) => {
    const raw = String(value || '').trim();
    if (!raw) {
      return '';
    }

    const normalized = raw.replace(/\\/g, '/');
    return process.platform === 'win32'
      ? normalized.toLowerCase()
      : normalized;
  };

  const clearResumePositionForIdentifiers = (identifiers) => {
    const needles = new Set(
      (Array.isArray(identifiers) ? identifiers : [])
        .map((item) => normalizeResumeKey(item))
        .filter((item) => item.length > 0),
    );

    if (needles.size === 0) {
      return false;
    }

    let changed = false;
    for (const resumeKey of Array.from(resumePositions.keys())) {
      if (needles.has(normalizeResumeKey(resumeKey))) {
        resumePositions.delete(resumeKey);
        changed = true;
      }
    }

    if (changed) {
      persistResumePositions();
    }

    return changed;
  };

  for (const [key, value] of Object.entries(initialResumePositions && typeof initialResumePositions === 'object'
    ? initialResumePositions
    : {})) {
    const resumeKey = String(key || '').trim();
    const positionSec = Number(value && value.positionSec);
    const durationSec = Number(value && value.durationSec);
    const progress = Number(value && value.progress);
    if (!resumeKey || !Number.isFinite(positionSec) || positionSec <= 0) {
      continue;
    }
    resumePositions.set(resumeKey, {
      positionSec,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      progress: Number.isFinite(progress) ? progress : null,
      updatedAt: (value && value.updatedAt) || new Date().toISOString(),
    });
  }

  const persistResumePositions = () => {
    if (typeof onResumePositionsChanged !== 'function') {
      return;
    }

    const payload = {};
    for (const [key, value] of resumePositions.entries()) {
      payload[key] = {
        positionSec: value.positionSec,
        durationSec: value.durationSec,
        progress: value.progress,
        updatedAt: value.updatedAt,
      };
    }
    onResumePositionsChanged(payload);
  };

  const setResumePosition = (key, positionSec, durationSec) => {
    const resumeKey = String(key || '').trim();
    if (!resumeKey) {
      return;
    }

    const safePosition = Math.max(0, Math.floor(Number(positionSec) || 0));
    const safeDuration = Number.isFinite(Number(durationSec)) && Number(durationSec) > 0
      ? Math.floor(Number(durationSec))
      : null;
    const progress = safeDuration ? (safePosition / safeDuration) : null;

    if (!safePosition || (Number.isFinite(progress) && progress >= WATCHED_COMPLETION_PROGRESS)) {
      if (resumePositions.delete(resumeKey)) {
        persistResumePositions();
      }
      return;
    }

    resumePositions.set(resumeKey, {
      positionSec: safePosition,
      durationSec: safeDuration,
      progress: Number.isFinite(progress) ? progress : null,
      updatedAt: new Date().toISOString(),
    });
    persistResumePositions();
  };

  const clearResumePosition = (key) => {
    const resumeKey = String(key || '').trim();
    if (!resumeKey) {
      return;
    }
    if (resumePositions.delete(resumeKey)) {
      persistResumePositions();
    }
  };

  const markMediaWatched = (media) => {
    if (!media) {
      return false;
    }

    const watchedKey = trackingKeyFromMedia(media);
    if (!watchedKey) {
      return false;
    }

    const wasAdded = !watchedMediaKeys.has(watchedKey);
    watchedMediaKeys.add(watchedKey);

    clearResumePositionForIdentifiers([
      watchedKey,
      media.id,
      media.filePath,
    ]);

    if (wasAdded && typeof onWatchedKeysChanged === 'function') {
      onWatchedKeysChanged(Array.from(watchedMediaKeys));
    }

    return wasAdded;
  };

  const isShowCategoryFromMedia = (media) => {
    if (!media || !media.filePath) {
      return false;
    }
    return isShowsCategory(resolveCategory(media.filePath));
  };

  const mediaEpisodeIndexInfo = (media) => {
    if (!media || !media.filePath) {
      return null;
    }

    const category = resolveCategory(media.filePath);
    if (!isShowsCategory(category)) {
      return null;
    }

    const episodeInfo = extractSeasonEpisodeInfo(media.filePath);

    return {
      category,
      showName: seriesNameFor(media.filePath, category),
      seasonNumber: episodeInfo.seasonNumber,
      episodeNumber: episodeInfo.episodeNumber,
      seasonSort: Number.isFinite(episodeInfo.seasonSort) ? episodeInfo.seasonSort : 999,
      episodeSort: Number.isFinite(episodeInfo.episodeSort) ? episodeInfo.episodeSort : 9999,
      sortName: String(media.name || path.basename(media.filePath) || ''),
    };
  };

  // "Part 2" must sort before "Part 10", so compare numbers inside names numerically.
  const compareSequenceEntries = (a, b) => {
    if (a.seasonSort !== b.seasonSort) {
      return a.seasonSort - b.seasonSort;
    }
    if (a.episodeSort !== b.episodeSort) {
      return a.episodeSort - b.episodeSort;
    }

    const byName = String(a.sortName || '').localeCompare(
      String(b.sortName || ''),
      undefined,
      { numeric: true, sensitivity: 'base' },
    );
    if (byName !== 0) {
      return byName;
    }

    return String(a.media.filePath || '').localeCompare(String(b.media.filePath || ''));
  };

  const sequenceEntriesFor = (currentMedia) => {
    const currentInfo = mediaEpisodeIndexInfo(currentMedia);
    if (!currentInfo) {
      return [];
    }

    return mediaServer.library
      .filter((item) => isLikelyMovie(item))
      .map((item) => {
        const info = mediaEpisodeIndexInfo(item);
        if (!info) {
          return null;
        }
        if (info.category !== currentInfo.category || info.showName !== currentInfo.showName) {
          return null;
        }
        return Object.assign({ media: item }, info);
      })
      .filter(Boolean)
      .sort(compareSequenceEntries);
  };

  const findAdjacentEpisode = (currentMedia, direction) => {
    const episodeCandidates = sequenceEntriesFor(currentMedia);
    if (episodeCandidates.length === 0) {
      return null;
    }

    const currentIndex = episodeCandidates.findIndex((entry) => entry.media.id === currentMedia.id);
    if (currentIndex < 0) {
      return null;
    }

    const safeDirection = Number(direction);
    if (!Number.isFinite(safeDirection) || safeDirection === 0) {
      return null;
    }

    const targetEntry = episodeCandidates[currentIndex + (safeDirection > 0 ? 1 : -1)] || null;
    return targetEntry ? targetEntry.media : null;
  };

  const getEpisodeSequenceForMedia = (currentMedia) => sequenceEntriesFor(currentMedia)
    .map((entry) => entry.media);

  const buildEpisodePlaylistContext = (media) => {
    if (!isShowCategoryFromMedia(media)) {
      return null;
    }

    const sequence = getEpisodeSequenceForMedia(media);
    if (sequence.length < 2) {
      return null;
    }

    const selectedIndex = sequence.findIndex((item) => item.id === media.id);
    if (selectedIndex < 0) {
      return null;
    }

    const lines = ['#EXTM3U'];
    for (const item of sequence) {
      const title = safeBasename(path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim());
      lines.push(`#EXTINF:-1,${title}`);
      lines.push(mediaServer.getMediaUrl(item.id));
    }

    const playlistId = playlistIdFromMedia(media);
    const playlistUrl = mediaServer.registerPlaylist(playlistId, lines);
    if (!playlistUrl) {
      return null;
    }

    return {
      sequence,
      selectedTrackNumber: selectedIndex + 1,
      playlistUrl,
    };
  };

  const findNextEpisode = (currentMedia) => findAdjacentEpisode(currentMedia, 1);

  const findPreviousEpisode = (currentMedia) => findAdjacentEpisode(currentMedia, -1);

  const configureRendererNextEpisode = async (renderer, currentMedia) => {
    if (!renderer) {
      return;
    }

    const nextEpisode = findNextEpisode(currentMedia);
    if (!nextEpisode) {
      await setNextAvTransportUri(renderer, '', '').catch(() => {});
      return;
    }

    const nextMediaUrl = mediaServer.getMediaUrl(nextEpisode.id);
    const nextSubtitleUrl = await mediaServer.getSubtitleUrl(nextEpisode.id, { allowDownload: true });
    const nextMetadata = buildDidlLite({
      title: nextEpisode.name,
      filePath: nextEpisode.filePath,
      mediaUrl: nextMediaUrl,
      subtitleUrl: nextSubtitleUrl,
    });

    try {
      await setNextAvTransportUri(renderer, nextMediaUrl, nextMetadata);
    } catch (err) {
      const message = String(err && err.message ? err.message : '');
      if (message.includes('errorCode>714</errorCode>') || message.includes('Illegal MIME-type')) {
        await setNextAvTransportUri(renderer, nextMediaUrl, '');
      } else {
        throw err;
      }
    }
  };

  const shouldAutoAdvanceToNextEpisode = (media, relTimeSec, durationSec) => {
    if (!isShowCategoryFromMedia(media)) {
      return false;
    }
    if (!Number.isFinite(relTimeSec) || relTimeSec <= 0) {
      return false;
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return false;
    }

    const remaining = durationSec - relTimeSec;
    return remaining <= AUTO_NEXT_MIN_CREDITS_WATCH_SEC;
  };

  const autoAdvanceToNextEpisode = async (sessionKey, session) => {
    if (!session || session.playlistMode || session.autoAdvanceInProgress || !session.mediaId || !session.renderer) {
      return;
    }

    const currentMedia = mediaServer.getMediaById(session.mediaId);
    if (!currentMedia) {
      return;
    }

    const nextEpisode = findNextEpisode(currentMedia);
    if (!nextEpisode) {
      return;
    }

    session.autoAdvanceInProgress = true;
    activePlaybacks.set(sessionKey, session);
    try {
      markMediaWatched(currentMedia);
      console.log(`[CastUI] Auto-advancing to next episode: ${nextEpisode.name}`);
      const fromTitle = safeBasename(path.basename(currentMedia.name, path.extname(currentMedia.name)).replace(/[._]+/g, ' ').trim());
      const toTitle = safeBasename(path.basename(nextEpisode.name, path.extname(nextEpisode.name)).replace(/[._]+/g, ' ').trim());
      await castMediaItem(session.renderer, mediaServer, nextEpisode, { startSeconds: 0 });

      const nextResumeKey = trackingKeyFromMedia(nextEpisode);
      const rendererName = session.renderer && session.renderer.friendlyName
        ? session.renderer.friendlyName
        : 'Unknown Renderer';
      lastAutoAdvanceEvent = {
        at: new Date().toISOString(),
        fromTitle,
        toTitle,
        rendererName,
        mediaId: nextEpisode.id,
      };
      const updatedSession = {
        mediaId: nextEpisode.id,
        resumeKey: nextResumeKey,
        renderer: session.renderer,
        positionSec: 0,
        durationSec: null,
        autoAdvanceInProgress: false,
        playlistMode: false,
      };
      activePlaybacks.set(sessionKey, updatedSession);
      await configureRendererNextEpisode(updatedSession.renderer, nextEpisode).catch(() => {});

      // Capture initial position for the new episode quickly.
      await pollActivePlaybackPosition(sessionKey, updatedSession).catch(() => {});
    } catch (error) {
      session.autoAdvanceInProgress = false;
      activePlaybacks.set(sessionKey, session);
      console.warn(`[CastUI] Auto-next-episode failed: ${error.message}`);
    }
  };

  const stopPlaybackProgressPolling = () => {
    if (progressPollTimer) {
      clearInterval(progressPollTimer);
      progressPollTimer = null;
    }
  };

  const clearPlaybackSession = (sessionKey) => {
    if (!activePlaybacks.has(sessionKey)) {
      return;
    }

    activePlaybacks.delete(sessionKey);
    if (activePlaybacks.size === 0) {
      stopPlaybackProgressPolling();
    }
  };

  const pollActivePlaybackPosition = async (sessionKey, session) => {
    if (!session || !session.renderer || !session.resumeKey) {
      return;
    }

    const transportInfo = await getTransportInfo(session.renderer).catch(() => null);
    const transportState = transportInfo
      && transportInfo['s:Envelope']
      && transportInfo['s:Envelope']['s:Body']
      && transportInfo['s:Envelope']['s:Body']['u:GetTransportInfoResponse']
      && transportInfo['s:Envelope']['s:Body']['u:GetTransportInfoResponse']['CurrentTransportState'];
    const isTerminalTransport = transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT';
    if (isTerminalTransport && !session.autoAdvanceInProgress && Number(session.positionSec) > 0) {
      clearPlaybackSession(sessionKey);
      return;
    }

    const positionInfo = await getPositionInfo(session.renderer);
    const mediaInfo = await getMediaInfo(session.renderer).catch(() => null);
    const response = positionInfo
      && positionInfo['s:Envelope']
      && positionInfo['s:Envelope']['s:Body']
      && positionInfo['s:Envelope']['s:Body']['u:GetPositionInfoResponse'];

    if (!response) {
      return;
    }

    const trackUri = String(response.TrackURI || '').trim()
      || String(
        mediaInfo
        && mediaInfo['s:Envelope']
        && mediaInfo['s:Envelope']['s:Body']
        && mediaInfo['s:Envelope']['s:Body']['u:GetMediaInfoResponse']
        && mediaInfo['s:Envelope']['s:Body']['u:GetMediaInfoResponse']['CurrentURI']
      || '').trim();
    const trackMediaId = mediaIdFromTrackUri(trackUri);
    const trackMedia = trackMediaId ? mediaServer.getMediaById(trackMediaId) : null;

    if (trackMedia && trackMedia.id && trackMedia.id !== session.mediaId) {
      const previousMedia = mediaServer.getMediaById(session.mediaId);
      const previousNext = previousMedia ? findNextEpisode(previousMedia) : null;
      if (previousMedia && previousNext && previousNext.id === trackMedia.id && Number(session.positionSec) > 0) {
        markMediaWatched(previousMedia);
      }

      session.mediaId = trackMedia.id;
      session.resumeKey = trackingKeyFromMedia(trackMedia);
      session.positionSec = 0;
      session.durationSec = null;
      activePlaybacks.set(sessionKey, session);

      if (!session.playlistMode) {
        await configureRendererNextEpisode(session.renderer, trackMedia).catch(() => {});
      }

      const previousEpisode = trackMedia ? findPreviousEpisode(trackMedia) : null;
      console.log(
        `[CastUI] Renderer switched episode via on-screen controls: ${trackMedia.name}`
        + `${previousEpisode ? ` (previous: ${previousEpisode.name})` : ''}`,
      );
    }

    const relTimeSec = parseDlnaClockToSeconds(response.RelTime);
    const durationSec = parseDlnaClockToSeconds(response.TrackDuration) || session.durationSec || null;
    if (!Number.isFinite(relTimeSec) || relTimeSec <= 0) {
      return;
    }

    setResumePosition(session.resumeKey, relTimeSec, durationSec);
    session.positionSec = relTimeSec;
    session.durationSec = durationSec;
    activePlaybacks.set(sessionKey, session);

    const currentMedia = mediaServer.getMediaById(session.mediaId);
    const progress = Number.isFinite(durationSec) && durationSec > 0
      ? (relTimeSec / durationSec)
      : null;
    if (currentMedia && isShowCategoryFromMedia(currentMedia) && Number.isFinite(progress) && progress >= WATCHED_COMPLETION_PROGRESS) {
      markMediaWatched(currentMedia);
      if (!findNextEpisode(currentMedia)) {
        clearPlaybackSession(sessionKey);
        return;
      }
    }

    if (!session.playlistMode && currentMedia && shouldAutoAdvanceToNextEpisode(currentMedia, relTimeSec, durationSec)) {
      await autoAdvanceToNextEpisode(sessionKey, session);
    }
  };

  const pollAllActivePlaybackPositions = async () => {
    if (activePlaybacks.size === 0) {
      return;
    }

    const tasks = [];
    for (const [sessionKey, session] of activePlaybacks.entries()) {
      tasks.push(pollActivePlaybackPosition(sessionKey, session).catch(() => {}));
    }
    await Promise.all(tasks);
  };

  const startPlaybackProgressPolling = () => {
    stopPlaybackProgressPolling();
    progressPollTimer = setInterval(() => {
      pollAllActivePlaybackPositions().catch(() => {});
    }, 15000);
  };

  const isLoopbackAddress = (address) => {
    const raw = String(address || '').trim().toLowerCase();
    if (!raw) {
      return false;
    }
    const normalized = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
    return normalized === '::1' || normalized.startsWith('127.');
  };

  // Adding a media folder reaches the host filesystem, so it stays local-only
  // even when the UI itself is published to the LAN.
  const isLocalRequest = (req) => isLoopbackAddress(req && req.socket && req.socket.remoteAddress);

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
      let addedAtMs = null;
      try {
        const stat = fs.statSync(item.filePath);
        size = stat.size;
        addedAtMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
      } catch (err) {
        size = null;
        addedAtMs = null;
      }

      return {
        id: item.id,
        name: safeBasename(item.name),
        filePath: item.filePath,
        watchedKey: item.filePath,
        mimeType: item.mimeType,
        size,
        addedAtMs,
      };
    });

  const metadataMap = new Map();
  const metadataPending = new Map();
  let metadataVersion = 0;
  const MAX_METADATA_CONCURRENCY = 4;
  const metadataQueue = [];
  let metadataInFlight = 0;

  const pumpMetadataQueue = () => {
    while (metadataInFlight < MAX_METADATA_CONCURRENCY && metadataQueue.length > 0) {
      const runTask = metadataQueue.shift();
      metadataInFlight += 1;
      Promise.resolve()
        .then(() => runTask())
        .catch(() => {})
        .finally(() => {
          metadataInFlight -= 1;
          pumpMetadataQueue();
        });
    }
  };

  const buildLocalMetadata = (item) => {
    const category = resolveCategory(item.filePath);
    const categoryIsShows = isShowsCategory(category);
    const showName = categoryIsShows ? seriesNameFor(item.filePath, category) : null;
    const seasonInfo = categoryIsShows ? extractSeasonEpisodeInfo(item.filePath) : null;
    if (seasonInfo && !Number.isFinite(seasonInfo.seasonNumber)) {
      seasonInfo.seasonLabel = 'Episodes';
    }
    const fallbackSeriesTitle = extractSeriesTitleFromEpisodeName(item.name);
    const searchTitle = showName || fallbackSeriesTitle || extractMovieTitle(item.name);
    const isShowCategory = categoryIsShows;
    const displayTitle = showName
      ? safeBasename(path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim())
      : searchTitle;

    return {
      category,
      showName,
      seasonInfo,
      fallbackSeriesTitle,
      searchTitle,
      isShowCategory,
      displayTitle,
      enriched: {
        movieTitle: displayTitle,
        showName,
        showDisplayTitle: isShowCategory ? (showName || displayTitle) : null,
        showPosterUrl: null,
        showPlot: null,
        showImdbRating: null,
        showRatingSource: null,
        showYear: null,
        seasonLabel: seasonInfo ? seasonInfo.seasonLabel : null,
        seasonNumber: seasonInfo ? seasonInfo.seasonNumber : null,
        episodeNumber: seasonInfo ? seasonInfo.episodeNumber : null,
        seasonSort: seasonInfo ? seasonInfo.seasonSort : null,
        episodeSort: seasonInfo ? seasonInfo.episodeSort : null,
        posterUrl: null,
        year: null,
        plot: null,
        imdbRating: null,
        ratingSource: null,
      },
    };
  };

  const queueMetadataFetch = (item, local) => {
    if (metadataMap.has(item.id) || metadataPending.has(item.id)) {
      return;
    }

    let resolvePending = null;
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    metadataPending.set(item.id, pendingPromise);

    metadataQueue.push(async () => {
      try {
        const seriesResult = local.isShowCategory
          ? await fetchSeriesMetadataWithFallback([
            local.searchTitle,
            local.fallbackSeriesTitle,
            extractMovieTitle(item.name),
          ])
          : null;

        const metadata = local.isShowCategory
          ? seriesResult.metadata
          : await fetchMovieMetadata(local.searchTitle);

        const seriesLookupTitle = local.isShowCategory
          ? (seriesResult.matchedTitle || local.searchTitle)
          : local.searchTitle;

        const episodeMetadata = (
          local.isShowCategory
          && local.seasonInfo
          && Number.isFinite(local.seasonInfo.seasonNumber)
          && Number.isFinite(local.seasonInfo.episodeNumber)
        )
          ? await fetchEpisodeMetadata(
            seriesLookupTitle,
            local.seasonInfo.seasonNumber,
            local.seasonInfo.episodeNumber,
            local.displayTitle,
          )
          : null;

        const episodeTitle = (episodeMetadata && episodeMetadata.title) || local.displayTitle;
        const episodePoster = (episodeMetadata && episodeMetadata.posterUrl) || (metadata && metadata.posterUrl) || null;
        const episodePlot = (episodeMetadata && episodeMetadata.plot) || (metadata && metadata.plot) || null;
        const episodeRating = (episodeMetadata && episodeMetadata.imdbRating) || (metadata && metadata.imdbRating) || null;
        const episodeRatingSource = (episodeMetadata && episodeMetadata.imdbRating)
          ? (episodeMetadata.ratingSource || null)
          : ((metadata && metadata.imdbRating) ? (metadata.ratingSource || null) : null);
        const episodeYear = (episodeMetadata && episodeMetadata.year) || (metadata && metadata.year) || null;

        metadataMap.set(item.id, {
          movieTitle: episodeTitle,
          showName: local.showName,
          showDisplayTitle: local.isShowCategory ? ((metadata && metadata.title) || local.showName) : null,
          showPosterUrl: local.isShowCategory ? ((metadata && metadata.posterUrl) || null) : null,
          showPlot: local.isShowCategory ? ((metadata && metadata.plot) || null) : null,
          showImdbRating: local.isShowCategory ? ((metadata && metadata.imdbRating) || null) : null,
          showRatingSource: local.isShowCategory ? ((metadata && metadata.ratingSource) || null) : null,
          showYear: local.isShowCategory ? ((metadata && metadata.year) || null) : null,
          seasonLabel: local.seasonInfo ? local.seasonInfo.seasonLabel : null,
          seasonNumber: local.seasonInfo ? local.seasonInfo.seasonNumber : null,
          episodeNumber: local.seasonInfo ? local.seasonInfo.episodeNumber : null,
          seasonSort: local.seasonInfo ? local.seasonInfo.seasonSort : null,
          episodeSort: local.seasonInfo ? local.seasonInfo.episodeSort : null,
          posterUrl: episodePoster,
          year: episodeYear,
          plot: episodePlot,
          imdbRating: episodeRating,
          ratingSource: episodeRatingSource,
        });
        metadataVersion += 1;
      } catch {
        // Ignore metadata fetch failures.
      } finally {
        metadataPending.delete(item.id);
        if (resolvePending) {
          resolvePending();
        }
      }
    });

    pumpMetadataQueue();
  };

  const enrichItemsWithMetadata = async (items) => {
    const result = [];

    for (const item of items) {
      if (metadataMap.has(item.id)) {
        result.push({
          ...item,
          ...metadataMap.get(item.id),
        });
      } else {
        const local = buildLocalMetadata(item);
        queueMetadataFetch(item, local);
        result.push({
          ...item,
          ...local.enriched,
        });
      }
    }

    return result;
  };

  const getCategoryPayload = async (category, sortMode = 'alpha') => {
    const normalizedSort = sortMode === 'recent' ? 'recent' : 'alpha';
    const items = getMovieItems().filter((item) => resolveCategory(item.filePath) === category);
    const enrichedItems = await enrichItemsWithMetadata(items);

    const sortByTitle = (a, b) => {
      const titleA = String(a.movieTitle || a.name || '').toLowerCase();
      const titleB = String(b.movieTitle || b.name || '').toLowerCase();
      return titleA.localeCompare(titleB);
    };

    const sortByRecent = (a, b) => {
      const aTs = Number.isFinite(Number(a.addedAtMs)) ? Number(a.addedAtMs) : 0;
      const bTs = Number.isFinite(Number(b.addedAtMs)) ? Number(b.addedAtMs) : 0;
      if (bTs !== aTs) {
        return bTs - aTs;
      }
      return sortByTitle(a, b);
    };

    if (isShowsCategory(category)) {
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

                return String(a.name || '').localeCompare(
                  String(b.name || ''),
                  undefined,
                  { numeric: true, sensitivity: 'base' },
                );
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

          const latestAddedAtMs = seasons.reduce((latest, season) => {
            const seasonLatest = (season.items || []).reduce((seasonMax, episode) => {
              const ts = Number.isFinite(Number(episode.addedAtMs)) ? Number(episode.addedAtMs) : 0;
              return Math.max(seasonMax, ts);
            }, 0);
            return Math.max(latest, seasonLatest);
          }, 0);

          return {
            name,
            displayTitle: (firstWithPoster.showDisplayTitle || firstWithPoster.showName || name),
            posterUrl: firstWithPoster.showPosterUrl || firstWithPoster.posterUrl || null,
            year: firstWithPoster.showYear || firstWithPoster.year || null,
            plot: firstWithPoster.showPlot || firstWithPoster.plot || null,
            imdbRating: firstWithPoster.showImdbRating || firstWithPoster.imdbRating || null,
            ratingSource: firstWithPoster.showRatingSource || firstWithPoster.ratingSource || null,
            latestAddedAtMs,
            seasons,
            items: [],
          };
        })
        .sort((a, b) => {
          if (normalizedSort === 'recent') {
            const aTs = Number.isFinite(Number(a.latestAddedAtMs)) ? Number(a.latestAddedAtMs) : 0;
            const bTs = Number.isFinite(Number(b.latestAddedAtMs)) ? Number(b.latestAddedAtMs) : 0;
            if (bTs !== aTs) {
              return bTs - aTs;
            }
          }
          return String(a.displayTitle || a.name || '').localeCompare(String(b.displayTitle || b.name || ''));
        });

      return { items: [], groups };
    }

    const sortedItems = [...enrichedItems].sort(normalizedSort === 'recent' ? sortByRecent : sortByTitle);
    return { items: sortedItems, groups: [] };
  };

  const categorySummaries = () => {
    const counts = new Map();
    for (const item of getMovieItems()) {
      const id = resolveCategory(item.filePath);
      counts.set(id, (counts.get(id) || 0) + 1);
    }

    const pinnedFolders = new Map();
    for (const categoryId of folderCategories.values()) {
      pinnedFolders.set(categoryId, (pinnedFolders.get(categoryId) || 0) + 1);
    }

    return getAllCategories().map((item) => ({
      id: item.id,
      label: item.label,
      kind: item.kind,
      builtIn: Boolean(item.builtIn),
      itemCount: counts.get(item.id) || 0,
      folderCount: pinnedFolders.get(item.id) || 0,
    }));
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
          metadataVersion += 1;
        }
        const category = String(parsed.searchParams.get('category') || CATEGORY_MOVIES);
        const sort = String(parsed.searchParams.get('sort') || 'alpha');
        const noFolders = mediaServer.getRootDirs().length === 0;
        const payload = noFolders
          ? { items: [], groups: [] }
          : await getCategoryPayload(category, sort);
        sendJson(res, 200, {
          ok: true,
          noFolders,
          category,
          categories: categorySummaries(),
          items: payload.items,
          groups: payload.groups,
          metadataVersion,
          watchedKeys: Array.from(watchedMediaKeys),
          resumePositions: Object.fromEntries(resumePositions.entries()),
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/library/status') {
      sendJson(res, 200, {
        ok: true,
        metadataVersion,
        pendingCount: metadataPending.size,
        cachedCount: metadataMap.size,
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/playback-state') {
      const selectedRendererSession = selectedRenderer
        ? activePlaybacks.get(rendererKey(selectedRenderer))
        : null;
      const rendererName = selectedRendererSession && selectedRendererSession.renderer && selectedRendererSession.renderer.friendlyName
        ? selectedRendererSession.renderer.friendlyName
        : (selectedRenderer && selectedRenderer.friendlyName ? selectedRenderer.friendlyName : 'Unknown Renderer');
      const sessions = Array.from(activePlaybacks.values()).map((session) => {
        const media = mediaServer.getMediaById(session.mediaId);
        const resume = session.resumeKey ? resumePositions.get(session.resumeKey) : null;
        const safePosition = Math.max(
          0,
          Math.floor(Number(session.positionSec ?? (resume && resume.positionSec) ?? 0) || 0),
        );
        const safeDuration = Number.isFinite(Number(session.durationSec ?? (resume && resume.durationSec)))
          ? Math.floor(Number(session.durationSec ?? (resume && resume.durationSec)))
          : null;
        const progress = safeDuration && safeDuration > 0
          ? (safePosition / safeDuration)
          : null;
        return {
          mediaId: session.mediaId || null,
          mediaName: media ? media.name : null,
          rendererKey: rendererKey(session.renderer),
          rendererName: session.renderer && session.renderer.friendlyName
            ? session.renderer.friendlyName
            : 'Unknown Renderer',
          resumeKey: session.resumeKey || null,
          positionSec: safePosition,
          durationSec: safeDuration,
          progress: Number.isFinite(progress) ? progress : null,
        };
      });
      sendJson(res, 200, {
        ok: true,
        active: Boolean(selectedRendererSession && selectedRendererSession.mediaId),
        mediaId: selectedRendererSession && selectedRendererSession.mediaId
          ? selectedRendererSession.mediaId
          : null,
        rendererName,
        sessions,
        autoAdvance: lastAutoAdvanceEvent,
        watchedKeys: Array.from(watchedMediaKeys),
        resumePositions: Object.fromEntries(resumePositions.entries()),
      });
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

        const resumeKey = trackingKeyFromMedia(media);
        const savedResume = resumePositions.get(resumeKey);
        const requestedResume = payload.resume !== false;
        const startSeconds = requestedResume && savedResume
          ? Math.max(0, Math.floor(Number(savedResume.positionSec) || 0))
          : 0;
        const playlistContext = null;

        const result = await castMediaItem(selectedRenderer, mediaServer, media, {
          startSeconds,
          playlistContext,
        });
        const playlistModeUsed = Boolean(result && result.playlistModeUsed);
        const selectedKey = rendererKey(selectedRenderer);
        activePlaybacks.set(selectedKey, {
          mediaId: media.id,
          resumeKey,
          renderer: selectedRenderer,
          positionSec: startSeconds,
          durationSec: savedResume && Number.isFinite(savedResume.durationSec)
            ? Math.floor(Number(savedResume.durationSec))
            : null,
          autoAdvanceInProgress: false,
          playlistMode: playlistModeUsed,
        });
        if (!playlistModeUsed) {
          await configureRendererNextEpisode(selectedRenderer, media).catch(() => {});
        }
        startPlaybackProgressPolling();
        pollAllActivePlaybackPositions().catch(() => {});

        sendJson(res, 200, {
          ok: true,
          media: {
            id: media.id,
            name: media.name,
          },
          rendererName: selectedRenderer.friendlyName || 'Unknown Renderer',
          transportState: result.transportState,
          mediaUrl: result.mediaUrl,
          resumedFromSec: result.resumedFromSec || 0,
          playlistMode: playlistModeUsed,
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

        const selectedKey = rendererKey(selectedRenderer);
        const selectedSession = activePlaybacks.get(selectedKey);
        if (selectedSession) {
          await pollActivePlaybackPosition(selectedKey, selectedSession).catch(() => {});
        }
        await stop(selectedRenderer);
        activePlaybacks.delete(selectedKey);
        if (activePlaybacks.size === 0) {
          stopPlaybackProgressPolling();
        }
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
        const mediaId = String(payload.id || '').trim();
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

        // Clicking Watched or Unmark clears any partial resume progress.
        const mediaById = mediaId ? mediaServer.getMediaById(mediaId) : null;
        const mediaPath = mediaById && mediaById.filePath ? String(mediaById.filePath).trim() : '';
        const mediaTrackingKey = mediaById ? trackingKeyFromMedia(mediaById) : '';
        const clearKeys = [key, mediaId, mediaPath, mediaTrackingKey];

        clearResumePositionForIdentifiers(clearKeys);

        const normalizedClearKeys = new Set(
          clearKeys.map((item) => normalizeResumeKey(item)).filter((item) => item.length > 0),
        );
        for (const [sessionKey, session] of activePlaybacks.entries()) {
          const sessionResumeKey = session && session.resumeKey
            ? normalizeResumeKey(session.resumeKey)
            : '';
          if (session && normalizedClearKeys.has(sessionResumeKey)) {
            activePlaybacks.delete(sessionKey);
          }
        }
        if (activePlaybacks.size === 0) {
          stopPlaybackProgressPolling();
        }

        if (typeof onWatchedKeysChanged === 'function') {
          onWatchedKeysChanged(Array.from(watchedMediaKeys));
        }

        sendJson(res, 200, {
          ok: true,
          key,
          watched: watchedMediaKeys.has(key),
          watchedKeys: Array.from(watchedMediaKeys),
          resumeCleared: true,
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/categories') {
      sendJson(res, 200, {
        ok: true,
        categories: categorySummaries(),
      });
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/categories') {
      try {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, {
            ok: false,
            error: 'Categories can only be created from the machine running MediaCast.',
          });
          return;
        }

        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const category = registerCustomCategory(payload.label, payload.kind);
        persistCategories();

        sendJson(res, 200, {
          ok: true,
          category: {
            id: category.id,
            label: category.label,
            kind: category.kind,
            builtIn: false,
          },
          categories: categorySummaries(),
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/media-folders/add') {
      try {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, {
            ok: false,
            error: 'Media folders can only be added from the machine running MediaCast.',
          });
          return;
        }

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

        const requestedCategory = String(payload.category || CATEGORY_AUTO).trim();
        if (requestedCategory && requestedCategory !== CATEGORY_AUTO && !findCategory(requestedCategory)) {
          sendJson(res, 400, {
            ok: false,
            error: 'Unknown category: ' + requestedCategory,
          });
          return;
        }

        const added = mediaServer.addRootDir(folderPath);
        setFolderCategory(folderPath, requestedCategory);
        persistCategories();

        await mediaServer.buildLibrary();
        metadataMap.clear();
        metadataVersion += 1;

        if (typeof onMediaFoldersChanged === 'function') {
          onMediaFoldersChanged(mediaServer.getRootDirs());
        }

        const assignedCategory = requestedCategory === CATEGORY_AUTO ? null : requestedCategory;

        sendJson(res, 200, {
          ok: true,
          added,
          folderPath,
          category: assignedCategory,
          categoryLabel: assignedCategory ? (findCategory(assignedCategory) || {}).label : null,
          folderCount: mediaServer.getRootDirs().length,
          movieCount: getMovieItems().length,
          categories: categorySummaries(),
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: error.message,
        });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname.startsWith('/playlist/series/')) {
      try {
        const mediaId = parseMediaIdFromPlaylistPath(parsed.pathname);
        const media = mediaId ? mediaServer.getMediaById(mediaId) : null;
        if (!media) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const sequence = getEpisodeSequenceForMedia(media);
        if (sequence.length === 0) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const lines = ['#EXTM3U'];
        for (const item of sequence) {
          const title = safeBasename(path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim());
          lines.push(`#EXTINF:-1,${title}`);
          lines.push(mediaServer.getMediaUrl(item.id));
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'audio/mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="series-playlist.m3u"');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(lines.join('\r\n') + '\r\n');
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
      const basePort = Number(uiPort);
      const maxAttempts = 10;

      for (let offset = 0; offset < maxAttempts; offset += 1) {
        const attemptPort = basePort + offset;
        server = http.createServer((req, res) => {
          handleRequest(req, res).catch((error) => {
            sendJson(res, 500, {
              ok: false,
              error: error.message,
            });
          });
        });

        try {
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(attemptPort, serverListenHost, () => resolve());
          });
          break;
        } catch (error) {
          if (error && error.code === 'EADDRINUSE' && offset < maxAttempts - 1) {
            await new Promise((resolve) => {
              server.close(() => resolve());
            }).catch(() => {});
            server = null;
            continue;
          }

          throw error;
        }
      }

      if (!server || !server.listening) {
        throw new Error(`Unable to bind the web app to ${uiHost}:${basePort} or the next ${maxAttempts - 1} port(s).`);
      }

      const address = server.address();
      boundUiPort = address.port;
      return {
        host: requestedUiHost,
        port: address.port,
      };
    },
    stop: () => {
      stopPlaybackProgressPolling();
      activePlaybacks.clear();
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

export { createCastUiServer };
