import path from 'path';
import mime from 'mime-types';

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.ts'];
const AUDIO_EXTENSIONS = ['.mp3', '.aac', '.m4a', '.wav', '.flac'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const COMIC_EXTENSIONS = ['.cbz', '.cbr'];
const BOOK_EXTENSIONS = ['.epub'];
// Plain .zip/.rar are only comics when they sit in a comics tree; indexing every
// zip on the disk would be worse than useless.
const AMBIGUOUS_ARCHIVE_EXTENSIONS = ['.zip', '.rar'];
const COMICS_PATH_HINTS = ['comics', 'comic', 'manga', 'manhwa', 'manhua', 'graphic novel'];

const SUPPORTED_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...COMIC_EXTENSIONS,
  ...BOOK_EXTENSIONS,
];

// Artwork that sits beside a video is not a library item in its own right.
const ARTWORK_BASENAMES = new Set([
  'folder', 'poster', 'cover', 'fanart', 'banner', 'thumb', 'thumbnail',
  'backdrop', 'landscape', 'clearart', 'disc', 'logo', 'season-all-poster',
]);

export function isArtworkImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    return false;
  }

  const base = path.basename(filePath, ext).toLowerCase().trim();
  if (ARTWORK_BASENAMES.has(base)) {
    return true;
  }

  // Kodi/Plex style companions such as "Movie Name-poster.jpg".
  return /-(poster|fanart|banner|thumb|backdrop|landscape|clearart|logo|disc)$/.test(base);
}

export function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export function isBookFile(filePath) {
  return BOOK_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export function isComicFile(filePath) {
  return COMIC_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

export function looksLikeComicsPath(filePath) {
  const parts = String(filePath || '').split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part) => COMICS_PATH_HINTS.some((hint) => part.includes(hint)));
}

// Any file openable as a comic book: .cbz/.cbr anywhere, or .zip/.rar that lives
// inside a comics or manga folder.
export function isComicArchiveFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (COMIC_EXTENSIONS.includes(ext)) {
    return true;
  }
  return AMBIGUOUS_ARCHIVE_EXTENSIONS.includes(ext) && looksLikeComicsPath(filePath);
}

export function isSupportedMediaFile(filePath) {
  if (/\.d\.ts$/i.test(filePath)) {
    return false;
  }
  if (isArtworkImage(filePath)) {
    return false;
  }
  if (isComicArchiveFile(filePath)) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export function getMimeType(filePath) {
  return mime.lookup(filePath) || 'application/octet-stream';
}

export function getDlnaContentFeatures(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  // LG TVs require explicit DLNA.ORG_PN profile names — '*' causes error 714.
  // DLNA.ORG_OP=01 = byte seek + time seek; DLNA.ORG_CI=0 = not converted;
  // DLNA.ORG_FLAGS: first 8 bits = 01700000 (sender paced, limited operations, streaming).
  const flags = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  if (ext === '.mp4' || ext === '.m4v') {
    return `DLNA.ORG_PN=AVC_MP4_MP_HD_720p_AAC;${flags}`;
  }
  if (ext === '.mkv') {
    return `DLNA.ORG_PN=AVC_MKV_MP_HD_AAC_MULT5;${flags}`;
  }
  if (ext === '.avi') {
    return `DLNA.ORG_PN=AVI;${flags}`;
  }
  if (ext === '.mp3') {
    return `DLNA.ORG_PN=MP3;${flags}`;
  }
  if (ext === '.m4a' || ext === '.aac') {
    return `DLNA.ORG_PN=AAC_ISO_320;${flags}`;
  }
  if (ext === '.ts') {
    return `DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5;${flags}`;
  }

  // Photos are shown, not streamed: renderers expect the interactive flag and
  // no seek operations.
  const imageFlags = 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00900000000000000000000000000000';
  if (ext === '.jpg' || ext === '.jpeg') {
    return `DLNA.ORG_PN=JPEG_LRG;${imageFlags}`;
  }
  if (ext === '.png') {
    return `DLNA.ORG_PN=PNG_LRG;${imageFlags}`;
  }
  if (ext === '.gif' || ext === '.webp' || ext === '.bmp') {
    return imageFlags;
  }

  return flags;
}

export function getDlnaProtocolInfo(filePath) {
  const mimeType = getMimeType(filePath);
  const contentFeatures = getDlnaContentFeatures(filePath);
  return `http-get:*:${mimeType}:${contentFeatures}`;
}

export function mediaKind(filePath) {
  // Comic archives read as generic zip/rar by mime type, so classify by extension.
  if (isComicFile(filePath)) {
    return 'comic';
  }

  const mimeType = getMimeType(filePath);
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  return 'other';
}

export function printSupportedFormats() {
  return {
    containers: ['MP4', 'MKV', 'AVI', 'MOV', 'M4V', 'TS'],
    images: ['JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'],
    comics: ['CBZ', 'CBR (read on this device only)'],
    audio: ['MP3', 'AAC', 'M4A', 'WAV', 'FLAC', 'AC3 (renderer dependent passthrough)'],
    videoCodecs: [
      'H.264/AVC (widely supported)',
      'H.265/HEVC (renderer dependent)',
      'x265 (HEVC encoding profile, renderer dependent)',
    ],
    notes: [
      'DLNA/UPnP compatibility depends on target renderer profiles.',
      'Unsupported combinations may require transcoding outside this MVP stack.',
    ],
  };
}
