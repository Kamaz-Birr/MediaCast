import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const DLNA_SAFE_CONTAINER = 'mp4';
const DLNA_SAFE_VIDEO_CODEC = 'h264';
const DLNA_SAFE_AUDIO_CODEC = 'aac';

function describeStream(stream, typeOrdinal) {
  const tags = stream && stream.tags ? stream.tags : {};
  const disposition = stream && stream.disposition ? stream.disposition : {};

  return {
    index: Number(stream.index),
    // Position among streams of the same type, which is what -map 0:a:N wants.
    typeIndex: typeOrdinal,
    codec_type: stream.codec_type || '',
    codec_name: stream.codec_name || '',
    profile: stream.profile || '',
    language: String(tags.language || tags.LANGUAGE || '').trim(),
    title: String(tags.title || tags.TITLE || '').trim(),
    channels: Number.isFinite(Number(stream.channels)) ? Number(stream.channels) : null,
    channelLayout: stream.channel_layout || '',
    width: Number.isFinite(Number(stream.width)) ? Number(stream.width) : null,
    height: Number.isFinite(Number(stream.height)) ? Number(stream.height) : null,
    isDefault: disposition.default === 1,
    isForced: disposition.forced === 1,
  };
}

async function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
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

      let parsed;
      try {
        parsed = JSON.parse(stdout || '{}');
      } catch (err) {
        return reject(new Error(`ffprobe returned unreadable output: ${err.message}`));
      }

      const format = parsed.format || {};
      const typeCounters = {};
      const streams = (Array.isArray(parsed.streams) ? parsed.streams : [])
        .filter((stream) => stream && stream.codec_type)
        .map((stream) => {
          const type = stream.codec_type;
          const ordinal = typeCounters[type] === undefined ? 0 : typeCounters[type];
          typeCounters[type] = ordinal + 1;
          return describeStream(stream, ordinal);
        });

      resolve({
        container: path.extname(filePath).toLowerCase().replace('.', ''),
        format: format.format_name || '',
        duration: Math.round(Number(format.duration) || 0),
        bitrate: parseInt(format.bit_rate, 10) || 0,
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
  // Explicit flags win over the platform default below.
  if (options.forceTranscode) {
    return true;
  }

  if (options.skipTranscode) {
    return false;
  }

  // Auto-detection stays off on Windows: FFmpeg pipe streaming is unreliable there,
  // so unflagged files default to direct play.
  // TODO: Implement file-based transcode or use a different streaming approach
  if (process.platform === 'win32') {
    console.log(`[TRANSCODE_SKIP] Windows detected - using direct play for ${path.basename(filePath)}`);
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

export {
  probeFile,
  needsTranscoding,
  shouldTranscode,
  DLNA_SAFE_CONTAINER,
  DLNA_SAFE_VIDEO_CODEC,
  DLNA_SAFE_AUDIO_CODEC,
};

