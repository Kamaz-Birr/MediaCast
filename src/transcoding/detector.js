const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DLNA_SAFE_CONTAINER = 'mp4';
const DLNA_SAFE_VIDEO_CODEC = 'h264';
const DLNA_SAFE_AUDIO_CODEC = 'aac';

function parseFFprobeLine(text) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }

  return result;
}

async function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'flat',
      '-show_format',
      '-show_streams',
      filePath,
    ]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        return reject(
          new Error('ffprobe not found. Install FFmpeg: https://ffmpeg.org/download.html'),
        );
      }
      reject(err);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe failed: ${stderr}`));
      }

      const info = parseFFprobeLine(stdout);
      const streams = [];

      let streamIndex = 0;
      while (true) {
        const prefix = `streams_${streamIndex}`;
        if (!Object.keys(info).some((k) => k.startsWith(prefix))) {
          break;
        }

        const stream = {};
        for (const [key, value] of Object.entries(info)) {
          if (key.startsWith(prefix)) {
            const streamKey = key.substring(prefix.length + 1);
            stream[streamKey] = value;
          }
        }

        if (stream.codec_type) {
          streams.push(stream);
        }
        streamIndex++;
      }

      resolve({
        container: path.extname(filePath).toLowerCase().replace('.', ''),
        format: info['format_name'] || '',
        duration: parseInt(info['format_duration']) || 0,
        bitrate: parseInt(info['format_bit_rate']) || 0,
        streams,
      });
    });
  });
}

function needsTranscoding(probe) {
  if (!probe || !probe.streams) {
    return true;
  }

  const videoStream = probe.streams.find((s) => s.codec_type === 'video');
  const audioStream = probe.streams.find((s) => s.codec_type === 'audio');

  const isH264 = videoStream && videoStream.codec_name === DLNA_SAFE_VIDEO_CODEC;
  const isAAC = audioStream && audioStream.codec_name === DLNA_SAFE_AUDIO_CODEC;
  const isMp4 = probe.container === DLNA_SAFE_CONTAINER;

  const needsVideoTranscode = videoStream && !isH264;
  const needsAudioTranscode = audioStream && !isAAC;

  return !isMp4 || needsVideoTranscode || needsAudioTranscode;
}

async function shouldTranscode(filePath, options = {}) {
  // Disable transcode on Windows due to pipe handling issues
  // Media server will gracefully fall back to direct play
  // TODO: Implement file-based transcode or use a different streaming approach
  if (process.platform === 'win32') {
    console.log(`[TRANSCODE_SKIP] Windows detected - using direct play for ${path.basename(filePath)}`);
    return false;
  }

  if (options.forceTranscode) {
    return true;
  }

  if (options.skipTranscode) {
    return false;
  }

  try {
    const probe = await probeFile(filePath);
    return needsTranscoding(probe);
  } catch (err) {
    console.warn(`Probe failed for ${filePath}: ${err.message}`);
    return false;
  }
}

module.exports = {
  probeFile,
  needsTranscoding,
  shouldTranscode,
  DLNA_SAFE_CONTAINER,
  DLNA_SAFE_VIDEO_CODEC,
  DLNA_SAFE_AUDIO_CODEC,
};
