import path from 'path';
import { isComicArchiveFile, isImageFile, looksLikeComicsPath } from '../utils/media.js';

// Comic collections are laid out inconsistently. Observed in the wild, all within
// one library:
//   Comic/Volume 01.cbz                       archives straight in the comic folder
//   Comic/v01/chapter.zip                     a volume folder holding archives
//   Comic/Book 4/0001.jpg                     a volume folder holding loose pages
//   Comic/volume 1/chapter 03/0001.jpg        volume folder holding chapter folders
// The one thing they share: a "book" is either an archive file or a directory of
// images, and the folder above it names the volume.

const DEFAULT_VOLUME = 'Volumes';

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalize(filePath) {
  const resolved = path.resolve(filePath);
  const unified = resolved.split(path.sep).join('/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function tidyName(value) {
  return String(value || '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A "book" is one readable thing: an archive, or a directory whose own files are
 * images. Collapsing an image directory into a single entry is the whole point -
 * a 300-page chapter should be one tile, not 300.
 */
export function collectComicBooks(items) {
  const books = new Map();
  const pageDirectories = new Map();
  const pageImagePaths = new Set();

  for (const item of items) {
    const filePath = item.filePath;
    if (!filePath) {
      continue;
    }

    if (isComicArchiveFile(filePath)) {
      const key = normalize(filePath);
      books.set(key, {
        key,
        kind: 'archive',
        path: filePath,
        directory: path.dirname(filePath),
        name: tidyName(path.basename(filePath, path.extname(filePath))),
      });
      continue;
    }

    // Loose images only become comic pages inside a comics/manga tree; elsewhere
    // they are just photos.
    if (isImageFile(filePath) && looksLikeComicsPath(filePath)) {
      const directory = path.dirname(filePath);
      const key = normalize(directory);
      if (!pageDirectories.has(key)) {
        pageDirectories.set(key, { directory, pages: [] });
      }
      pageDirectories.get(key).pages.push(filePath);
      pageImagePaths.add(normalize(filePath));
    }
  }

  for (const [key, entry] of pageDirectories.entries()) {
    // A directory that also holds archives is a volume folder, not a book.
    if (books.has(key)) {
      continue;
    }
    entry.pages.sort(naturalCompare);
    books.set(key, {
      key,
      kind: 'folder',
      path: entry.directory,
      directory: path.dirname(entry.directory),
      name: tidyName(path.basename(entry.directory)),
      pages: entry.pages,
    });
  }

  return { books: [...books.values()], pageImagePaths };
}

/**
 * Media roots often have a pass-through folder above the comics themselves
 * (D:/Media/Manga/Mangaka/<comic>). Descend through directories that hold no
 * books of their own and have exactly one child, so the comic names come out
 * right instead of every comic being called "Mangaka".
 */
function findCollectionBase(root, books) {
  const bookDirs = new Set(books.map((book) => normalize(book.directory)));
  const bookPaths = new Set(books.map((book) => normalize(book.path)));

  let base = path.resolve(root);
  for (let depth = 0; depth < 6; depth += 1) {
    const baseKey = normalize(base);
    if (bookDirs.has(baseKey)) {
      break;
    }

    // Children of this directory that lead to at least one book.
    const children = new Set();
    for (const book of books) {
      const target = normalize(book.path);
      if (!target.startsWith(baseKey + '/')) {
        continue;
      }
      const rest = target.slice(baseKey.length + 1);
      const first = rest.split('/')[0];
      if (first) {
        children.add(first);
      }
    }

    if (children.size !== 1) {
      break;
    }

    const only = [...children][0];
    const candidate = path.join(base, only);
    // Stop if that single child is itself a book.
    if (bookPaths.has(normalize(candidate))) {
      break;
    }
    base = candidate;
  }

  return base;
}

/**
 * Groups books into comic -> volume -> book, mirroring show -> season -> episode
 * so the existing grouped UI renders them without special cases.
 */
export function buildComicGroups({ books, rootDirs }) {
  const roots = (rootDirs || []).map((dir) => path.resolve(dir));
  const rootBases = new Map();

  const baseFor = (book) => {
    // Longest matching media root wins, mirroring how folder pins resolve.
    let best = null;
    const target = normalize(book.path);
    for (const root of roots) {
      const key = normalize(root);
      if (target === key || target.startsWith(key + '/')) {
        if (!best || key.length > normalize(best).length) {
          best = root;
        }
      }
    }

    if (!best) {
      return path.dirname(book.directory);
    }
    if (!rootBases.has(best)) {
      rootBases.set(best, findCollectionBase(best, books.filter((candidate) => {
        const t = normalize(candidate.path);
        const k = normalize(best);
        return t === k || t.startsWith(k + '/');
      })));
    }
    return rootBases.get(best);
  };

  const groups = new Map();

  for (const book of books) {
    const base = baseFor(book);
    const baseKey = normalize(base);
    const target = normalize(book.path);

    let relative = target.startsWith(baseKey + '/')
      ? target.slice(baseKey.length + 1)
      : path.basename(book.path);
    const segments = relative.split('/').filter(Boolean);

    // First segment under the collection base names the comic. A book sitting
    // directly in the base is its own single-book comic.
    const comicSegment = segments.length > 1 ? segments[0] : null;
    const originalParts = path.resolve(book.path).split(path.sep);
    const comicName = comicSegment
      ? tidyName(originalParts[originalParts.length - segments.length])
      : book.name;

    // The folder directly above the book names the volume, unless that folder is
    // the comic folder itself.
    const parentName = tidyName(path.basename(book.directory));
    const volumeName = (segments.length > 2 && parentName && parentName !== comicName)
      ? parentName
      : DEFAULT_VOLUME;

    if (!groups.has(comicName)) {
      groups.set(comicName, new Map());
    }
    const volumes = groups.get(comicName);
    if (!volumes.has(volumeName)) {
      volumes.set(volumeName, []);
    }
    volumes.get(volumeName).push(book);
  }

  return [...groups.entries()]
    .map(([name, volumes]) => ({
      name,
      volumes: [...volumes.entries()]
        .map(([volumeName, volumeBooks]) => ({
          name: volumeName,
          books: volumeBooks.sort((a, b) => naturalCompare(a.name, b.name)),
        }))
        // A lone default volume sorts first; named volumes sort naturally.
        .sort((a, b) => {
          if (a.name === DEFAULT_VOLUME) return -1;
          if (b.name === DEFAULT_VOLUME) return 1;
          return naturalCompare(a.name, b.name);
        }),
    }))
    .sort((a, b) => naturalCompare(a.name, b.name));
}

export { naturalCompare as compareComicNames, DEFAULT_VOLUME };
