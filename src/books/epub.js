import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { XMLParser } from 'fast-xml-parser';
import { readZipEntries, readZipEntryData, looksLikeZip } from '../comics/zipReader.js';

// An EPUB is a zip holding XHTML chapters plus a package file that names them in
// reading order. Everything here works off the zip reader the comics use, so no
// extra dependency is needed to open a book.

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

const CONTAINER_PATH = 'META-INF/container.xml';

// Entries are matched case-insensitively because some writers vary the casing.
function findEntry(entries, name) {
  const wanted = String(name || '').replace(/^\/+/, '').toLowerCase();
  return entries.find((entry) => entry.name.toLowerCase() === wanted) || null;
}

function readEntryText(filePath, entries, name) {
  const entry = findEntry(entries, name);
  if (!entry) {
    return null;
  }
  return readZipEntryData(filePath, entry).toString('utf8').replace(/^﻿/, '');
}

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// Resolves an href that is relative to the package file into a zip entry name.
function resolveHref(baseDir, href) {
  const clean = String(href || '').split('#')[0].trim();
  if (!clean) {
    return '';
  }
  const joined = baseDir ? path.posix.join(baseDir, clean) : clean;
  // path.posix.normalize keeps "../" honest without touching the zip.
  return path.posix.normalize(joined).replace(/^\/+/, '');
}

function textOf(node) {
  if (node === undefined || node === null) {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (typeof node === 'object' && node['#text'] !== undefined) {
    return String(node['#text']);
  }
  return '';
}

export function looksLikeEpub(filePath) {
  if (!looksLikeZip(filePath)) {
    return false;
  }
  try {
    const entries = readZipEntries(filePath);
    return Boolean(findEntry(entries, CONTAINER_PATH));
  } catch {
    return false;
  }
}

function findPackagePath(filePath, entries) {
  const containerXml = readEntryText(filePath, entries, CONTAINER_PATH);
  if (containerXml) {
    const container = parser.parse(containerXml);
    const rootFiles = asArray(container?.container?.rootfiles?.rootfile);
    for (const rootFile of rootFiles) {
      const fullPath = rootFile && rootFile['@_full-path'];
      if (fullPath && findEntry(entries, fullPath)) {
        return String(fullPath).replace(/^\/+/, '');
      }
    }
  }

  // A missing or broken container still leaves the package findable by suffix.
  const fallback = entries.find((entry) => /\.opf$/i.test(entry.name));
  return fallback ? fallback.name : null;
}

function parseNcxToc(xml, baseDir) {
  const doc = parser.parse(xml);
  const out = [];

  const walk = (points, depth) => {
    for (const point of asArray(points)) {
      if (!point) {
        continue;
      }
      const label = textOf(point.navLabel?.text).trim();
      const src = point.content && point.content['@_src'];
      if (label && src) {
        out.push({ label, href: resolveHref(baseDir, src), anchor: String(src).split('#')[1] || '', depth });
      }
      if (point.navPoint) {
        walk(point.navPoint, depth + 1);
      }
    }
  };

  walk(doc?.ncx?.navMap?.navPoint, 0);
  return out;
}

// EPUB 3 replaces the NCX with an XHTML nav document.
function parseNavToc(xml, baseDir) {
  const out = [];
  // The nav doc is XHTML; a scoped scan is more forgiving than full parsing of
  // documents that often carry stray markup.
  const navMatch = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(xml);
  const scope = navMatch ? navMatch[1] : xml;
  const linkPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match = linkPattern.exec(scope);
  while (match) {
    const label = match[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (label) {
      out.push({
        label,
        href: resolveHref(baseDir, match[1]),
        anchor: String(match[1]).split('#')[1] || '',
        depth: 0,
      });
    }
    match = linkPattern.exec(scope);
  }

  return out;
}

/**
 * Reads the package file and returns everything needed to render the book:
 * metadata, the spine in reading order and a table of contents.
 */
export function openEpub(filePath) {
  const entries = readZipEntries(filePath);
  const packagePath = findPackagePath(filePath, entries);
  if (!packagePath) {
    throw new Error('This EPUB has no package file, so its contents cannot be ordered.');
  }

  const packageXml = readEntryText(filePath, entries, packagePath);
  if (!packageXml) {
    throw new Error('The EPUB package file could not be read.');
  }

  const baseDir = path.posix.dirname(packagePath.replace(/\\/g, '/'));
  const normalizedBase = baseDir === '.' ? '' : baseDir;
  const pkg = parser.parse(packageXml)?.package || {};
  const metadata = pkg.metadata || {};

  const manifestItems = asArray(pkg.manifest?.item).filter(Boolean);
  const byId = new Map();
  for (const item of manifestItems) {
    const id = item['@_id'];
    if (!id) {
      continue;
    }
    byId.set(String(id), {
      id: String(id),
      href: resolveHref(normalizedBase, item['@_href']),
      mediaType: String(item['@_media-type'] || ''),
      properties: String(item['@_properties'] || ''),
    });
  }

  const spine = [];
  for (const ref of asArray(pkg.spine?.itemref)) {
    const item = ref && byId.get(String(ref['@_idref']));
    // linear="no" marks incidental matter; it still belongs in the flow.
    if (item && item.href) {
      spine.push({ id: item.id, href: item.href, mediaType: item.mediaType });
    }
  }

  if (spine.length === 0) {
    throw new Error('This EPUB lists no readable chapters.');
  }

  // ---- table of contents -------------------------------------------------
  let toc = [];
  const navItem = manifestItems.find((item) => String(item['@_properties'] || '').includes('nav'));
  const ncxId = pkg.spine && pkg.spine['@_toc'];
  const ncxItem = (ncxId && byId.get(String(ncxId)))
    || [...byId.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml');

  try {
    if (navItem) {
      const navHref = resolveHref(normalizedBase, navItem['@_href']);
      const navXml = readEntryText(filePath, entries, navHref);
      if (navXml) {
        toc = parseNavToc(navXml, path.posix.dirname(navHref));
      }
    }
    if (toc.length === 0 && ncxItem) {
      const ncxXml = readEntryText(filePath, entries, ncxItem.href);
      if (ncxXml) {
        toc = parseNcxToc(ncxXml, path.posix.dirname(ncxItem.href));
      }
    }
  } catch {
    // A malformed contents list must not stop the book from opening.
    toc = [];
  }

  // Point each contents entry at the spine position it lands in.
  const spineIndexByHref = new Map(spine.map((item, index) => [item.href, index]));
  toc = toc
    .map((entry) => ({ ...entry, spineIndex: spineIndexByHref.has(entry.href)
      ? spineIndexByHref.get(entry.href)
      : -1 }))
    .filter((entry) => entry.spineIndex >= 0);

  if (toc.length === 0) {
    // Without a usable contents list the spine itself is the next best thing.
    toc = spine.map((item, index) => ({
      label: 'Section ' + (index + 1),
      href: item.href,
      anchor: '',
      depth: 0,
      spineIndex: index,
    }));
  }

  // ---- cover -------------------------------------------------------------
  let coverHref = '';
  const coverMeta = asArray(metadata.meta).find((meta) => meta && String(meta['@_name']) === 'cover');
  if (coverMeta && byId.has(String(coverMeta['@_content']))) {
    coverHref = byId.get(String(coverMeta['@_content'])).href;
  }
  if (!coverHref) {
    const coverProp = [...byId.values()].find((item) => item.properties.includes('cover-image'));
    if (coverProp) {
      coverHref = coverProp.href;
    }
  }
  if (!coverHref) {
    const guess = [...byId.values()].find((item) => item.mediaType.startsWith('image/')
      && /cover/i.test(item.href));
    if (guess) {
      coverHref = guess.href;
    }
  }

  const creators = asArray(metadata['dc:creator'] || metadata.creator)
    .map((value) => textOf(value).trim())
    .filter(Boolean);

  return {
    packagePath,
    baseDir: normalizedBase,
    title: textOf(metadata['dc:title'] || metadata.title).trim()
      || path.basename(filePath, path.extname(filePath)),
    creator: creators.join(', '),
    language: textOf(metadata['dc:language'] || metadata.language).trim(),
    publisher: textOf(metadata['dc:publisher'] || metadata.publisher).trim(),
    description: textOf(metadata['dc:description'] || metadata.description).trim(),
    coverHref,
    spine,
    toc,
  };
}

/**
 * Reads one file out of the book. Chapters come back as text so they can be
 * cleaned before display; everything else stays binary.
 */
export function readEpubResource(filePath, href) {
  const entries = readZipEntries(filePath);
  const wanted = String(href || '').replace(/^\/+/, '');
  const entry = findEntry(entries, wanted);
  if (!entry) {
    const error = new Error(`"${wanted}" is not in this book.`);
    error.code = 'EPUB_RESOURCE_NOT_FOUND';
    throw error;
  }

  return {
    name: entry.name,
    data: readZipEntryData(filePath, entry),
    mimeType: mime.lookup(entry.name) || 'application/octet-stream',
  };
}

const SCRIPT_BLOCK = /<script\b[\s\S]*?<\/script\s*>/gi;
const STYLE_IMPORT = /@import\s+url\([^)]*\)\s*;?/gi;
const EVENT_ATTRIBUTE = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_ATTRIBUTE = /\s(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi;

/**
 * Chapter markup comes from an untrusted file, so scripts and inline handlers
 * are stripped before it reaches the reader. Relative links are rewritten to
 * point back at this book's resource route.
 */
export function prepareChapterHtml(html, chapterHref, resourceUrlBuilder) {
  const chapterDir = path.posix.dirname(chapterHref);

  let out = String(html || '')
    .replace(SCRIPT_BLOCK, '')
    .replace(EVENT_ATTRIBUTE, '')
    .replace(JS_URL_ATTRIBUTE, ' $1="#"')
    .replace(STYLE_IMPORT, '');

  // Rewrite src/href/xlink:href that point inside the archive.
  out = out.replace(
    /(\s(?:src|href|xlink:href|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (match, prefix, _quoted, doubleValue, singleValue) => {
      const value = doubleValue !== undefined ? doubleValue : singleValue;
      const raw = String(value || '').trim();

      if (!raw || raw.startsWith('#') || raw.startsWith('data:')
        || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        return match;
      }

      const anchorAt = raw.indexOf('#');
      const target = anchorAt === -1 ? raw : raw.slice(0, anchorAt);
      const anchor = anchorAt === -1 ? '' : raw.slice(anchorAt);
      const resolved = resolveHref(chapterDir, target);
      if (!resolved) {
        return match;
      }

      return prefix + '"' + resourceUrlBuilder(resolved) + anchor + '"';
    },
  );

  // Same rewrite for url() references inside inline styles.
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('data:') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return match;
    }
    const resolved = resolveHref(chapterDir, raw);
    return resolved ? 'url("' + resourceUrlBuilder(resolved) + '")' : match;
  });

  return out;
}

/** Stylesheets can pull in fonts and images, so their url()s need rewriting too. */
export function prepareStylesheet(css, cssHref, resourceUrlBuilder) {
  const cssDir = path.posix.dirname(cssHref);
  return String(css || '')
    .replace(STYLE_IMPORT, '')
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('data:') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        return match;
      }
      const resolved = resolveHref(cssDir, raw);
      return resolved ? 'url("' + resourceUrlBuilder(resolved) + '")' : match;
    });
}

/** Plain text of a chapter, used to size progress and to search. */
export function chapterPlainText(html) {
  return String(html || '')
    .replace(SCRIPT_BLOCK, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
