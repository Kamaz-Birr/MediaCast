import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The speech engine ships inside the executable, but a packaged app cannot run
// a .exe or load a .dll straight out of its virtual filesystem: those have to be
// real files on disk. So the bundle is unpacked once, next to the config, and
// everything afterwards points at that copy.

const moduleDir = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

// Bumped when the bundled engine or voice changes, so an upgrade replaces the
// unpacked copy instead of leaving an old voice in place.
export const BUNDLED_ENGINE_VERSION = '1-cori-high';

const MARKER = '.bundled-engine';

/** Where the bundle sits, in development and inside the packaged snapshot. */
export function findBundledEngine() {
  const candidates = [
    // src/books -> project root (development)
    path.join(moduleDir, '..', '..', 'vendor', 'speech'),
    // dist -> project root (packaged: C:\snapshot\MediaCast\vendor\speech)
    path.join(moduleDir, '..', 'vendor', 'speech'),
    path.join(moduleDir, 'vendor', 'speech'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'piper', 'piper.exe'))
        || fs.existsSync(path.join(candidate, 'piper', 'piper'))) {
        return candidate;
      }
    } catch {
      // Try the next location.
    }
  }

  return null;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target);
    } else {
      // Reading and writing explicitly rather than copyFileSync: the source is
      // inside the snapshot, where some copy fast-paths do not apply.
      fs.writeFileSync(target, fs.readFileSync(source));
    }
  }
}

/**
 * Unpacks the bundled engine into targetDir the first time it is needed.
 * Returns what happened so the caller can tell the user, and never throws:
 * a machine that cannot be written to should still open books.
 */
export function ensureBundledEngine(targetDir) {
  if (!targetDir) {
    return { installed: false, reason: 'no-target' };
  }

  const markerPath = path.join(targetDir, MARKER);
  try {
    if (fs.readFileSync(markerPath, 'utf8').trim() === BUNDLED_ENGINE_VERSION) {
      return { installed: true, reason: 'already-installed' };
    }
  } catch {
    // Not installed yet, or a different version.
  }

  const bundle = findBundledEngine();
  if (!bundle) {
    return { installed: false, reason: 'not-bundled' };
  }

  try {
    copyTree(bundle, targetDir);
    fs.writeFileSync(markerPath, BUNDLED_ENGINE_VERSION, 'utf8');
    return { installed: true, reason: 'unpacked' };
  } catch (error) {
    return { installed: false, reason: 'failed', error: error.message };
  }
}
