import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { spawn } from 'child_process';
import axios from 'axios';
import { getLocalIPv4 } from '../utils/network.js';
import {
  getMimeType,
  isSupportedMediaFile,
  getDlnaProtocolInfo,
  getDlnaContentFeatures,
  isImageFile,
} from '../utils/media.js';
import { shouldTranscode } from '../transcoding/detector.js';
import { FFmpegTranscoder } from '../transcoding/transcoder.js';

export async function walkMedia(rootDir, list = [], batchSize = 50) {
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });

  const directories = [];
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      directories.push(fullPath);
    } else if (entry.isFile() && isSupportedMediaFile(fullPath)) {
      files.push(fullPath);
    }
  }

  list.push(...files);

  for (let i = 0; i < directories.length; i += batchSize) {
    const batch = directories.slice(i, i + batchSize);
    await Promise.all(batch.map((dir) => walkMedia(dir, list, batchSize)));
  }

  return list;
}

// WebVTT is SubRip with a header and dots instead of commas in timestamps.
export function srtToVtt(subtitleContent) {
  const body = String(subtitleContent || '')
    .replace(/^\uFEFF/, '')
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      '$1.$2 --> $3.$4',
    );

  return 'WEBVTT' + String.fromCharCode(10) + String.fromCharCode(10) + body;
}

export function sendNotFound(res) {
  res.statusCode = 404;
  res.end('Not found');
}

export function normalizeRootDirectories({ rootDir, rootDirs }) {
  const input = Array.isArray(rootDirs)
    ? rootDirs
    : (rootDir ? [rootDir] : []);

  const unique = new Set();
  input.forEach((item) => {
    if (!item) {
      return;
    }
    const resolved = path.resolve(item);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      unique.add(resolved);
    }
  });

  return Array.from(unique);
}

class MediaServer {
  constructor({
    rootDir,
    rootDirs,
    port = 0,
    host,
    transcoding = {},
    libraryCache,
    subtitles = {},
    thumbnailsDir,
  }) {
    this.rootDirs = normalizeRootDirectories({ rootDir, rootDirs });
    // Allow starting with no directories — user can add one via the web UI

    this.rootDir = this.rootDirs[0];
    this.host = host || getLocalIPv4();
    this.port = port;
    this.server = null;
    this.library = [];
    this.transcoding = {
      enabled: transcoding.enabled !== false,
      forceTranscode: transcoding.forceTranscode || false,
      skipTranscode: transcoding.skipTranscode || false,
      videoCodec: transcoding.videoCodec || 'libx264',
      videoPreset: transcoding.videoPreset || 'medium',
      videoCrf: transcoding.videoCrf || 23,
      audioCodec: transcoding.audioCodec || 'aac',
      audioBitrate: transcoding.audioBitrate || '128k',
    }
    this.activeTranscoders = new Map();
    this.backgroundRefreshPromise = null;
    this.libraryCache = libraryCache && typeof libraryCache === 'object'
      ? libraryCache
      : null;
    this.subtitles = {
      delayMs: Number.isFinite(Number(subtitles.delayMs)) ? Number(subtitles.delayMs) : 0,
    };
    this.playlists = new Map();
    this.thumbnailsDir = thumbnailsDir ? path.resolve(thumbnailsDir) : null;
    this.thumbnailFailures = new Set();
    // Per-item playback choices made in the web UI, consumed on the next request.
    this.subtitleOverrides = new Map();
    this.playbackOptions = new Map();
  }

  setSubtitleOverride(id, subtitlePath) {
    const key = String(id || '').trim();
    if (!key) {
      return;
    }
    if (!subtitlePath) {
      this.subtitleOverrides.delete(key);
      return;
    }
    this.subtitleOverrides.set(key, path.resolve(subtitlePath));
  }

  setPlaybackOptions(id, options) {
    const key = String(id || '').trim();
    if (!key) {
      return;
    }
    if (!options || typeof options !== 'object') {
      this.playbackOptions.delete(key);
      return;
    }

    const audioStreamIndex = Number(options.audioStreamIndex);
    this.playbackOptions.set(key, {
      audioStreamIndex: Number.isInteger(audioStreamIndex) && audioStreamIndex >= 0
        ? audioStreamIndex
        : null,
    });
  }


  _getRootDirsSignature() {
    return this.rootDirs
      .map((dir) => path.resolve(dir).toLowerCase())
      .sort((a, b) => a.localeCompare(b))
      .join('|');
  }

  _applyLibraryFromPaths(filePaths) {
    const uniqueFiles = Array.from(new Set((filePaths || []).map((item) => path.resolve(item))));
    this.library = uniqueFiles.map((filePath, index) => {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, path.extname(filePath));
      const srtPath = path.join(dir, base + '.srt');
      const hasSubtitle = fs.existsSync(srtPath);
      return {
        id: String(index + 1),
        filePath,
        name: path.basename(filePath),
        mimeType: getMimeType(filePath),
        hasSubtitle,
      };
    });
    return this.library;
  }

  async _loadLibraryFromCache() {
    if (!this.libraryCache || typeof this.libraryCache.load !== 'function') {
      return false;
    }

    try {
      const payload = this.libraryCache.load();
      if (!payload || typeof payload !== 'object') {
        return false;
      }

      const expectedSignature = this._getRootDirsSignature();
      if (String(payload.rootDirsSignature || '') !== expectedSignature) {
        return false;
      }

      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      if (entries.length === 0) {
        return false;
      }

      // Fast startup path: trust cached entries and refresh in background.
      const cachedFilePaths = entries
        .map((entry) => path.resolve(String(entry && entry.filePath ? entry.filePath : '')))
        .filter((filePath) => filePath.length > 0 && isSupportedMediaFile(filePath));

      if (cachedFilePaths.length === 0) {
        return false;
      }

      this._applyLibraryFromPaths(cachedFilePaths);
      return true;
    } catch (error) {
      console.error('Failed to load library from cache:', error);
      return false;
    }
  }

  async _saveLibraryCache() {
    if (!this.libraryCache || typeof this.libraryCache.save !== 'function') {
      return;
    }

    try {
      const payload = {
        rootDirsSignature: this._getRootDirsSignature(),
        entries: this.library.map((item) => ({
          filePath: item.filePath,
          size: fs.statSync(item.filePath).size,
          mtimeMs: fs.statSync(item.filePath).mtimeMs,
        })),
      }
      await this.libraryCache.save(payload);
    } catch (error) {
      console.error('Failed to save library cache:', error);
    }
  }

  async buildLibrary() {
    const allFiles = [];
    for (const dir of this.rootDirs) {
      const files = await walkMedia(dir, []);
      allFiles.push(...files);
    }

    this._applyLibraryFromPaths(allFiles);
    await this._saveLibraryCache();
    return this.library;
  }

  _startBackgroundLibraryRefresh() {
    if (this.backgroundRefreshPromise || this.rootDirs.length === 0) {
      return;
    }

    this.backgroundRefreshPromise = (async () => {
      try {
        await this.buildLibrary();
        console.log(`[Library] Background refresh complete. Indexed ${this.library.length} item(s).`);
      } catch (error) {
        console.warn(`[Library] Background refresh failed: ${error.message}`);
      } finally {
        this.backgroundRefreshPromise = null;
      }
    })();
  }

  getRootDirs() {
    return [...this.rootDirs];
  }

  addRootDir(directoryPath) {
    const resolved = path.resolve(directoryPath);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory not found: ${resolved}`);
    }

    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    if (this.rootDirs.includes(resolved)) {
      return false;
    }

    this.rootDirs.push(resolved);
    return true;
  }

  getMediaById(id) {
    return this.library.find((item) => item.id === String(id)) || null;
  }

  findByPath(filePath) {
    const resolved = path.resolve(filePath);
    return this.library.find((item) => path.resolve(item.filePath) === resolved) || null;
  }

  getMediaUrl(id) {
    if (!this.host || this.host === '127.0.0.1') {
      throw new Error(
        'Media server bound to localhost. Renderer cannot access it. Use --host with your computer\'s network IP address.',
      );
    }

    const media = this.getMediaById(id);
    const fileName = media ? path.basename(media.filePath) : 'media';
    return `http://${this.host}:${this.port}/media/${encodeURIComponent(id)}/${encodeURIComponent(fileName)}`;
  }

  _thumbnailPathFor(media) {
    if (!this.thumbnailsDir) {
      return null;
    }
    const stem = crypto.createHash('sha1')
      .update(path.resolve(media.filePath).toLowerCase())
      .digest('hex')
      .slice(0, 16);
    return path.join(this.thumbnailsDir, stem + '.jpg');
  }

  // Photo grids would otherwise pull full-resolution originals for every tile.
  _ensureThumbnail(media) {
    return new Promise((resolve, reject) => {
      const outPath = this._thumbnailPathFor(media);
      if (!outPath) {
        reject(new Error('Thumbnail storage is not configured.'));
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
        '-vf', "scale='min(480,iw)':-2",
        '-frames:v', '1',
        '-q:v', '4',
        outPath,
      ], { windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          resolve(outPath);
        } else {
          reject(new Error('Thumbnail generation failed: ' + stderr.slice(0, 200)));
        }
      });
    });
  }

  getLocalThumbUrl(id) {
    const media = this.getMediaById(id);
    if (!media || !isImageFile(media.filePath) || !this.thumbnailsDir) {
      return null;
    }

    const host = this.host || '127.0.0.1';
    return `http://${host}:${this.port}/thumb/${encodeURIComponent(String(id))}`;
  }

  getLocalMediaUrl(id) {
    const media = this.getMediaById(id);
    if (!media) {
      return null;
    }

    const host = this.host || '127.0.0.1';
    const fileName = path.basename(media.filePath);
    return `http://${host}:${this.port}/media/${encodeURIComponent(id)}/${encodeURIComponent(fileName)}`;
  }

  getLocalSubtitleUrl(id) {
    const media = this.getMediaById(id);
    if (!media) {
      return null;
    }

    const subtitlePath = this._subtitlePathForMedia(media);
    if (!subtitlePath || !fs.existsSync(subtitlePath)) {
      return null;
    }

    const host = this.host || '127.0.0.1';
    return `http://${host}:${this.port}/subtitles/${encodeURIComponent(String(id))}?format=vtt`;
  }

  registerPlaylist(playlistId, lines) {
    const key = String(playlistId || '').trim();
    if (!key) {
      return null;
    }

    const normalizedLines = Array.isArray(lines)
      ? lines.map((line) => String(line || ''))
      : [];
    if (normalizedLines.length === 0) {
      this.playlists.delete(key);
      return null;
    }

    this.playlists.set(key, {
      lines: normalizedLines,
      updatedAt: Date.now(),
    });

    return `http://${this.host}:${this.port}/playlist/${encodeURIComponent(key)}.m3u`;
  }

  _subtitlePathForMedia(media) {
    // A track chosen in the UI wins over the sidecar sitting next to the file.
    const override = this.subtitleOverrides.get(String(media.id));
    if (override && fs.existsSync(override)) {
      return override;
    }

    const dir = path.dirname(media.filePath);
    const base = path.basename(media.filePath, path.extname(media.filePath));
    return path.join(dir, `${base}.srt`);
  }

  _applySubtitleDelay(subtitleContent, delayMs = 0) {
    const shift = Number(delayMs);
    if (!Number.isFinite(shift) || shift === 0) {
      return subtitleContent;
    }

    const toMs = (hh, mm, ss, mmm) => (
      Number(hh) * 3600000
      + Number(mm) * 60000
      + Number(ss) * 1000
      + Number(mmm)
    );

    const toSrtTime = (totalMs) => {
      const clamped = Math.max(0, Math.floor(totalMs));
      const hh = Math.floor(clamped / 3600000);
      const mm = Math.floor((clamped % 3600000) / 60000);
      const ss = Math.floor((clamped % 60000) / 1000);
      const mmm = clamped % 1000;

      const pad2 = (v) => String(v).padStart(2, '0');
      const pad3 = (v) => String(v).padStart(3, '0');
      return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(mmm)}`;
    };

    return subtitleContent.replace(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
      (
        _,
        sh,
        sm,
        ss,
        sms,
        eh,
        em,
        es,
        ems,
      ) => {
        const start = toMs(sh, sm, ss, sms) + shift;
        const end = toMs(eh, em, es, ems) + shift;
        return `${toSrtTime(start)} --> ${toSrtTime(end)}`;
      },
    );
  }

  async _downloadSubtitleForMedia(media) {
    const srtPath = this._subtitlePathForMedia(media);
    if (fs.existsSync(srtPath)) {
      return srtPath;
    }

    try {
      const size = fs.statSync(media.filePath).size;
      const searchUrl = `https://rest.opensubtitles.org/search/moviebytesize-${size}/sublanguageid-eng`;
      const searchResponse = await axios.get(searchUrl, {
        headers: { 'User-Agent': 'TemporaryMediaCast/1.0' },
        timeout: 7000,
      });

      const first = Array.isArray(searchResponse.data) ? searchResponse.data[0] : null;
      if (!first || !first.SubDownloadLink) {
        return null;
      }

      console.log(`[Subtitle] Downloading subtitles for: ${media.filePath}`);
      console.log(`[Subtitle] OpenSubtitles search URL: ${searchUrl}`);
      if (first && first.SubDownloadLink) {
        console.log(`[Subtitle] Found subtitle: ${first.SubDownloadLink}`);
      } else {
        console.warn(`[Subtitle] No subtitles found for: ${media.filePath}`);
      }

      const subtitleResponse = await axios.get(first.SubDownloadLink, {
        responseType: 'arraybuffer',
        timeout: 10000,
      });

      const rawBuffer = Buffer.from(subtitleResponse.data);
      const isGzip = rawBuffer.length >= 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b;
      const subtitleBuffer = isGzip ? zlib.gunzipSync(rawBuffer) : rawBuffer;

      fs.writeFileSync(srtPath, subtitleBuffer);
      return fs.existsSync(srtPath) ? srtPath : null;
    } catch {
      return null;
    }
  }

  async getSubtitleUrl(id, options = {}) {
    if (!this.host || this.host === '127.0.0.1') {
      throw new Error(
        'Media server bound to localhost. Renderer cannot access it. Use --host with your computer\'s network IP address.',
      );
    }

    const media = this.getMediaById(id);
    if (!media) {
      return null;
    }

    const allowDownload = options.allowDownload !== false;
    let srtPath = this._subtitlePathForMedia(media);

    if (!fs.existsSync(srtPath) && allowDownload) {
      srtPath = await this._downloadSubtitleForMedia(media);
    }

    if (!srtPath || !fs.existsSync(srtPath)) {
      return null;
    }

    media.hasSubtitle = true;
    return `http://${this.host}:${this.port}/subtitles/${encodeURIComponent(String(id))}`;
  }

  async _handleMediaRequest(req, res, media) {
    console.log(`[HTTP] Request for media: ${media.name}`);

    let forcedByQuery = false;
    try {
      forcedByQuery = new URL(req.url, 'http://localhost').searchParams.get('transcode') === '1';
    } catch {
      forcedByQuery = false;
    }

    const playbackOptions = this.playbackOptions.get(String(media.id)) || {};
    const audioStreamIndex = Number.isInteger(playbackOptions.audioStreamIndex)
      ? playbackOptions.audioStreamIndex
      : null;
    // A renderer always plays the file's default audio track, so honouring a
    // different choice means remuxing it ourselves.
    const needsAudioSelection = audioStreamIndex !== null && audioStreamIndex > 0;

    let willTranscode = false;

    if (this.transcoding.enabled) {
      try {
        willTranscode = forcedByQuery || needsAudioSelection || await shouldTranscode(media.filePath, {
          forceTranscode: this.transcoding.forceTranscode,
          skipTranscode: this.transcoding.skipTranscode,
        });
      } catch (err) {
        console.warn(`[PROBE] Failed to detect transcode: ${err.message}`);
        willTranscode = forcedByQuery || needsAudioSelection;
      }
    }

    if (needsAudioSelection && !this.transcoding.enabled) {
      console.warn('[AUDIO] Track selection needs transcoding, which is disabled; using the default track.');
    }

    try {
      if (willTranscode) {
        console.log(`[TRANSCODE] Starting for ${media.name}`);
        // Detect .srt file for burn-in
        const dir = path.dirname(media.filePath);
        const base = path.basename(media.filePath, path.extname(media.filePath));
        const srtPath = path.join(dir, base + '.srt');
        const subtitlesPath = fs.existsSync(srtPath) ? srtPath : null;
        if (subtitlesPath) {
          console.log(`[TRANSCODE] Burning in subtitles: ${srtPath}`);
        }
        const transcoder = new FFmpegTranscoder(media.filePath, {
          videoCodec: this.transcoding.videoCodec,
          videoPreset: this.transcoding.videoPreset,
          videoCrf: this.transcoding.videoCrf,
          audioCodec: this.transcoding.audioCodec,
          audioBitrate: this.transcoding.audioBitrate,
          videoMaxrate: this.transcoding.videoMaxrate,
          videoBufsize: this.transcoding.videoBufsize,
          videoGop: this.transcoding.videoGop,
          subtitlesPath,
          audioStreamIndex,
        });

        const cacheKey = `${media.id}:${Date.now()}`;
        this.activeTranscoders.set(cacheKey, transcoder);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('transferMode.dlna.org', 'Streaming');
        res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0');
        res.setHeader('Cache-Control', 'no-cache');
        res.statusCode = 200;

        const stream = transcoder.start();
        let transcodeFailed = false;

        // Handle transcoder errors
        transcoder.on('error', (err) => {
          console.error(`[TRANSCODE_ERROR] ${media.name}: ${err.message}`);
          transcodeFailed = true;
          if (!res.headersSent) {
            // Fall back to direct play instead of returning 500
            console.log(`[FALLBACK] Falling back to direct play for ${media.name}`);
            res.removeHeader('Content-Type');
            res.removeHeader('transferMode.dlna.org');
            res.removeHeader('contentFeatures.dlna.org');
            res.removeHeader('Cache-Control');
            res.removeHeader('Accept-Ranges');
            this._streamDirectPlay(res, media);
          } else {
            // Headers already sent; just close response gracefully
            res.end();
          }
        });

        stream.on('error', (err) => {
          console.error(`[TRANSCODE_STREAM_ERROR] ${media.name}: ${err.message}`);
          transcodeFailed = true;
          transcoder.kill();
          if (!res.headersSent) {
            res.removeHeader('Content-Type');
            res.removeHeader('transferMode.dlna.org');
            res.removeHeader('contentFeatures.dlna.org');
            res.removeHeader('Cache-Control');
            res.removeHeader('Accept-Ranges');
            this._streamDirectPlay(res, media);
          } else {
            res.end();
          }
        });

        transcoder.on('end', () => {
          this.activeTranscoders.delete(cacheKey);
          if (!transcodeFailed) {
            console.log(`[TRANSCODE_DONE] ${media.name}`);
          }
        });

        res.on('close', () => {
          transcoder.kill();
          this.activeTranscoders.delete(cacheKey);
        });

        stream.pipe(res);
        return;
      }

      const stat = fs.statSync(media.filePath);
      const fileSize = stat.size;
      const range = req.headers.range;
      const contentFeatures = getDlnaContentFeatures(media.filePath);

      res.setHeader('Content-Type', media.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('transferMode.dlna.org', 'Streaming');
      res.setHeader('contentFeatures.dlna.org', contentFeatures);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      console.log(`[DIRECT_PLAY] ${media.name} (${fileSize} bytes)`);

      if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.setHeader('Content-Length', fileSize);
        res.end();
        return;
      }

      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = Number(startStr);
        const end = endStr ? Number(endStr) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize);

        fs.createReadStream(media.filePath, { start, end }).pipe(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(media.filePath).pipe(res);
    } catch (err) {
      console.error(`[MEDIA_ERROR] ${media.name}: ${err.message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Media request failed');
      }
    }
  }

  _streamDirectPlay(res, media) {
    try {
      const stat = fs.statSync(media.filePath);
      const fileSize = stat.size;
      const range = res.req?.headers?.range || null;
      const contentFeatures = getDlnaContentFeatures(media.filePath);

      res.setHeader('Content-Type', media.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('transferMode.dlna.org', 'Streaming');
      res.setHeader('contentFeatures.dlna.org', contentFeatures);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      console.log(`[DIRECT_PLAY] ${media.name} (${fileSize} bytes)`);

      if (res.req?.method === 'HEAD') {
        res.statusCode = 200;
        res.setHeader('Content-Length', fileSize);
        res.end();
        return;
      }

      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = Number(startStr);
        const end = endStr ? Number(endStr) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize);

        fs.createReadStream(media.filePath, { start, end }).pipe(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(media.filePath).pipe(res);
    } catch (err) {
      console.error(`[FALLBACK_ERROR] Failed to fallback to direct play: ${err.message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Media playback failed');
      }
    }
  }

  async start() {
    const libraryLoadStartedAt = Date.now();
    const loadedFromCache = await this._loadLibraryFromCache();
    if (!loadedFromCache) {
      await this.buildLibrary();
    } else {
      this._startBackgroundLibraryRefresh();
    }
    const libraryLoadDurationMs = Date.now() - libraryLoadStartedAt;
    const libraryLoadSource = loadedFromCache ? 'cache' : 'scan';

    this.server = http.createServer((req, res) => {
      const parsed = new URL(req.url, `http://${req.headers.host}`);

      if (parsed.pathname === '/library') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(this.library, null, 2));
        return;
      }

      // Serve subtitles: /subtitles/:id
      if (parsed.pathname.startsWith('/subtitles/')) {
        const subtitlePath = decodeURIComponent(parsed.pathname.replace('/subtitles/', ''));
        const subId = subtitlePath.split('/')[0];
        const media = this.getMediaById(subId);
        if (!media) {
          sendNotFound(res);
          return;
        }
        const base = path.basename(media.filePath, path.extname(media.filePath));
        const srtPath = this._subtitlePathForMedia(media);
        if (!fs.existsSync(srtPath)) {
          sendNotFound(res);
          return;
        }
        const subtitleContent = fs.readFileSync(srtPath, 'utf8');
        const subtitleDelayMs = this.subtitles && Number.isFinite(Number(this.subtitles.delayMs))
          ? Number(this.subtitles.delayMs)
          : 0;
        const shiftedContent = this._applySubtitleDelay(subtitleContent, subtitleDelayMs);

        if (parsed.searchParams.get('format') === 'vtt') {
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(srtToVtt(shiftedContent));
          return;
        }

        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        res.setHeader('Content-Disposition', `inline; filename="${base}.srt"`);
        res.end(shiftedContent);
        return;
      }

      if (parsed.pathname.startsWith('/thumb/')) {
        const thumbId = decodeURIComponent(parsed.pathname.replace('/thumb/', '')).split('/')[0];
        const media = this.getMediaById(thumbId);
        if (!media || !isImageFile(media.filePath)) {
          sendNotFound(res);
          return;
        }

        // A file ffmpeg could not read once will not read the next time either,
        // so fall back to the original instead of re-spawning on every tile.
        const serveOriginal = () => {
          res.statusCode = 200;
          res.setHeader('Content-Type', media.mimeType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          fs.createReadStream(media.filePath).pipe(res);
        };

        if (this.thumbnailFailures.has(String(thumbId))) {
          serveOriginal();
          return;
        }

        this._ensureThumbnail(media)
          .then((thumbPath) => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(thumbPath).pipe(res);
          })
          .catch((error) => {
            console.warn(`[Thumb] ${media.name}: ${error.message}`);
            this.thumbnailFailures.add(String(thumbId));
            if (!res.headersSent) {
              serveOriginal();
            }
          });
        return;
      }

      if (parsed.pathname.startsWith('/playlist/')) {
        const playlistKeyRaw = decodeURIComponent(parsed.pathname.replace('/playlist/', ''));
        const playlistKey = String(playlistKeyRaw || '').replace(/\.m3u$/i, '').trim();
        const playlist = this.playlists.get(playlistKey);
        if (!playlist || !Array.isArray(playlist.lines) || playlist.lines.length === 0) {
          sendNotFound(res);
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'audio/mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="series-playlist.m3u"');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(playlist.lines.join('\r\n') + '\r\n');
        return;
      }

      if (!parsed.pathname.startsWith('/media/')) {
        sendNotFound(res);
        return;
      }

      const mediaPath = decodeURIComponent(parsed.pathname.replace('/media/', ''));
      const id = mediaPath.split('/')[0];
      const media = this.getMediaById(id);

      if (!media) {
        sendNotFound(res);
        return;
      }

      this._handleMediaRequest(req, res, media);
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        const address = this.server.address();
        this.port = address.port;
        resolve();
      });
    });

    return {
      host: this.host,
      port: this.port,
      rootDir: this.rootDir,
      rootDirs: this.getRootDirs(),
      librarySize: this.library.length,
      libraryLoad: {
        source: libraryLoadSource,
        durationMs: libraryLoadDurationMs,
        backgroundRefreshPending: Boolean(this.backgroundRefreshPromise),
      },
    }
  }

  stop() {
    this.activeTranscoders.forEach((transcoder) => {
      transcoder.kill();
    });
    this.activeTranscoders.clear();

    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}

export {
  MediaServer,
}
