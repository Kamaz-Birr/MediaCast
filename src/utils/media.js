import path from 'path';
import mime from 'mime-types';

const SUPPORTED_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mp3',
  '.aac',
  '.m4a',
  '.mov',
  '.wav',
  '.flac',
  '.m4v',
  '.ts',
];

export function isSupportedMediaFile(filePath) {
  if (/\.d\.ts$/i.test(filePath)) {
    return false;
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
  return flags;
}

export function getDlnaProtocolInfo(filePath) {
  const mimeType = getMimeType(filePath);
  const contentFeatures = getDlnaContentFeatures(filePath);
  return `http-get:*:${mimeType}:${contentFeatures}`;
}

export function mediaKind(filePath) {
  const mimeType = getMimeType(filePath);
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  return 'other';
}

export function printSupportedFormats() {
  return {
    containers: ['MP4', 'MKV', 'AVI', 'MOV', 'M4V', 'TS'],
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
