import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
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
import { isImageFile, isComicFile, isComicArchiveFile, isBookFile } from '../utils/media.js';
import {
  openEpub,
  readEpubResource,
  prepareChapterHtml,
  prepareStylesheet,
  chapterPlainText,
} from '../books/epub.js';
import {
  speechSentences,
  chapterSpeechText,
  findPiper,
  synthesiseWithPiper,
  speechCacheKey,
} from '../books/speech.js';
import { ensureBundledEngine } from '../books/engineInstall.js';
import { listComicPages, readComicPage, comicArchiveKind } from '../comics/archive.js';
import { collectComicBooks, buildComicGroups } from '../comics/library.js';
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

  if (/\.d\.ts$/i.test(media.filePath)) {
    return false;
  }

  const ext = path.extname(media.filePath).toLowerCase();
  const videoExts = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.mts']);
  return videoExts.has(ext);
}

// Anything the grid should show. Episode sequencing still uses isLikelyMovie,
// since a photo has no "next episode".
function isLibraryItem(media) {
  if (!media || !media.filePath) {
    return false;
  }
  return isLikelyMovie(media)
    || isImageFile(media.filePath)
    || isComicFile(media.filePath)
    || isBookFile(media.filePath);
}

const CATEGORY_BOOKS = 'books';
const CATEGORY_MOVIES = 'movies';
const CATEGORY_TV_SHOWS = 'tv-shows';
const CATEGORY_ANIME_MOVIES = 'anime-movies';
const CATEGORY_ANIME_SHOWS = 'anime-shows';
const CATEGORY_PHOTOS = 'photos';
const CATEGORY_COMICS = 'comics';
const CATEGORY_KIND_MOVIES = 'movies';
const CATEGORY_KIND_SHOWS = 'shows';
const CATEGORY_AUTO = 'auto';

// Categories that ship with the app. Custom ones are appended at runtime.
const BUILT_IN_CATEGORIES = [
  { id: CATEGORY_MOVIES, label: 'Movies', kind: CATEGORY_KIND_MOVIES, builtIn: true },
  { id: CATEGORY_TV_SHOWS, label: 'TV Shows', kind: CATEGORY_KIND_SHOWS, builtIn: true },
  { id: CATEGORY_ANIME_MOVIES, label: 'Anime Movies', kind: CATEGORY_KIND_MOVIES, builtIn: true },
  { id: CATEGORY_ANIME_SHOWS, label: 'Anime Shows', kind: CATEGORY_KIND_SHOWS, builtIn: true },
  { id: CATEGORY_PHOTOS, label: 'Photos', kind: CATEGORY_KIND_MOVIES, builtIn: true },
  { id: CATEGORY_COMICS, label: 'Comics', kind: CATEGORY_KIND_SHOWS, builtIn: true },
  { id: CATEGORY_BOOKS, label: 'Books', kind: CATEGORY_KIND_MOVIES, builtIn: true },
];

const COVER_MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_COVER_BYTES = 8 * 1024 * 1024;

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
// Reaching the end of the last chapter counts as finishing the book.
const BOOK_COMPLETION_PERCENT = 0.995;
const ANNOTATION_KINDS = new Set(['highlight', 'note', 'bookmark']);
const ANNOTATION_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple']);

// Annotations arrive from the browser, so every field is bounded here before it
// is stored or handed back to another session.
function normalizeAnnotation(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const kind = String(input.kind || '').trim();
  if (!ANNOTATION_KINDS.has(kind)) {
    return null;
  }

  const chapterIndex = Math.floor(Number(input.chapterIndex));
  if (!Number.isFinite(chapterIndex) || chapterIndex < 0) {
    return null;
  }

  const start = Math.max(0, Math.floor(Number(input.start) || 0));
  const end = Math.max(start, Math.floor(Number(input.end) || 0));
  if (kind !== 'bookmark' && end <= start) {
    return null;
  }

  const color = ANNOTATION_COLORS.has(String(input.color)) ? String(input.color) : 'yellow';
  const id = String(input.id || '').trim().slice(0, 64)
    || crypto.randomBytes(8).toString('hex');

  return {
    id,
    kind,
    chapterIndex,
    start,
    end,
    color,
    text: String(input.text || '').slice(0, 4000),
    note: String(input.note || '').slice(0, 4000),
    chapterLabel: String(input.chapterLabel || '').slice(0, 200),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

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
      flex: none;
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

    /* ---------- Detail dialog ---------- */

    /* overflow:hidden here would clip the dialog instead of scrolling it, which
       hid the editor's Save row entirely on shorter screens. */
    .detail-modal {
      width: min(880px, 100%);
      padding: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
    }

    .modal-close {
      position: absolute;
      top: 14px;
      right: 14px;
      z-index: 3;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      border: 1px solid var(--stroke);
      background: rgba(6, 11, 22, 0.75);
      color: var(--text);
      font-size: 19px;
      line-height: 1;
      cursor: pointer;
      backdrop-filter: blur(8px);
      transition: background 200ms var(--ease-soft), transform 200ms var(--ease);
    }

    .modal-close:hover { background: rgba(248, 113, 113, 0.28); transform: rotate(90deg); }

    .detail-body {
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 0;
    }

    .detail-poster {
      position: relative;
      align-self: start;
      aspect-ratio: 2 / 3;
      background: linear-gradient(150deg, #17203a, #0d1526);
      cursor: pointer;
      overflow: hidden;
    }

    /* Hover affordance telling the user the cover is editable. */
    .poster-edit {
      position: absolute;
      inset: 0;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px;
      border: 0;
      background: rgba(4, 8, 16, 0.74);
      backdrop-filter: blur(3px);
      color: #fff;
      font-family: inherit;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      text-align: center;
      line-height: 1.4;
      cursor: pointer;
      opacity: 0;
      transition: opacity 260ms var(--ease-soft);
    }

    .detail-poster:hover .poster-edit,
    .poster-edit:focus-visible { opacity: 1; }

    .poster-edit .icon {
      font-size: 26px;
      line-height: 1;
    }

    .detail-poster img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .detail-poster .placeholder { font-size: 60px; }

    .detail-poster.is-photo { aspect-ratio: 4 / 3; }
    .detail-poster.is-photo img { object-fit: contain; background: #05080f; }

    .detail-info { padding: 26px 26px 22px; min-width: 0; }

    .detail-info .modal-title { font-size: 1.55rem; margin-bottom: 8px; }

    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }

    .detail-meta span {
      padding: 5px 11px;
      border-radius: 999px;
      background: var(--glass);
      border: 1px solid var(--stroke);
      color: #9dc4fb;
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.03em;
    }

    .detail-meta span.edited { color: #fde68a; border-color: rgba(250, 204, 21, 0.45); }

    .detail-plot {
      margin: 0 0 16px;
      color: #c9d6ea;
      font-size: 0.92rem;
      line-height: 1.65;
    }

    .detail-file {
      color: var(--faint);
      font-size: 0.72rem;
      font-weight: 600;
      word-break: break-all;
      margin-bottom: 18px;
    }

    .detail-actions { justify-content: flex-start; }

    .track-section {
      border-top: 1px solid var(--stroke);
      padding-top: 14px;
      margin-bottom: 16px;
      display: grid;
      gap: 12px;
    }

    .track-section[hidden] { display: none; }

    .track-row[hidden] { display: none; }

    .track-select {
      width: 100%;
      min-width: 0;
      margin-top: 2px;
    }

    .track-actions {
      display: flex;
      gap: 8px;
      margin-top: 9px;
      flex-wrap: wrap;
    }

    .track-actions .neu-btn { padding: 8px 12px; min-height: 34px; font-size: 0.63rem; }

    .track-note {
      color: var(--faint);
      font-size: 0.73rem;
      font-weight: 600;
      line-height: 1.5;
    }

    .track-note.warn { color: #fcd34d; }

    .detail-edit {
      border-top: 1px solid var(--stroke);
      padding: 22px 26px 24px;
      animation: section-in 300ms var(--ease);
    }

    .detail-edit[hidden] { display: none; }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr 140px;
      gap: 12px;
      margin-bottom: 12px;
    }

    .form-field { min-width: 0; }

    textarea.text-input {
      min-height: 108px;
      resize: vertical;
      line-height: 1.55;
      font-weight: 500;
    }

    .cover-row {
      display: flex;
      gap: 12px;
      align-items: flex-end;
      margin-top: 12px;
      flex-wrap: wrap;
    }

    .cover-preview {
      width: 62px;
      height: 93px;
      border-radius: 8px;
      border: 1px solid var(--stroke);
      object-fit: cover;
      background: #0d1526;
      flex: none;
    }

    .cover-fields { flex: 1 1 240px; min-width: 0; }

    .file-btn { position: relative; overflow: hidden; }
    .file-btn input[type="file"] {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      font-size: 0;
    }

    .edit-actions {
      position: sticky;
      bottom: 0;
      display: flex;
      gap: 9px;
      justify-content: flex-end;
      flex-wrap: wrap;
      margin-top: 18px;
      padding: 14px 0 2px;
      background: linear-gradient(to top, rgba(14, 20, 34, 0.98) 55%, rgba(14, 20, 34, 0));
    }

    .edit-actions .spacer { flex: 1; }

    @media (max-width: 720px) {
      .detail-body { grid-template-columns: 1fr; }
      .detail-poster { min-height: 220px; max-height: 300px; }
      .form-grid { grid-template-columns: 1fr; }
    }

    /* ---------- Local player ---------- */

    .player-modal {
      width: min(1100px, 100%);
      padding: 0;
      overflow: hidden;
      background: #05080f;
      display: flex;
      flex-direction: column;
    }

    /* Keep in step with .modal's max-height and the bar's own height. */
    :root { --player-media-max: calc(min(86vh, 760px) - 104px); }

    .player-frame {
      position: relative;
      background: #000;
      line-height: 0;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .player-frame video {
      width: 100%;
      max-height: var(--player-media-max);
      display: block;
      background: #000;
    }

    /* An element selector setting display:block outranks the hidden attribute's
       user-agent rule, which left an empty video player showing over the comic
       reader and the photo viewer. */
    .player-frame video[hidden],
    .player-frame img[hidden] {
      display: none;
    }

    .player-bar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      flex-wrap: wrap;
      line-height: 1.4;
    }

    .player-title {
      font-weight: 800;
      font-size: 0.95rem;
      color: var(--text);
      flex: 1 1 240px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .player-note {
      color: var(--faint);
      font-size: 0.73rem;
      font-weight: 600;
      flex: 1 1 100%;
    }

    .player-note.warn { color: #fcd34d; }

    /* ---------- Photo viewer ---------- */

    .viewer-image {
      width: 100%;
      max-height: var(--player-media-max);
      object-fit: contain;
      display: block;
      background: #000;
    }

    .viewer-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 46px;
      height: 46px;
      border-radius: 999px;
      border: 1px solid var(--stroke-hi);
      background: rgba(6, 11, 22, 0.72);
      color: #fff;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      backdrop-filter: blur(8px);
      opacity: 0;
      transition: opacity 220ms var(--ease-soft), background 200ms var(--ease-soft);
      z-index: 3;
    }

    .player-frame:hover .viewer-nav,
    .viewer-nav:focus-visible { opacity: 1; }

    .viewer-nav:hover { background: rgba(251, 146, 60, 0.35); }
    .viewer-nav.prev { left: 14px; }
    .viewer-nav.next { right: 14px; }
    .viewer-nav[hidden] { display: none; }

    /* Photos in the grid are landscape more often than not. */
    .movie-card.is-photo { aspect-ratio: 4 / 3; }
    .movie-card.is-photo .movie-plot { display: none; }

    /* The poster scrim is sized for tall artwork where the lower half is text.
       On a short photo card it would swallow most of the picture. */
    .movie-card.is-photo .movie-overlay {
      background: linear-gradient(
        to top,
        rgba(4, 8, 16, 0.9) 0%,
        rgba(4, 8, 16, 0.55) 22%,
        transparent 48%
      );
    }

    .movie-card.is-photo:hover .movie-overlay {
      background: linear-gradient(
        to top,
        rgba(4, 8, 16, 0.94) 0%,
        rgba(4, 8, 16, 0.7) 34%,
        rgba(4, 8, 16, 0.25) 70%,
        transparent 100%
      );
    }

    /* ---------- Comic reader ---------- */

    /* Comic covers are portrait like a book, not like a film poster. */
    .movie-card.is-comic { aspect-ratio: 2 / 3; }

    .movie-card.is-comic .movie-plot { display: none; }

    .reader-page {
      width: 100%;
      max-height: var(--player-media-max);
      object-fit: contain;
      display: block;
      background: #05080f;
    }

    .reader-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 18px;
      flex-wrap: wrap;
    }

    .reader-progress {
      flex: 1 1 160px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
      overflow: hidden;
      min-width: 120px;
    }

    .reader-progress span {
      display: block;
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, var(--accent), #fdba74);
      transition: width 260ms var(--ease);
    }

    .reader-count {
      color: var(--muted);
      font-size: 0.76rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    /* ---------- Book reader ---------- */

    .book-modal {
      width: min(1180px, 100%);
      max-width: 100%;
      /* An iframe has no intrinsic height, so the reader is sized explicitly
         rather than left to collapse around its content. */
      height: min(92vh, 900px);
      max-height: min(92vh, 900px);
      padding: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: var(--panel);
    }

    .book-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 56px 14px 18px;
      border-bottom: 1px solid var(--stroke);
    }

    .book-heading {
      flex: 1 1 auto;
      min-width: 0;
    }

    .book-heading strong {
      display: block;
      font-size: 0.95rem;
      font-weight: 800;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .book-heading span {
      display: block;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--faint);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .book-head .neu-btn {
      flex: 0 0 auto;
      padding: 8px 12px;
      font-size: 0.72rem;
    }

    .book-body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
    }

    /* Contents and notes share the side rail; only one is open at a time. */
    .book-side {
      flex: 0 0 288px;
      min-width: 0;
      border-right: 1px solid var(--stroke);
      display: flex;
      flex-direction: column;
      background: rgba(6, 10, 18, 0.35);
      animation: side-in 220ms var(--ease);
    }

    .book-side[hidden] { display: none; }

    @keyframes side-in {
      from { opacity: 0; transform: translateX(-10px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    .book-side-tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 6px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--stroke);
    }

    .book-side-tab {
      flex: 1 1 0;
      min-width: 0;
      padding: 7px 8px;
      border-radius: 9px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--faint);
      font: inherit;
      font-size: 0.72rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 160ms var(--ease), color 160ms var(--ease);
    }

    .book-side-tab:hover { color: var(--text); background: rgba(255, 255, 255, 0.05); }

    .book-side-tab.active {
      color: var(--text);
      background: rgba(255, 255, 255, 0.08);
      border-color: var(--stroke-hi);
    }

    .book-side-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 8px;
    }

    .book-side-list[hidden] { display: none; }

    .book-toc-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 8px 10px;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 0.78rem;
      line-height: 1.35;
      cursor: pointer;
      transition: background 150ms var(--ease), color 150ms var(--ease);
    }

    .book-toc-item:hover { background: rgba(255, 255, 255, 0.06); color: var(--text); }

    .book-toc-item.current {
      background: rgba(96, 165, 250, 0.16);
      color: var(--text);
      font-weight: 700;
    }

    .book-toc-item.depth-1 { padding-left: 24px; font-size: 0.74rem; }
    .book-toc-item.depth-2 { padding-left: 38px; font-size: 0.72rem; }

    .book-note-card {
      position: relative;
      padding: 10px 30px 10px 12px;
      margin-bottom: 8px;
      border-radius: 11px;
      border: 1px solid var(--stroke);
      border-left: 3px solid var(--note-accent, #facc15);
      background: rgba(255, 255, 255, 0.035);
      cursor: pointer;
      transition: background 150ms var(--ease), transform 150ms var(--ease);
    }

    .book-note-card:hover { background: rgba(255, 255, 255, 0.07); transform: translateX(2px); }

    .book-note-kind {
      display: block;
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--faint);
      margin-bottom: 3px;
    }

    .book-note-text {
      display: block;
      font-size: 0.76rem;
      line-height: 1.4;
      color: var(--text);
    }

    .book-note-body {
      display: block;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed var(--stroke);
      font-size: 0.73rem;
      line-height: 1.4;
      color: var(--muted);
      font-style: italic;
    }

    .book-note-remove {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--faint);
      font-size: 0.9rem;
      line-height: 1;
      cursor: pointer;
    }

    .book-note-remove:hover { background: rgba(248, 113, 113, 0.18); color: #fca5a5; }

    .book-side-empty {
      padding: 18px 12px;
      font-size: 0.76rem;
      color: var(--faint);
      text-align: center;
      line-height: 1.5;
    }

    .book-stage {
      position: relative;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }

    #bookFrame {
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      border: 0;
      background: var(--book-bg, #f6f1e6);
    }

    .book-foot {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 18px;
      border-top: 1px solid var(--stroke);
    }

    .book-foot .neu-btn { padding: 8px 14px; font-size: 0.72rem; }

    .book-position {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--faint);
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .book-rail {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      background: rgba(255, 255, 255, 0.07);
    }

    .book-rail span {
      display: block;
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width 240ms var(--ease);
    }

    /* Selection toolbar, positioned over the text being marked. */
    .book-tools {
      position: absolute;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 8px;
      border-radius: 12px;
      border: 1px solid var(--stroke-hi);
      background: rgba(16, 22, 36, 0.97);
      box-shadow: var(--shadow-lg);
      animation: tools-in 160ms var(--ease);
    }

    .book-tools[hidden] { display: none; }

    @keyframes tools-in {
      from { opacity: 0; transform: translateY(6px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .book-swatch {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.28);
      cursor: pointer;
      padding: 0;
      transition: transform 150ms var(--ease), border-color 150ms var(--ease);
    }

    .book-swatch:hover { transform: scale(1.16); border-color: #fff; }

    .book-swatch.yellow { background: #facc15; }
    .book-swatch.green  { background: #4ade80; }
    .book-swatch.blue   { background: #60a5fa; }
    .book-swatch.pink   { background: #f472b6; }
    .book-swatch.purple { background: #c084fc; }

    .book-tools .neu-btn { padding: 6px 10px; font-size: 0.68rem; }

    .book-tools-divider {
      width: 1px;
      height: 20px;
      background: var(--stroke-hi);
    }

    /* Type controls, shown from the Aa button. */
    .book-type {
      position: absolute;
      top: 8px;
      right: 14px;
      z-index: 6;
      width: 248px;
      padding: 14px;
      border-radius: 14px;
      border: 1px solid var(--stroke-hi);
      background: rgba(16, 22, 36, 0.98);
      box-shadow: var(--shadow-lg);
      animation: tools-in 180ms var(--ease);
    }

    .book-type[hidden] { display: none; }

    .book-type-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 12px;
    }

    .book-type-row:last-child { margin-bottom: 0; }

    .book-type-row label {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--muted);
    }

    .book-type-row input[type="range"] { flex: 1 1 auto; min-width: 0; }

    .book-theme-group { display: flex; gap: 6px; }

    .book-theme {
      width: 30px;
      height: 26px;
      border-radius: 8px;
      border: 2px solid var(--stroke-hi);
      cursor: pointer;
      padding: 0;
      transition: transform 150ms var(--ease), border-color 150ms var(--ease);
    }

    .book-theme:hover { transform: translateY(-1px); }
    .book-theme.active { border-color: var(--accent); }

    .book-theme.light { background: #ffffff; }
    .book-theme.sepia { background: #f6ecd8; }
    .book-theme.night { background: #14181f; }

    /* Read-aloud bar, shown under the book while speech is running. */
    .book-speech {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 18px;
      border-top: 1px solid var(--stroke);
      background: rgba(96, 165, 250, 0.07);
      animation: side-in 200ms var(--ease);
    }

    .book-speech[hidden] { display: none; }

    .book-speech .neu-btn { padding: 8px 12px; font-size: 0.7rem; }

    .book-speech-status {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .book-speech-status.warn { color: #fcd34d; }

    .book-speech select {
      max-width: 190px;
      padding: 7px 10px;
      font-size: 0.7rem;
    }

    .book-speech-rate {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--faint);
    }

    .book-speech-rate input { width: 96px; }

    /* The sentence being spoken, marked inside the book's own frame. */
    .book-modal.is-fullscreen,
    .book-modal.is-fullscreen,
    .book-modal:fullscreen {
      width: 100vw;
      max-width: 100vw;
      max-height: 100vh;
      border: 0;
      border-radius: 0;
    }

    @media (max-width: 780px) {
      .book-side { position: absolute; inset: 0 auto 0 0; z-index: 4; flex-basis: 82%; }
      .book-body { position: relative; }
    }

    /* ---------- Fullscreen ---------- */

    /* The panel itself goes fullscreen so the page controls stay reachable. */
    .player-modal.is-fullscreen,
    .player-modal:fullscreen {
      width: 100vw;
      max-width: 100vw;
      max-height: 100vh;
      border: 0;
      border-radius: 0;
      display: flex;
      flex-direction: column;
      background: #05080f;
    }

    .player-modal.is-fullscreen .player-frame,
    .player-modal:fullscreen .player-frame {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
    }

    .player-modal.is-fullscreen .reader-page,
    .player-modal.is-fullscreen .viewer-image,
    .player-modal.is-fullscreen video,
    .player-modal:fullscreen .reader-page,
    .player-modal:fullscreen .viewer-image,
    .player-modal:fullscreen video {
      max-height: calc(100vh - 64px);
      width: auto;
      max-width: 100vw;
      margin: 0 auto;
    }

    .player-modal.is-fullscreen .player-bar,
    .player-modal:fullscreen .player-bar {
      flex: none;
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

    /* That frame is short: hiding the synopsis and holding the title to one
       line leaves room for Play and Watched at their full height. */
    .movie-card.is-episode .movie-plot { display: none; }

    .movie-card.is-episode .movie-title {
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .movie-card.is-episode .movie-overlay { gap: 4px; }

    .movie-card.is-episode:hover .movie-overlay .button-row { margin-top: 8px; }

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

  <div class="modal-backdrop" id="playerModal" hidden>
    <div class="modal player-modal" role="dialog" aria-modal="true" aria-labelledby="playerTitle">
      <button class="modal-close" id="playerClose" aria-label="Close player">&times;</button>
      <div class="player-frame">
        <video id="playerVideo" controls playsinline preload="metadata"></video>
        <img id="playerImage" class="viewer-image" alt="" hidden />
        <img id="readerPage" class="reader-page" alt="" hidden />
        <button type="button" class="viewer-nav prev" id="viewerPrev" aria-label="Previous photo" hidden>&#8249;</button>
        <button type="button" class="viewer-nav next" id="viewerNext" aria-label="Next photo" hidden>&#8250;</button>
      </div>
      <div class="player-bar">
        <span class="player-title" id="playerTitle"></span>
        <button class="neu-btn secondary" id="playerTranscode">Force Transcode</button>
        <button class="neu-btn secondary" id="playerFullscreen">Fullscreen</button>
        <span class="reader-count" id="readerCount" hidden></span>
        <div class="reader-progress" id="readerProgress" hidden><span id="readerProgressFill"></span></div>
        <span class="player-note" id="playerNote"></span>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="bookModal" hidden>
    <div class="modal book-modal" role="dialog" aria-modal="true" aria-labelledby="bookTitle">
      <button class="modal-close" id="bookClose" aria-label="Close book">&times;</button>

      <div class="book-head">
        <button class="neu-btn secondary" id="bookSideToggle" aria-expanded="false">Contents</button>
        <div class="book-heading">
          <strong id="bookTitle"></strong>
          <span id="bookAuthor"></span>
        </div>
        <button class="neu-btn secondary" id="bookListen">Read Aloud</button>
        <button class="neu-btn secondary" id="bookType" aria-expanded="false">Aa</button>
        <button class="neu-btn secondary" id="bookMark">Bookmark</button>
        <button class="neu-btn secondary" id="bookFullscreen">Fullscreen</button>
      </div>

      <div class="book-body">
        <aside class="book-side" id="bookSide" hidden>
          <div class="book-side-tabs">
            <button class="book-side-tab active" id="bookTabToc">Contents</button>
            <button class="book-side-tab" id="bookTabNotes">Notes</button>
          </div>
          <div class="book-side-list" id="bookTocList"></div>
          <div class="book-side-list" id="bookNotesList" hidden></div>
        </aside>

        <div class="book-stage" id="bookStage">
          <iframe id="bookFrame" title="Book text" sandbox="allow-same-origin"></iframe>

          <div class="book-tools" id="bookTools" hidden>
            <button class="book-swatch yellow" data-color="yellow" title="Highlight yellow"></button>
            <button class="book-swatch green" data-color="green" title="Highlight green"></button>
            <button class="book-swatch blue" data-color="blue" title="Highlight blue"></button>
            <button class="book-swatch pink" data-color="pink" title="Highlight pink"></button>
            <button class="book-swatch purple" data-color="purple" title="Highlight purple"></button>
            <span class="book-tools-divider"></span>
            <button class="neu-btn secondary" id="bookAddNote">Note</button>
            <button class="neu-btn secondary" id="bookCopy">Copy</button>
          </div>

          <div class="book-type" id="bookTypePanel" hidden>
            <div class="book-type-row">
              <label for="bookFontSize">Size</label>
              <input type="range" id="bookFontSize" min="80" max="200" step="5" value="110" />
            </div>
            <div class="book-type-row">
              <label for="bookLineHeight">Spacing</label>
              <input type="range" id="bookLineHeight" min="120" max="240" step="10" value="170" />
            </div>
            <div class="book-type-row">
              <label for="bookWidth">Margins</label>
              <input type="range" id="bookWidth" min="480" max="1000" step="20" value="720" />
            </div>
            <div class="book-type-row">
              <label>Theme</label>
              <div class="book-theme-group">
                <button class="book-theme light" data-theme="light" title="Light"></button>
                <button class="book-theme sepia active" data-theme="sepia" title="Sepia"></button>
                <button class="book-theme night" data-theme="night" title="Night"></button>
              </div>
            </div>
          </div>

          <div class="book-rail"><span id="bookRailFill"></span></div>
        </div>
      </div>

      <div class="book-speech" id="bookSpeechBar" hidden>
        <button class="neu-btn" id="speechToggle">Pause</button>
        <button class="neu-btn secondary" id="speechPrev" aria-label="Previous sentence">&#8249;</button>
        <button class="neu-btn secondary" id="speechNext" aria-label="Next sentence">&#8250;</button>
        <span class="book-speech-status" id="speechStatus"></span>
        <label class="book-speech-rate" for="speechRate">Speed
          <input type="range" id="speechRate" min="0.6" max="1.6" step="0.05" value="1" />
          <span id="speechRateLabel">1.0&times;</span>
        </label>
        <select class="sort-select" id="speechVoice" aria-label="Voice"></select>
        <button class="neu-btn secondary" id="speechStop">Stop</button>
      </div>

      <div class="book-foot">
        <button class="neu-btn secondary" id="bookPrev">&#8249; Previous</button>
        <span class="book-position" id="bookPosition"></span>
        <button class="neu-btn secondary" id="bookNext">Next &#8250;</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="detailModal" hidden>
    <div class="modal detail-modal" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
      <button class="modal-close" id="detailClose" aria-label="Close">&times;</button>
      <input type="file" id="detailPosterFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />

      <div class="detail-body">
        <div class="detail-poster" id="detailPosterWrap"></div>
        <div class="detail-info">
          <h2 class="modal-title" id="detailTitle"></h2>
          <div class="detail-meta" id="detailMeta"></div>
          <p class="detail-plot" id="detailPlot"></p>
          <div class="detail-file" id="detailFile"></div>
          <div class="track-section" id="trackSection" hidden>
            <div class="track-row" id="audioRow" hidden>
              <label class="field-label" for="audioSelect">Audio track</label>
              <select class="sort-select track-select" id="audioSelect"></select>
            </div>
            <div class="track-row" id="subtitleRow">
              <label class="field-label" for="subtitleSelect">Subtitles</label>
              <select class="sort-select track-select" id="subtitleSelect"></select>
              <div class="track-actions">
                <button type="button" class="neu-btn secondary file-btn" id="subtitleLoadBtn">
                  Load Subtitle File
                  <input type="file" id="subtitleFile" accept=".srt,.vtt,.ass,.ssa,text/plain" />
                </button>
                <button type="button" class="neu-btn secondary" id="subtitleFindBtn">Find Online</button>
              </div>
            </div>
            <div class="track-note" id="trackNote"></div>
          </div>

          <div class="modal-actions detail-actions">
            <button class="neu-btn" id="detailPlay">Play</button>
            <button class="neu-btn secondary" id="detailPlayHere">Play Here</button>
            <button class="neu-btn secondary" id="detailWatched">Watched</button>
            <button class="neu-btn secondary" id="detailEdit">Edit Info</button>
          </div>
        </div>
      </div>

      <div class="detail-edit" id="detailEditForm" hidden>
        <div class="form-grid">
          <div class="form-field">
            <label class="field-label" for="editTitle">Title</label>
            <input class="text-input" id="editTitle" type="text" maxlength="300" autocomplete="off" />
          </div>
          <div class="form-field">
            <label class="field-label" for="editYear">Year</label>
            <input class="text-input" id="editYear" type="text" maxlength="12" autocomplete="off" />
          </div>
        </div>

        <label class="field-label" for="editPlot">Synopsis</label>
        <textarea class="text-input" id="editPlot" maxlength="4000"></textarea>

        <div class="cover-row">
          <img class="cover-preview" id="editCoverPreview" alt="" />
          <div class="cover-fields">
            <label class="field-label" for="editPoster">Cover image URL</label>
            <input class="text-input" id="editPoster" type="text" maxlength="2000" placeholder="https://... or choose a file" autocomplete="off" />
          </div>
          <button type="button" class="neu-btn secondary file-btn" id="editCoverBtn">
            Choose Image
            <input type="file" id="editCoverFile" accept="image/png,image/jpeg,image/webp,image/gif" />
          </button>
        </div>

        <div class="edit-actions">
          <button type="button" class="neu-btn danger" id="editReset">Reset To Original</button>
          <span class="spacer"></span>
          <button type="button" class="neu-btn secondary" id="editCancel">Cancel</button>
          <button type="button" class="neu-btn" id="editSave">Save Changes</button>
        </div>
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
    let rendererCount = 0;
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
    const detailModal = document.getElementById('detailModal');
    const detailClose = document.getElementById('detailClose');
    const detailPosterWrap = document.getElementById('detailPosterWrap');
    const detailPosterFile = document.getElementById('detailPosterFile');
    const detailTitle = document.getElementById('detailTitle');
    const detailMeta = document.getElementById('detailMeta');
    const detailPlot = document.getElementById('detailPlot');
    const detailFile = document.getElementById('detailFile');
    const detailPlay = document.getElementById('detailPlay');
    const detailPlayHere = document.getElementById('detailPlayHere');
    const playerModal = document.getElementById('playerModal');
    const playerVideo = document.getElementById('playerVideo');
    const playerTitle = document.getElementById('playerTitle');
    const playerNote = document.getElementById('playerNote');
    const playerClose = document.getElementById('playerClose');
    const playerTranscode = document.getElementById('playerTranscode');
    const playerFullscreen = document.getElementById('playerFullscreen');
    const playerImage = document.getElementById('playerImage');
    const viewerPrev = document.getElementById('viewerPrev');
    const viewerNext = document.getElementById('viewerNext');
    const readerPage = document.getElementById('readerPage');
    const readerCount = document.getElementById('readerCount');
    const readerProgress = document.getElementById('readerProgress');
    const readerProgressFill = document.getElementById('readerProgressFill');
    let readerComic = null;
    let readerIndex = 0;
    let readerPageCount = 0;
    // Bookmarks, by the same key the watched list uses: key -> { page, pageCount }.
    const comicProgressByKey = new Map();
    // Only offer Resume once there is a meaningful amount to come back to.
    const COMIC_RESUME_MIN_PAGE = 5;
    let comicProgressTimer = null;
    // Sentences of the chapter on screen, offset into its own text.
    let bookChapterSentences = [];
    let viewerList = [];
    let viewerIndex = -1;
    let playerItem = null;
    let playerReportTimer = null;
    let playerUsedTranscode = false;
    let playerLastTracks = null;
    const detailWatched = document.getElementById('detailWatched');
    const detailEdit = document.getElementById('detailEdit');
    const detailEditForm = document.getElementById('detailEditForm');
    const editTitle = document.getElementById('editTitle');
    const editYear = document.getElementById('editYear');
    const editPlot = document.getElementById('editPlot');
    const editPoster = document.getElementById('editPoster');
    const editCoverPreview = document.getElementById('editCoverPreview');
    const editCoverFile = document.getElementById('editCoverFile');
    const editReset = document.getElementById('editReset');
    const editCancel = document.getElementById('editCancel');
    const editSave = document.getElementById('editSave');
    const trackSection = document.getElementById('trackSection');
    const audioRow = document.getElementById('audioRow');
    const audioSelect = document.getElementById('audioSelect');
    const subtitleSelect = document.getElementById('subtitleSelect');
    const subtitleFile = document.getElementById('subtitleFile');
    const subtitleFindBtn = document.getElementById('subtitleFindBtn');
    const trackNote = document.getElementById('trackNote');
    let detailItem = null;
    // Set when the dialog is showing a show or comic tile rather than one file.
    let detailGroup = null;
    let detailCard = null;
    let detailTracks = null;
    let pendingCoverDataUrl = '';
    let detailPosterFileHandler = null;
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

    // Repaint a card's artwork only when the URL actually changed.
    function syncCardPoster(card, posterUrl, altText) {
      const existing = card.querySelector('img');

      if (posterUrl) {
        if (existing) {
          if (existing.getAttribute('src') === posterUrl) {
            return;
          }
          existing.alt = altText || '';
          attachPosterLoader(card, existing);
          existing.src = posterUrl;
          return;
        }

        const placeholder = card.querySelector('.placeholder');
        if (placeholder) {
          placeholder.remove();
        }

        const img = document.createElement('img');
        // A card already on the page gets its poster eagerly: lazy loading only
        // helps the initial bulk render, and deferring here can leave the
        // loading shimmer up on a card the user is already looking at.
        img.loading = card.isConnected ? 'eager' : 'lazy';
        img.alt = altText || '';
        attachPosterLoader(card, img);
        img.onerror = () => {
          img.remove();
          addCardPlaceholder(card);
        };
        img.src = posterUrl;
        card.insertBefore(img, card.firstChild);
        return;
      }

      if (existing) {
        existing.remove();
      }
      if (!card.querySelector('.placeholder')) {
        addCardPlaceholder(card);
      }
    }

    function addCardPlaceholder(card) {
      const fallback = document.createElement('div');
      fallback.className = 'placeholder';
      fallback.textContent = '▶';
      card.insertBefore(fallback, card.firstChild);
      return fallback;
    }

    function movieMetaText(item) {
      const parts = [];
      if (item.year) parts.push(item.year);
      if (item.imdbRating) parts.push((item.ratingSource || 'IMDb') + ' ' + item.imdbRating + '/10');
      if (Number.isFinite(item.size)) parts.push(formatSize(item.size));
      return parts.join(' • ');
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

    function plural(count, word) {
      return count + ' ' + word + (count === 1 ? '' : 's');
    }

    // Comics reuse the show grouping, so the wording has to follow the category.
    function categoryNouns(category) {
      if (category === 'comics') {
        return { group: 'comic', groupPlural: 'comics', item: 'book', section: 'Books', volume: 'volume' };
      }
      return { group: 'show', groupPlural: 'shows', item: 'episode', section: 'Episodes', volume: 'season' };
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

        rendererCount = renderers.length;

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

    function playOnThisDevice(item) {
      if (isBookItem(item)) {
        openBookReader(item);
      } else if (isComicItem(item)) {
        openComicReader(item);
      } else if (isImageItem(item)) {
        openImageViewer(item);
      } else {
        openLocalPlayer(item);
      }
    }

    async function castItem(item, button, options) {
      if (isBookItem(item)) {
        setStatus('Books are read on this device and cannot be cast.', true);
        return;
      }

      if (isComicItem(item)) {
        setStatus('Comics are read on this device and cannot be cast.', true);
        return;
      }

      // With nothing on the network to cast to, play here rather than failing.
      if (rendererCount === 0) {
        setStatus('No renderer found - playing on this device.');
        playOnThisDevice(item);
        return;
      }

      const choices = options && typeof options === 'object' ? options : {};
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
          body: JSON.stringify({
          id: item.id,
          resume: resumeSeconds > 0,
          audioStreamIndex: Number.isFinite(choices.audioStreamIndex) ? choices.audioStreamIndex : null,
          subtitleMode: choices.subtitleMode || '',
        }),
        });
        const result = await response.json();
        if (response.status === 503 && /no renderer/i.test(String(result.error || ''))) {
          setStatus('No renderer found - playing on this device.');
          playOnThisDevice(item);
          return;
        }
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

      const isRead = Boolean(card.__item
        && (card.__item.mediaType === 'comic' || card.__item.mediaType === 'book'));
      if (isRead) {
        watchedButton.textContent = isWatched ? 'Not Done' : 'Done';
      } else {
        watchedButton.textContent = isWatched ? 'Unmark' : 'Watched';
      }

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
        if (item.mediaType === 'image') {
          card.classList.add('is-photo');
        } else if (item.mediaType === 'comic') {
          card.classList.add('is-comic');
        } else if (item.seasonNumber !== null && item.seasonNumber !== undefined) {
          card.classList.add('is-episode');
        }
        card.__mediaId = item.id;
        card.__item = item;
        card.__watchedKey = item.watchedKey || item.filePath || item.id;

        syncCardPoster(card, item.posterUrl, item.movieTitle || item.name);

        const overlay = document.createElement('div');
        overlay.className = 'movie-overlay';

        const title = document.createElement('h3');
        title.className = 'movie-title';
        title.textContent = item.movieTitle || item.name;

        const meta = document.createElement('div');
        meta.className = 'movie-meta';
        meta.textContent = movieMetaText(item);

        const plot = document.createElement('p');
        plot.className = 'movie-plot';
        plot.textContent = item.plot || 'No synopsis available for this title.';

        const playButton = document.createElement('button');
        playButton.className = 'neu-btn';
        playButton.dataset.role = 'play';
        let initialResumeInfo = getResumeInfo(item);
        function updatePlayButtonText() {
            // Books and comics are read here; no renderer state applies.
            if (isBookItem(item)) {
              applyBookPlayLabel(playButton, item);
              return;
            }

            if (isComicItem(item)) {
              applyComicPlayLabel(playButton, item);
              return;
            }

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
          if (isBookItem(item)) {
            openBookReader(item);
            return;
          }
          if (isComicItem(item)) {
            openComicReader(item);
            return;
          }
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
            if (isBookItem(item)) {
              bookProgressByKey.delete(bookKeyOf(item));
              applyBookPlayLabel(playButton, item);
            } else if (isComicItem(item)) {
              comicProgressByKey.delete(comicProgressKey(item));
              applyComicPlayLabel(playButton, item);
            } else {
              playButton.textContent = 'Play';
              playButton.classList.remove('resume');
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
        // Update resume badge to match play button state
        setResumeCardState(card, Boolean(initialResumeInfo) || Boolean(findActiveSessionByMediaId(item.id)));

        // The tile opens details; casting is reserved for the Play button so a
        // stray click on artwork never starts playback.
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.addEventListener('click', () => openDetailModal(item, card));
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openDetailModal(item, card);
          }
        });

        // Refresh this card's contents without recreating it, so background
        // metadata updates do not restart entrance animations or reload posters.
        card.__patch = (nextItem) => {
          item = nextItem;
          card.__item = nextItem;
          card.__watchedKey = nextItem.watchedKey || nextItem.filePath || nextItem.id;

          title.textContent = nextItem.movieTitle || nextItem.name;
          meta.textContent = movieMetaText(nextItem);
          plot.textContent = nextItem.plot || 'No synopsis available for this title.';
          syncCardPoster(card, nextItem.posterUrl, nextItem.movieTitle || nextItem.name);

          initialResumeInfo = getResumeInfo(nextItem);
          updatePlayButtonText();
          setWatchedCardState(card, watchedButton, watchedItemIds.has(card.__watchedKey));
          setResumeCardState(
            card,
            Boolean(initialResumeInfo) || Boolean(findActiveSessionByMediaId(nextItem.id)),
          );
        };

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
      syncCardPoster(card, posterUrl, group.displayTitle || group.name);

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
      metaParts.push(plural(getGroupEpisodeCount(group), categoryNouns(currentCategory).item));
      meta.textContent = metaParts.join(' • ');

      const plot = document.createElement('p');
      plot.className = 'movie-plot';
      plot.textContent = group.plot || (representative && representative.plot) || 'No synopsis available for this show.';

      const viewButton = document.createElement('button');
      viewButton.className = 'neu-btn';
      viewButton.dataset.role = 'view';
      viewButton.textContent = 'View';
      viewButton.addEventListener('click', (event) => {
        event.stopPropagation();
        selectedShowName = group.name;
        expandedSeasonName = null;
        renderSelectedShowPage();
      });

      // Fetched details are often wrong for a folder name, so the tile itself
      // can be corrected without opening the show.
      const editButton = document.createElement('button');
      editButton.className = 'neu-btn secondary';
      editButton.dataset.role = 'edit-group';
      editButton.textContent = 'Edit';
      editButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openGroupDetail(group);
      });

      const buttonRow = document.createElement('div');
      buttonRow.className = 'button-row';
      buttonRow.appendChild(viewButton);
      buttonRow.appendChild(editButton);

      overlay.appendChild(title);
      overlay.appendChild(meta);
      overlay.appendChild(plot);
      overlay.appendChild(buttonRow);

      card.addEventListener('click', () => {
        selectedShowName = group.name;
        expandedSeasonName = null;
        renderSelectedShowPage();
      });

      card.__patch = (nextGroup) => {
        group = nextGroup;
        const nextRep = getGroupRepresentative(nextGroup);
        const nouns = categoryNouns(currentCategory);
        title.textContent = nextGroup.displayTitle || nextGroup.name;

        const nextParts = [];
        if (nextGroup.year || (nextRep && nextRep.year)) {
          nextParts.push(nextGroup.year || nextRep.year);
        }
        if (nextGroup.imdbRating || (nextRep && nextRep.imdbRating)) {
          const label = nextGroup.ratingSource || (nextRep && nextRep.ratingSource) || 'IMDb';
          nextParts.push(label + ' ' + (nextGroup.imdbRating || nextRep.imdbRating) + '/10');
        }
        nextParts.push(plural(getGroupEpisodeCount(nextGroup), nouns.item));
        meta.textContent = nextParts.join(' • ');

        plot.textContent = nextGroup.plot
          || (nextRep && nextRep.plot)
          || 'No synopsis available for this show.';
        syncCardPoster(
          card,
          nextGroup.posterUrl || (nextRep && nextRep.posterUrl),
          nextGroup.displayTitle || nextGroup.name,
        );
      };

      card.appendChild(overlay);
      return card;
    }

    function createSeasonCard(showName, season) {
      const representative = getSeasonRepresentative(season);
      const card = document.createElement('article');
      card.className = 'movie-card';

      syncCardPoster(card, representative && representative.posterUrl, season.name);

      const overlay = document.createElement('div');
      overlay.className = 'movie-overlay';

      const title = document.createElement('h3');
      title.className = 'movie-title';
      title.textContent = season.name;

      const meta = document.createElement('div');
      meta.className = 'movie-meta';
      meta.textContent = plural((season.items || []).length, categoryNouns(currentCategory).item);

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

      card.__patch = (nextSeason) => {
        season = nextSeason;
        const nextRep = getSeasonRepresentative(nextSeason);
        title.textContent = nextSeason.name;
        meta.textContent = plural((nextSeason.items || []).length, categoryNouns(currentCategory).item);
        syncCardPoster(card, nextRep && nextRep.posterUrl, nextSeason.name);
      };

      card.appendChild(overlay);
      return card;
    }

    function patchCards(target, list, selector) {
      const cards = target.querySelectorAll(selector);
      if (cards.length !== list.length) {
        return false;
      }
      for (let index = 0; index < list.length; index += 1) {
        if (typeof cards[index].__patch !== 'function') {
          return false;
        }
      }
      for (let index = 0; index < list.length; index += 1) {
        cards[index].__patch(list[index]);
      }
      return true;
    }

    function renderItems(items, noFolders, category, container) {
      const target = container || grid;

      if (!items.length) {
        target.__signature = '';
        target.innerHTML = '';
        target.appendChild(createEmptyState(noFolders, category));
        return;
      }

      // Same items as last time means an in-place refresh, which avoids the
      // teardown that made the grid flicker while metadata streamed in.
      const signature = 'items:' + items.map((item) => item.id).join('|');
      if (target.__signature === signature
        && patchCards(target, items, ':scope > .movie-card')) {
        return;
      }

      target.innerHTML = '';
      for (const item of items) {
        target.appendChild(createMovieCard(item));
      }

      applyStagger(target);
      target.__signature = signature;
    }

    function renderGroupedItems(groups, noFolders, category) {
      if (!groups.length) {
        grid.__signature = '';
        grid.innerHTML = '';
        grid.appendChild(createEmptyState(noFolders, category));
        return;
      }

      const signature = 'groups:' + category + ':' + groups.map((group) => group.name).join('|');
      if (grid.__signature === signature
        && patchCards(grid, groups, ':scope > .movie-card')) {
        return;
      }

      grid.innerHTML = '';
      for (const group of groups) {
        grid.appendChild(createShowCard(group));
      }

      applyStagger(grid);
      grid.__signature = signature;
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

      const seasons = Array.isArray(selected.seasons) ? selected.seasons : [];
      const expandedSeason = expandedSeasonName
        ? seasons.find((season) => season.name === expandedSeasonName)
        : null;
      const episodes = expandedSeason ? (expandedSeason.items || []) : [];

      // Refresh the existing season and episode cards when the page is showing
      // the same content, so streaming metadata does not rebuild the view.
      const signature = 'show:' + selectedShowName
        + ':' + (expandedSeasonName || '')
        + ':' + seasons.map((season) => season.name).join('|')
        + ':' + episodes.map((item) => item.id).join('|');

      if (grid.__signature === signature) {
        const showTitleEl = grid.querySelector('.group-title');
        if (showTitleEl) {
          showTitleEl.textContent = selected.displayTitle || selected.name;
        }
        const seasonsOk = patchCards(grid, seasons, '[data-role="seasons"] > .movie-card');
        const episodesOk = episodes.length === 0
          || patchCards(grid, episodes, '[data-role="episodes"] > .movie-card');
        if (seasonsOk && episodesOk) {
          const patchedNouns = categoryNouns(currentCategory);
          const patchedCount = getGroupEpisodeCount(selected);
          setStatus('Viewing ' + selected.name + ' • ' + plural(seasons.length, patchedNouns.volume)
            + ' • ' + plural(patchedCount, patchedNouns.item) + '.');
          return;
        }
      }

      grid.innerHTML = '';

      const section = document.createElement('section');
      section.className = 'group-section';

      const showTitle = document.createElement('h2');
      showTitle.className = 'group-title';
      showTitle.textContent = selected.displayTitle || selected.name;
      section.appendChild(showTitle);

      const seasonGrid = document.createElement('div');
      seasonGrid.className = 'group-grid';
      seasonGrid.dataset.role = 'seasons';
      for (const season of seasons) {
        seasonGrid.appendChild(createSeasonCard(selected.name, season));
      }
      section.appendChild(seasonGrid);

      if (expandedSeason) {
        const episodesBlock = document.createElement('div');
        episodesBlock.className = 'episodes-block';

        const episodesTitle = document.createElement('h3');
        episodesTitle.className = 'episodes-title';
        episodesTitle.textContent = expandedSeason.name + ' ' + categoryNouns(currentCategory).section;

        const episodesGrid = document.createElement('div');
        episodesGrid.className = 'group-grid';
        episodesGrid.dataset.role = 'episodes';
        for (const item of episodes) {
          episodesGrid.appendChild(createMovieCard(item));
        }

        episodesBlock.appendChild(episodesTitle);
        episodesBlock.appendChild(episodesGrid);
        section.appendChild(episodesBlock);
      }

      grid.appendChild(section);
      applyStagger(section);
      grid.__signature = signature;
      const nouns = categoryNouns(currentCategory);
      const seasonCount = seasons.length;
      const episodeCount = getGroupEpisodeCount(selected);
      setStatus('Viewing ' + selected.name + ' • ' + plural(seasonCount, nouns.volume)
        + ' • ' + plural(episodeCount, nouns.item) + '.');
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

        bookProgressByKey.clear();
        const bookProgressPayload = result.bookProgress && typeof result.bookProgress === 'object'
          ? result.bookProgress
          : {};
        for (const [progressKey, entry] of Object.entries(bookProgressPayload)) {
          const key = String(progressKey || '').trim();
          const chapterIndex = Number(entry && entry.chapterIndex);
          if (!key || !Number.isFinite(chapterIndex) || chapterIndex < 0) {
            continue;
          }
          bookProgressByKey.set(key, {
            chapterIndex: Math.floor(chapterIndex),
            offset: Math.max(0, Math.floor(Number(entry && entry.offset) || 0)),
            percent: Math.max(0, Math.min(1, Number(entry && entry.percent) || 0)),
            label: typeof (entry && entry.label) === 'string' ? entry.label : '',
          });
        }

        comicProgressByKey.clear();
        const comicProgress = result.comicProgress && typeof result.comicProgress === 'object'
          ? result.comicProgress
          : {};
        for (const [progressKey, entry] of Object.entries(comicProgress)) {
          const key = String(progressKey || '').trim();
          const page = Number(entry && entry.page);
          if (!key || !Number.isFinite(page) || page <= 1) {
            continue;
          }
          const pageCount = Number(entry && entry.pageCount);
          comicProgressByKey.set(key, {
            page: Math.floor(page),
            pageCount: Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : null,
          });
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
              setStatus('Showing ' + plural((result.groups || []).length, categoryNouns(currentCategory).group)
                + ' in ' + categoryName + ' (' + sortLabel + ').');
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

        bookProgressByKey.clear();
        const bookProgressPayload = result.bookProgress && typeof result.bookProgress === 'object'
          ? result.bookProgress
          : {};
        for (const [progressKey, entry] of Object.entries(bookProgressPayload)) {
          const key = String(progressKey || '').trim();
          const chapterIndex = Number(entry && entry.chapterIndex);
          if (!key || !Number.isFinite(chapterIndex) || chapterIndex < 0) {
            continue;
          }
          bookProgressByKey.set(key, {
            chapterIndex: Math.floor(chapterIndex),
            offset: Math.max(0, Math.floor(Number(entry && entry.offset) || 0)),
            percent: Math.max(0, Math.min(1, Number(entry && entry.percent) || 0)),
            label: typeof (entry && entry.label) === 'string' ? entry.label : '',
          });
        }

        comicProgressByKey.clear();
        const comicProgress = result.comicProgress && typeof result.comicProgress === 'object'
          ? result.comicProgress
          : {};
        for (const [progressKey, entry] of Object.entries(comicProgress)) {
          const key = String(progressKey || '').trim();
          const page = Number(entry && entry.page);
          if (!key || !Number.isFinite(page) || page <= 1) {
            continue;
          }
          const pageCount = Number(entry && entry.pageCount);
          comicProgressByKey.set(key, {
            page: Math.floor(page),
            pageCount: Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : null,
          });
        }

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

          if (playButton && card.__item && card.__item.mediaType === 'book') {
            // A book has no playback state to reflect, only a reading position.
            applyBookPlayLabel(playButton, card.__item);
          } else if (playButton && card.__item && card.__item.mediaType === 'comic') {
            // A comic has no playback state to reflect, only a bookmark.
            applyComicPlayLabel(playButton, card.__item);
          } else if (playButton) {
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
      setStatus('Back to ' + categoryName + '. Showing '
        + plural(currentGroupedData.length, categoryNouns(currentCategory).group) + '.');
      setBackButton(false);
    });

    addFolderBtn.addEventListener('click', () => {
      openFolderModal();
    });

    // A group is not a file, so the dialog is filled from the group payload and
    // its edits are saved against the category and group name instead.
    function openGroupDetail(group) {
      detailGroup = { category: currentCategory, name: group.name };

      // A generated placeholder is shown but never offered as an editable URL,
      // otherwise Save would store the whole data: blob as the cover.
      const shownPoster = group.posterUrl || '';
      const editablePoster = /^data:/i.test(shownPoster) ? '' : shownPoster;

      detailItem = {
        id: 'group:' + currentCategory + ':' + group.name,
        name: group.name,
        movieTitle: group.displayTitle || group.name,
        year: group.year || '',
        plot: group.plot || '',
        posterUrl: editablePoster,
        mediaType: 'group',
      };
      detailCard = null;
      pendingCoverDataUrl = '';

      const nouns = categoryNouns(currentCategory);
      detailTitle.textContent = detailItem.movieTitle;

      const metaParts = [];
      if (detailItem.year) {
        metaParts.push(detailItem.year);
      }
      metaParts.push(plural(getGroupEpisodeCount(group), nouns.item));
      if (group.edited) {
        metaParts.push('edited');
      }
      detailMeta.textContent = metaParts.join('  \u00b7  ');

      detailPlot.textContent = detailItem.plot || 'No synopsis yet.';
      detailPlot.hidden = false;
      detailFile.textContent = 'Folder name: ' + group.name;

      renderDetailPoster(shownPoster, detailItem.movieTitle);

      // Nothing here plays; the dialog is purely for correcting the tile.
      detailPlay.hidden = true;
      detailPlayHere.hidden = true;
      detailWatched.hidden = true;
      detailEdit.hidden = false;
      trackSection.hidden = true;
      trackNote.textContent = '';

      detailModal.hidden = false;
      openEditForm();
      editTitle.focus();
    }

    function openDetailModal(item, card) {
      detailGroup = null;
      detailItem = item;
      detailPlayHere.hidden = false;
      detailWatched.hidden = false;
      detailCard = card || null;
      const itemIsImage = isImageItem(item);
      const itemIsComic = isComicItem(item);
      const itemIsBook = isBookItem(item);
      // Reading material shares one set of words and one set of actions.
      const itemIsRead = itemIsComic || itemIsBook;
      pendingCoverDataUrl = '';
      detailEditForm.hidden = true;
      detailEdit.textContent = 'Edit Info';

      detailTitle.textContent = item.movieTitle || item.name;

      renderDetailPoster(item.posterUrl, item.movieTitle || item.name);

      detailMeta.innerHTML = '';
      const chips = [];
      if (item.year) chips.push(String(item.year));
      if (item.imdbRating) chips.push((item.ratingSource || 'IMDb') + ' ' + item.imdbRating + '/10');
      if (item.showName) chips.push(item.showName);
      if (item.seasonLabel) chips.push(item.seasonLabel);
      if (Number.isFinite(item.size)) chips.push(formatSize(item.size));
      for (const text of chips) {
        const chip = document.createElement('span');
        chip.textContent = text;
        detailMeta.appendChild(chip);
      }
      if (item.userEdited) {
        const chip = document.createElement('span');
        chip.className = 'edited';
        chip.textContent = 'Edited by you';
        detailMeta.appendChild(chip);
      }

      detailPosterWrap.classList.toggle('is-photo', itemIsImage);
      detailPlot.hidden = false;
      // A photo or comic has no synopsis to be missing.
      detailPlot.hidden = (itemIsImage || itemIsRead) && !item.plot;
      detailPlot.textContent = item.plot || 'No synopsis available for this title.';
      detailFile.textContent = item.filePath || item.name;

      const resumeInfo = itemIsImage ? null : getResumeInfo(item);
      detailPlay.textContent = itemIsImage
        ? 'Cast To TV'
        : (resumeInfo ? 'Resume ' + formatResumeClock(resumeInfo.positionSec) : 'Play');
      detailPlay.classList.toggle('resume', Boolean(resumeInfo));
      // A renderer has no way to display a comic archive.
      detailPlay.hidden = itemIsRead;
      detailPlayHere.textContent = itemIsRead
        ? (itemIsBook ? bookPlayLabel(item) : 'Read')
        : (itemIsImage ? 'View' : 'Play Here');

      const watchedKey = item.watchedKey || item.filePath || item.id;
      const isWatched = watchedItemIds.has(watchedKey);
      detailWatched.textContent = itemIsRead
        ? (isWatched ? 'Not Done' : 'Done')
        : (isWatched ? 'Unmark' : 'Watched');
      detailWatched.classList.toggle('watched', isWatched);

      const hasRenderer = rendererCount > 0;
      detailPlayHere.classList.toggle('secondary', hasRenderer);
      detailPlay.classList.toggle('secondary', !hasRenderer);
      detailPlay.title = hasRenderer ? '' : 'No renderer found - use Play Here instead';

      trackSection.hidden = true;
      trackNote.textContent = '';
      detailModal.hidden = false;
      if (!itemIsImage && !itemIsRead) {
        loadDetailTracks(item);
      }
    }

    function addOption(select, value, label) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
      return option;
    }

    function renderTrackOptions(tracks) {
      detailTracks = tracks;
      audioSelect.innerHTML = '';
      subtitleSelect.innerHTML = '';
      trackNote.textContent = '';
      trackNote.classList.remove('warn');

      const audio = Array.isArray(tracks.audio) ? tracks.audio : [];
      const subtitles = Array.isArray(tracks.subtitles) ? tracks.subtitles : [];

      audio.forEach((track, index) => {
        addOption(audioSelect, String(track.streamIndex),
          track.label + (track.isDefault ? ' - default' : ''));
        if (track.isDefault || index === 0) {
          audioSelect.value = String(track.streamIndex);
        }
      });
      audioRow.hidden = audio.length < 2;

      addOption(subtitleSelect, 'off', 'Off');
      for (const track of subtitles) {
        if (track.extractable) {
          addOption(subtitleSelect, 'embedded:' + track.streamIndex, 'Embedded - ' + track.label);
        } else {
          const option = addOption(subtitleSelect, 'embedded:' + track.streamIndex,
            'Embedded - ' + track.label + ' (image based)');
          option.disabled = true;
        }
      }
      if (tracks.hasSidecar) {
        addOption(subtitleSelect, 'sidecar', 'Subtitle file next to the video');
      }
      if (tracks.hasUserSubtitle) {
        addOption(subtitleSelect, 'user', 'Subtitle file you loaded');
      }
      addOption(subtitleSelect, 'download', 'Download automatically');

      // Prefer something that already exists over an extraction step.
      const firstEmbedded = subtitles.find((track) => track.extractable);
      if (tracks.hasUserSubtitle) {
        subtitleSelect.value = 'user';
      } else if (tracks.hasSidecar) {
        subtitleSelect.value = 'sidecar';
      } else if (firstEmbedded) {
        subtitleSelect.value = 'embedded:' + firstEmbedded.streamIndex;
      } else {
        subtitleSelect.value = 'off';
      }

      const notes = [];
      if (tracks.probeError) {
        notes.push('Could not read tracks from this file: ' + tracks.probeError);
      } else {
        if (subtitles.length === 0) {
          notes.push('No embedded subtitles found - load a file or download one.');
        }
        if (audio.length > 1 && !tracks.canSelectAudio) {
          notes.push('Audio track switching needs transcoding, which is currently disabled.');
        }
      }

      trackNote.textContent = notes.join(' ');
      trackNote.classList.toggle('warn', Boolean(tracks.probeError));
      trackSection.hidden = false;
    }

    async function loadDetailTracks(item) {
      detailTracks = null;
      trackSection.hidden = true;
      try {
        const response = await fetch('/api/media/tracks?id=' + encodeURIComponent(item.id));
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        if (detailItem && detailItem.id === item.id && result.mediaType !== 'image') {
          renderTrackOptions(result);
        }
      } catch (error) {
        if (detailItem && detailItem.id === item.id) {
          trackNote.textContent = 'Could not read tracks: ' + error.message;
          trackNote.classList.add('warn');
          trackSection.hidden = false;
        }
      }
    }

    // Make the chosen subtitle available to the renderer before playback starts.
    async function prepareSubtitleSelection() {
      const value = String(subtitleSelect.value || 'off');

      if (value === 'off') {
        await fetch('/api/media/subtitle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: detailItem.id, mode: 'off' }),
        });
        return 'off';
      }

      let body = { id: detailItem.id, mode: value };
      if (value.indexOf('embedded:') === 0) {
        body = {
          id: detailItem.id,
          mode: 'embedded',
          streamIndex: Number(value.split(':')[1]),
        };
      }

      const response = await fetch('/api/media/subtitle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || ('HTTP ' + response.status));
      }

      return value === 'download' ? 'download' : 'sidecar';
    }

    async function playFromDetail() {
      if (!detailItem) {
        return;
      }

      detailPlay.disabled = true;
      try {
        const subtitleMode = detailTracks ? await prepareSubtitleSelection() : '';
        const audioStreamIndex = (detailTracks && !audioRow.hidden)
          ? Number(audioSelect.value)
          : null;

        const item = detailItem;
        const button = detailPlay;
        closeDetailModal();
        await castItem(item, button, {
          subtitleMode,
          audioStreamIndex: Number.isFinite(audioStreamIndex) ? audioStreamIndex : null,
        });
      } catch (error) {
        setStatus('Playback setup failed: ' + error.message, true);
      } finally {
        detailPlay.disabled = false;
      }
    }

    function reopenDetailFor(mediaId) {
      const card = [...document.querySelectorAll('.movie-card')]
        .find((element) => element.__mediaId === mediaId);
      if (card && card.__item) {
        openDetailModal(card.__item, card);
      }
    }

    function renderDetailPoster(posterUrl, altText) {
      detailPosterWrap.innerHTML = '';

      const showFallback = () => {
        const fallback = document.createElement('div');
        fallback.className = 'placeholder';
        fallback.textContent = '\u25B6';
        detailPosterWrap.insertBefore(fallback, detailPosterWrap.firstChild);
      };

      if (posterUrl) {
        const img = document.createElement('img');
        img.src = posterUrl;
        img.alt = altText || '';
        img.onerror = () => {
          img.remove();
          showFallback();
        };
        detailPosterWrap.appendChild(img);
      } else {
        showFallback();
      }

      // Overlay is rebuilt with the poster so it always sits on top.
      const overlay = document.createElement('button');
      overlay.type = 'button';
      overlay.className = 'poster-edit';
      overlay.title = 'Change cover image';

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = '🖼';

      const label = document.createElement('span');
      label.textContent = 'Click to change cover';

      overlay.appendChild(icon);
      overlay.appendChild(label);
      overlay.addEventListener('click', (event) => {
        event.stopPropagation();
        detailPosterFile.click();
      });
      detailPosterWrap.appendChild(overlay);
    }

    function populateEditFields() {
      if (!detailItem) {
        return;
      }
      editTitle.value = detailItem.movieTitle || detailItem.name || '';
      editYear.value = detailItem.year ? String(detailItem.year) : '';
      editPlot.value = detailItem.plot || '';
      editPoster.value = detailItem.posterUrl || '';
      editCoverPreview.src = detailItem.posterUrl || '';
    }

    function openEditForm(options) {
      const keepCover = Boolean(options && options.keepPendingCover);
      if (!keepCover) {
        pendingCoverDataUrl = '';
      }

      const wasOpen = !detailEditForm.hidden;
      detailEditForm.hidden = false;
      detailEdit.textContent = 'Close Editor';

      if (!wasOpen) {
        populateEditFields();
      }

      if (keepCover && pendingCoverDataUrl) {
        editCoverPreview.src = pendingCoverDataUrl;
      }
    }

    function closeEditForm() {
      detailEditForm.hidden = true;
      detailEdit.textContent = 'Edit Info';
      pendingCoverDataUrl = '';
    }

    function closeDetailModal() {
      detailModal.hidden = true;
      detailItem = null;
      detailGroup = null;
      detailCard = null;
      pendingCoverDataUrl = '';
      detailEditForm.hidden = true;
    }

    // Reuse the card's own buttons so playback and watched logic stay in one place.
    function clickCardButton(role) {
      if (!detailCard) {
        return null;
      }
      const button = detailCard.querySelector('[data-role="' + role + '"]');
      if (button) {
        button.click();
      }
      return button;
    }

    function toggleEditForm() {
      if (!detailItem) {
        return;
      }

      if (detailEditForm.hidden) {
        openEditForm();
        editTitle.focus();
      } else {
        closeEditForm();
      }
    }

    // Picking a cover straight from the poster opens the editor with the image
    // staged, so one Save writes the cover and the text fields together.
    detailPosterFileHandler = () => {
      const file = detailPosterFile.files && detailPosterFile.files[0];
      if (!file || !detailItem) {
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setStatus('Cover image must be 8MB or smaller.', true);
        detailPosterFile.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        pendingCoverDataUrl = String(reader.result || '');
        openEditForm({ keepPendingCover: true });
        editPoster.value = file.name;
        editCoverPreview.src = pendingCoverDataUrl;
        renderDetailPoster(pendingCoverDataUrl, detailItem.movieTitle || detailItem.name);
        detailEditForm.scrollIntoView({ block: 'nearest' });
        detailPosterFile.value = '';
      };
      reader.readAsDataURL(file);
    };

    async function saveDetailEdits() {
      if (!detailItem) {
        return;
      }

      if (detailGroup) {
        await saveGroupEdits();
        return;
      }

      editSave.disabled = true;
      try {
        const body = {
          id: detailItem.id,
          title: editTitle.value,
          year: editYear.value,
          plot: editPlot.value,
          posterUrl: editPoster.value,
        };
        if (pendingCoverDataUrl) {
          body.coverDataUrl = pendingCoverDataUrl;
        }

        const response = await fetch('/api/media/override', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        const title = (result.override && result.override.title) || detailItem.name;
        const savedId = detailItem.id;
        closeDetailModal();
        await loadLibrary(false, { silent: true });
        setStatus(result.cleared
          ? 'Restored original details for ' + title + '.'
          : 'Saved details for ' + title + '.');
        reopenDetailFor(savedId);
      } catch (error) {
        setStatus('Save failed: ' + error.message, true);
      } finally {
        editSave.disabled = false;
      }
    }

    // Saving and resetting a group tile, which has no media id to key on.
    async function postGroupOverride(body) {
      const response = await fetch('/api/group/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: detailGroup.category,
          group: detailGroup.name,
          ...body,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || ('HTTP ' + response.status));
      }
      return result;
    }

    async function saveGroupEdits() {
      const groupName = detailGroup.name;
      editSave.disabled = true;
      try {
        const body = {
          title: editTitle.value,
          year: editYear.value,
          plot: editPlot.value,
          posterUrl: editPoster.value,
        };
        if (pendingCoverDataUrl) {
          body.coverDataUrl = pendingCoverDataUrl;
        }

        const result = await postGroupOverride(body);
        closeDetailModal();
        await loadLibrary(false, { silent: true });
        setStatus(result.cleared
          ? 'Restored original details for ' + groupName + '.'
          : 'Saved details for ' + groupName + '.');
      } catch (error) {
        setStatus('Save failed: ' + error.message, true);
      } finally {
        editSave.disabled = false;
      }
    }

    async function resetGroupEdits() {
      const groupName = detailGroup.name;
      editReset.disabled = true;
      try {
        await postGroupOverride({ clear: true });
        closeDetailModal();
        await loadLibrary(false, { silent: true });
        setStatus('Restored original details for ' + groupName + '.');
      } catch (error) {
        setStatus('Reset failed: ' + error.message, true);
      } finally {
        editReset.disabled = false;
      }
    }

    async function resetDetailEdits() {
      if (!detailItem) {
        return;
      }

      if (detailGroup) {
        await resetGroupEdits();
        return;
      }

      editReset.disabled = true;
      try {
        const response = await fetch('/api/media/override', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: detailItem.id, clear: true }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        const name = detailItem.name;
        const savedId = detailItem.id;
        closeDetailModal();
        await loadLibrary(false, { silent: true });
        setStatus('Restored original details for ' + name + '.');
        reopenDetailFor(savedId);
      } catch (error) {
        setStatus('Reset failed: ' + error.message, true);
      } finally {
        editReset.disabled = false;
      }
    }

    detailClose.addEventListener('click', closeDetailModal);
    detailEdit.addEventListener('click', toggleEditForm);
    editCancel.addEventListener('click', () => {
      closeEditForm();
      if (detailItem) {
        renderDetailPoster(detailItem.posterUrl, detailItem.movieTitle || detailItem.name);
      }
    });

    detailPosterFile.addEventListener('change', () => {
      if (detailPosterFileHandler) {
        detailPosterFileHandler();
      }
    });
    editSave.addEventListener('click', saveDetailEdits);
    editReset.addEventListener('click', resetDetailEdits);

    detailPlay.addEventListener('click', playFromDetail);

    subtitleFindBtn.addEventListener('click', async () => {
      if (!detailItem) {
        return;
      }
      subtitleFindBtn.disabled = true;
      trackNote.classList.remove('warn');
      trackNote.textContent = 'Searching for subtitles...';
      try {
        const response = await fetch('/api/media/subtitle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: detailItem.id, mode: 'download' }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || 'No subtitles found.');
        }
        trackNote.textContent = 'Subtitles downloaded and selected.';
        await loadDetailTracks(detailItem);
        subtitleSelect.value = 'sidecar';
      } catch (error) {
        trackNote.textContent = error.message;
        trackNote.classList.add('warn');
      } finally {
        subtitleFindBtn.disabled = false;
      }
    });

    subtitleFile.addEventListener('change', () => {
      const file = subtitleFile.files && subtitleFile.files[0];
      if (!file || !detailItem) {
        return;
      }
      if (file.size > 4 * 1024 * 1024) {
        trackNote.textContent = 'Subtitle files must be 4MB or smaller.';
        trackNote.classList.add('warn');
        subtitleFile.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const response = await fetch('/api/media/subtitle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: detailItem.id,
              mode: 'upload',
              content: String(reader.result || ''),
            }),
          });
          const result = await response.json();
          if (!response.ok || !result.ok) {
            throw new Error(result.error || ('HTTP ' + response.status));
          }
          trackNote.classList.remove('warn');
          trackNote.textContent = 'Loaded ' + file.name + '.';
          await loadDetailTracks(detailItem);
          subtitleSelect.value = 'user';
        } catch (error) {
          trackNote.textContent = 'Could not load that file: ' + error.message;
          trackNote.classList.add('warn');
        } finally {
          subtitleFile.value = '';
        }
      };
      reader.readAsText(file);
    });

    detailWatched.addEventListener('click', () => {
      clickCardButton('watched');
      closeDetailModal();
    });

    editPoster.addEventListener('input', () => {
      pendingCoverDataUrl = '';
      editCoverPreview.src = editPoster.value || '';
    });

    editCoverFile.addEventListener('change', () => {
      const file = editCoverFile.files && editCoverFile.files[0];
      if (!file) {
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setStatus('Cover image must be 8MB or smaller.', true);
        editCoverFile.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        pendingCoverDataUrl = String(reader.result || '');
        editCoverPreview.src = pendingCoverDataUrl;
        editPoster.value = file.name;
      };
      reader.readAsDataURL(file);
    });

    detailModal.addEventListener('click', (event) => {
      if (event.target === detailModal) {
        closeDetailModal();
      }
    });

    function isFullscreen() {
      return Boolean(document.fullscreenElement);
    }

    function syncFullscreenLabel() {
      const on = isFullscreen();
      playerFullscreen.textContent = on ? 'Exit Fullscreen' : 'Fullscreen';
      const panel = playerModal.querySelector('.player-modal');
      if (panel) {
        panel.classList.toggle('is-fullscreen', on);
      }
    }

    async function toggleFullscreen() {
      const panel = playerModal.querySelector('.player-modal');
      if (!panel) {
        return;
      }

      try {
        if (isFullscreen()) {
          await document.exitFullscreen();
        } else {
          await panel.requestFullscreen();
        }
      } catch (error) {
        // Fullscreen can be blocked by policy; the dialog still works windowed.
        playerNote.textContent = 'Fullscreen is unavailable: ' + error.message;
        playerNote.classList.add('warn');
      }
      syncFullscreenLabel();
    }

    playerFullscreen.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFullscreenLabel);

    // ---------------- Book reader ----------------

    const bookModal = document.getElementById('bookModal');
    const bookClose = document.getElementById('bookClose');
    const bookTitle = document.getElementById('bookTitle');
    const bookAuthor = document.getElementById('bookAuthor');
    const bookSide = document.getElementById('bookSide');
    const bookSideToggle = document.getElementById('bookSideToggle');
    const bookTabToc = document.getElementById('bookTabToc');
    const bookTabNotes = document.getElementById('bookTabNotes');
    const bookTocList = document.getElementById('bookTocList');
    const bookNotesList = document.getElementById('bookNotesList');
    const bookStage = document.getElementById('bookStage');
    const bookFrame = document.getElementById('bookFrame');
    const bookTools = document.getElementById('bookTools');
    const bookAddNote = document.getElementById('bookAddNote');
    const bookCopy = document.getElementById('bookCopy');
    const bookTypeButton = document.getElementById('bookType');
    const bookTypePanel = document.getElementById('bookTypePanel');
    const bookFontSize = document.getElementById('bookFontSize');
    const bookLineHeight = document.getElementById('bookLineHeight');
    const bookWidth = document.getElementById('bookWidth');
    const bookMark = document.getElementById('bookMark');
    const bookFullscreen = document.getElementById('bookFullscreen');
    const bookPrev = document.getElementById('bookPrev');
    const bookNext = document.getElementById('bookNext');
    const bookPosition = document.getElementById('bookPosition');
    const bookRailFill = document.getElementById('bookRailFill');

    // Only offer Resume once there is a meaningful amount to come back to.
    const BOOK_RESUME_MIN_PERCENT = 0.01;
    const BOOK_THEMES = {
      light: { bg: '#ffffff', fg: '#16181d', faint: '#6b7280' },
      sepia: { bg: '#f6ecd8', fg: '#3b3227', faint: '#8a7c68' },
      night: { bg: '#14181f', fg: '#d7dae0', faint: '#8b93a1' },
    };
    const HIGHLIGHT_TINTS = {
      yellow: 'rgba(250, 204, 21, 0.42)',
      green: 'rgba(74, 222, 128, 0.40)',
      blue: 'rgba(96, 165, 250, 0.40)',
      pink: 'rgba(244, 114, 182, 0.40)',
      purple: 'rgba(192, 132, 252, 0.40)',
    };

    let bookItem = null;
    let bookData = null;
    let bookChapterIndex = 0;
    let bookAnnotations = [];
    let bookProgressByKey = new Map();
    let bookPendingSelection = null;
    let bookProgressTimer = null;
    let bookRestoreOffset = 0;
    const bookPrefs = {
      fontScale: 110,
      lineHeight: 170,
      width: 720,
      theme: 'sepia',
    };

    function isBookItem(item) {
      return Boolean(item && item.mediaType === 'book');
    }

    function bookKeyOf(item) {
      return item ? (item.watchedKey || item.filePath || item.id || '') : '';
    }

    function bookBookmark(item) {
      const key = bookKeyOf(item);
      return key ? (bookProgressByKey.get(key) || null) : null;
    }

    function bookPlayLabel(item) {
      const mark = bookBookmark(item);
      return mark && Number(mark.percent) > BOOK_RESUME_MIN_PERCENT ? 'Resume' : 'Read';
    }

    function applyBookPlayLabel(button, item) {
      const label = bookPlayLabel(item);
      button.textContent = label;
      button.classList.toggle('resume', label === 'Resume');
    }

    function bookDoc() {
      return bookFrame.contentDocument || null;
    }

    function bookRoot() {
      const doc = bookDoc();
      return doc ? doc.body : null;
    }

    // ---- character offsets ------------------------------------------------
    // Positions are stored as character offsets into the chapter's text, which
    // survive font changes and stay valid once highlights wrap parts of it.

    function offsetsForRange(doc, root, range) {
      const pre = doc.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(range.startContainer, range.startOffset);
      const start = pre.toString().length;
      return { start, end: start + range.toString().length };
    }

    function textNodesIn(root) {
      const doc = root.ownerDocument;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const out = [];
      let node = walker.nextNode();
      while (node) {
        out.push(node);
        node = walker.nextNode();
      }
      return out;
    }

    // Wraps every text run inside [start, end) so a mark can cross elements.
    function wrapOffsets(doc, root, start, end, annotation) {
      const segments = [];
      let pos = 0;

      for (const node of textNodesIn(root)) {
        const length = node.nodeValue.length;
        const nodeStart = pos;
        const nodeEnd = pos + length;
        pos = nodeEnd;

        if (nodeEnd <= start || nodeStart >= end) {
          continue;
        }
        segments.push({
          node,
          from: Math.max(0, start - nodeStart),
          to: Math.min(length, end - nodeStart),
        });
      }

      // Later segments first, so earlier offsets are untouched while wrapping.
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (segment.to <= segment.from) {
          continue;
        }
        const range = doc.createRange();
        range.setStart(segment.node, segment.from);
        range.setEnd(segment.node, segment.to);
        const mark = doc.createElement('mark');
        mark.className = 'mc-highlight';
        mark.setAttribute('data-mc-id', annotation.id);
        mark.style.background = HIGHLIGHT_TINTS[annotation.color] || HIGHLIGHT_TINTS.yellow;
        mark.style.color = 'inherit';
        mark.style.borderRadius = '2px';
        mark.style.cursor = 'pointer';
        if (annotation.note) {
          mark.style.borderBottom = '2px dotted currentColor';
          mark.title = annotation.note;
        }
        // Ranges inside a single text node always surround cleanly.
        range.surroundContents(mark);
      }
    }

    function paintAnnotations() {
      const doc = bookDoc();
      const root = bookRoot();
      if (!doc || !root) {
        return;
      }

      for (const stale of root.querySelectorAll('mark.mc-highlight')) {
        const parent = stale.parentNode;
        while (stale.firstChild) {
          parent.insertBefore(stale.firstChild, stale);
        }
        parent.removeChild(stale);
        parent.normalize();
      }

      const forChapter = bookAnnotations
        .filter((entry) => entry.chapterIndex === bookChapterIndex && entry.kind !== 'bookmark')
        .sort((a, b) => a.start - b.start);

      for (const annotation of forChapter) {
        try {
          wrapOffsets(doc, root, annotation.start, annotation.end, annotation);
        } catch {
          // A highlight whose text has shifted is skipped rather than fatal.
        }
      }
    }

    // ---- rendering ---------------------------------------------------------

    function bookReaderStyles() {
      const theme = BOOK_THEMES[bookPrefs.theme] || BOOK_THEMES.sepia;
      return [
        'html { background: ' + theme.bg + '; }',
        'body {',
        '  background: ' + theme.bg + ';',
        '  color: ' + theme.fg + ';',
        '  font-size: ' + bookPrefs.fontScale + '%;',
        '  line-height: ' + (bookPrefs.lineHeight / 100) + ';',
        '  max-width: ' + bookPrefs.width + 'px;',
        '  margin: 0 auto;',
        '  padding: 48px 28px 96px;',
        '  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;',
        '  text-rendering: optimizeLegibility;',
        '  -webkit-font-smoothing: antialiased;',
        '}',
        'img, svg, video { max-width: 100%; height: auto; }',
        'a { color: inherit; }',
        'p { orphans: 2; widows: 2; }',
        '::selection { background: rgba(96, 165, 250, 0.35); }',
        'mark.mc-highlight { padding: 0 1px; }',
        '.mc-bookmark-flag {',
        '  position: absolute; left: 0; width: 3px; height: 1.6em;',
        '  background: ' + theme.faint + '; border-radius: 2px;',
        '}',
      ].join('\\n');
    }

    function applyReaderStyles() {
      const doc = bookDoc();
      if (!doc) {
        return;
      }
      let style = doc.getElementById('mc-reader-style');
      if (!style) {
        style = doc.createElement('style');
        style.id = 'mc-reader-style';
        (doc.head || doc.documentElement).appendChild(style);
      }
      style.textContent = bookReaderStyles();
      bookFrame.style.background = (BOOK_THEMES[bookPrefs.theme] || BOOK_THEMES.sepia).bg;
    }

    // The offset of the text currently at the top of the view, so the place is
    // kept even if type size changes between sessions.
    function currentTopOffset() {
      const doc = bookDoc();
      const root = bookRoot();
      if (!doc || !root) {
        return 0;
      }

      const nodes = textNodesIn(root);
      let pos = 0;
      for (const node of nodes) {
        const length = node.nodeValue.length;
        if (node.nodeValue.trim()) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > 0) {
            return pos;
          }
        }
        pos += length;
      }
      return pos;
    }

    function scrollToOffset(offset) {
      const doc = bookDoc();
      const root = bookRoot();
      const win = bookFrame.contentWindow;
      if (!doc || !root || !win || offset <= 0) {
        return;
      }

      let pos = 0;
      for (const node of textNodesIn(root)) {
        const length = node.nodeValue.length;
        // Strictly inside this node, so the position never lands on a boundary
        // where there is no character to measure.
        if (pos + length > offset) {
          const local = Math.max(0, Math.min(length - 1, offset - pos));
          const range = doc.createRange();
          range.setStart(node, local);
          range.setEnd(node, Math.min(length, local + 1));

          // A collapsed or whitespace-only range can report an empty rect, so
          // fall back to the element that holds the text.
          let rect = range.getBoundingClientRect();
          if (!rect || (rect.height === 0 && rect.top === 0)) {
            const holder = node.parentElement;
            rect = holder ? holder.getBoundingClientRect() : null;
          }

          if (rect) {
            win.scrollTo({ top: Math.max(0, win.scrollY + rect.top - 40), behavior: 'auto' });
          }
          return;
        }
        pos += length;
      }

      // Past the last character: the end of the section is the right place.
      win.scrollTo({ top: doc.documentElement.scrollHeight, behavior: 'auto' });
    }

    function chapterLabelFor(index) {
      if (!bookData) {
        return '';
      }
      let label = '';
      for (const entry of bookData.toc) {
        if (entry.spineIndex <= index) {
          label = entry.label;
        }
      }
      return label;
    }

    function bookPercent() {
      if (!bookData || bookData.chapterCount === 0) {
        return 0;
      }

      const win = bookFrame.contentWindow;
      const doc = bookDoc();
      let within = 0;
      if (win && doc && doc.documentElement) {
        const scrollable = doc.documentElement.scrollHeight - win.innerHeight;
        within = scrollable > 0 ? Math.min(1, Math.max(0, win.scrollY / scrollable)) : 1;
      }

      return Math.min(1, (bookChapterIndex + within) / bookData.chapterCount);
    }

    function updateBookPosition() {
      if (!bookData) {
        return;
      }
      const percent = bookPercent();
      const label = chapterLabelFor(bookChapterIndex);
      bookPosition.textContent = (label ? label + '  \u00b7  ' : '')
        + 'Section ' + (bookChapterIndex + 1) + ' of ' + bookData.chapterCount
        + '  \u00b7  ' + Math.round(percent * 100) + '%';
      bookRailFill.style.width = (percent * 100) + '%';

      for (const button of bookTocList.querySelectorAll('.book-toc-item')) {
        button.classList.toggle('current', Number(button.dataset.spineIndex) === bookChapterIndex);
      }

      bookPrev.disabled = bookChapterIndex <= 0;
      bookNext.disabled = bookChapterIndex >= bookData.chapterCount - 1;
    }

    async function reportBookProgress(force) {
      if (!bookItem || !bookData) {
        return;
      }

      const key = bookKeyOf(bookItem);
      const percent = bookPercent();
      const offset = currentTopOffset();
      const label = chapterLabelFor(bookChapterIndex);
      const finished = percent >= 0.995;

      if (finished) {
        bookProgressByKey.delete(key);
        watchedItemIds.add(key);
      } else if (bookChapterIndex > 0 || offset > 0) {
        bookProgressByKey.set(key, { chapterIndex: bookChapterIndex, offset, percent, label });
      } else {
        bookProgressByKey.delete(key);
      }

      refreshBookCardState(key);

      try {
        await fetch('/api/book/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: bookItem.id,
            key,
            chapterIndex: bookChapterIndex,
            offset,
            percent,
            label,
          }),
        });
      } catch {
        // Position is best effort; reading carries on regardless.
      }
    }

    function queueBookProgress() {
      window.clearTimeout(bookProgressTimer);
      bookProgressTimer = window.setTimeout(() => reportBookProgress(false), 700);
    }

    function refreshBookCardState(key) {
      for (const card of document.querySelectorAll('.movie-card')) {
        if (!card.__item || bookKeyOf(card.__item) !== key) {
          continue;
        }
        const playButton = card.querySelector('[data-role="play"]');
        if (playButton) {
          applyBookPlayLabel(playButton, card.__item);
        }
        const watchedButton = card.querySelector('[data-role="watched"]');
        if (watchedButton) {
          setWatchedCardState(card, watchedButton, watchedItemIds.has(key));
        }
      }
    }

    async function loadChapter(index, restoreOffset) {
      if (!bookItem || !bookData) {
        return;
      }

      const target = Math.max(0, Math.min(bookData.chapterCount - 1, index));
      bookChapterIndex = target;
      bookRestoreOffset = Number(restoreOffset) || 0;
      hideBookTools();

      try {
        const response = await fetch('/api/book/chapter?id=' + encodeURIComponent(bookItem.id)
          + '&chapter=' + target);
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        // srcdoc keeps the frame same-origin, so selections stay reachable.
        await new Promise((resolve) => {
          const onLoad = () => {
            bookFrame.removeEventListener('load', onLoad);
            resolve();
          };
          bookFrame.addEventListener('load', onLoad);
          bookFrame.srcdoc = result.html;
        });

        bookChapterSentences = Array.isArray(result.sentences) ? result.sentences : [];
        speechSentences = bookChapterSentences;

        applyReaderStyles();
        paintAnnotations();
        wireFrameEvents();
        scrollToOffset(bookRestoreOffset);
        updateBookPosition();
        renderBookNotes();

        if (bookRestoreOffset > 0) {
          const settleFor = bookRestoreOffset;
          const settleChapter = bookChapterIndex;
          window.setTimeout(() => {
            // Only if the reader is still on the section that asked for it.
            if (bookChapterIndex === settleChapter) {
              scrollToOffset(settleFor);
              updateBookPosition();
            }
          }, 220);
        }
      } catch (error) {
        bookPosition.textContent = 'Could not open this section: ' + error.message;
      }
    }

    function wireFrameEvents() {
      const doc = bookDoc();
      const win = bookFrame.contentWindow;
      if (!doc || !win) {
        return;
      }

      doc.addEventListener('mouseup', () => window.setTimeout(handleBookSelection, 10));
      doc.addEventListener('keyup', () => window.setTimeout(handleBookSelection, 10));

      doc.addEventListener('click', (event) => {
        const mark = event.target && event.target.closest
          ? event.target.closest('mark.mc-highlight')
          : null;
        if (mark) {
          const found = bookAnnotations.find((entry) => entry.id === mark.getAttribute('data-mc-id'));
          if (found) {
            openBookSide('notes');
            highlightNoteCard(found.id);
          }
          return;
        }
        hideBookTools();
        hideTypePanel();
      });

      win.addEventListener('scroll', () => {
        updateBookPosition();
        queueBookProgress();
        hideBookTools();
      }, { passive: true });

      // Arrow keys must work whether focus sits in the frame or the page.
      doc.addEventListener('keydown', handleBookKey);
    }

    function handleBookSelection() {
      const doc = bookDoc();
      const root = bookRoot();
      if (!doc || !root) {
        return;
      }

      const selection = doc.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        hideBookTools();
        return;
      }

      const range = selection.getRangeAt(0);
      const text = range.toString().trim();
      if (!text) {
        hideBookTools();
        return;
      }

      const offsets = offsetsForRange(doc, root, range);
      bookPendingSelection = { ...offsets, text };

      const rect = range.getBoundingClientRect();
      const frameRect = bookFrame.getBoundingClientRect();
      const stageRect = bookStage.getBoundingClientRect();

      bookTools.hidden = false;
      const toolsWidth = bookTools.offsetWidth || 280;
      const left = (frameRect.left - stageRect.left) + rect.left + (rect.width / 2) - (toolsWidth / 2);
      const top = (frameRect.top - stageRect.top) + rect.top - bookTools.offsetHeight - 10;

      bookTools.style.left = Math.max(8,
        Math.min(left, bookStage.clientWidth - toolsWidth - 8)) + 'px';
      bookTools.style.top = Math.max(8, top) + 'px';
    }

    function hideBookTools() {
      bookTools.hidden = true;
      bookPendingSelection = null;
    }

    function hideTypePanel() {
      bookTypePanel.hidden = true;
      bookTypeButton.setAttribute('aria-expanded', 'false');
    }

    async function saveAnnotation(annotation) {
      if (!bookItem) {
        return null;
      }

      try {
        const response = await fetch('/api/book/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: bookItem.id,
            key: bookKeyOf(bookItem),
            action: 'save',
            annotation,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        bookAnnotations = Array.isArray(result.annotations) ? result.annotations : bookAnnotations;
        paintAnnotations();
        renderBookNotes();
        return result.annotation;
      } catch (error) {
        setStatus('Could not save that note: ' + error.message, true);
        return null;
      }
    }

    async function removeAnnotation(annotationId) {
      if (!bookItem) {
        return;
      }

      try {
        const response = await fetch('/api/book/annotations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: bookItem.id,
            key: bookKeyOf(bookItem),
            action: 'delete',
            annotationId,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }
        bookAnnotations = Array.isArray(result.annotations) ? result.annotations : [];
        paintAnnotations();
        renderBookNotes();
      } catch (error) {
        setStatus('Could not remove that note: ' + error.message, true);
      }
    }

    function newAnnotationId() {
      return 'an-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    async function addHighlight(color, note) {
      if (!bookPendingSelection) {
        return;
      }

      const annotation = {
        id: newAnnotationId(),
        kind: note ? 'note' : 'highlight',
        chapterIndex: bookChapterIndex,
        start: bookPendingSelection.start,
        end: bookPendingSelection.end,
        color,
        text: bookPendingSelection.text,
        note: note || '',
        chapterLabel: chapterLabelFor(bookChapterIndex),
      };

      hideBookTools();
      const doc = bookDoc();
      if (doc && doc.getSelection()) {
        doc.getSelection().removeAllRanges();
      }
      await saveAnnotation(annotation);
    }

    async function addBookmarkHere() {
      if (!bookItem) {
        return;
      }

      const offset = currentTopOffset();
      const root = bookRoot();
      let preview = '';
      if (root) {
        preview = String(root.textContent || '').slice(offset, offset + 140).trim();
      }

      const annotation = {
        id: newAnnotationId(),
        kind: 'bookmark',
        chapterIndex: bookChapterIndex,
        start: offset,
        end: offset,
        color: 'blue',
        text: preview,
        note: '',
        chapterLabel: chapterLabelFor(bookChapterIndex),
      };

      const saved = await saveAnnotation(annotation);
      if (saved) {
        setStatus('Bookmarked ' + (annotation.chapterLabel || 'this page') + '.');
        openBookSide('notes');
      }
    }

    function renderBookToc() {
      bookTocList.innerHTML = '';
      if (!bookData || bookData.toc.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'book-side-empty';
        empty.textContent = 'This book has no contents list.';
        bookTocList.appendChild(empty);
        return;
      }

      for (const entry of bookData.toc) {
        const button = document.createElement('button');
        button.className = 'book-toc-item depth-' + Math.min(2, Number(entry.depth) || 0);
        button.textContent = entry.label;
        button.dataset.spineIndex = String(entry.spineIndex);
        button.addEventListener('click', () => {
          loadChapter(entry.spineIndex, 0);
        });
        bookTocList.appendChild(button);
      }
    }

    function renderBookNotes() {
      bookNotesList.innerHTML = '';

      if (bookAnnotations.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'book-side-empty';
        empty.textContent = 'Select any text to highlight it or attach a note. '
          + 'The Bookmark button saves your spot.';
        bookNotesList.appendChild(empty);
        return;
      }

      const sorted = [...bookAnnotations].sort((a, b) => (a.chapterIndex - b.chapterIndex)
        || (a.start - b.start));

      for (const annotation of sorted) {
        const card = document.createElement('div');
        card.className = 'book-note-card';
        card.dataset.annotationId = annotation.id;
        card.style.setProperty('--note-accent', ({
          yellow: '#facc15', green: '#4ade80', blue: '#60a5fa',
          pink: '#f472b6', purple: '#c084fc',
        })[annotation.color] || '#facc15');

        const kind = document.createElement('span');
        kind.className = 'book-note-kind';
        kind.textContent = (annotation.kind === 'bookmark' ? 'Bookmark' : (annotation.kind === 'note' ? 'Note' : 'Highlight'))
          + (annotation.chapterLabel ? '  \u00b7  ' + annotation.chapterLabel : '');
        card.appendChild(kind);

        const text = document.createElement('span');
        text.className = 'book-note-text';
        text.textContent = annotation.text || '(no text)';
        card.appendChild(text);

        if (annotation.note) {
          const note = document.createElement('span');
          note.className = 'book-note-body';
          note.textContent = annotation.note;
          card.appendChild(note);
        }

        const remove = document.createElement('button');
        remove.className = 'book-note-remove';
        remove.textContent = '\u00d7';
        remove.title = 'Remove';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          removeAnnotation(annotation.id);
        });
        card.appendChild(remove);

        card.addEventListener('click', () => {
          if (annotation.chapterIndex === bookChapterIndex) {
            scrollToOffset(annotation.start);
          } else {
            loadChapter(annotation.chapterIndex, annotation.start);
          }
        });

        bookNotesList.appendChild(card);
      }
    }

    function highlightNoteCard(annotationId) {
      const card = bookNotesList.querySelector('[data-annotation-id="' + annotationId + '"]');
      if (card) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        card.style.transition = 'background 200ms ease';
        card.style.background = 'rgba(96, 165, 250, 0.22)';
        window.setTimeout(() => { card.style.background = ''; }, 900);
      }
    }

    function openBookSide(tab) {
      bookSide.hidden = false;
      bookSideToggle.setAttribute('aria-expanded', 'true');
      const showNotes = tab === 'notes';
      bookTabToc.classList.toggle('active', !showNotes);
      bookTabNotes.classList.toggle('active', showNotes);
      bookTocList.hidden = showNotes;
      bookNotesList.hidden = !showNotes;
    }

    function applyBookPrefs() {
      bookFontSize.value = String(bookPrefs.fontScale);
      bookLineHeight.value = String(bookPrefs.lineHeight);
      bookWidth.value = String(bookPrefs.width);
      for (const button of bookTypePanel.querySelectorAll('.book-theme')) {
        button.classList.toggle('active', button.dataset.theme === bookPrefs.theme);
      }
      applyReaderStyles();
    }

    function saveBookPrefs() {
      try {
        window.localStorage.setItem('novabox.reader', JSON.stringify(bookPrefs));
      } catch {
        // Reading preferences are a convenience; storage may be unavailable.
      }
    }

    function loadBookPrefs() {
      try {
        const stored = JSON.parse(window.localStorage.getItem('novabox.reader') || '{}');
        if (stored && typeof stored === 'object') {
          if (Number.isFinite(Number(stored.fontScale))) bookPrefs.fontScale = Number(stored.fontScale);
          if (Number.isFinite(Number(stored.lineHeight))) bookPrefs.lineHeight = Number(stored.lineHeight);
          if (Number.isFinite(Number(stored.width))) bookPrefs.width = Number(stored.width);
          if (BOOK_THEMES[stored.theme]) bookPrefs.theme = stored.theme;
        }
      } catch {
        // Fall back to the defaults above.
      }
    }

    async function openBookReader(item) {
      bookItem = item;
      bookData = null;
      bookAnnotations = [];
      bookChapterIndex = 0;
      bookTitle.textContent = item.movieTitle || item.name;
      bookAuthor.textContent = item.author || '';
      bookPosition.textContent = 'Opening book...';
      bookRailFill.style.width = '0%';
      bookFrame.srcdoc = '';
      bookSide.hidden = true;
      bookSideToggle.setAttribute('aria-expanded', 'false');
      hideBookTools();
      hideTypePanel();
      bookModal.hidden = false;
      syncBookFullscreenLabel();

      try {
        const response = await fetch('/api/book/open?id=' + encodeURIComponent(item.id));
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        bookData = result;
        bookAnnotations = Array.isArray(result.annotations) ? result.annotations : [];
        bookAuthor.textContent = result.creator || item.author || '';
        renderBookToc();
        renderBookNotes();

        const saved = result.progress;
        const startChapter = saved && Number.isFinite(Number(saved.chapterIndex))
          ? Number(saved.chapterIndex)
          : 0;
        const startOffset = saved && Number.isFinite(Number(saved.offset)) ? Number(saved.offset) : 0;

        await loadChapter(startChapter, startOffset);
        if (saved && (startChapter > 0 || startOffset > 0)) {
          setStatus('Resumed ' + (saved.label || ('section ' + (startChapter + 1))) + '.');
        }
      } catch (error) {
        bookPosition.textContent = 'Could not open this book: ' + error.message;
      }
    }

    function closeBookReader() {
      stopSpeech();
      if (bookItem && bookData) {
        window.clearTimeout(bookProgressTimer);
        reportBookProgress(true);
      }
      exitFullscreenIfNeeded();
      bookModal.hidden = true;
      bookFrame.srcdoc = '';
      bookItem = null;
      bookData = null;
      hideBookTools();
      hideTypePanel();
    }

    function syncBookFullscreenLabel() {
      const on = Boolean(document.fullscreenElement);
      bookFullscreen.textContent = on ? 'Exit Fullscreen' : 'Fullscreen';
      const panel = bookModal.querySelector('.book-modal');
      if (panel) {
        panel.classList.toggle('is-fullscreen', on);
      }
    }

    async function toggleBookFullscreen() {
      const panel = bookModal.querySelector('.book-modal');
      if (!panel) {
        return;
      }
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          await panel.requestFullscreen();
        }
      } catch (error) {
        setStatus('Fullscreen is unavailable: ' + error.message, true);
      }
      syncBookFullscreenLabel();
    }

    function pageBook(direction) {
      const win = bookFrame.contentWindow;
      if (!win || !bookData) {
        return;
      }

      const step = Math.max(120, win.innerHeight - 80);
      const atStart = win.scrollY <= 2;
      const doc = bookDoc();
      const maxScroll = doc && doc.documentElement
        ? doc.documentElement.scrollHeight - win.innerHeight
        : 0;
      const atEnd = win.scrollY >= maxScroll - 2;

      if (direction < 0 && atStart) {
        if (bookChapterIndex > 0) {
          // Landing at the end of the previous section keeps reading continuous.
          loadChapter(bookChapterIndex - 1, Number.MAX_SAFE_INTEGER);
        }
        return;
      }
      if (direction > 0 && atEnd) {
        if (bookChapterIndex < bookData.chapterCount - 1) {
          loadChapter(bookChapterIndex + 1, 0);
        }
        return;
      }

      win.scrollBy({ top: direction * step, behavior: 'smooth' });
    }

    function handleBookKey(event) {
      if (bookModal.hidden) {
        return;
      }

      if (event.key === 'Escape') {
        if (!bookTools.hidden) {
          hideBookTools();
          return;
        }
        if (!bookTypePanel.hidden) {
          hideTypePanel();
          return;
        }
        if (document.fullscreenElement) {
          return;
        }
        event.preventDefault();
        closeBookReader();
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        pageBook(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        pageBook(-1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (bookData && bookChapterIndex < bookData.chapterCount - 1) {
          loadChapter(bookChapterIndex + 1, 0);
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (bookChapterIndex > 0) {
          loadChapter(bookChapterIndex - 1, 0);
        }
      } else if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        addBookmarkHere();
      } else if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        openBookSide(bookSide.hidden || bookTocList.hidden ? 'toc' : 'notes');
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleBookFullscreen();
      }
    }

    // ---- wiring ------------------------------------------------------------

    bookClose.addEventListener('click', closeBookReader);
    bookModal.addEventListener('click', (event) => {
      if (event.target === bookModal) {
        closeBookReader();
      }
    });

    bookSideToggle.addEventListener('click', () => {
      if (bookSide.hidden) {
        openBookSide(bookNotesList.hidden ? 'toc' : 'notes');
      } else {
        bookSide.hidden = true;
        bookSideToggle.setAttribute('aria-expanded', 'false');
      }
    });

    bookTabToc.addEventListener('click', () => openBookSide('toc'));
    bookTabNotes.addEventListener('click', () => openBookSide('notes'));

    bookPrev.addEventListener('click', () => pageBook(-1));
    bookNext.addEventListener('click', () => pageBook(1));
    bookMark.addEventListener('click', addBookmarkHere);
    bookFullscreen.addEventListener('click', toggleBookFullscreen);

    for (const swatch of bookTools.querySelectorAll('.book-swatch')) {
      swatch.addEventListener('click', () => addHighlight(swatch.dataset.color, ''));
    }

    bookAddNote.addEventListener('click', () => {
      if (!bookPendingSelection) {
        return;
      }
      const note = window.prompt('Note for "'
        + bookPendingSelection.text.slice(0, 60)
        + (bookPendingSelection.text.length > 60 ? '...' : '') + '"');
      if (note && note.trim()) {
        addHighlight('yellow', note.trim());
      }
    });

    bookCopy.addEventListener('click', async () => {
      if (!bookPendingSelection) {
        return;
      }
      try {
        await navigator.clipboard.writeText(bookPendingSelection.text);
        setStatus('Passage copied.');
      } catch {
        setStatus('Copying is blocked in this browser.', true);
      }
      hideBookTools();
    });

    bookTypeButton.addEventListener('click', () => {
      const open = bookTypePanel.hidden;
      bookTypePanel.hidden = !open;
      bookTypeButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    const onTypeChange = () => {
      bookPrefs.fontScale = Number(bookFontSize.value);
      bookPrefs.lineHeight = Number(bookLineHeight.value);
      bookPrefs.width = Number(bookWidth.value);
      applyReaderStyles();
      saveBookPrefs();
      updateBookPosition();
    };

    bookFontSize.addEventListener('input', onTypeChange);
    bookLineHeight.addEventListener('input', onTypeChange);
    bookWidth.addEventListener('input', onTypeChange);

    for (const button of bookTypePanel.querySelectorAll('.book-theme')) {
      button.addEventListener('click', () => {
        bookPrefs.theme = button.dataset.theme;
        applyBookPrefs();
        saveBookPrefs();
      });
    }

    document.addEventListener('keydown', handleBookKey);
    document.addEventListener('fullscreenchange', syncBookFullscreenLabel);

    loadBookPrefs();

    // ---------------- Read aloud ----------------

    const bookListen = document.getElementById('bookListen');
    const bookSpeechBar = document.getElementById('bookSpeechBar');
    const speechToggle = document.getElementById('speechToggle');
    const speechPrev = document.getElementById('speechPrev');
    const speechNext = document.getElementById('speechNext');
    const speechStop = document.getElementById('speechStop');
    const speechStatus = document.getElementById('speechStatus');
    const speechRate = document.getElementById('speechRate');
    const speechRateLabel = document.getElementById('speechRateLabel');
    const speechVoice = document.getElementById('speechVoice');

    const speechAudio = new Audio();
    speechAudio.preload = 'auto';

    let speechEngine = null;
    let speechSentences = [];
    let speechIndex = 0;
    let speechPlaying = false;
    // Sentence audio is fetched a little ahead so playback never waits.
    const speechAhead = new Map();
    const SPEECH_LOOKAHEAD = 2;
    let speechMark = null;
    let speechRequestId = 0;

    function speechPrefs() {
      return {
        rate: Number(speechRate.value) || 1,
        voice: speechVoice.value || '',
      };
    }

    function setSpeechStatus(message, isWarning) {
      speechStatus.textContent = message;
      speechStatus.classList.toggle('warn', Boolean(isWarning));
    }

    async function loadSpeechEngine() {
      if (speechEngine) {
        return speechEngine;
      }
      try {
        const response = await fetch('/api/book/speech/status');
        speechEngine = await response.json();
      } catch (error) {
        speechEngine = { ok: false, available: false, voices: [], hint: error.message };
      }

      speechVoice.innerHTML = '';
      for (const voice of speechEngine.voices || []) {
        const option = document.createElement('option');
        option.value = voice.id;
        option.textContent = voice.label;
        speechVoice.appendChild(option);
      }
      speechVoice.hidden = (speechEngine.voices || []).length < 2;

      return speechEngine;
    }

    function speechAudioUrl(index) {
      const prefs = speechPrefs();
      return '/api/book/speech/audio?id=' + encodeURIComponent(bookItem.id)
        + '&chapter=' + bookChapterIndex
        + '&index=' + index
        + '&rate=' + prefs.rate
        + (prefs.voice ? '&voice=' + encodeURIComponent(prefs.voice) : '');
    }

    // Fetching as a blob means the next sentence is already decoded when the
    // current one ends, so there is no gap between them.
    function prefetchSentence(index) {
      if (index < 0 || index >= speechSentences.length || speechAhead.has(index)) {
        return;
      }
      const pending = fetch(speechAudioUrl(index))
        .then((response) => {
          if (!response.ok) {
            throw new Error('HTTP ' + response.status);
          }
          return response.blob();
        })
        .then((blob) => URL.createObjectURL(blob))
        .catch(() => null);
      speechAhead.set(index, pending);
    }

    function releaseSpeechCache(keepFrom) {
      for (const [index, pending] of [...speechAhead.entries()]) {
        if (index < keepFrom || index > keepFrom + SPEECH_LOOKAHEAD + 1) {
          speechAhead.delete(index);
          Promise.resolve(pending).then((url) => {
            if (url) {
              URL.revokeObjectURL(url);
            }
          });
        }
      }
    }

    // The spoken sentence is marked with the same wrapping the highlights use,
    // so it lands exactly on the words being read.
    function markSpokenSentence(index) {
      clearSpokenSentence();
      const doc = bookDoc();
      const root = bookRoot();
      const sentence = speechSentences[index];
      if (!doc || !root || !sentence) {
        return;
      }

      try {
        wrapOffsets(doc, root, sentence.start, sentence.end, {
          id: 'mc-speaking',
          color: 'blue',
          note: '',
        });
      } catch {
        return;
      }

      const marks = root.querySelectorAll('mark[data-mc-id="mc-speaking"]');
      for (const mark of marks) {
        mark.classList.add('mc-speaking');
        mark.style.background = 'rgba(96, 165, 250, 0.34)';
        mark.style.boxShadow = '0 0 0 2px rgba(96, 165, 250, 0.24)';
      }
      speechMark = marks.length > 0;

      // Keep the spoken line on screen without yanking the page around.
      const first = marks[0];
      if (first) {
        const win = bookFrame.contentWindow;
        const rect = first.getBoundingClientRect();
        if (win && (rect.top < 60 || rect.bottom > win.innerHeight - 60)) {
          win.scrollTo({
            top: Math.max(0, win.scrollY + rect.top - (win.innerHeight / 3)),
            behavior: 'smooth',
          });
        }
      }
    }

    function clearSpokenSentence() {
      const root = bookRoot();
      if (!root || !speechMark) {
        return;
      }
      for (const mark of root.querySelectorAll('mark[data-mc-id="mc-speaking"]')) {
        const parent = mark.parentNode;
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
      }
      speechMark = false;
    }

    async function speakSentence(index) {
      if (!bookItem || index < 0) {
        return;
      }

      // Past the end of a chapter, carry on into the next one.
      if (index >= speechSentences.length) {
        if (bookData && bookChapterIndex < bookData.chapterCount - 1) {
          setSpeechStatus('Moving to the next section...');
          await loadChapter(bookChapterIndex + 1, 0);
          speechIndex = 0;
          if (speechPlaying) {
            speakSentence(0);
          }
        } else {
          stopSpeech();
          setSpeechStatus('Finished the book.');
        }
        return;
      }

      const token = ++speechRequestId;
      speechIndex = index;
      markSpokenSentence(index);

      for (let ahead = 1; ahead <= SPEECH_LOOKAHEAD; ahead += 1) {
        prefetchSentence(index + ahead);
      }
      prefetchSentence(index);
      releaseSpeechCache(index);

      const sentence = speechSentences[index];
      setSpeechStatus('Sentence ' + (index + 1) + ' of ' + speechSentences.length
        + '  \u00b7  ' + sentence.text.slice(0, 60)
        + (sentence.text.length > 60 ? '...' : ''));

      let url = null;
      try {
        url = await speechAhead.get(index);
      } catch {
        url = null;
      }

      // A newer request landed while this one was fetching.
      if (token !== speechRequestId) {
        return;
      }

      if (!url) {
        setSpeechStatus('Could not speak that sentence - skipping.', true);
        window.setTimeout(() => {
          if (speechPlaying && token === speechRequestId) {
            speakSentence(index + 1);
          }
        }, 400);
        return;
      }

      speechAudio.src = url;
      try {
        await speechAudio.play();
      } catch (error) {
        if (token === speechRequestId) {
          setSpeechStatus('Playback was blocked: ' + error.message, true);
          speechPlaying = false;
          speechToggle.textContent = 'Resume';
        }
      }
    }

    speechAudio.addEventListener('ended', () => {
      if (speechPlaying) {
        speakSentence(speechIndex + 1);
      }
    });

    speechAudio.addEventListener('error', () => {
      if (speechPlaying) {
        speakSentence(speechIndex + 1);
      }
    });

    // Reading starts from whatever is at the top of the view, not the chapter
    // start, so it picks up where the eye already is.
    function sentenceAtCurrentPosition() {
      const offset = currentTopOffset();
      let best = 0;
      for (let i = 0; i < speechSentences.length; i += 1) {
        if (speechSentences[i].end <= offset) {
          best = i + 1;
        } else {
          break;
        }
      }
      return Math.min(best, Math.max(0, speechSentences.length - 1));
    }

    async function startSpeech() {
      if (!bookItem || !bookData) {
        return;
      }

      const engine = await loadSpeechEngine();
      if (!engine.available) {
        bookSpeechBar.hidden = false;
        setSpeechStatus(engine.hint || 'No speech engine is installed.', true);
        speechToggle.disabled = true;
        return;
      }

      speechToggle.disabled = false;
      speechSentences = Array.isArray(bookChapterSentences) ? bookChapterSentences : [];
      if (speechSentences.length === 0) {
        bookSpeechBar.hidden = false;
        setSpeechStatus('There is nothing to read in this section.', true);
        return;
      }

      bookSpeechBar.hidden = false;
      bookListen.textContent = 'Stop Reading';
      speechPlaying = true;
      speechToggle.textContent = 'Pause';
      speakSentence(sentenceAtCurrentPosition());
    }

    function stopSpeech() {
      speechPlaying = false;
      speechRequestId += 1;
      speechAudio.pause();
      speechAudio.removeAttribute('src');
      releaseSpeechCache(Number.MAX_SAFE_INTEGER);
      clearSpokenSentence();
      bookSpeechBar.hidden = true;
      bookListen.textContent = 'Read Aloud';
      // Reading aloud moves the place in the book, same as reading by eye.
      queueBookProgress();
    }

    function toggleSpeechPlayback() {
      if (!speechPlaying) {
        speechPlaying = true;
        speechToggle.textContent = 'Pause';
        if (speechAudio.src && speechAudio.currentTime > 0 && !speechAudio.ended) {
          speechAudio.play().catch(() => {});
        } else {
          speakSentence(speechIndex);
        }
        return;
      }
      speechPlaying = false;
      speechToggle.textContent = 'Resume';
      speechAudio.pause();
    }

    bookListen.addEventListener('click', () => {
      if (bookSpeechBar.hidden) {
        startSpeech();
      } else {
        stopSpeech();
      }
    });

    speechToggle.addEventListener('click', toggleSpeechPlayback);
    speechStop.addEventListener('click', stopSpeech);

    speechPrev.addEventListener('click', () => {
      speechAudio.pause();
      speakSentence(Math.max(0, speechIndex - 1));
    });

    speechNext.addEventListener('click', () => {
      speechAudio.pause();
      speakSentence(speechIndex + 1);
    });

    const onSpeechSettingChange = () => {
      speechRateLabel.textContent = Number(speechRate.value).toFixed(1) + '\u00d7';
      // Rate and voice change the audio, so anything already fetched is stale.
      releaseSpeechCache(Number.MAX_SAFE_INTEGER);
      if (speechPlaying) {
        speechAudio.pause();
        speakSentence(speechIndex);
      }
    };

    speechRate.addEventListener('change', onSpeechSettingChange);
    speechVoice.addEventListener('change', onSpeechSettingChange);
    speechRate.addEventListener('input', () => {
      speechRateLabel.textContent = Number(speechRate.value).toFixed(1) + '\u00d7';
    });

    function reportPlayerPosition(finished) {
      if (!playerItem) {
        return;
      }

      const positionSec = Math.floor(playerVideo.currentTime || 0);
      const durationSec = Number.isFinite(playerVideo.duration) ? Math.floor(playerVideo.duration) : null;
      if (!finished && positionSec <= 0) {
        return;
      }

      fetch('/api/media/position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: playerItem.id,
          positionSec,
          durationSec,
          finished: Boolean(finished),
        }),
      }).catch(() => {});
    }

    function setPlayerSource(item, tracks, useTranscode) {
      playerUsedTranscode = Boolean(useTranscode);
      const baseUrl = tracks && tracks.mediaUrl ? tracks.mediaUrl : null;
      if (!baseUrl) {
        playerNote.textContent = 'This item has no reachable stream URL.';
        playerNote.classList.add('warn');
        return;
      }

      while (playerVideo.firstChild) {
        playerVideo.removeChild(playerVideo.firstChild);
      }

      playerVideo.src = useTranscode
        ? baseUrl + (baseUrl.indexOf('?') >= 0 ? '&' : '?') + 'transcode=1'
        : baseUrl;

      if (tracks && tracks.subtitleUrl) {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = 'Subtitles';
        track.srclang = 'en';
        track.src = tracks.subtitleUrl;
        track.default = true;
        playerVideo.appendChild(track);
      }

      playerNote.classList.toggle('warn', Boolean(useTranscode));
      playerNote.textContent = useTranscode
        ? 'Transcoding live for the browser. Seeking is unavailable while transcoding.'
        : 'Playing the original file. If it stays black or silent, use Force Transcode.';

      playerVideo.load();

      const resumeInfo = getResumeInfo(item);
      const startAt = resumeInfo ? resumeInfo.positionSec : 0;
      if (startAt > 0 && !useTranscode) {
        playerVideo.addEventListener('loadedmetadata', () => {
          try {
            playerVideo.currentTime = startAt;
          } catch (error) {
            // Some streams refuse an initial seek; starting at zero is fine.
          }
        }, { once: true });
      }

      playerVideo.play().catch(() => {
        // Autoplay can be blocked; the controls are right there.
      });
    }

    function isImageItem(item) {
      return Boolean(item && item.mediaType === 'image');
    }

    function isComicItem(item) {
      return Boolean(item && item.mediaType === 'comic');
    }

    function comicProgressKey(item) {
      return item ? (item.watchedKey || item.filePath || item.id || '') : '';
    }

    function comicBookmark(item) {
      const key = comicProgressKey(item);
      return key ? (comicProgressByKey.get(key) || null) : null;
    }

    // A book only says Resume once it has been read past the opening pages.
    function comicPlayLabel(item) {
      const bookmark = comicBookmark(item);
      return bookmark && bookmark.page > COMIC_RESUME_MIN_PAGE ? 'Resume' : 'Read';
    }

    function applyComicPlayLabel(button, item) {
      const label = comicPlayLabel(item);
      button.textContent = label;
      button.classList.toggle('resume', label === 'Resume');
    }

    // Update the tile behind the reader without a full re-render.
    function refreshComicCardState(key, item) {
      for (const card of document.querySelectorAll('.movie-card')) {
        if (!card.__item || comicProgressKey(card.__item) !== key) {
          continue;
        }
        const playButton = card.querySelector('[data-role="play"]');
        if (playButton) {
          applyComicPlayLabel(playButton, item || card.__item);
        }
        const watchedButton = card.querySelector('[data-role="watched"]');
        if (watchedButton) {
          setWatchedCardState(card, watchedButton, watchedItemIds.has(key));
        }
      }
    }

    // Sent as the reader moves, and again on close, so closing the app still
    // leaves a usable bookmark behind.
    async function reportComicProgress(item, page, pageCount) {
      const key = comicProgressKey(item);
      if (!key || !page) {
        return;
      }

      const finished = pageCount > 0 && page >= pageCount;
      if (finished) {
        comicProgressByKey.delete(key);
        watchedItemIds.add(key);
      } else if (page > 1) {
        comicProgressByKey.set(key, { page, pageCount: pageCount || null });
      } else {
        comicProgressByKey.delete(key);
      }

      refreshComicCardState(key, item);

      try {
        await fetch('/api/comic/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, key, page, pageCount }),
        });
      } catch {
        // The bookmark is best effort; reading continues either way.
      }
    }

    function queueComicProgress(item, page, pageCount) {
      window.clearTimeout(comicProgressTimer);
      const finished = pageCount > 0 && page >= pageCount;
      // Finishing is worth recording at once; ordinary paging can settle first.
      comicProgressTimer = window.setTimeout(() => {
        reportComicProgress(item, page, pageCount);
      }, finished ? 0 : 600);
    }

    function showComicPage(index) {
      if (!readerComic || readerPageCount === 0) {
        return;
      }

      readerIndex = Math.max(0, Math.min(readerPageCount - 1, index));
      readerPage.src = '/comic/' + encodeURIComponent(readerComic.id)
        + '/page/' + readerIndex;
      readerCount.textContent = 'Page ' + (readerIndex + 1) + ' of ' + readerPageCount;
      queueComicProgress(readerComic, readerIndex + 1, readerPageCount);
      readerProgressFill.style.width =
        (((readerIndex + 1) / readerPageCount) * 100) + '%';

      // Warm the next page so forward paging feels instant, which matters most
      // for RAR where extraction is slow.
      if (readerIndex + 1 < readerPageCount) {
        const preload = new Image();
        preload.src = '/comic/' + encodeURIComponent(readerComic.id)
          + '/page/' + (readerIndex + 1);
      }
    }

    function stepComicPage(delta) {
      showComicPage(readerIndex + delta);
    }

    async function openComicReader(item) {
      playerVideo.hidden = true;
      playerVideo.removeAttribute('src');
      playerImage.hidden = true;
      playerImage.removeAttribute('src');
      playerTranscode.hidden = true;
      readerPage.hidden = false;
      readerCount.hidden = false;
      readerProgress.hidden = false;
      viewerPrev.hidden = false;
      viewerNext.hidden = false;

      readerComic = item;
      readerIndex = 0;
      readerPageCount = 0;
      syncFullscreenLabel();
      playerTitle.textContent = item.movieTitle || item.name;
      playerNote.classList.remove('warn');
      playerNote.textContent = 'Opening comic...';
      readerCount.textContent = '';
      playerModal.hidden = false;

      try {
        const response = await fetch('/api/comic/pages?id=' + encodeURIComponent(item.id));
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.error || ('HTTP ' + response.status));
        }

        readerPageCount = Number(result.pageCount) || 0;
        if (readerPageCount === 0) {
          throw new Error('No pages found inside this archive.');
        }

        const bookmark = comicBookmark(item);
        const startPage = bookmark && bookmark.page > 1
          ? Math.min(bookmark.page, readerPageCount) - 1
          : 0;

        playerNote.textContent = (startPage > 0
          ? 'Resumed on page ' + (startPage + 1) + '. '
          : '')
          + 'Arrow keys or the side buttons turn pages ('
          + String(result.archive).toUpperCase() + ' archive).';
        showComicPage(startPage);
      } catch (error) {
        playerNote.textContent = 'Could not open this comic: ' + error.message;
        playerNote.classList.add('warn');
        readerCount.hidden = true;
        readerProgress.hidden = true;
      }
    }

    function closeComicReader() {
      if (readerComic && readerPageCount > 0) {
        window.clearTimeout(comicProgressTimer);
        reportComicProgress(readerComic, readerIndex + 1, readerPageCount);
      }
      readerPage.hidden = true;
      readerPage.removeAttribute('src');
      readerCount.hidden = true;
      readerProgress.hidden = true;
      playerModal.hidden = true;
      readerComic = null;
      readerPageCount = 0;
    }

    // Photos step through whatever is currently on screen, in display order.
    function collectViewerList(item) {
      const cards = [...document.querySelectorAll('.movie-card')];
      const items = cards
        .map((card) => card.__item)
        .filter((candidate) => candidate && isImageItem(candidate));

      viewerList = items.length ? items : [item];
      viewerIndex = Math.max(0, viewerList.findIndex((candidate) => candidate.id === item.id));
    }

    function showViewerImage(item) {
      playerItem = item;
      playerTitle.textContent = item.movieTitle || item.name;
      playerImage.alt = item.movieTitle || item.name;

      // The grid shows a thumbnail; the viewer should show the original.
      fetch('/api/media/tracks?id=' + encodeURIComponent(item.id))
        .then((response) => response.json())
        .then((tracks) => {
          if (playerItem && playerItem.id === item.id) {
            playerImage.src = (tracks && tracks.mediaUrl) || item.posterUrl || '';
          }
        })
        .catch(() => {
          playerImage.src = item.posterUrl || '';
        });

      const hasSiblings = viewerList.length > 1;
      viewerPrev.hidden = !hasSiblings;
      viewerNext.hidden = !hasSiblings;
      playerNote.classList.remove('warn');
      playerNote.textContent = hasSiblings
        ? (viewerIndex + 1) + ' of ' + viewerList.length + ' - use the arrows or arrow keys'
        : 'Viewing the original image.';
    }

    function stepViewer(delta) {
      if (viewerList.length < 2) {
        return;
      }
      viewerIndex = (viewerIndex + delta + viewerList.length) % viewerList.length;
      showViewerImage(viewerList[viewerIndex]);
    }

    function jumpViewer(index) {
      if (viewerList.length === 0) {
        return;
      }
      viewerIndex = Math.max(0, Math.min(viewerList.length - 1, index));
      showViewerImage(viewerList[viewerIndex]);
    }

    function openImageViewer(item) {
      readerComic = null;
      readerPage.hidden = true;
      readerPage.removeAttribute('src');
      readerCount.hidden = true;
      readerProgress.hidden = true;
      playerVideo.hidden = true;
      playerVideo.removeAttribute('src');
      playerImage.hidden = false;
      playerTranscode.hidden = true;

      collectViewerList(item);
      playerModal.hidden = false;
      syncFullscreenLabel();
      showViewerImage(item);
    }

    viewerPrev.addEventListener('click', () => {
      if (readerComic) {
        stepComicPage(-1);
      } else {
        stepViewer(-1);
      }
    });

    viewerNext.addEventListener('click', () => {
      if (readerComic) {
        stepComicPage(1);
      } else {
        stepViewer(1);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (playerModal.hidden) {
        return;
      }

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
        return;
      }

      // Left/right turn a page, up/down jump to the start or end of the book.
      // Home/End do the same, since that is what those keys mean everywhere else.
      const isReader = Boolean(readerComic);
      const isViewer = !isReader && !playerImage.hidden;
      if (!isReader && !isViewer) {
        return;
      }

      const key = event.key;
      let handled = true;

      if (key === 'ArrowLeft' || key === 'PageUp') {
        if (isReader) {
          stepComicPage(-1);
        } else {
          stepViewer(-1);
        }
      } else if (key === 'ArrowRight' || key === 'PageDown') {
        if (isReader) {
          stepComicPage(1);
        } else {
          stepViewer(1);
        }
      } else if (key === 'ArrowUp' || key === 'Home') {
        if (isReader) {
          showComicPage(0);
        } else {
          jumpViewer(0);
        }
      } else if (key === 'ArrowDown' || key === 'End') {
        if (isReader) {
          showComicPage(readerPageCount - 1);
        } else {
          jumpViewer(viewerList.length - 1);
        }
      } else {
        handled = false;
      }

      if (handled) {
        event.preventDefault();
      }
    });

    async function openLocalPlayer(item) {
      readerComic = null;
      readerPage.hidden = true;
      readerPage.removeAttribute('src');
      readerCount.hidden = true;
      readerProgress.hidden = true;
      playerVideo.hidden = false;
      playerImage.hidden = true;
      playerImage.removeAttribute('src');
      playerTranscode.hidden = false;
      viewerPrev.hidden = true;
      viewerNext.hidden = true;
      playerItem = item;
      playerTitle.textContent = item.movieTitle || item.name;
      playerNote.textContent = 'Loading...';
      playerNote.classList.remove('warn');
      playerModal.hidden = false;

      let tracks = detailTracks;
      if (!tracks || !tracks.mediaUrl) {
        try {
          const response = await fetch('/api/media/tracks?id=' + encodeURIComponent(item.id));
          tracks = await response.json();
        } catch (error) {
          tracks = null;
        }
      }

      playerLastTracks = tracks;
      setPlayerSource(item, tracks, false);

      if (playerReportTimer) {
        clearInterval(playerReportTimer);
      }
      playerReportTimer = setInterval(() => {
        if (!playerVideo.paused) {
          reportPlayerPosition(false);
        }
      }, 10000);
    }

    function exitFullscreenIfNeeded() {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }

    function closeLocalPlayer() {
      exitFullscreenIfNeeded();
      if (readerComic) {
        closeComicReader();
        return;
      }

      if (!playerImage.hidden) {
        playerImage.hidden = true;
        playerImage.removeAttribute('src');
        playerModal.hidden = true;
        playerItem = null;
        viewerList = [];
        viewerIndex = -1;
        return;
      }

      reportPlayerPosition(false);
      if (playerReportTimer) {
        clearInterval(playerReportTimer);
        playerReportTimer = null;
      }
      playerVideo.pause();
      playerVideo.removeAttribute('src');
      playerVideo.load();
      playerModal.hidden = true;
      playerItem = null;
      loadLibrary(false, { silent: true });
    }

    playerClose.addEventListener('click', closeLocalPlayer);

    playerModal.addEventListener('click', (event) => {
      if (event.target === playerModal) {
        closeLocalPlayer();
      }
    });

    playerTranscode.addEventListener('click', () => {
      if (playerItem) {
        setPlayerSource(playerItem, playerLastTracks, true);
      }
    });

    playerVideo.addEventListener('pause', () => reportPlayerPosition(false));
    playerVideo.addEventListener('ended', () => reportPlayerPosition(true));

    // A codec the browser cannot decode fails here; retry once through FFmpeg.
    playerVideo.addEventListener('error', () => {
      if (!playerItem || playerUsedTranscode) {
        playerNote.textContent = 'This file could not be played in the browser.';
        playerNote.classList.add('warn');
        return;
      }
      playerNote.textContent = 'The browser cannot decode this file directly. Transcoding...';
      playerNote.classList.add('warn');
      setPlayerSource(playerItem, playerLastTracks, true);
    });

    detailPlayHere.addEventListener('click', () => {
      const item = detailItem;
      if (!item) {
        return;
      }
      closeDetailModal();
      playOnThisDevice(item);
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
      if (event.key !== 'Escape') {
        return;
      }
      // The browser uses Escape to leave fullscreen; do not also close the view.
      if (document.fullscreenElement) {
        return;
      }
      if (!playerModal.hidden) {
        closeLocalPlayer();
      } else if (!detailModal.hidden) {
        closeDetailModal();
      } else if (!folderModal.hidden) {
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

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
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
  const subtitleUrl = options.subtitleUrl !== undefined
    ? options.subtitleUrl
    : await mediaServer.getSubtitleUrl(media.id, { allowDownload: true });
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

  if (options.isImage) {
    await play(renderer);
  } else if (effectivePlaylistContext && Number.isFinite(Number(effectivePlaylistContext.selectedTrackNumber))) {
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
  initialComicProgress = {},
  onComicProgressChanged,
  initialBookProgress = {},
  onBookProgressChanged,
  initialBookAnnotations = {},
  onBookAnnotationsChanged,
  speechDir,
  initialCustomCategories = [],
  initialFolderCategories = {},
  onCategoriesChanged,
  initialMediaOverrides = {},
  onMediaOverridesChanged,
  initialGroupOverrides = {},
  onGroupOverridesChanged,
  initialMetadataCache = {},
  onMetadataCacheChanged,
  coversDir,
  subtitlesDir,
  comicsDir,
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

  // ---- User-supplied metadata -------------------------------------------
  // Keyed by file path (not the index-based media id, which shifts whenever the
  // library is rescanned) so edits stick across restarts.
  const mediaOverrides = new Map();

  const overrideKeyFor = (filePath) => normalizeFolderKey(filePath);

  const overrideFor = (filePath) => mediaOverrides.get(overrideKeyFor(filePath)) || null;

  // A show or comic tile is not a file, so its edits are keyed by the category
  // and the group name the library built it from.
  const groupOverrides = new Map();

  const groupOverrideKey = (category, name) => {
    const categoryPart = String(category || '').trim().toLowerCase();
    const namePart = String(name || '').trim().toLowerCase();
    return categoryPart && namePart ? categoryPart + '::' + namePart : '';
  };

  const groupOverrideFor = (category, name) => {
    const key = groupOverrideKey(category, name);
    return key ? (groupOverrides.get(key) || null) : null;
  };

  // Folds a group's edits over whatever the library worked out for it.
  const withGroupOverride = (category, group) => {
    const override = groupOverrideFor(category, group.name);
    if (!override) {
      return group;
    }

    return {
      ...group,
      displayTitle: override.title || group.displayTitle,
      year: override.year || group.year,
      plot: override.plot || group.plot,
      posterUrl: override.posterUrl || group.posterUrl,
      edited: true,
    };
  };

  const sanitizeOverride = (value) => {
    const source = value && typeof value === 'object' ? value : {};
    const text = (input, max) => {
      const cleaned = String(input === null || input === undefined ? '' : input).trim();
      return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
    };

    const entry = {
      title: text(source.title, 300),
      year: text(source.year, 12),
      plot: text(source.plot, 4000),
      posterUrl: text(source.posterUrl, 2000),
    };

    // An entry with nothing in it is the same as having no override at all.
    if (!entry.title && !entry.year && !entry.plot && !entry.posterUrl) {
      return null;
    }

    entry.updatedAt = source.updatedAt || new Date().toISOString();
    return entry;
  };

  const persistMediaOverrides = () => {
    if (typeof onMediaOverridesChanged !== 'function') {
      return;
    }
    onMediaOverridesChanged(Object.fromEntries(mediaOverrides.entries()));
  };

  const persistGroupOverrides = () => {
    if (typeof onGroupOverridesChanged !== 'function') {
      return;
    }
    onGroupOverridesChanged(Object.fromEntries(groupOverrides.entries()));
  };

  const setGroupOverride = (category, name, value) => {
    const key = groupOverrideKey(category, name);
    if (!key) {
      return null;
    }

    const entry = sanitizeOverride(value);
    if (!entry) {
      groupOverrides.delete(key);
      persistGroupOverrides();
      return null;
    }

    groupOverrides.set(key, entry);
    persistGroupOverrides();
    return entry;
  };

  const setMediaOverride = (filePath, value) => {
    const key = overrideKeyFor(filePath);
    if (!key) {
      return null;
    }

    const entry = sanitizeOverride(value);
    if (!entry) {
      mediaOverrides.delete(key);
      persistMediaOverrides();
      return null;
    }

    mediaOverrides.set(key, entry);
    persistMediaOverrides();
    return entry;
  };

  for (const [key, value] of Object.entries(
    initialMediaOverrides && typeof initialMediaOverrides === 'object' ? initialMediaOverrides : {},
  )) {
    const entry = sanitizeOverride(value);
    const normalized = String(key || '').trim();
    if (entry && normalized) {
      mediaOverrides.set(normalized, entry);
    }
  }

  for (const [key, value] of Object.entries(
    initialGroupOverrides && typeof initialGroupOverrides === 'object' ? initialGroupOverrides : {},
  )) {
    const entry = sanitizeOverride(value);
    const normalized = String(key || '').trim().toLowerCase();
    if (entry && normalized) {
      groupOverrides.set(normalized, entry);
    }
  }

  const resolvedCoversDir = coversDir ? path.resolve(coversDir) : null;
  const resolvedSubtitlesDir = subtitlesDir
    ? path.resolve(subtitlesDir)
    : (coversDir ? path.join(path.dirname(path.resolve(coversDir)), 'subtitles') : null);

  // Text formats convert cleanly to SRT; bitmap ones would need OCR, so they are
  // offered only as burn-in candidates rather than sidecar tracks.
  const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

  const probeCache = new Map();
  const comicPageCache = new Map();
  let comicIndex = null;
  let comicIndexSignature = '';

  const bookId = (book) => 'cb-' + crypto.createHash('sha1')
    .update(normalizeFolderKey(book.path))
    .digest('hex')
    .slice(0, 16);

  // Rebuilt only when the library actually changes; scanning 6000 files takes
  // about 100ms, which is too much to repeat per request.
  const getComicIndex = () => {
    const library = mediaServer.library || [];
    const signature = librarySignature();

    if (comicIndex && comicIndexSignature === signature) {
      return comicIndex;
    }

    const comicItems = library.filter((item) => (
      isComicArchiveFile(item.filePath)
      || (isImageFile(item.filePath) && resolveCategory(item.filePath) === CATEGORY_COMICS)
      || isImageFile(item.filePath)
    ));

    const { books, pageImagePaths } = collectComicBooks(comicItems);
    const groups = buildComicGroups({ books, rootDirs: mediaServer.getRootDirs() });

    const byId = new Map();
    for (const book of books) {
      book.id = bookId(book);
      try {
        const stat = fs.statSync(book.path);
        book.size = stat.isDirectory() ? null : stat.size;
        book.addedAtMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
      } catch {
        book.size = null;
        book.addedAtMs = null;
      }
      byId.set(book.id, book);
    }

    comicIndex = { books, groups, byId, pageImagePaths };
    comicIndexSignature = signature;
    return comicIndex;
  };

  const findComicBook = (id) => getComicIndex().byId.get(String(id || '')) || null;

  // Comic endpoints accept either a library media id or a synthetic book id,
  // since a folder of pages is a book without being a file.
  const resolveComicTarget = (id) => {
    const book = findComicBook(id);
    if (book) {
      return book;
    }

    const media = mediaServer.getMediaById(String(id || ''));
    if (media && isComicArchiveFile(media.filePath)) {
      return {
        id: String(id),
        kind: 'archive',
        path: media.filePath,
        name: path.basename(media.filePath, path.extname(media.filePath)),
      };
    }
    return null;
  };

  const resolvedComicsDir = comicsDir
    ? path.resolve(comicsDir)
    : (coversDir ? path.join(path.dirname(path.resolve(coversDir)), 'comics') : null);

  const comicCacheKey = (book) => crypto.createHash('sha1')
    .update(normalizeFolderKey(book.path || book.filePath))
    .digest('hex')
    .slice(0, 16);

  // Page names are read once per archive: for RAR this means decoding the whole
  // archive, which is far too slow to repeat for every page request.
  const getComicPageNames = async (book) => {
    // A folder book already knows its pages; only archives need opening.
    if (book.kind === 'folder') {
      return book.pages || [];
    }

    const key = comicCacheKey(book);
    if (comicPageCache.has(key)) {
      return comicPageCache.get(key);
    }

    const pages = await listComicPages(book.path);
    comicPageCache.set(key, pages);
    return pages;
  };

  // Extracted pages are cached on disk so re-reading a comic costs nothing,
  // which matters most for RAR where extraction is expensive.
  const getComicPageFile = async (book, pageIndex) => {
    const pages = await getComicPageNames(book);
    if (pageIndex < 0 || pageIndex >= pages.length) {
      const error = new Error('That page does not exist.');
      error.code = 'COMIC_PAGE_NOT_FOUND';
      throw error;
    }

    const entryName = pages[pageIndex];
    const extension = (path.extname(entryName) || '.jpg').toLowerCase();

    // Pages of a folder book are already files on disk; nothing to extract.
    if (book.kind === 'folder') {
      return { filePath: entryName, extension };
    }

    if (!resolvedComicsDir) {
      return { buffer: await readComicPage(book.path, entryName), extension };
    }

    const dir = path.join(resolvedComicsDir, comicCacheKey(book));
    const cached = path.join(dir, String(pageIndex) + extension);
    if (fs.existsSync(cached) && fs.statSync(cached).size > 0) {
      return { filePath: cached, extension };
    }

    const buffer = await readComicPage(book.path, entryName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cached, buffer);
    return { filePath: cached, extension };
  };

  const comicCoverPath = (book) => (resolvedComicsDir
    ? path.join(resolvedComicsDir, comicCacheKey(book) + '-cover.jpg')
    : null);

  const buildComicCover = async (book) => {
    const media = book;
    const outPath = comicCoverPath(book);
    if (!outPath) {
      return null;
    }
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return outPath;
    }

    const page = await getComicPageFile(media, 0);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const sourcePath = page.filePath
      || path.join(path.dirname(outPath), comicCacheKey(media) + '-src' + page.extension);
    if (!page.filePath) {
      fs.writeFileSync(sourcePath, page.buffer);
    }

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', sourcePath,
        '-vf', "scale='min(480,iw)':-2",
        '-frames:v', '1', '-q:v', '4',
        outPath,
      ], { windowsHide: true });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('cover scaling failed'))));
    });

    return fs.existsSync(outPath) ? outPath : null;
  };

  const comicMimeFor = (extension) => {
    const clean = String(extension || '').toLowerCase();
    if (clean === '.png') return 'image/png';
    if (clean === '.gif') return 'image/gif';
    if (clean === '.webp') return 'image/webp';
    if (clean === '.bmp') return 'image/bmp';
    return 'image/jpeg';
  };

  const probeMediaTracks = async (media) => {
    const cacheKey = media.filePath;
    if (probeCache.has(cacheKey)) {
      return probeCache.get(cacheKey);
    }

    const { probeFile } = await import('../transcoding/detector.js');
    const probe = await probeFile(media.filePath);
    probeCache.set(cacheKey, probe);
    return probe;
  };

  const describeAudioTrack = (stream) => {
    const parts = [];
    if (stream.language) {
      parts.push(stream.language.toUpperCase());
    }
    if (stream.title) {
      parts.push(stream.title);
    }
    if (!parts.length) {
      parts.push('Track ' + (stream.typeIndex + 1));
    }

    const extras = [];
    if (stream.codec_name) {
      extras.push(stream.codec_name.toUpperCase());
    }
    if (stream.channels === 1) {
      extras.push('Mono');
    } else if (stream.channels === 2) {
      extras.push('Stereo');
    } else if (stream.channels > 2) {
      extras.push(stream.channels + 'ch');
    }

    return parts.join(' - ') + (extras.length ? ' (' + extras.join(', ') + ')' : '');
  };

  const describeSubtitleTrack = (stream) => {
    const parts = [];
    if (stream.language) {
      parts.push(stream.language.toUpperCase());
    }
    if (stream.title) {
      parts.push(stream.title);
    }
    if (!parts.length) {
      parts.push('Track ' + (stream.typeIndex + 1));
    }
    if (stream.isForced) {
      parts.push('Forced');
    }

    return parts.join(' - ') + (stream.codec_name ? ' (' + stream.codec_name + ')' : '');
  };

  const subtitleCachePath = (media, streamIndex) => {
    if (!resolvedSubtitlesDir) {
      return null;
    }
    const stem = crypto.createHash('sha1').update(normalizeFolderKey(media.filePath)).digest('hex').slice(0, 16);
    return path.join(resolvedSubtitlesDir, stem + '-s' + streamIndex + '.srt');
  };

  // Pull one embedded track out to SRT so the renderer can show it as a sidecar,
  // which avoids re-encoding the video just to get subtitles on screen.
  const extractEmbeddedSubtitle = (media, streamIndex) => new Promise((resolve, reject) => {
    const outPath = subtitleCachePath(media, streamIndex);
    if (!outPath) {
      reject(new Error('Subtitle storage is not available.'));
      return;
    }

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      resolve(outPath);
      return;
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const proc = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', media.filePath,
      '-map', '0:s:' + streamIndex,
      '-c:s', 'srt',
      outPath,
    ], { windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      reject(new Error(err.code === 'ENOENT'
        ? 'ffmpeg not found. Install FFmpeg to use embedded subtitles.'
        : err.message));
    });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        resolve(outPath);
      } else {
        reject(new Error('Could not extract that subtitle track. ' + stderr.slice(0, 200)));
      }
    });
  });

  const saveUploadedSubtitle = (media, content) => {
    const outPath = subtitleCachePath(media, 'user');
    if (!outPath) {
      throw new Error('Subtitle storage is not available.');
    }

    const text = String(content || '');
    if (!text.trim()) {
      throw new Error('That subtitle file is empty.');
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, 'utf8');
    return outPath;
  };

  const saveCoverImage = (filePath, dataUrl) => saveCoverImageForKey(overrideKeyFor(filePath), dataUrl);

  const saveCoverImageForKey = (coverKey, dataUrl) => {
    if (!resolvedCoversDir) {
      throw new Error('Cover storage is not available.');
    }

    const match = String(dataUrl || '').match(/^data:([a-z/+.-]+);base64,(.+)$/i);
    if (!match) {
      throw new Error('Cover must be a base64 image.');
    }

    const extension = COVER_MIME_EXTENSIONS[match[1].toLowerCase()];
    if (!extension) {
      throw new Error('Unsupported image type: ' + match[1]);
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) {
      throw new Error('Cover image is empty.');
    }
    if (buffer.length > MAX_COVER_BYTES) {
      throw new Error('Cover image is larger than 8MB.');
    }

    fs.mkdirSync(resolvedCoversDir, { recursive: true });

    const stem = crypto.createHash('sha1').update(String(coverKey || '')).digest('hex').slice(0, 16);

    // Drop any previous cover for this item so the folder does not accumulate.
    for (const candidate of Object.values(COVER_MIME_EXTENSIONS)) {
      const previous = path.join(resolvedCoversDir, stem + '.' + candidate);
      if (previous !== path.join(resolvedCoversDir, stem + '.' + extension) && fs.existsSync(previous)) {
        try {
          fs.unlinkSync(previous);
        } catch {
          // A locked file is not worth failing the save over.
        }
      }
    }

    const fileName = stem + '.' + extension;
    fs.writeFileSync(path.join(resolvedCoversDir, fileName), buffer);

    // Cache-bust so the browser picks up a replaced cover immediately.
    return '/covers/' + fileName + '?v=' + Date.now();
  };

  const transcodingEnabled = Boolean(
    mediaServer && mediaServer.transcoding && mediaServer.transcoding.enabled !== false,
  );

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
    // Without an explicit pin, photos and comics would fall through to Movies.
    if (isImageFile(filePath)) {
      return CATEGORY_PHOTOS;
    }
    if (isBookFile(filePath)) {
      return CATEGORY_BOOKS;
    }
    if (isComicArchiveFile(filePath)) {
      return CATEGORY_COMICS;
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
  // Where the reader left off, per book: { page (1-based), pageCount }.
  const comicProgress = new Map();
  // Where the e-reader left off: { chapterIndex, offset, percent, label }.
  const bookProgress = new Map();
  // Highlights, notes and bookmarks, per book: key -> [annotation].
  const bookAnnotations = new Map();
  // Opening an EPUB means unzipping and parsing it, so keep the result around.
  const bookInfoCache = new Map();

  const readBookInfo = (filePath) => {
    const cacheKey = normalizeFolderKey(filePath);
    const cached = bookInfoCache.get(cacheKey);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }

    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.info;
    }

    let info;
    try {
      info = openEpub(filePath);
    } catch (error) {
      // A book that will not parse still deserves a tile, just a plain one.
      info = {
        title: '',
        creator: '',
        description: '',
        spine: [],
        toc: [],
        coverHref: '',
        error: error.message,
      };
    }

    if (bookInfoCache.size > 64) {
      bookInfoCache.clear();
    }
    bookInfoCache.set(cacheKey, { mtimeMs, info });
    return info;
  };

  // Piper is looked up once and re-checked when the folder changes, so dropping
  // a voice in does not need a restart.
  const resolvedSpeechDir = speechDir ? path.resolve(speechDir) : null;
  let speechEngineCache = null;
  let speechEngineStamp = '';

  const speechFolderStamp = () => {
    if (!resolvedSpeechDir) {
      return 'none';
    }
    try {
      const stat = fs.statSync(resolvedSpeechDir);
      return String(stat.mtimeMs) + ':' + String(stat.size);
    } catch {
      return 'missing';
    }
  };

let speechInstallResult = null;

  const getSpeechEngine = () => {
    const stamp = speechFolderStamp();
    if (speechEngineCache && speechEngineStamp === stamp) {
      return speechEngineCache;
    }

    if (!resolvedSpeechDir) {
      speechEngineCache = { binary: null, voices: [], available: false };
      speechEngineStamp = stamp;
      return speechEngineCache;
    }

    let engine = findPiper(resolvedSpeechDir);

    // Nothing installed yet: unpack the copy that ships with the app. This runs
    // once, the first time a book is asked to read itself aloud.
    if (!engine.available) {
      speechInstallResult = ensureBundledEngine(resolvedSpeechDir);
      if (speechInstallResult.installed) {
        engine = findPiper(resolvedSpeechDir);
      }
    }

    speechEngineCache = engine;
    speechEngineStamp = speechFolderStamp();
    return speechEngineCache;
  };

  const speechAudioCachePath = (key) => (
    resolvedSpeechDir ? path.join(resolvedSpeechDir, 'cache', key + '.wav') : null
  );

  const resolveBookTarget = (mediaId) => {
    const media = mediaServer.getMediaById(String(mediaId || '').trim());
    if (!media || !isBookFile(media.filePath)) {
      return null;
    }
    return media;
  };

  const bookKeyFor = (media) => String(media && media.filePath ? media.filePath : '').trim();

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

  for (const [key, value] of Object.entries(initialComicProgress && typeof initialComicProgress === 'object'
    ? initialComicProgress
    : {})) {
    const progressKey = String(key || '').trim();
    const page = Number(value && value.page);
    const pageCount = Number(value && value.pageCount);
    if (!progressKey || !Number.isFinite(page) || page <= 1) {
      continue;
    }
    comicProgress.set(progressKey, {
      page: Math.floor(page),
      pageCount: Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : null,
      updatedAt: (value && value.updatedAt) || new Date().toISOString(),
    });
  }

  for (const [key, value] of Object.entries(initialBookProgress && typeof initialBookProgress === 'object'
    ? initialBookProgress
    : {})) {
    const progressKey = String(key || '').trim();
    const chapterIndex = Number(value && value.chapterIndex);
    if (!progressKey || !Number.isFinite(chapterIndex) || chapterIndex < 0) {
      continue;
    }
    const offset = Number(value && value.offset);
    const percent = Number(value && value.percent);
    bookProgress.set(progressKey, {
      chapterIndex: Math.floor(chapterIndex),
      offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(1, percent)) : 0,
      label: typeof (value && value.label) === 'string' ? value.label : '',
      updatedAt: (value && value.updatedAt) || new Date().toISOString(),
    });
  }

  for (const [key, value] of Object.entries(initialBookAnnotations && typeof initialBookAnnotations === 'object'
    ? initialBookAnnotations
    : {})) {
    const annotationKey = String(key || '').trim();
    if (!annotationKey || !Array.isArray(value)) {
      continue;
    }
    const cleaned = value.map(normalizeAnnotation).filter(Boolean);
    if (cleaned.length > 0) {
      bookAnnotations.set(annotationKey, cleaned);
    }
  }

  const persistBookProgress = () => {
    if (typeof onBookProgressChanged !== 'function') {
      return;
    }
    const payload = {};
    for (const [key, value] of bookProgress.entries()) {
      payload[key] = { ...value };
    }
    onBookProgressChanged(payload);
  };

  const persistBookAnnotations = () => {
    if (typeof onBookAnnotationsChanged !== 'function') {
      return;
    }
    const payload = {};
    for (const [key, value] of bookAnnotations.entries()) {
      if (value.length > 0) {
        payload[key] = value.map((entry) => ({ ...entry }));
      }
    }
    onBookAnnotationsChanged(payload);
  };

  const persistComicProgress = () => {
    if (typeof onComicProgressChanged !== 'function') {
      return;
    }

    const payload = {};
    for (const [key, value] of comicProgress.entries()) {
      payload[key] = {
        page: value.page,
        pageCount: value.pageCount,
        updatedAt: value.updatedAt,
      };
    }
    onComicProgressChanged(payload);
  };

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

  let movieItemsCache = null;
  let movieItemsSignature = '';

  const librarySignature = () => {
    const library = mediaServer.library || [];
    return library.length
      + ':' + (library[0] ? library[0].filePath : '')
      + ':' + (library[library.length - 1] ? library[library.length - 1].filePath : '');
  };

  // Stats every file, so it is memoised per library revision. With a few
  // thousand files this was costing hundreds of milliseconds on every request,
  // and it runs for the category counts on all of them.
  const getMovieItems = () => {
    const signature = librarySignature();
    if (movieItemsCache && movieItemsSignature === signature) {
      return movieItemsCache;
    }

    movieItemsCache = mediaServer.library
      .filter(isLibraryItem)
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
    movieItemsSignature = signature;
    return movieItemsCache;
  };

  // Keyed by file path, not media id: ids are positional and shift on every
  // rescan, whereas paths let a cached lookup survive restarts.
  const metadataMap = new Map();
  const metadataPending = new Map();
  let metadataVersion = 0;
  let metadataSaveTimer = null;

  const metaKey = (item) => normalizeFolderKey(item && item.filePath ? item.filePath : '');

  // A result with no identifiers is a placeholder; retry those occasionally in
  // case the title later becomes available, but keep real results forever.
  const UNRESOLVED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

  const isResolvedMetadata = (entry) => Boolean(
    entry && (entry.tmdbId || entry.imdbId || entry.plot || entry.imdbRating || entry.year),
  );

  for (const [key, value] of Object.entries(
    initialMetadataCache && typeof initialMetadataCache === 'object' ? initialMetadataCache : {},
  )) {
    const cacheKey = String(key || '').trim();
    if (!cacheKey || !value || typeof value !== 'object') {
      continue;
    }

    if (!isResolvedMetadata(value)) {
      const fetchedAt = Date.parse(value.fetchedAt || '');
      if (!Number.isFinite(fetchedAt) || (Date.now() - fetchedAt) > UNRESOLVED_RETRY_MS) {
        continue;
      }
    }

    metadataMap.set(cacheKey, value);
  }

  // Batched so a burst of lookups results in one write, not hundreds.
  const scheduleMetadataSave = () => {
    if (typeof onMetadataCacheChanged !== 'function' || metadataSaveTimer) {
      return;
    }

    metadataSaveTimer = setTimeout(() => {
      metadataSaveTimer = null;
      try {
        onMetadataCacheChanged(Object.fromEntries(metadataMap.entries()));
      } catch (error) {
        console.warn('[Metadata] Could not save the metadata cache: ' + error.message);
      }
    }, 2500);

    if (typeof metadataSaveTimer.unref === 'function') {
      metadataSaveTimer.unref();
    }
  };
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
    if (isComicFile(item.filePath)) {
      const displayName = safeBasename(
        path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim(),
      );

      return {
        category: resolveCategory(item.filePath),
        showName: null,
        seasonInfo: null,
        fallbackSeriesTitle: '',
        searchTitle: displayName,
        isShowCategory: false,
        isImage: true,
        displayTitle: displayName,
        enriched: {
          movieTitle: displayName,
          mediaType: 'comic',
          showName: null,
          showDisplayTitle: null,
          showPosterUrl: null,
          showPlot: null,
          showImdbRating: null,
          showRatingSource: null,
          showYear: null,
          seasonLabel: null,
          seasonNumber: null,
          episodeNumber: null,
          seasonSort: null,
          episodeSort: null,
          posterUrl: '/comic/' + encodeURIComponent(item.id) + '/cover',
          year: null,
          plot: null,
          imdbRating: null,
          ratingSource: null,
        },
      };
    }

    if (isBookFile(item.filePath)) {
      // Title and author come from inside the book, so no network lookup runs.
      const info = readBookInfo(item.filePath);
      const displayName = info.title || safeBasename(
        path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim(),
      );

      return {
        category: resolveCategory(item.filePath),
        showName: null,
        seasonInfo: null,
        fallbackSeriesTitle: '',
        searchTitle: displayName,
        isShowCategory: false,
        isImage: true,
        displayTitle: displayName,
        enriched: {
          movieTitle: displayName,
          mediaType: 'book',
          author: info.creator || null,
          showName: null,
          showDisplayTitle: null,
          showPosterUrl: null,
          showPlot: null,
          showImdbRating: null,
          showRatingSource: null,
          showYear: null,
          seasonLabel: null,
          seasonNumber: null,
          episodeNumber: null,
          seasonSort: null,
          episodeSort: null,
          posterUrl: '/book/' + encodeURIComponent(item.id) + '/cover',
          year: null,
          plot: info.description || null,
          imdbRating: null,
          ratingSource: null,
        },
      };
    }

    if (isImageFile(item.filePath)) {
      const displayName = safeBasename(
        path.basename(item.name, path.extname(item.name)).replace(/[._]+/g, ' ').trim(),
      );
      let thumbUrl = null;
      try {
        thumbUrl = typeof mediaServer.getLocalThumbUrl === 'function'
          ? mediaServer.getLocalThumbUrl(item.id)
          : null;
      } catch {
        thumbUrl = null;
      }

      return {
        category: resolveCategory(item.filePath),
        showName: null,
        seasonInfo: null,
        fallbackSeriesTitle: '',
        searchTitle: displayName,
        isShowCategory: false,
        isImage: true,
        displayTitle: displayName,
        enriched: {
          movieTitle: displayName,
          mediaType: 'image',
          showName: null,
          showDisplayTitle: null,
          showPosterUrl: null,
          showPlot: null,
          showImdbRating: null,
          showRatingSource: null,
          showYear: null,
          seasonLabel: null,
          seasonNumber: null,
          episodeNumber: null,
          seasonSort: null,
          episodeSort: null,
          posterUrl: thumbUrl,
          year: null,
          plot: null,
          imdbRating: null,
          ratingSource: null,
        },
      };
    }

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
      isImage: false,
      enriched: {
        movieTitle: displayTitle,
        mediaType: 'video',
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
    if (local && local.isImage) {
      return;
    }

    const cacheKey = metaKey(item);
    if (!cacheKey || metadataMap.has(cacheKey) || metadataPending.has(cacheKey)) {
      return;
    }

    let resolvePending = null;
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    metadataPending.set(cacheKey, pendingPromise);

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

        metadataMap.set(cacheKey, {
          fetchedAt: new Date().toISOString(),
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
        scheduleMetadataSave();
      } catch {
        // Ignore metadata fetch failures.
      } finally {
        metadataPending.delete(cacheKey);
        if (resolvePending) {
          resolvePending();
        }
      }
    });

    pumpMetadataQueue();
  };

  const withOverride = (item, enriched) => {
    const override = overrideFor(item.filePath);
    if (!override) {
      return enriched;
    }

    return {
      ...enriched,
      movieTitle: override.title || enriched.movieTitle,
      year: override.year || enriched.year,
      plot: override.plot || enriched.plot,
      posterUrl: override.posterUrl || enriched.posterUrl,
      userEdited: true,
      overrideFields: {
        title: Boolean(override.title),
        year: Boolean(override.year),
        plot: Boolean(override.plot),
        posterUrl: Boolean(override.posterUrl),
      },
    };
  };

  const enrichItemsWithMetadata = async (items) => {
    const result = [];

    for (const item of items) {
      const cacheKey = metaKey(item);
      if (metadataMap.has(cacheKey)) {
        result.push(withOverride(item, {
          ...item,
          ...metadataMap.get(cacheKey),
        }));
      } else {
        const local = buildLocalMetadata(item);
        queueMetadataFetch(item, local);
        result.push(withOverride(item, {
          ...item,
          ...local.enriched,
        }));
      }
    }

    return result;
  };

  const comicBookItem = (book) => {
    const base = {
      id: book.id,
      name: book.name,
      filePath: book.path,
      watchedKey: book.path,
      mimeType: book.kind === 'folder' ? 'inode/directory' : 'application/vnd.comicbook',
      size: book.size === undefined ? null : book.size,
      addedAtMs: book.addedAtMs === undefined ? null : book.addedAtMs,
      mediaType: 'comic',
      movieTitle: book.name,
      posterUrl: '/comic/' + encodeURIComponent(book.id) + '/cover',
      showName: null,
      showDisplayTitle: null,
      showPosterUrl: null,
      showPlot: null,
      showImdbRating: null,
      showRatingSource: null,
      showYear: null,
      seasonLabel: null,
      seasonNumber: null,
      episodeNumber: null,
      seasonSort: null,
      episodeSort: null,
      year: null,
      plot: null,
      imdbRating: null,
      ratingSource: null,
    };

    return withOverride({ filePath: book.path }, base);
  };

  // Comics come from the folder tree rather than from filename metadata, so they
  // build their own comic -> volume -> book payload.
  let comicPayloadCache = new Map();

  const getComicsPayload = (sortMode) => {
    const index = getComicIndex();
    // metadataVersion moves whenever a user edit lands, which is the only other
    // thing the payload depends on.
    const cacheKey = comicIndexSignature + ':' + metadataVersion + ':' + sortMode;
    if (comicPayloadCache.has(cacheKey)) {
      return comicPayloadCache.get(cacheKey);
    }
    const groups = index.groups.map((group) => {
      const seasons = group.volumes.map((volume) => ({
        name: volume.name,
        seasonSort: 0,
        items: volume.books.map(comicBookItem),
      }));

      const firstBook = seasons.length && seasons[0].items.length ? seasons[0].items[0] : null;
      const latestAddedAtMs = seasons.reduce((latest, season) => Math.max(
        latest,
        season.items.reduce((seasonMax, item) => Math.max(
          seasonMax,
          Number.isFinite(Number(item.addedAtMs)) ? Number(item.addedAtMs) : 0,
        ), 0),
      ), 0);

      return withGroupOverride(CATEGORY_COMICS, {
        name: group.name,
        displayTitle: group.name,
        posterUrl: firstBook ? firstBook.posterUrl : null,
        year: null,
        plot: null,
        imdbRating: null,
        ratingSource: null,
        latestAddedAtMs,
        seasons,
        items: [],
      });
    });

    if (sortMode === 'recent') {
      groups.sort((a, b) => (b.latestAddedAtMs || 0) - (a.latestAddedAtMs || 0)
        || String(a.name).localeCompare(String(b.name)));
    }

    const payload = { items: [], groups };
    if (comicPayloadCache.size > 8) {
      comicPayloadCache = new Map();
    }
    comicPayloadCache.set(cacheKey, payload);
    return payload;
  };

  const getCategoryPayload = async (category, sortMode = 'alpha') => {
    const normalizedSort = sortMode === 'recent' ? 'recent' : 'alpha';

    if (category === CATEGORY_COMICS) {
      return getComicsPayload(normalizedSort);
    }

    // Pages that belong to a comic must not also appear as loose photos.
    const comicPages = getComicIndex().pageImagePaths;
    const items = getMovieItems().filter((item) => (
      resolveCategory(item.filePath) === category
      && !comicPages.has(normalizeFolderKey(item.filePath))
    ));
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

          return withGroupOverride(category, {
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
          });
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
    const index = getComicIndex();
    for (const item of getMovieItems()) {
      if (index.pageImagePaths.has(normalizeFolderKey(item.filePath))) {
        continue;
      }
      const id = resolveCategory(item.filePath);
      if (id === CATEGORY_COMICS) {
        continue;
      }
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    counts.set(CATEGORY_COMICS, index.books.length);

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
          comicProgress: Object.fromEntries(comicProgress.entries()),
          bookProgress: Object.fromEntries(bookProgress.entries()),
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
        comicProgress: Object.fromEntries(comicProgress.entries()),
        bookProgress: Object.fromEntries(bookProgress.entries()),
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

        // Books open in the reader; a renderer has nothing to do with them.
        if (isBookFile(media.filePath)) {
          sendJson(res, 400, {
            ok: false,
            error: 'Books are read on this device and cannot be cast.',
          });
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

        // Audio choice is applied when the stream is built for this item.
        const mediaIsImage = isImageFile(media.filePath);
        const audioStreamIndex = Number(payload.audioStreamIndex);
        mediaServer.setPlaybackOptions(media.id, {
          audioStreamIndex: (!mediaIsImage && Number.isInteger(audioStreamIndex))
            ? audioStreamIndex
            : null,
        });

        const subtitleMode = String(payload.subtitleMode || '').trim();
        let subtitleUrl;
        if (mediaIsImage) {
          subtitleUrl = null;
        } else if (subtitleMode === 'off') {
          subtitleUrl = null;
        } else if (subtitleMode) {
          subtitleUrl = await mediaServer.getSubtitleUrl(media.id, {
            allowDownload: subtitleMode === 'download',
          });
        }

        const result = await castMediaItem(selectedRenderer, mediaServer, media, {
          startSeconds: mediaIsImage ? 0 : startSeconds,
          playlistContext,
          subtitleUrl,
          isImage: mediaIsImage,
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
        if (!mediaIsImage) {
          if (!playlistModeUsed) {
            await configureRendererNextEpisode(selectedRenderer, media).catch(() => {});
          }
          startPlaybackProgressPolling();
          pollAllActivePlaybackPositions().catch(() => {});
        } else {
          activePlaybacks.delete(selectedKey);
        }

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

        let bookProgressCleared = false;
        for (const clearKey of clearKeys) {
          const trimmed = String(clearKey || '').trim();
          if (trimmed && bookProgress.delete(trimmed)) {
            bookProgressCleared = true;
          }
        }
        if (bookProgressCleared) {
          persistBookProgress();
        }

        let comicProgressCleared = false;
        for (const clearKey of clearKeys) {
          const trimmed = String(clearKey || '').trim();
          if (trimmed && comicProgress.delete(trimmed)) {
            comicProgressCleared = true;
          }
        }
        if (comicProgressCleared) {
          persistComicProgress();
        }

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

    if (req.method === 'GET' && parsed.pathname.startsWith('/covers/')) {
      try {
        const fileName = decodeURIComponent(parsed.pathname.slice('/covers/'.length));
        if (!resolvedCoversDir || !/^[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(fileName)) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const fullPath = path.join(resolvedCoversDir, fileName);
        if (!fs.existsSync(fullPath)) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const extension = path.extname(fileName).slice(1).toLowerCase();
        const mime = extension === 'png' ? 'image/png'
          : extension === 'webp' ? 'image/webp'
            : extension === 'gif' ? 'image/gif'
              : 'image/jpeg';

        res.statusCode = 200;
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(fullPath).pipe(res);
      } catch (error) {
        res.statusCode = 500;
        res.end('Cover read failed');
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/book/speech/status') {
      const engine = getSpeechEngine();
      sendJson(res, 200, {
        ok: true,
        available: engine.available,
        engine: engine.available ? 'piper' : 'none',
        voices: engine.voices.map((voice) => ({ id: voice.id, label: voice.label })),
        folder: resolvedSpeechDir,
        installed: speechInstallResult ? speechInstallResult.reason : null,
        // Shown in the reader only when there is something to fix.
        hint: engine.available
          ? ''
          : (engine.binary
            ? 'A speech engine is installed but has no voice. Add a .onnx voice and its .json file beside it.'
            : 'No speech engine yet. Put the Piper engine and a voice in this folder to have books read aloud.'),
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/book/speech/audio') {
      try {
        const engine = getSpeechEngine();
        if (!engine.available) {
          sendJson(res, 503, { ok: false, error: 'No local speech engine is installed.' });
          return;
        }

        const media = resolveBookTarget(parsed.searchParams.get('id'));
        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Book not found.' });
          return;
        }

        const info = readBookInfo(media.filePath);
        const chapterIndex = Math.floor(Number(parsed.searchParams.get('chapter')) || 0);
        const sentenceIndex = Math.floor(Number(parsed.searchParams.get('index')) || 0);
        const chapter = info.spine[chapterIndex];
        if (!chapter) {
          sendJson(res, 404, { ok: false, error: 'Chapter not found.' });
          return;
        }

        const resource = readEpubResource(media.filePath, chapter.href);
        const html = prepareChapterHtml(
          resource.data.toString('utf8'),
          chapter.href,
          (href) => '/book/' + encodeURIComponent(media.id) + '/res?href=' + encodeURIComponent(href),
        );
        const sentences = speechSentences(html);
        const sentence = sentences[sentenceIndex];
        if (!sentence) {
          sendJson(res, 404, { ok: false, error: 'Sentence not found.' });
          return;
        }

        const requestedVoice = String(parsed.searchParams.get('voice') || '');
        const voice = engine.voices.find((entry) => entry.id === requestedVoice)
          || engine.voices[0];

        // Piper's length_scale is inverse speed: 0.8 is faster, 1.2 slower.
        const rate = Math.max(0.5, Math.min(2, Number(parsed.searchParams.get('rate')) || 1));
        const lengthScale = Number((1 / rate).toFixed(3));

        const key = speechCacheKey(voice.id, lengthScale, sentence.text);
        const cachePath = speechAudioCachePath(key);

        let wav = null;
        if (cachePath && fs.existsSync(cachePath)) {
          try {
            wav = fs.readFileSync(cachePath);
          } catch {
            wav = null;
          }
        }

        if (!wav) {
          wav = await synthesiseWithPiper({
            binary: engine.binary,
            voicePath: voice.path,
            text: sentence.text,
            lengthScale,
          });
          if (cachePath) {
            try {
              fs.mkdirSync(path.dirname(cachePath), { recursive: true });
              fs.writeFileSync(cachePath, wav);
            } catch {
              // A cache miss is only a speed problem, never a failure.
            }
          }
        }

        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wav.length,
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(wav);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/book/open') {
      try {
        const media = resolveBookTarget(parsed.searchParams.get('id'));
        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Book not found.' });
          return;
        }

        const info = readBookInfo(media.filePath);
        if (info.error) {
          sendJson(res, 500, { ok: false, error: info.error });
          return;
        }

        const key = bookKeyFor(media);
        sendJson(res, 200, {
          ok: true,
          id: media.id,
          key,
          title: info.title,
          creator: info.creator,
          publisher: info.publisher,
          language: info.language,
          chapterCount: info.spine.length,
          chapters: info.spine.map((entry, index) => ({ index, href: entry.href })),
          toc: info.toc.map((entry) => ({
            label: entry.label,
            spineIndex: entry.spineIndex,
            anchor: entry.anchor,
            depth: entry.depth,
          })),
          progress: bookProgress.get(key) || null,
          annotations: bookAnnotations.get(key) || [],
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/book/chapter') {
      try {
        const media = resolveBookTarget(parsed.searchParams.get('id'));
        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Book not found.' });
          return;
        }

        const info = readBookInfo(media.filePath);
        const index = Math.floor(Number(parsed.searchParams.get('chapter')) || 0);
        const chapter = info.spine[index];
        if (!chapter) {
          sendJson(res, 404, { ok: false, error: 'Chapter not found.' });
          return;
        }

        const resource = readEpubResource(media.filePath, chapter.href);
        const rawHtml = resource.data.toString('utf8');
        const html = prepareChapterHtml(
          rawHtml,
          chapter.href,
          (href) => '/book/' + encodeURIComponent(media.id) + '/res?href=' + encodeURIComponent(href),
        );

        // Sentences are offset into the same character space the reader uses
        // for highlights, so a spoken sentence can be marked in place.
        const sentences = speechSentences(html);

        sendJson(res, 200, {
          ok: true,
          index,
          href: chapter.href,
          html,
          textLength: chapterPlainText(rawHtml).length,
          speechTextLength: chapterSpeechText(html).length,
          sentences: sentences.map((entry) => ({
            start: entry.start,
            end: entry.end,
            text: entry.text,
          })),
        });
      } catch (error) {
        const status = error.code === 'EPUB_RESOURCE_NOT_FOUND' ? 404 : 500;
        sendJson(res, status, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/book/progress') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const media = resolveBookTarget(payload.id);
        const key = String(payload.key || '').trim() || (media ? bookKeyFor(media) : '');
        const chapterIndex = Math.floor(Number(payload.chapterIndex) || 0);
        const offset = Math.max(0, Math.floor(Number(payload.offset) || 0));
        const percent = Math.max(0, Math.min(1, Number(payload.percent) || 0));

        if (!key) {
          sendJson(res, 400, { ok: false, error: 'Missing book key.' });
          return;
        }

        // Finishing the book marks it read and drops the bookmark.
        if (percent >= BOOK_COMPLETION_PERCENT) {
          bookProgress.delete(key);
          watchedMediaKeys.add(key);
          persistBookProgress();
          if (typeof onWatchedKeysChanged === 'function') {
            onWatchedKeysChanged(Array.from(watchedMediaKeys));
          }
          sendJson(res, 200, { ok: true, done: true });
          return;
        }

        // The very start is the same as never having opened it.
        if (chapterIndex <= 0 && offset <= 0) {
          if (bookProgress.delete(key)) {
            persistBookProgress();
          }
          sendJson(res, 200, { ok: true, done: false });
          return;
        }

        bookProgress.set(key, {
          chapterIndex,
          offset,
          percent,
          label: String(payload.label || '').slice(0, 200),
          updatedAt: new Date().toISOString(),
        });
        persistBookProgress();
        sendJson(res, 200, { ok: true, done: false });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/book/annotations') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const media = resolveBookTarget(payload.id);
        const key = String(payload.key || '').trim() || (media ? bookKeyFor(media) : '');
        if (!key) {
          sendJson(res, 400, { ok: false, error: 'Missing book key.' });
          return;
        }

        const action = String(payload.action || 'save');
        const existing = bookAnnotations.get(key) || [];

        if (action === 'delete') {
          const targetId = String(payload.annotationId || '');
          const next = existing.filter((entry) => entry.id !== targetId);
          if (next.length > 0) {
            bookAnnotations.set(key, next);
          } else {
            bookAnnotations.delete(key);
          }
          persistBookAnnotations();
          sendJson(res, 200, { ok: true, annotations: next });
          return;
        }

        const annotation = normalizeAnnotation(payload.annotation);
        if (!annotation) {
          sendJson(res, 400, { ok: false, error: 'Invalid annotation.' });
          return;
        }

        const next = existing.filter((entry) => entry.id !== annotation.id);
        next.push(annotation);
        next.sort((a, b) => (a.chapterIndex - b.chapterIndex) || (a.start - b.start));
        bookAnnotations.set(key, next);
        persistBookAnnotations();
        sendJson(res, 200, { ok: true, annotation, annotations: next });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/comic/progress') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const mediaId = String(payload.id || '').trim();
        const book = mediaId ? resolveComicTarget(mediaId) : null;
        const progressKey = String(payload.key || '').trim()
          || (book ? String(book.path || book.id || '').trim() : '');
        const page = Math.floor(Number(payload.page) || 0);
        const pageCount = Math.floor(Number(payload.pageCount) || 0);

        if (!progressKey || page <= 0) {
          sendJson(res, 400, { ok: false, error: 'Missing comic progress key or page.' });
          return;
        }

        // Finishing the last page marks the book done and drops the bookmark,
        // so it reopens from the start next time.
        const finished = pageCount > 0 && page >= pageCount;
        if (finished) {
          comicProgress.delete(progressKey);
          watchedMediaKeys.add(progressKey);
          persistComicProgress();
          if (typeof onWatchedKeysChanged === 'function') {
            onWatchedKeysChanged(Array.from(watchedMediaKeys));
          }
          sendJson(res, 200, { ok: true, done: true, page, pageCount });
          return;
        }

        // Back at the start is the same as no bookmark at all.
        if (page <= 1) {
          if (comicProgress.delete(progressKey)) {
            persistComicProgress();
          }
          sendJson(res, 200, { ok: true, done: false, page, pageCount });
          return;
        }

        comicProgress.set(progressKey, {
          page,
          pageCount: pageCount > 0 ? pageCount : null,
          updatedAt: new Date().toISOString(),
        });
        persistComicProgress();
        sendJson(res, 200, { ok: true, done: false, page, pageCount });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    const bookRouteMatch = /^\/book\/([^/]+)\/(res|cover)$/.exec(parsed.pathname);
    if (req.method === 'GET' && bookRouteMatch) {
      try {
        const media = resolveBookTarget(decodeURIComponent(bookRouteMatch[1]));
        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Book not found.' });
          return;
        }

        const info = readBookInfo(media.filePath);
        const wanted = bookRouteMatch[2] === 'cover'
          ? info.coverHref
          : String(parsed.searchParams.get('href') || '');

        if (!wanted) {
          sendJson(res, 404, { ok: false, error: 'No cover in this book.' });
          return;
        }

        const resource = readEpubResource(media.filePath, wanted);
        let payload = resource.data;
        let contentType = resource.mimeType;

        // Stylesheets point at fonts and images inside the archive.
        if (/\.css$/i.test(resource.name)) {
          contentType = 'text/css; charset=utf-8';
          payload = Buffer.from(prepareStylesheet(
            payload.toString('utf8'),
            resource.name,
            (href) => '/book/' + encodeURIComponent(media.id) + '/res?href=' + encodeURIComponent(href),
          ), 'utf8');
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': payload.length,
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(payload);
      } catch (error) {
        const status = error.code === 'EPUB_RESOURCE_NOT_FOUND' ? 404 : 500;
        sendJson(res, status, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/comic/pages') {
      try {
        const book = resolveComicTarget(parsed.searchParams.get('id'));
        if (!book) {
          sendJson(res, 404, { ok: false, error: 'Comic not found.' });
          return;
        }

        const pages = await getComicPageNames(book);
        sendJson(res, 200, {
          ok: true,
          id: book.id,
          title: safeBasename(book.name),
          archive: book.kind === 'folder' ? 'folder' : comicArchiveKind(book.path),
          pageCount: pages.length,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname.startsWith('/comic/')) {
      try {
        const rest = parsed.pathname.slice('/comic/'.length).split('/');
        const book = resolveComicTarget(decodeURIComponent(rest[0] || ''));
        if (!book) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        if (rest[1] === 'cover') {
          const coverPath = await buildComicCover(book);
          if (!coverPath) {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          fs.createReadStream(coverPath).pipe(res);
          return;
        }

        if (rest[1] === 'page') {
          const pageIndex = Number(rest[2]);
          if (!Number.isInteger(pageIndex)) {
            res.statusCode = 400;
            res.end('Bad page');
            return;
          }

          const page = await getComicPageFile(book, pageIndex);
          res.statusCode = 200;
          res.setHeader('Content-Type', comicMimeFor(page.extension));
          res.setHeader('Cache-Control', 'public, max-age=86400');
          if (page.filePath) {
            fs.createReadStream(page.filePath).pipe(res);
          } else {
            res.end(page.buffer);
          }
          return;
        }

        res.statusCode = 404;
        res.end('Not found');
      } catch (error) {
        console.warn('[Comic] ' + error.message);
        if (!res.headersSent) {
          const missing = error.code === 'COMIC_PAGE_NOT_FOUND';
          res.statusCode = missing ? 404 : 500;
          res.end(missing ? 'Not found' : 'Comic read failed');
        }
      }
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/api/media/tracks') {
      try {
        const requestedId = String(parsed.searchParams.get('id') || '');
        const comicTarget = resolveComicTarget(requestedId);
        if (comicTarget) {
          sendJson(res, 200, {
            ok: true,
            id: comicTarget.id,
            mediaType: 'comic',
            mediaUrl: null,
            subtitleUrl: null,
            audio: [],
            subtitles: [],
            hasSidecar: false,
            hasUserSubtitle: false,
            canSelectAudio: false,
            probeError: null,
          });
          return;
        }

        const media = mediaServer.getMediaById(requestedId);
        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Media item not found.' });
          return;
        }

        // A book is read here, so it is never offered as a stream.
        if (isBookFile(media.filePath)) {
          sendJson(res, 200, {
            ok: true,
            id: media.id,
            mediaType: 'book',
            mediaUrl: null,
            subtitleUrl: null,
            audio: [],
            subtitles: [],
            hasSidecar: false,
            hasUserSubtitle: false,
            canSelectAudio: false,
            probeError: null,
          });
          return;
        }

        const sidecarPath = path.join(
          path.dirname(media.filePath),
          path.basename(media.filePath, path.extname(media.filePath)) + '.srt',
        );
        const userPath = subtitleCachePath(media, 'user');

        let audio = [];
        let subtitles = [];
        let probeError = null;

        if (isComicFile(media.filePath)) {
          sendJson(res, 200, {
            ok: true,
            id: media.id,
            mediaType: 'comic',
            mediaUrl: null,
            subtitleUrl: null,
            audio: [],
            subtitles: [],
            hasSidecar: false,
            hasUserSubtitle: false,
            canSelectAudio: false,
            probeError: null,
          });
          return;
        }

        if (isImageFile(media.filePath)) {
          let imageUrl = null;
          try {
            imageUrl = typeof mediaServer.getLocalMediaUrl === 'function'
              ? mediaServer.getLocalMediaUrl(media.id)
              : null;
          } catch {
            imageUrl = null;
          }

          sendJson(res, 200, {
            ok: true,
            id: media.id,
            mediaType: 'image',
            mediaUrl: imageUrl,
            subtitleUrl: null,
            audio: [],
            subtitles: [],
            hasSidecar: false,
            hasUserSubtitle: false,
            canSelectAudio: false,
            probeError: null,
          });
          return;
        }

        try {
          const probe = await probeMediaTracks(media);
          audio = probe.streams
            .filter((stream) => stream.codec_type === 'audio')
            .map((stream) => ({
              streamIndex: stream.typeIndex,
              label: describeAudioTrack(stream),
              language: stream.language,
              isDefault: stream.isDefault,
            }));

          subtitles = probe.streams
            .filter((stream) => stream.codec_type === 'subtitle')
            .map((stream) => ({
              streamIndex: stream.typeIndex,
              label: describeSubtitleTrack(stream),
              language: stream.language,
              isDefault: stream.isDefault,
              // Bitmap subtitles cannot be turned into a text sidecar.
              extractable: TEXT_SUBTITLE_CODECS.has(String(stream.codec_name || '').toLowerCase()),
            }));
        } catch (error) {
          probeError = error.message;
        }

        let mediaUrl = null;
        let localSubtitleUrl = null;
        try {
          if (typeof mediaServer.getLocalMediaUrl === 'function') {
            mediaUrl = mediaServer.getLocalMediaUrl(media.id);
          }
          if (typeof mediaServer.getLocalSubtitleUrl === 'function') {
            localSubtitleUrl = mediaServer.getLocalSubtitleUrl(media.id);
          }
        } catch (error) {
          console.warn('[CastUI] Could not build a local stream URL: ' + error.message);
        }

        sendJson(res, 200, {
          ok: true,
          id: media.id,
          mediaType: 'video',
          mediaUrl,
          subtitleUrl: localSubtitleUrl,
          audio,
          subtitles,
          hasSidecar: fs.existsSync(sidecarPath),
          hasUserSubtitle: Boolean(userPath && fs.existsSync(userPath)),
          // Selecting a non-default audio track requires a remux on our side.
          canSelectAudio: transcodingEnabled,
          probeError,
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/media/position') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const media = mediaServer.getMediaById(String(payload.id || ''));

        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Media item not found.' });
          return;
        }

        const positionSec = Math.max(0, Math.floor(Number(payload.positionSec) || 0));
        const durationSec = Number(payload.durationSec);
        const resumeKey = trackingKeyFromMedia(media);

        if (payload.finished === true) {
          markMediaWatched(media);
        } else {
          setResumePosition(
            resumeKey,
            positionSec,
            Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
          );
        }

        sendJson(res, 200, { ok: true, positionSec });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/media/subtitle') {
      try {
        const body = await readRequestBody(req, 4 * 1024 * 1024);
        const payload = JSON.parse(body || '{}');
        const media = mediaServer.getMediaById(String(payload.id || ''));

        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Media item not found.' });
          return;
        }

        const mode = String(payload.mode || '').trim();

        if (mode === 'upload') {
          const savedPath = saveUploadedSubtitle(media, payload.content);
          mediaServer.setSubtitleOverride(media.id, savedPath);
          sendJson(res, 200, { ok: true, mode, ready: true });
          return;
        }

        if (mode === 'user') {
          const userPath = subtitleCachePath(media, 'user');
          if (!userPath || !fs.existsSync(userPath)) {
            sendJson(res, 404, { ok: false, error: 'No subtitle file has been loaded for this item.' });
            return;
          }
          mediaServer.setSubtitleOverride(media.id, userPath);
          sendJson(res, 200, { ok: true, mode, ready: true });
          return;
        }

        if (mode === 'download') {
          mediaServer.setSubtitleOverride(media.id, null);
          const url = await mediaServer.getSubtitleUrl(media.id, { allowDownload: true });
          sendJson(res, 200, {
            ok: Boolean(url),
            mode,
            ready: Boolean(url),
            error: url ? undefined : 'No subtitles found online for this file.',
          });
          return;
        }

        if (mode === 'embedded') {
          const streamIndex = Number(payload.streamIndex);
          if (!Number.isInteger(streamIndex) || streamIndex < 0) {
            sendJson(res, 400, { ok: false, error: 'Pick a subtitle track first.' });
            return;
          }

          const savedPath = await extractEmbeddedSubtitle(media, streamIndex);
          mediaServer.setSubtitleOverride(media.id, savedPath);
          sendJson(res, 200, { ok: true, mode, ready: true });
          return;
        }

        // "off" and "sidecar" only need the override cleared.
        mediaServer.setSubtitleOverride(media.id, null);
        sendJson(res, 200, { ok: true, mode: mode || 'sidecar', ready: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/media/override') {
      try {
        const body = await readRequestBody(req, MAX_COVER_BYTES + 1024 * 64);
        const payload = JSON.parse(body || '{}');
        const comicTarget = resolveComicTarget(payload.id);
        const media = comicTarget
          ? { id: comicTarget.id, filePath: comicTarget.path, name: comicTarget.name }
          : mediaServer.getMediaById(String(payload.id || ''));

        if (!media) {
          sendJson(res, 404, { ok: false, error: 'Media item not found.' });
          return;
        }

        if (payload.clear === true) {
          setMediaOverride(media.filePath, null);
          metadataVersion += 1;
          sendJson(res, 200, { ok: true, cleared: true, override: null });
          return;
        }

        let posterUrl = String(payload.posterUrl || '').trim();
        if (typeof payload.coverDataUrl === 'string' && payload.coverDataUrl.length > 0) {
          posterUrl = saveCoverImage(media.filePath, payload.coverDataUrl);
        }

        const saved = setMediaOverride(media.filePath, {
          title: payload.title,
          year: payload.year,
          plot: payload.plot,
          posterUrl,
        });
        metadataVersion += 1;

        sendJson(res, 200, {
          ok: true,
          cleared: !saved,
          override: saved,
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && parsed.pathname === '/api/group/override') {
      try {
        const body = await readRequestBody(req, MAX_COVER_BYTES + 1024 * 64);
        const payload = JSON.parse(body || '{}');
        const category = String(payload.category || '').trim();
        const name = String(payload.group || '').trim();

        if (!groupOverrideKey(category, name)) {
          sendJson(res, 400, { ok: false, error: 'Missing category or group name.' });
          return;
        }

        if (!findCategory(category)) {
          sendJson(res, 404, { ok: false, error: 'Unknown category.' });
          return;
        }

        if (payload.clear === true) {
          setGroupOverride(category, name, null);
          metadataVersion += 1;
          comicPayloadCache = new Map();
          sendJson(res, 200, { ok: true, cleared: true, override: null });
          return;
        }

        let posterUrl = String(payload.posterUrl || '').trim();
        if (typeof payload.coverDataUrl === 'string' && payload.coverDataUrl.length > 0) {
          posterUrl = saveCoverImageForKey(groupOverrideKey(category, name), payload.coverDataUrl);
        }

        const saved = setGroupOverride(category, name, {
          title: payload.title,
          year: payload.year,
          plot: payload.plot,
          posterUrl,
        });
        metadataVersion += 1;
        // The comic payload is memoised, so it has to be dropped on an edit.
        comicPayloadCache = new Map();

        sendJson(res, 200, { ok: true, cleared: !saved, override: saved });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
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
        const closing = server;
        server = null;
        closing.close(() => resolve());
        // close() only stops new connections and then waits for the open ones.
        // A browser keeping a socket alive, or a request that never completes,
        // would otherwise hold shutdown open indefinitely.
        if (typeof closing.closeIdleConnections === 'function') {
          closing.closeIdleConnections();
        }
        if (typeof closing.closeAllConnections === 'function') {
          closing.closeAllConnections();
        }
      });
    },
  };
}

export { createCastUiServer };
