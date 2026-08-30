#!/usr/bin/env node

import path from 'path';
import process from 'process';
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import readline from 'readline/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { MediaServer } from './dlna/mediaServer.js';
import { buildDidlLite } from './dlna/metadata.js';
import { discoverRenderers, pickRenderer, getRendererByIp } from './upnp/discovery.js';
import {
  setAvTransportUri,
  play,
  pause,
  stop,
  setVolume,
  getTransportInfo,
  getCurrentTransportActions,
} from './upnp/soap.js';
import { printSupportedFormats } from './utils/media.js';
import { getLocalIPForRenderer } from './utils/network.js';
import { createCastUiServer } from './web/castUiServer.js';
import { configureMetadataApiKeys } from './web/metadataFetcher.js';

const runtimeFilename = typeof __filename === 'string'
  ? __filename
  : fileURLToPath(import.meta.url);
const runtimeDirname = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(runtimeFilename);

async function getRendererOrThrow(rendererQuery, timeoutMs, rendererIp) {
  const extractRendererAddress = (renderer) => {
    if (!renderer || !renderer.location) {
      return null;
    }

    try {
      return new URL(renderer.location).hostname;
    } catch {
      const urlMatch = String(renderer.location).match(/http:\/\/([^:]+):/);
      return urlMatch ? urlMatch[1] : null;
    }
  };

  if (rendererIp) {
    const byIp = await getRendererByIp(rendererIp);
    if (byIp) {
      return { renderer: byIp, renderers: [byIp], rendererAddress: rendererIp };
    }

    // Graceful fallback: if IP is stale, use discovery results when unambiguous.
    const discovered = await discoverRenderers(Number(timeoutMs) || 5000);
    if (discovered.length === 1) {
      const fallbackRenderer = discovered[0];
      const fallbackAddress = extractRendererAddress(fallbackRenderer);
      console.warn(
        `[Renderer] Could not resolve renderer at ${rendererIp}; using discovered renderer ${fallbackRenderer.friendlyName}${fallbackAddress ? ` (${fallbackAddress})` : ''}.`,
      );
      return {
        renderer: fallbackRenderer,
        renderers: discovered,
        rendererAddress: fallbackAddress || rendererIp,
      };
    }

    if (discovered.length > 1) {
      const hints = discovered
        .map((item) => {
          const address = extractRendererAddress(item);
          return `${item.friendlyName}${address ? ` (${address})` : ''}`;
        })
        .join(', ');
      throw new Error(`Could not resolve renderer at ${rendererIp}. Discovered renderers: ${hints}`);
    }

    throw new Error(`Could not resolve renderer at ${rendererIp}. No renderers discovered on the network.`);
  }

  const renderers = await discoverRenderers(timeoutMs);
  if (!renderers.length) {
    throw new Error('No DLNA/UPnP MediaRenderer devices found on the network.');
  }

  const renderer = pickRenderer(renderers, rendererQuery);
  if (!renderer) {
    const names = renderers.map((item) => item.friendlyName).join(', ');
    throw new Error(`Renderer not found: "${rendererQuery}". Available: ${names}`);
  }

  const rendererAddress = extractRendererAddress(renderer);

  return { renderer, renderers, rendererAddress };
}

function validateDirectoryOrThrow(directoryPath) {
  const resolvedPath = path.resolve(directoryPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Directory not found: ${resolvedPath}`);
  }

  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

function openWindowsFolderPicker() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'Select media folder'",
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
  ].join('; ');

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(String(stdout || '').trim());
      },
    );
  });
}

async function promptForDirectoryPath() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Media folder path: ');
    return String(answer || '').trim();
  } finally {
    rl.close();
  }
}

async function resolveMediaDirectory(inputDir) {
  if (inputDir) {
    return validateDirectoryOrThrow(inputDir);
  }

  let selectedDir = '';

  if (process.platform === 'win32') {
    try {
      selectedDir = await openWindowsFolderPicker();
    } catch (error) {
      console.warn(`Folder picker unavailable: ${error.message}`);
    }
  }

  if (!selectedDir) {
    console.log('Select a media folder to launch the web app.');
    selectedDir = await promptForDirectoryPath();
  }

  if (!selectedDir) {
    throw new Error('No media folder selected.');
  }

  return validateDirectoryOrThrow(selectedDir);
}

// The app's own root directory — never allowed as a media source
const APP_ROOT = process.pkg
  ? path.dirname(process.execPath)
  : path.resolve(runtimeDirname, '..');

function isAppDirectory(dirPath) {
  const resolved = path.resolve(dirPath);
  return resolved === APP_ROOT || resolved.startsWith(APP_ROOT + path.sep);
}

function getCastUiConfigPath() {
  const baseDir = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA
    : path.join(os.homedir(), '.config');

  return path.join(baseDir, 'MediaCast', 'cast-ui.json');
}

function readCastUiConfig() {
  const configPath = getCastUiConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeCastUiConfig(config) {
  const configPath = getCastUiConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(config && typeof config === 'object' ? config : {}, null, 2),
    'utf8',
  );
}

function updateCastUiConfig(patch) {
  const existing = readCastUiConfig();
  writeCastUiConfig({
    ...existing,
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
}

function toBrowserFriendlyHost(host) {
  const normalized = String(host || '').trim();
  if (!normalized || normalized === '0.0.0.0' || normalized === '::') {
    return 'localhost';
  }

  return normalized;
}

async function openUrlInDefaultBrowser(url) {
  if (process.platform === 'win32') {
    const escapedUrl = String(url || '').replace(/'/g, "''");
    const tryExec = (command, args) => new Promise((resolve) => {
      execFile(
        command,
        args,
        { windowsHide: true },
        (error) => {
          resolve(!error);
        },
      );
    });

    if (await tryExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${escapedUrl}'`])) {
      return true;
    }

    if (await tryExec('cmd.exe', ['/c', 'start', '', url])) {
      return true;
    }

    if (await tryExec('rundll32.exe', ['url.dll,FileProtocolHandler', url])) {
      return true;
    }

    if (await tryExec('explorer.exe', [url])) {
      return true;
    }

    return false;
  }

  return new Promise((resolve) => {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

function loadSavedMediaDirectories() {
  const parsed = readCastUiConfig();
  const values = Array.isArray(parsed.mediaDirs) ? parsed.mediaDirs : [];

  return values
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0)
    .filter((item) => fs.existsSync(item) && fs.statSync(item).isDirectory())
    .filter((item) => !isAppDirectory(item))
    .map((item) => path.resolve(item));
}

function saveMediaDirectories(mediaDirs) {
  const unique = Array.from(new Set(mediaDirs.map((item) => path.resolve(item))))
    .filter((item) => !isAppDirectory(item));
  updateCastUiConfig({ mediaDirs: unique });
}

function loadWatchedMediaKeys() {
  const parsed = readCastUiConfig();
  const values = Array.isArray(parsed.watchedMediaKeys) ? parsed.watchedMediaKeys : [];
  return Array.from(new Set(
    values
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0),
  ));
}

function saveWatchedMediaKeys(watchedMediaKeys) {
  const normalized = Array.from(new Set(
    (Array.isArray(watchedMediaKeys) ? watchedMediaKeys : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0),
  ));
  updateCastUiConfig({ watchedMediaKeys: normalized });
}

function loadResumePositions() {
  const parsed = readCastUiConfig();
  const source = parsed.resumePositions;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    const itemKey = String(key || '').trim();
    if (!itemKey || !value || typeof value !== 'object') {
      continue;
    }

    const positionSec = Number(value.positionSec);
    const durationSec = Number(value.durationSec);
    const progress = Number(value.progress);

    if (!Number.isFinite(positionSec) || positionSec <= 0) {
      continue;
    }

    normalized[itemKey] = {
      positionSec,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      progress: Number.isFinite(progress) ? progress : null,
      updatedAt: value.updatedAt || new Date().toISOString(),
    };
  }

  return normalized;
}

function saveResumePositions(resumePositions) {
  const source = resumePositions && typeof resumePositions === 'object' ? resumePositions : {};
  const normalized = {};

  for (const [key, value] of Object.entries(source)) {
    const itemKey = String(key || '').trim();
    if (!itemKey || !value || typeof value !== 'object') {
      continue;
    }

    const positionSec = Number(value.positionSec);
    const durationSec = Number(value.durationSec);
    const progress = Number(value.progress);

    if (!Number.isFinite(positionSec) || positionSec <= 0) {
      continue;
    }

    normalized[itemKey] = {
      positionSec,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      progress: Number.isFinite(progress) ? progress : null,
      updatedAt: value.updatedAt || new Date().toISOString(),
    };
  }

  updateCastUiConfig({ resumePositions: normalized });
}

function loadCustomCategories() {
  const parsed = readCastUiConfig();
  const values = Array.isArray(parsed.customCategories) ? parsed.customCategories : [];

  return values
    .map((item) => ({
      id: String(item && item.id ? item.id : '').trim(),
      label: String(item && item.label ? item.label : '').trim(),
      kind: item && item.kind === 'shows' ? 'shows' : 'movies',
    }))
    .filter((item) => item.id.length > 0 && item.label.length > 0);
}

function loadFolderCategories() {
  const parsed = readCastUiConfig();
  const source = parsed.folderCategories;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }

  const normalized = {};
  for (const [folderPath, categoryId] of Object.entries(source)) {
    const key = String(folderPath || '').trim();
    const value = String(categoryId || '').trim();
    if (key && value) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function saveCategoryConfig(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};

  const customCategories = (Array.isArray(source.customCategories) ? source.customCategories : [])
    .map((item) => ({
      id: String(item && item.id ? item.id : '').trim(),
      label: String(item && item.label ? item.label : '').trim(),
      kind: item && item.kind === 'shows' ? 'shows' : 'movies',
    }))
    .filter((item) => item.id.length > 0 && item.label.length > 0);

  const folderSource = source.folderCategories && typeof source.folderCategories === 'object'
    ? source.folderCategories
    : {};
  const folderCategories = {};
  for (const [folderPath, categoryId] of Object.entries(folderSource)) {
    const key = String(folderPath || '').trim();
    const value = String(categoryId || '').trim();
    if (key && value) {
      folderCategories[key] = value;
    }
  }

  updateCastUiConfig({ customCategories, folderCategories });
}

function getCoversDir() {
  return path.join(path.dirname(getCastUiConfigPath()), 'covers');
}

function getSubtitlesDir() {
  return path.join(path.dirname(getCastUiConfigPath()), 'subtitles');
}

// Kept out of cast-ui.json: that file is rewritten whenever a resume position
// moves, and the metadata cache is far too large to rewrite that often.
function getThumbnailsDir() {
  return path.join(path.dirname(getCastUiConfigPath()), 'thumbnails');
}

function getMetadataCachePath() {
  return path.join(path.dirname(getCastUiConfigPath()), 'metadata-cache.json');
}

function loadMetadataCache() {
  const cachePath = getMetadataCachePath();
  if (!fs.existsSync(cachePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
  } catch (error) {
    console.warn(`[Metadata] Ignoring unreadable metadata cache: ${error.message}`);
    return {};
  }
}

function saveMetadataCache(entries) {
  const cachePath = getMetadataCachePath();
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: entries && typeof entries === 'object' ? entries : {},
    };
    // Write then rename so an interrupted save cannot leave a truncated file.
    const tempPath = cachePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tempPath, cachePath);
  } catch (error) {
    console.warn(`[Metadata] Could not write the metadata cache: ${error.message}`);
  }
}

function normalizeMediaOverrides(source) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const normalized = {};

  for (const [key, value] of Object.entries(input)) {
    const itemKey = String(key || '').trim();
    if (!itemKey || !value || typeof value !== 'object') {
      continue;
    }

    const entry = {
      title: String(value.title || '').trim(),
      year: String(value.year || '').trim(),
      plot: String(value.plot || '').trim(),
      posterUrl: String(value.posterUrl || '').trim(),
    };

    if (!entry.title && !entry.year && !entry.plot && !entry.posterUrl) {
      continue;
    }

    entry.updatedAt = value.updatedAt || new Date().toISOString();
    normalized[itemKey] = entry;
  }

  return normalized;
}

function loadMediaOverrides() {
  return normalizeMediaOverrides(readCastUiConfig().mediaOverrides);
}

function saveMediaOverrides(overrides) {
  updateCastUiConfig({ mediaOverrides: normalizeMediaOverrides(overrides) });
}

function loadMediaLibraryCache() {
  const parsed = readCastUiConfig();
  const cache = parsed.mediaLibraryCache;
  if (!cache || typeof cache !== 'object') {
    return null;
  }
  return cache;
}

function saveMediaLibraryCache(cache) {
  updateCastUiConfig({
    mediaLibraryCache: cache && typeof cache === 'object' ? cache : null,
  });
}

async function resolveInitialMediaDirectories(inputDir) {
  if (inputDir) {
    // Explicit --dir flag: use it and save as the new default
    const explicit = validateDirectoryOrThrow(inputDir);
    if (isAppDirectory(explicit)) {
      throw new Error(`Cannot use the app's own directory as a media source: ${explicit}`);
    }
    saveMediaDirectories([explicit]);
    return [explicit];
  }

  // Use saved folders if they exist 
  const saved = loadSavedMediaDirectories();
  const validDirectories = await Promise.all(
    saved.map(async (dir) => {
      try {
        const stat = await fs.promises.stat(dir);
        return stat.isDirectory() ? dir : null;
      } catch {
        return null;
      }
    })
  );

  const filteredDirectories = validDirectories.filter(Boolean);
  if (filteredDirectories.length > 0) {
    return filteredDirectories;
  }

  // First run: no saved folders 
  return [];
}

const program = new Command();
program
  .name('mediacast')
  .description('UPnP/DLNA JavaScript casting stack')
  .version('1.3.0');

if (process.pkg) {
  const knownCommands = new Set([
    'info',
    'discover',
    'serve',
    'cast-file',
    'cast-url',
    'cast-ui',
    'pause',
    'stop',
    'volume',
    'network',
  ]);

  const rawArgs = process.argv.slice(2).map((item) => String(item || '').trim()).filter(Boolean);
  const hasKnownCommand = rawArgs.some((arg) => knownCommands.has(arg.toLowerCase()));
  const hasTopLevelFlag = rawArgs.some((arg) => (
    arg === '-h'
    || arg === '--help'
    || arg === '-V'
    || arg === '--version'
  ));

  if (!hasKnownCommand && !hasTopLevelFlag) {
    process.argv.push('cast-ui');
  }
}

program
  .command('info')
  .description('Display media file and transcoding info')
  .requiredOption('-f, --file <file>', 'Path to media file')
  .action(async (options) => {
    try {
      const { probeFile, needsTranscoding } = await import('./transcoding/detector.js');
      const filePath = path.resolve(options.file);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const probe = await probeFile(filePath);
      const willTranscode = needsTranscoding(probe);

      console.log(`File: ${path.basename(filePath)}`);
      console.log(`Path: ${filePath}`);
      console.log(`Container: ${probe.container}`);
      console.log(`Duration: ${probe.duration}s`);
      console.log(`Bitrate: ${probe.bitrate} bps`);
      console.log(`Streams: ${probe.streams.length}`);

      probe.streams.forEach((stream, index) => {
        console.log(`  [${index}] ${stream.codec_type}: ${stream.codec_name} (profile: ${stream.profile || 'N/A'})`);
      });

      console.log(`\nTranscoding needed: ${willTranscode ? 'Yes' : 'No'}`);
      console.log(`Target: H.264 video (libx264) + AAC audio in MP4 container`);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('discover')
  .description('Discover DLNA/UPnP MediaRenderer devices')
  .option('-t, --timeout <ms>', 'Discovery timeout in milliseconds', '5000')
  .action(async (options) => {
    try {
      const timeout = Number(options.timeout);
      const renderers = await discoverRenderers(timeout);

      if (!renderers.length) {
        console.log('No renderers found.');
        return;
      }

      renderers.forEach((renderer, index) => {
        console.log(`${index + 1}. ${renderer.friendlyName}`);
        console.log(`   UDN: ${renderer.udn || 'N/A'}`);
        console.log(`   Model: ${renderer.modelName || 'N/A'}`);
        console.log(`   AVTransport: ${renderer.services.avTransport.controlUrl}`);
        if (renderer.services.renderingControl?.controlUrl) {
          console.log(`   RenderingControl: ${renderer.services.renderingControl.controlUrl}`);
        }
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start local HTTP media server (DLNA-friendly byte-range streaming)')
  .requiredOption('-d, --dir <directory>', 'Root media directory')
  .option('-p, --port <port>', 'Server port', '0')
  .option('-h, --host <host>', 'Bind host/IP (defaults to detected local IPv4)')
  .option('--no-transcode', 'Disable FFmpeg transcoding (direct play only)')
  .option('--force-transcode', 'Force all files through FFmpeg H.264+AAC')
  .option('--subtitle-delay-ms <ms>', 'Shift subtitles by milliseconds (positive delays subtitle, negative advances)', '0')
  .option('--video-preset <preset>', 'FFmpeg video preset (ultrafast, fast, medium, slow)', 'medium')
  .option('--audio-bitrate <bitrate>', 'FFmpeg audio bitrate (e.g., 128k, 192k)', '128k')
  .option('--video-maxrate <bitrate>', 'FFmpeg video maxrate (e.g., 20M, 10M)', '20M')
  .option('--video-bufsize <size>', 'FFmpeg video bufsize (e.g., 40M, 20M)', '40M')
  .option('--video-gop <frames>', 'FFmpeg keyframe interval (GOP, e.g., 60 for 2s at 30fps)')
  .action(async (options) => {
    try {
      const mediaServer = new MediaServer({
        rootDir: options.dir,
        port: Number(options.port),
        host: options.host,
        transcoding: {
          enabled: options.transcode,
          forceTranscode: options.forceTranscode,
          videoPreset: options.videoPreset,
          audioBitrate: options.audioBitrate,
          videoMaxrate: options.videoMaxrate,
          videoBufsize: options.videoBufsize,
          videoGop: options.videoGop,
        },
        subtitles: {
          delayMs: Number(options.subtitleDelayMs),
        },
      });

      const info = await mediaServer.start();
      console.log(`Media server started: http://${info.host}:${info.port}`);
      console.log(`Library files: ${info.librarySize}`);
      console.log(`Transcoding: ${options.transcode ? 'auto-detect' : 'disabled'}`);
      console.log('Press Ctrl+C to stop.');

      process.on('SIGINT', async () => {
        await mediaServer.stop();
        process.exit(0);
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('cast-file')
  .description('Start server, cast one local file to a renderer, and begin playback')
  .requiredOption('-f, --file <file>', 'Path to local media file')
  .option('-r, --renderer <nameOrUdn>', 'Renderer friendly name or UDN')
  .option('-p, --port <port>', 'Local HTTP server port', '0')
  .option('-h, --host <host>', 'Bind host/IP for media URL')
  .option('-t, --timeout <ms>', 'Renderer discovery timeout in ms', '5000')
  .option('--renderer-ip <ip>', 'Renderer IP address (bypass SSDP discovery)')
  .option('--no-transcode', 'Disable FFmpeg transcoding (direct play only)')
  .option('--force-transcode', 'Force transcoding to H.264+AAC')
  .option('--subtitle-delay-ms <ms>', 'Shift subtitles by milliseconds (positive delays subtitle, negative advances)', '0')
  .option('--video-preset <preset>', 'FFmpeg video preset (ultrafast, fast, medium, slow)', 'medium')
  .option('--audio-bitrate <bitrate>', 'FFmpeg audio bitrate (e.g., 128k, 192k)', '128k')
  .option('--video-maxrate <bitrate>', 'FFmpeg video maxrate (e.g., 20M, 10M)', '20M')
  .option('--video-bufsize <size>', 'FFmpeg video bufsize (e.g., 40M, 20M)', '40M')
  .option('--video-gop <frames>', 'FFmpeg keyframe interval (GOP, e.g., 60 for 2s at 30fps)')
  .action(async (options) => {
    try {
      const filePath = path.resolve(options.file);
      const rootDir = path.dirname(filePath);

      const mediaServer = new MediaServer({
        rootDir,
        port: Number(options.port),
        host: options.host,
        transcoding: {
          enabled: options.transcode,
          forceTranscode: options.forceTranscode,
          videoPreset: options.videoPreset,
          audioBitrate: options.audioBitrate,
          videoMaxrate: options.videoMaxrate,
          videoBufsize: options.videoBufsize,
          videoGop: options.videoGop,
        },
        subtitles: {
          delayMs: Number(options.subtitleDelayMs),
        },
      });

      const info = await mediaServer.start();
      const media = mediaServer.findByPath(filePath);

      if (!media) {
        await mediaServer.stop();
        throw new Error('File is not in supported extension list or cannot be indexed.');
      }

      const mediaUrl = mediaServer.getMediaUrl(media.id);
      const metadata = buildDidlLite({
        title: media.name,
        filePath: media.filePath,
        mediaUrl,
      });

      const { renderer } = await getRendererOrThrow(
        options.renderer,
        Number(options.timeout),
        options.rendererIp,
      );

      console.log(`\n[Casting] File: ${media.name}`);
      console.log(`[Casting] URL: ${mediaUrl}`);
      console.log(`[Casting] Renderer: ${renderer.friendlyName}`);
      console.log(`[Casting] AVTransport: ${renderer.services.avTransport.controlUrl}`);
      console.log(`[Casting] Sending SetAVTransportURI with DIDL metadata...`);

      // First try: DIDL metadata included
      try {
        await setAvTransportUri(renderer, mediaUrl, metadata);
      } catch (err) {
        const message = String(err?.message || '');
        if (message.includes('errorCode>714</errorCode>') || message.includes('Illegal MIME-type')) {
          console.warn('[Casting] Renderer rejected metadata MIME. Retrying SetAVTransportURI without metadata...');
          await setAvTransportUri(renderer, mediaUrl, '');
        } else {
          throw err;
        }
      }
      console.log(`[Casting] URI set successfully, checking transport state...`);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      let transportInfo = await getTransportInfo(renderer);
      if (transportInfo) {
        console.log(`[Casting] Transport state retrieved`);
      }
      await getCurrentTransportActions(renderer);

      console.log(`[Casting] Sending Play command...`);
      await play(renderer);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      transportInfo = await getTransportInfo(renderer);
      const stateAfterFirstPlay = transportInfo?.['s:Envelope']?.['s:Body']?.['u:GetTransportInfoResponse']?.['CurrentTransportState'];

      // LG fallback: retry without metadata if renderer remains STOPPED
      if (stateAfterFirstPlay === 'STOPPED') {
        console.log('[Casting] Renderer still STOPPED. Retrying without DIDL metadata...');
        await setAvTransportUri(renderer, mediaUrl, '');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await play(renderer);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const retryInfo = await getTransportInfo(renderer);
        const retryState = retryInfo?.['s:Envelope']?.['s:Body']?.['u:GetTransportInfoResponse']?.['CurrentTransportState'];
        console.log(`[Casting] State after metadata-less retry: ${retryState || 'unknown'}`);
      }

      console.log(`\n✓ Casting started: "${media.name}" on ${renderer.friendlyName}`);
      console.log(`✓ URL: ${mediaUrl}`);
      console.log(`✓ Server: http://${info.host}:${info.port}`);
      console.log(`✓ Transcoding: ${options.transcode ? 'auto-detect' : 'disabled'}`);
      console.log(`\nPress Ctrl+C to stop local server.\n`);

      process.on('SIGINT', async () => {
        await mediaServer.stop();
        process.exit(0);
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('cast-url')
  .description('Cast an existing URL to a renderer')
  .requiredOption('-u, --url <url>', 'Media URL reachable by renderer')
  .option('-r, --renderer <nameOrUdn>', 'Renderer friendly name or UDN')
  .option('-t, --timeout <ms>', 'Renderer discovery timeout in ms', '5000')
  .option('--renderer-ip <ip>', 'Renderer IP address (bypass SSDP discovery)')
  .action(async (options) => {
    try {
      const { renderer } = await getRendererOrThrow(
        options.renderer,
        Number(options.timeout),
        options.rendererIp,
      );
      await setAvTransportUri(renderer, options.url, '');
      await play(renderer);
      console.log(`✓ Casting URL to ${renderer.friendlyName}`);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('cast-ui')
  .description('Launch web UI: browse recursive media library and click to cast to renderer')
  .option('-d, --dir <directory>', 'Root media directory to scan recursively (prompted if omitted)')
  .option('-r, --renderer <nameOrUdn>', 'Renderer friendly name or UDN')
  .option('-t, --timeout <ms>', 'Renderer discovery timeout in ms', '5000')
  .option('--renderer-ip <ip>', 'Renderer IP address (bypass SSDP discovery)')
  .option('-p, --port <port>', 'Media HTTP server port', '0')
  .option('-h, --host <host>', 'Bind host/IP for media URL')
  .option('--ui-port <port>', 'Web app port', '8787')
  .option('--ui-host <host>', 'Web app host', '127.0.0.1')
  .option('--ui-lan', 'Expose the web app to your local network (default: this machine only)')
  .option('--no-transcode', 'Disable FFmpeg transcoding (direct play only)')
  .option('--force-transcode', 'Force transcoding to H.264+AAC')
  .option('--subtitle-delay-ms <ms>', 'Shift subtitles by milliseconds (positive delays subtitle, negative advances)', '0')
  .option('--video-preset <preset>', 'FFmpeg video preset (ultrafast, fast, medium, slow)', 'medium')
  .option('--audio-bitrate <bitrate>', 'FFmpeg audio bitrate (e.g., 128k, 192k)', '128k')
  .option('--video-maxrate <bitrate>', 'FFmpeg video maxrate (e.g., 20M, 10M)', '20M')
  .option('--video-bufsize <size>', 'FFmpeg video bufsize (e.g., 40M, 20M)', '40M')
  .option('--video-gop <frames>', 'FFmpeg keyframe interval (GOP, e.g., 60 for 2s at 30fps)')
  .action(async (options) => {
    let mediaServer = null;
    let uiServer = null;
    let renderer = null;
    let rendererAddress = null;

    try {
      const mediaDirs = await resolveInitialMediaDirectories(options.dir);
      const isFirstRun = mediaDirs.length === 0;

      const savedConfig = readCastUiConfig();
      configureMetadataApiKeys({
        tmdbApiKey: process.env.TMDB_API_KEY || savedConfig.tmdbApiKey,
        omdbApiKey: process.env.OMDB_API_KEY || savedConfig.omdbApiKey,
      });

      try {
        // Discover renderer first to determine correct network interface when one is available.
        ({ renderer, rendererAddress } = await getRendererOrThrow(
          options.renderer,
          Number(options.timeout),
          options.rendererIp,
        ));
      } catch (error) {
        const message = String(error?.message || '');
        if (message.includes('No DLNA/UPnP MediaRenderer devices found on the network.')) {
          console.warn('No renderer found yet. The web UI will start and you can refresh discovery there.');
        } else {
          throw error;
        }
      }

      // Auto-detect media server host if not provided
      let mediaHost = options.host;
      if (!mediaHost && rendererAddress && rendererAddress !== 'localhost') {
        const detectedHost = getLocalIPForRenderer(rendererAddress);
        if (detectedHost) {
          mediaHost = detectedHost;
          console.log(`Auto-detected media server host: ${mediaHost} (on same subnet as ${rendererAddress})`);
        }
      }

      mediaServer = new MediaServer({
        rootDirs: mediaDirs,
        port: Number(options.port),
        host: mediaHost,
        libraryCache: {
          load: () => loadMediaLibraryCache(),
          save: (cachePayload) => saveMediaLibraryCache(cachePayload),
        },
        thumbnailsDir: getThumbnailsDir(),
        transcoding: {
          enabled: options.transcode,
          forceTranscode: options.forceTranscode,
          videoPreset: options.videoPreset,
          audioBitrate: options.audioBitrate,
          videoMaxrate: options.videoMaxrate,
          videoBufsize: options.videoBufsize,
          videoGop: options.videoGop,
        },
        subtitles: {
          delayMs: Number(options.subtitleDelayMs),
        },
      });

      const mediaInfo = await mediaServer.start();

      uiServer = createCastUiServer({
        mediaServer,
        renderer,
        uiHost: options.uiHost,
        uiPort: Number(options.uiPort),
        allowLanAccess: Boolean(options.uiLan),
        chooseMediaFolder: () => resolveMediaDirectory(''),
        onMediaFoldersChanged: (dirs) => saveMediaDirectories(dirs),
        initialWatchedKeys: loadWatchedMediaKeys(),
        onWatchedKeysChanged: (keys) => saveWatchedMediaKeys(keys),
        initialResumePositions: loadResumePositions(),
        onResumePositionsChanged: (positions) => saveResumePositions(positions),
        initialCustomCategories: loadCustomCategories(),
        initialFolderCategories: loadFolderCategories(),
        onCategoriesChanged: (payload) => saveCategoryConfig(payload),
        initialMediaOverrides: loadMediaOverrides(),
        onMediaOverridesChanged: (overrides) => saveMediaOverrides(overrides),
        initialMetadataCache: loadMetadataCache(),
        onMetadataCacheChanged: (entries) => saveMetadataCache(entries),
        coversDir: getCoversDir(),
        subtitlesDir: getSubtitlesDir(),
      });

      const uiInfo = await uiServer.start();

      console.log(`Media server: http://${mediaInfo.host}:${mediaInfo.port}`);
      if (isFirstRun) {
        console.log('Media folders: (none — use the Add Media Folder button in the web UI)');
      } else {
        console.log(`Media folders: ${mediaDirs.join(' | ')}`);
      }
      console.log(`Renderer: ${renderer && renderer.friendlyName ? renderer.friendlyName : 'No renderer selected'}`);
      if (Number(options.subtitleDelayMs) !== 0) {
        console.log(`Subtitle delay: ${Number(options.subtitleDelayMs)}ms`);
      }
      console.log(`Movies indexed: ${mediaServer.library.filter((item) => item.mimeType.startsWith('video/')).length}`);
      if (mediaInfo.libraryLoad && mediaInfo.libraryLoad.source) {
        const sourceLabel = mediaInfo.libraryLoad.source === 'cache' ? 'cache' : 'full scan';
        const duration = Number.isFinite(mediaInfo.libraryLoad.durationMs)
          ? `${mediaInfo.libraryLoad.durationMs}ms`
          : 'unknown time';
        console.log(`Library load: ${sourceLabel} (${duration})`);
        if (mediaInfo.libraryLoad.backgroundRefreshPending) {
          console.log('Library refresh: running in background; new/changed files will appear shortly.');
        }
      }
      const requestedUiPort = Number(options.uiPort);
      if (uiInfo.port !== requestedUiPort) {
        console.log(`Web app port requested: ${requestedUiPort} (occupied, fell back to ${uiInfo.port})`);
      }
      const browserUrl = `http://${toBrowserFriendlyHost(uiInfo.host)}:${uiInfo.port}`;
      console.log(`Web app: ${browserUrl}`);
      if (options.uiLan) {
        console.log('Web app access: local network (adding media folders stays restricted to this machine).');
      } else {
        console.log('Web app access: this machine only (use --ui-lan to allow other devices).');
      }
      if (await openUrlInDefaultBrowser(browserUrl)) {
        console.log('Opened web app in your default browser.');
      } else {
        console.warn('Could not auto-open browser. Open the web app URL manually.');
      }
      if (isFirstRun) {
        console.log('First run: open the web app and click "Add Media Folder" to get started.');
      } else {
        console.log('Open the web app, click a movie, and it will cast instantly.');
      }
      console.log('Press Ctrl+C to stop.');

      process.on('SIGINT', async () => {
        if (uiServer) {
          await uiServer.stop();
        }
        if (mediaServer) {
          await mediaServer.stop();
        }
        process.exit(0);
      });
    } catch (error) {
      if (uiServer) {
        await uiServer.stop();
      }
      if (mediaServer) {
        await mediaServer.stop();
      }
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('pause')
  .description('Pause playback on renderer')
  .option('-r, --renderer <nameOrUdn>', 'Renderer friendly name or UDN')
  .option('-t, --timeout <ms>', 'Renderer discovery timeout in ms', '5000')
  .option('--renderer-ip <ip>', 'Renderer IP address (bypass SSDP discovery)')
  .action(async (options) => {
    try {
      const { renderer } = await getRendererOrThrow(
        options.renderer,
        Number(options.timeout),
        options.rendererIp,
      );
      await pause(renderer);
      console.log(`Paused on ${renderer.friendlyName}`);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop playback on renderer')
  .option('-r, --renderer <nameOrUdn>', 'Renderer friendly name or UDN')
  .option('-t, --timeout <ms>', 'Renderer discovery timeout in ms', '5000')
  .option('--renderer-ip <ip>', 'Renderer IP address (bypass SSDP discovery)')
  .action(async (options) => {
    try {
      const { renderer } = await getRendererOrThrow(
        options.renderer,
        Number(options.timeout),
        options.rendererIp,
      );
      await stop(renderer);
      console.log(`Stopped on ${renderer.friendlyName}`);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('volume')
  .description('Set renderer master volume (0-100)')
  .requiredOption('-v, --value <number>', 'Volume value from 0 to 100')
  .option('-r, --renderer <nameOrUdn>', 'Renderer friendly name or UDN')
  .option('-t, --timeout <ms>', 'Renderer discovery timeout in ms', '5000')
  .option('--renderer-ip <ip>', 'Renderer IP address (bypass SSDP discovery)')
  .action(async (options) => {
    try {
      const value = Number(options.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('Volume must be a number from 0 to 100.');
      }

      const { renderer } = await getRendererOrThrow(
        options.renderer,
        Number(options.timeout),
        options.rendererIp,
      );
      await setVolume(renderer, Math.round(value));
      console.log(`Volume set to ${Math.round(value)} on ${renderer.friendlyName}`);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('network')
  .description('Show local network interfaces for casting')
  .action(() => {
    try {
      const interfaces = os.networkInterfaces();

      console.log('Local network interfaces:\n');
      for (const [name, addrs] of Object.entries(interfaces)) {
        const ipv4Addrs = addrs.filter((a) => a.family === 'IPv4');
        if (ipv4Addrs.length > 0) {
          ipv4Addrs.forEach((addr) => {
            const internal = addr.internal ? ' (loopback)' : '';
            console.log(`  ${name}: ${addr.address}${internal}`);
          });
        }
      }

      console.log(
        '\nUse the non-loopback IP that matches your renderer\'s network with: --host <ip>\n',
      );
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .description('Show media/container/codec compatibility notes for this stack')
  .action(() => {
    const formats = printSupportedFormats();
    console.log('Containers:', formats.containers.join(', '));
    console.log('Audio:', formats.audio.join(', '));
    console.log('Video codecs:', formats.videoCodecs.join(', '));
    console.log('Notes:');
    formats.notes.forEach((note) => console.log(`- ${note}`));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled error: ${reason?.message || reason}`);
  process.exit(1);
});
