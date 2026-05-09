#!/usr/bin/env node

const path = require('path');
const process = require('process');
const fs = require('fs');
const { execFile } = require('child_process');
const readline = require('readline/promises');
const os = require('os');
const { Command } = require('commander');
const { MediaServer } = require('./dlna/mediaServer');
const { buildDidlLite } = require('./dlna/metadata');
const { discoverRenderers, pickRenderer, getRendererByIp } = require('./upnp/discovery');
const {
  setAvTransportUri,
  play,
  pause,
  stop,
  setVolume,
  getTransportInfo,
  getCurrentTransportActions,
} = require('./upnp/soap');
const { printSupportedFormats } = require('./utils/media');
const { createCastUiServer } = require('./web/castUiServer');

async function getRendererOrThrow(rendererQuery, timeoutMs, rendererIp) {
  if (rendererIp) {
    const byIp = await getRendererByIp(rendererIp);
    if (!byIp) {
      throw new Error(`Could not resolve renderer at ${rendererIp}.`);
    }
    return { renderer: byIp, renderers: [byIp] };
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

  return { renderer, renderers };
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
const APP_ROOT = path.resolve(__dirname, '..');

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

function loadSavedMediaDirectories() {
  const configPath = getCastUiConfigPath();
  if (!fs.existsSync(configPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed.mediaDirs) ? parsed.mediaDirs : [];

    return values
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0)
      .filter((item) => fs.existsSync(item) && fs.statSync(item).isDirectory())
      .filter((item) => !isAppDirectory(item))
      .map((item) => path.resolve(item));
  } catch {
    return [];
  }
}

function saveMediaDirectories(mediaDirs) {
  const configPath = getCastUiConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  const unique = Array.from(new Set(mediaDirs.map((item) => path.resolve(item))))
    .filter((item) => !isAppDirectory(item));
  fs.writeFileSync(
    configPath,
    JSON.stringify({ mediaDirs: unique }, null, 2),
    'utf8',
  );
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

  // Use saved folders if they exist — no prompt needed
  const saved = loadSavedMediaDirectories();
  if (saved.length > 0) {
    return saved;
  }

  // First run: no saved folders — start with empty library, user picks via UI
  return [];
}

const program = new Command();
program
  .name('mediacast')
  .description('UPnP/DLNA JavaScript casting stack')
  .version('1.0.0');

program
  .command('info')
  .description('Display media file and transcoding info')
  .requiredOption('-f, --file <file>', 'Path to media file')
  .action(async (options) => {
    try {
      const { probeFile, needsTranscoding } = require('./transcoding/detector');
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
  .option('--video-preset <preset>', 'FFmpeg video preset (ultrafast, fast, medium, slow)', 'medium')
  .option('--audio-bitrate <bitrate>', 'FFmpeg audio bitrate (e.g., 128k, 192k)', '128k')
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
  .option('--video-preset <preset>', 'FFmpeg video preset (ultrafast, fast, medium, slow)', 'medium')
  .option('--audio-bitrate <bitrate>', 'FFmpeg audio bitrate (e.g., 128k, 192k)', '128k')
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
  .option('--no-transcode', 'Disable FFmpeg transcoding (direct play only)')
  .option('--force-transcode', 'Force transcoding to H.264+AAC')
  .option('--video-preset <preset>', 'FFmpeg video preset (ultrafast, fast, medium, slow)', 'medium')
  .option('--audio-bitrate <bitrate>', 'FFmpeg audio bitrate (e.g., 128k, 192k)', '128k')
  .action(async (options) => {
    let mediaServer = null;
    let uiServer = null;

    try {
      const mediaDirs = await resolveInitialMediaDirectories(options.dir);
      const isFirstRun = mediaDirs.length === 0;

      mediaServer = new MediaServer({
        rootDirs: mediaDirs,
        port: Number(options.port),
        host: options.host,
        transcoding: {
          enabled: options.transcode,
          forceTranscode: options.forceTranscode,
          videoPreset: options.videoPreset,
          audioBitrate: options.audioBitrate,
        },
      });

      const mediaInfo = await mediaServer.start();
      const { renderer } = await getRendererOrThrow(
        options.renderer,
        Number(options.timeout),
        options.rendererIp,
      );

      uiServer = createCastUiServer({
        mediaServer,
        renderer,
        uiHost: options.uiHost,
        uiPort: Number(options.uiPort),
        chooseMediaFolder: () => resolveMediaDirectory(''),
        onMediaFoldersChanged: (dirs) => saveMediaDirectories(dirs),
      });

      const uiInfo = await uiServer.start();

      console.log(`Media server: http://${mediaInfo.host}:${mediaInfo.port}`);
      if (isFirstRun) {
        console.log('Media folders: (none — use the Add Media Folder button in the web UI)');
      } else {
        console.log(`Media folders: ${mediaDirs.join(' | ')}`);
      }
      console.log(`Renderer: ${renderer.friendlyName}`);
      console.log(`Movies indexed: ${mediaServer.library.filter((item) => item.mimeType.startsWith('video/')).length}`);
      console.log(`Web app: http://${uiInfo.host}:${uiInfo.port}`);
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
      const os = require('os');
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
