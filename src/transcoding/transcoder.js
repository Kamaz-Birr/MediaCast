import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export class FFmpegTranscoder extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.options = options;
    this.process = null;
    this.duration = null;
    this.isRunning = false;
    this.hasError = false;
    this.subtitlesPath = options.subtitlesPath || null;
  }

  start() {
    if (this.isRunning) {
      return;
    }

    const args = [
      '-i',
      this.filePath,
    ];
    // Burn in subtitles if present
    if (this.subtitlesPath) {
      args.push('-vf', `subtitles='${this.subtitlesPath.replace(/'/g, "'\\''")}'`);
    }

    // Video encoding options
    args.push(
      '-c:v',
      this.options.videoCodec || 'libx264',
      '-preset',
      this.options.videoPreset || 'medium',
      '-crf',
      String(this.options.videoCrf || 23),
    );

    // Add maxrate and bufsize for smoother streaming (default for 4K: 20M)
    const maxrate = this.options.videoMaxrate || '20M';
    const bufsize = this.options.videoBufsize || '40M';
    args.push('-maxrate', maxrate, '-bufsize', bufsize);

    // Keyframe interval (optional, default 2s for 30fps)
    if (this.options.videoGop) {
      args.push('-g', String(this.options.videoGop));
    }

    // Audio encoding options
    args.push(
      '-c:a',
      this.options.audioCodec || 'aac',
      '-b:a',
      this.options.audioBitrate || '128k',
    );

    args.push(
      '-c:s',
      'copy',
      '-map',
      '0',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov',
      'pipe:1',
    );

    console.log(`[TRANSCODE_SPAWN] ${this.filePath}`);
    console.log(`[TRANSCODE_ARGS] ${args.join(' ')}`);

    try {
      this.process = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      this.isRunning = false;
      this.hasError = true;
      const errorMsg = `Failed to spawn FFmpeg: ${err.message}`;
      console.error(`[TRANSCODE_SPAWN_ERROR] ${errorMsg}`);
      this.emit('error', new Error(errorMsg));
      return this.getErrorStream();
    }

    this.isRunning = true;

    this.process.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const errorMsg = 'ffmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html';
        this.isRunning = false;
        this.hasError = true;
        console.error(`[TRANSCODE_ERROR] ${errorMsg}`);
        this.emit('error', new Error(errorMsg));
        return;
      }

      this.isRunning = false;
      this.hasError = true;
      console.error(`[TRANSCODE_ERROR] ${err.message}`);
      this.emit('error', err);
    });

    let stderrData = '';
    this.process.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrData += text;

      const durationMatch = text.match(/Duration: (\d+):(\d+):(\d+)/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1]);
        const minutes = parseInt(durationMatch[2]);
        const seconds = parseInt(durationMatch[3]);
        this.duration = hours * 3600 + minutes * 60 + seconds;
        this.emit('duration', this.duration);
      }

      const progressMatch = text.match(/time=(\d+):(\d+):(\d+)/);
      if (progressMatch) {
        const hours = parseInt(progressMatch[1]);
        const minutes = parseInt(progressMatch[2]);
        const seconds = parseInt(progressMatch[3]);
        const time = hours * 3600 + minutes * 60 + seconds;
        this.emit('progress', { time, duration: this.duration });
      }

      // Log fatal FFmpeg errors
      if (text.includes('Fatal')) {
        console.error(`[TRANSCODE_FATAL] ${text}`);
      }
    });

    this.process.on('close', (code) => {
      this.isRunning = false;
      if (code !== 0 && !this.hasError) {
        this.hasError = true;
        const errorMsg = `FFmpeg exited with code ${code}`;
        console.error(`[TRANSCODE_EXIT] ${errorMsg} (${code === 4294967274 ? 'likely Windows spawn issue' : 'check stderr above'})`);
        // Only emit error if there are listeners to prevent unhandled error
        if (this.listenerCount('error') > 0) {
          this.emit('error', new Error(errorMsg));
        }
      } else if (code === 0 && !this.hasError) {
        console.log('[TRANSCODE_SUCCESS] FFmpeg completed successfully');
        this.emit('end');
      }
    });

    this.process.stdout.on('error', (err) => {
      this.hasError = true;
      console.error(`[TRANSCODE_STDOUT_ERROR] ${err.message}`);
      this.emit('error', err);
    });

    return this.process.stdout;
  }

  getErrorStream() {
    const { Readable } = require('stream');
    const stream = new Readable({
      read() {
        // Stream is empty; will be closed immediately
        this.push(null);
      },
    });
    return stream;
  }

  kill() {
    if (this.process && this.isRunning) {
      try {
        this.process.kill('SIGTERM');
        console.log('[TRANSCODE_KILLED] FFmpeg process terminated');
      } catch (err) {
        console.error(`[TRANSCODE_KILL_ERROR] ${err.message}`);
      }
      this.isRunning = false;
    }
  }
}
