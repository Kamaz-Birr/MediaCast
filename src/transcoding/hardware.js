import { spawn } from 'child_process';

// GPU acceleration for this app means hardware video encoding. Everything else
// it does (archive extraction, metadata lookups, byte-range streaming) is IO or
// network bound, and the browser already composites the UI on the GPU.

const PRESET_TO_NVENC = {
  ultrafast: 'p1',
  superfast: 'p1',
  veryfast: 'p2',
  faster: 'p3',
  fast: 'p3',
  medium: 'p4',
  slow: 'p5',
  slower: 'p6',
  veryslow: 'p7',
};

const PRESET_TO_AMF = {
  ultrafast: 'speed',
  superfast: 'speed',
  veryfast: 'speed',
  faster: 'speed',
  fast: 'balanced',
  medium: 'balanced',
  slow: 'quality',
  slower: 'quality',
  veryslow: 'quality',
};

// Quality knobs differ per encoder, so each descriptor translates the shared
// preset/CRF options into whatever its own encoder expects.
const ENCODERS = [
  {
    id: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    platforms: ['win32', 'linux'],
    buildArgs: ({ preset, crf, maxrate, bufsize }) => [
      '-c:v', 'h264_nvenc',
      '-preset', PRESET_TO_NVENC[preset] || 'p4',
      '-rc', 'vbr',
      '-cq', String(crf),
      '-b:v', '0',
      '-maxrate', maxrate,
      '-bufsize', bufsize,
    ],
  },
  {
    id: 'h264_qsv',
    label: 'Intel Quick Sync',
    platforms: ['win32', 'linux'],
    buildArgs: ({ crf, maxrate, bufsize }) => [
      '-c:v', 'h264_qsv',
      '-global_quality', String(crf),
      '-maxrate', maxrate,
      '-bufsize', bufsize,
    ],
  },
  {
    id: 'h264_amf',
    label: 'AMD AMF',
    platforms: ['win32', 'linux'],
    buildArgs: ({ preset, crf, maxrate, bufsize }) => [
      '-c:v', 'h264_amf',
      '-quality', PRESET_TO_AMF[preset] || 'balanced',
      '-rc', 'cqp',
      '-qp_i', String(crf),
      '-qp_p', String(crf),
      '-maxrate', maxrate,
      '-bufsize', bufsize,
    ],
  },
  {
    id: 'h264_videotoolbox',
    label: 'Apple VideoToolbox',
    platforms: ['darwin'],
    buildArgs: ({ maxrate, bufsize }) => [
      '-c:v', 'h264_videotoolbox',
      '-b:v', maxrate,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
    ],
  },
];

export const CPU_ENCODER = {
  id: 'libx264',
  label: 'CPU (libx264)',
  hardware: false,
  buildArgs: ({ preset, crf, maxrate, bufsize }) => [
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-maxrate', maxrate,
    '-bufsize', bufsize,
  ],
};

let detectionPromise = null;

function runFfmpeg(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let proc;
    try {
      proc = spawn('ffmpeg', args, { windowsHide: true });
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: error.message });
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish({ ok: false, stdout, stderr: 'timed out' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr: error.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, stdout, stderr });
    });
  });
}

async function listEncoderIds() {
  const result = await runFfmpeg(['-hide_banner', '-encoders']);
  if (!result.ok) {
    return new Set();
  }

  const ids = new Set();
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*[VASFXBD.]{6}\s+(\S+)/);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * Being listed is not the same as being usable: ffmpeg advertises h264_nvenc on
 * machines with no NVIDIA card, and the failure only shows up mid-stream. A
 * throwaway encode is the only reliable check.
 */
async function encoderWorks(id) {
  const result = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=5:duration=0.4',
    '-c:v', id,
    '-frames:v', '3',
    '-f', 'null', '-',
  ]);
  return result.ok;
}

export function resetHardwareDetection() {
  detectionPromise = null;
}

/**
 * @param {string} preference auto | cpu | an encoder id such as h264_nvenc
 */
export function detectVideoEncoder(preference = 'auto') {
  const wanted = String(preference || 'auto').trim().toLowerCase();

  if (wanted === 'cpu' || wanted === 'libx264') {
    return Promise.resolve({ ...CPU_ENCODER, reason: 'requested' });
  }

  if (detectionPromise) {
    return detectionPromise;
  }

  detectionPromise = (async () => {
    const available = await listEncoderIds();
    if (available.size === 0) {
      return { ...CPU_ENCODER, reason: 'ffmpeg encoder list unavailable' };
    }

    const shortlist = wanted === 'auto'
      ? ENCODERS.filter((item) => item.platforms.includes(process.platform))
      : ENCODERS.filter((item) => item.id === wanted || item.id.endsWith('_' + wanted));

    if (wanted !== 'auto' && shortlist.length === 0) {
      return { ...CPU_ENCODER, reason: `unknown encoder "${wanted}"` };
    }

    for (const candidate of shortlist) {
      if (!available.has(candidate.id)) {
        continue;
      }
      if (await encoderWorks(candidate.id)) {
        return { ...candidate, hardware: true, reason: 'verified' };
      }
      console.warn(`[GPU] ${candidate.label} is listed by ffmpeg but failed a test encode; skipping.`);
    }

    return {
      ...CPU_ENCODER,
      reason: wanted === 'auto'
        ? 'no working hardware encoder found'
        : `"${wanted}" is not usable on this machine`,
    };
  })();

  return detectionPromise;
}
