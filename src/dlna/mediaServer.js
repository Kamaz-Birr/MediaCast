const http = require('http');
const fs = require('fs');
const path = require('path');
const { getLocalIPv4 } = require('../utils/network');
const { getMimeType, isSupportedMediaFile, getDlnaProtocolInfo, getDlnaContentFeatures } = require('../utils/media');
const { shouldTranscode } = require('../transcoding/detector');
const { FFmpegTranscoder } = require('../transcoding/transcoder');

async function walkMedia(rootDir, list = []) {
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkMedia(fullPath, list);
      continue;
    }

    if (entry.isFile() && isSupportedMediaFile(fullPath)) {
      list.push(fullPath);
    }
  }

  return list;
}

function sendNotFound(res) {
  res.statusCode = 404;
  res.end('Not found');
}

function normalizeRootDirectories({ rootDir, rootDirs }) {
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
  constructor({ rootDir, rootDirs, port = 0, host, transcoding = {} }) {
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
    };
    this.activeTranscoders = new Map();
  }

  async buildLibrary() {
    const allFiles = [];
    for (const dir of this.rootDirs) {
      const files = await walkMedia(dir, []);
      allFiles.push(...files);
    }

    const uniqueFiles = Array.from(new Set(allFiles.map((item) => path.resolve(item))));
    this.library = uniqueFiles.map((filePath, index) => ({
      id: String(index + 1),
      filePath,
      name: path.basename(filePath),
      mimeType: getMimeType(filePath),
    }));
    return this.library;
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

  async _handleMediaRequest(req, res, media) {
    console.log(`[HTTP] Request for media: ${media.name}`);

    let willTranscode = false;

    if (this.transcoding.enabled && this.transcoding.forceTranscode) {
      willTranscode = true;
    } else if (this.transcoding.enabled && !this.transcoding.skipTranscode) {
      try {
        willTranscode = await shouldTranscode(media.filePath, {
          forceTranscode: this.transcoding.forceTranscode,
          skipTranscode: this.transcoding.skipTranscode,
        });
      } catch (err) {
        console.warn(`[PROBE] Failed to detect transcode: ${err.message}`);
        willTranscode = false;
      }
    }

    try {
      if (willTranscode) {
        console.log(`[TRANSCODE] Starting for ${media.name}`);
        const transcoder = new FFmpegTranscoder(media.filePath, {
          videoCodec: this.transcoding.videoCodec,
          videoPreset: this.transcoding.videoPreset,
          videoCrf: this.transcoding.videoCrf,
          audioCodec: this.transcoding.audioCodec,
          audioBitrate: this.transcoding.audioBitrate,
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
    await this.buildLibrary();

    this.server = http.createServer((req, res) => {
      const parsed = new URL(req.url, `http://${req.headers.host}`);

      if (parsed.pathname === '/library') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(this.library, null, 2));
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
    };
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

module.exports = {
  MediaServer,
};
