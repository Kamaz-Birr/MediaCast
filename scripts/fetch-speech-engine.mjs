// Populates vendor/speech with the read-aloud engine that gets bundled into the
// executable. The files are large binaries, so they are fetched here rather than
// committed; vendor/ is gitignored.
//
//   npm run fetch-speech-engine
//
// Only the English phoneme data is kept, which takes the bundle from about
// 155MB to 120MB without changing what the reader can say.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'speech');

const PIPER_RELEASE = '2023.11.14-2';
const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/'
  + PIPER_RELEASE + '/piper_windows_amd64.zip';

const VOICE = 'en_GB-cori-high';
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/high/';

// Everything piper needs to speak English, and nothing else.
const RUNTIME_FILES = [
  'piper.exe',
  'onnxruntime.dll',
  'piper_phonemize.dll',
  'espeak-ng.dll',
  'onnxruntime_providers_shared.dll',
];
const ESPEAK_FILES = [
  'en_dict', 'phondata', 'phontab', 'phonindex', 'intonations', 'phondata-manifest',
];

const log = (message) => console.log('[speech] ' + message);

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(url + ' -> HTTP ' + response.status);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return bytes.length;
}

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + 'MB';

async function main() {
  if (fs.existsSync(path.join(VENDOR, 'piper', 'piper.exe'))
    && fs.existsSync(path.join(VENDOR, VOICE + '.onnx'))) {
    log('vendor/speech is already populated - nothing to do.');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mediacast-speech-'));
  fs.mkdirSync(path.join(VENDOR, 'piper', 'espeak-ng-data', 'lang', 'gmw'), { recursive: true });

  log('downloading the piper engine...');
  const zipPath = path.join(work, 'piper.zip');
  log('  engine ' + mb(await download(PIPER_URL, zipPath)));

  // PowerShell is already a dependency of the Windows build path.
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + work + '" -Force',
  ], { stdio: 'inherit' });

  const extracted = path.join(work, 'piper');
  for (const name of RUNTIME_FILES) {
    fs.copyFileSync(path.join(extracted, name), path.join(VENDOR, 'piper', name));
  }
  for (const name of ESPEAK_FILES) {
    fs.copyFileSync(
      path.join(extracted, 'espeak-ng-data', name),
      path.join(VENDOR, 'piper', 'espeak-ng-data', name),
    );
  }
  const langDir = path.join(extracted, 'espeak-ng-data', 'lang', 'gmw');
  for (const name of fs.readdirSync(langDir)) {
    if (name.startsWith('en')) {
      fs.copyFileSync(
        path.join(langDir, name),
        path.join(VENDOR, 'piper', 'espeak-ng-data', 'lang', 'gmw', name),
      );
    }
  }

  log('downloading the ' + VOICE + ' voice...');
  log('  model ' + mb(await download(VOICE_BASE + VOICE + '.onnx', path.join(VENDOR, VOICE + '.onnx'))));
  log('  config ' + mb(await download(VOICE_BASE + VOICE + '.onnx.json', path.join(VENDOR, VOICE + '.onnx.json'))));

  fs.rmSync(work, { recursive: true, force: true });

  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        total += fs.statSync(full).size;
      }
    }
  };
  walk(VENDOR);
  log('vendor/speech ready: ' + mb(total));
}

main().catch((error) => {
  console.error('[speech] ' + error.message);
  process.exitCode = 1;
});
