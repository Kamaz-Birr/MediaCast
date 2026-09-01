import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readZipEntries, readZipEntryData, looksLikeZip } from './zipReader.js';

// __dirname exists once esbuild bundles to CJS; import.meta.url is the ESM path.
// Resolving relative to this module rather than the working directory matters:
// the executable can be launched from anywhere.
const moduleDir = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

// Comic archives are just image collections. The extension is only a hint: .cbr
// files are frequently zips and vice versa, so dispatch on the magic bytes.

const PAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const NESTED_ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.cbz', '.cbr']);
// Separates the inner archive from the page inside it in a synthetic page name.
const NESTED_SEPARATOR = String.fromCharCode(0);

function isNestedArchiveName(name) {
  const clean = String(name || '');
  if (clean.endsWith('/') || clean.includes('__MACOSX')) {
    return false;
  }
  return NESTED_ARCHIVE_EXTENSIONS.has(path.extname(clean).toLowerCase());
}

let cachedWasm = null;
let cachedRarModule = null;

function isPageName(name) {
  const clean = String(name || '');
  if (clean.endsWith('/') || clean.endsWith('\\')) {
    return false;
  }
  const base = path.basename(clean);
  // Skip macOS resource forks and hidden files that ship inside many archives.
  if (!base || base.startsWith('.') || clean.includes('__MACOSX')) {
    return false;
  }
  return PAGE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

// "page 2" must sort before "page 10", which a plain string sort gets wrong.
export function comparePageNames(a, b) {
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function looksLikeRar(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const magic = Buffer.alloc(8);
    fs.readSync(fd, magic, 0, 8, 0);
    // "Rar!\x1a\x07\x00" (RAR4) or "Rar!\x1a\x07\x01\x00" (RAR5).
    return magic.slice(0, 6).toString('latin1') === 'Rar!\x1a\x07';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// The wasm ships as a separate file, so it has to be found both from node_modules
// during development and from the pkg snapshot in the packaged executable.
function loadUnrarWasm() {
  if (cachedWasm) {
    return cachedWasm;
  }

  const wasmRelative = path.join('node_modules', 'node-unrar-js', 'esm', 'js', 'unrar.wasm');
  const candidates = [];

  try {
    const require = createRequire(path.join(moduleDir, 'x.js'));
    candidates.push(require.resolve('node-unrar-js/esm/js/unrar.wasm'));
  } catch {
    // Not resolvable once bundled; the paths below cover that.
  }

  // src/comics -> project root (development), dist -> project root (packaged).
  candidates.push(path.join(moduleDir, '..', '..', wasmRelative));
  candidates.push(path.join(moduleDir, '..', wasmRelative));
  candidates.push(path.join(moduleDir, wasmRelative));
  candidates.push(path.join(moduleDir, 'unrar.wasm'));
  candidates.push(path.join(path.dirname(process.execPath), 'unrar.wasm'));
  candidates.push(path.join(process.cwd(), wasmRelative));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        cachedWasm = fs.readFileSync(candidate);
        return cachedWasm;
      }
    } catch {
      // Try the next location.
    }
  }

  throw new Error('The RAR decoder (unrar.wasm) could not be located.');
}

async function getRarModule() {
  if (!cachedRarModule) {
    cachedRarModule = await import('node-unrar-js');
  }
  return cachedRarModule;
}

async function readRarArchive(filePath) {
  const wasmBinary = loadUnrarWasm();
  const { createExtractorFromData } = await getRarModule();
  const data = fs.readFileSync(filePath);
  return createExtractorFromData({ wasmBinary, data: new Uint8Array(data).buffer });
}

async function listRarPages(filePath) {
  const extractor = await readRarArchive(filePath);
  const list = extractor.getFileList();
  const names = [];
  for (const header of list.fileHeaders) {
    if (!header.flags.directory && isPageName(header.name)) {
      names.push(header.name);
    }
  }
  return names.sort(comparePageNames);
}

async function readRarPage(filePath, entryName) {
  const extractor = await readRarArchive(filePath);
  const extracted = extractor.extract({ files: [entryName] });
  for (const file of extracted.files) {
    if (file.extraction) {
      return Buffer.from(file.extraction);
    }
  }
  throw new Error(`Page "${entryName}" could not be extracted.`);
}

async function listAllEntryNames(filePath) {
  if (looksLikeZip(filePath)) {
    return readZipEntries(filePath).map((entry) => entry.name);
  }
  if (looksLikeRar(filePath)) {
    const extractor = await readRarArchive(filePath);
    const names = [];
    for (const header of extractor.getFileList().fileHeaders) {
      if (!header.flags.directory) {
        names.push(header.name);
      }
    }
    return names;
  }
  throw new Error('Unrecognised comic archive: it is neither a zip nor a rar.');
}

async function readRawEntry(filePath, entryName) {
  if (looksLikeZip(filePath)) {
    const entry = readZipEntries(filePath).find((item) => item.name === entryName);
    if (!entry) {
      throw new Error(`Page "${entryName}" is not in this archive.`);
    }
    return readZipEntryData(filePath, entry);
  }
  return readRarPage(filePath, entryName);
}

// Some volumes are archives of per-chapter archives. Unpacking the inner archive
// to a cached temp file lets the whole volume read as one continuous book.
async function materialiseNested(filePath, nestedName) {
  const stem = crypto.createHash('sha1')
    .update(path.resolve(filePath) + '::' + nestedName)
    .digest('hex')
    .slice(0, 20);
  const outPath = path.join(os.tmpdir(), 'mediacast-nested', stem + path.extname(nestedName));

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return outPath;
  }

  const data = await readRawEntry(filePath, nestedName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, data);
  return outPath;
}

/**
 * Page names in reading order. Dispatches on content, not on the extension,
 * because mislabelled comic archives are common. An archive holding only other
 * archives is expanded so the volume reads straight through.
 */
export async function listComicPages(filePath) {
  const names = await listAllEntryNames(filePath);

  const pages = names.filter(isPageName).sort(comparePageNames);
  if (pages.length > 0) {
    return pages;
  }

  const nested = names.filter(isNestedArchiveName).sort(comparePageNames);
  if (nested.length === 0) {
    return [];
  }

  const expanded = [];
  for (const nestedName of nested) {
    try {
      const nestedPath = await materialiseNested(filePath, nestedName);
      const innerPages = await listComicPages(nestedPath);
      for (const innerName of innerPages) {
        expanded.push(nestedName + NESTED_SEPARATOR + innerName);
      }
    } catch (error) {
      console.warn(`[Comic] Skipping "${nestedName}": ${error.message}`);
    }
  }

  return expanded;
}

export async function readComicPage(filePath, entryName) {
  const separatorAt = String(entryName).indexOf(NESTED_SEPARATOR);
  if (separatorAt !== -1) {
    const nestedName = entryName.slice(0, separatorAt);
    const innerName = entryName.slice(separatorAt + 1);
    const nestedPath = await materialiseNested(filePath, nestedName);
    return readComicPage(nestedPath, innerName);
  }

  return readRawEntry(filePath, entryName);
}

export function comicArchiveKind(filePath) {
  if (looksLikeZip(filePath)) {
    return 'zip';
  }
  if (looksLikeRar(filePath)) {
    return 'rar';
  }
  return 'unknown';
}
