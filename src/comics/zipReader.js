import fs from 'fs';
import zlib from 'zlib';

// Minimal ZIP reader, enough for comic archives. Reading the central directory
// and inflating single entries on demand avoids pulling a whole 400MB CBZ into
// memory just to show one page, and avoids a dependency for a format this simple.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const MAX_COMMENT = 65535;
const EOCD_MIN = 22;

function readChunk(fd, position, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : buffer.subarray(0, read);
}

function findEndOfCentralDirectory(fd, fileSize) {
  const scanLength = Math.min(fileSize, EOCD_MIN + MAX_COMMENT);
  const start = fileSize - scanLength;
  const tail = readChunk(fd, start, scanLength);

  for (let offset = tail.length - EOCD_MIN; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === SIG_EOCD) {
      return {
        entryCount: tail.readUInt16LE(offset + 10),
        directorySize: tail.readUInt32LE(offset + 12),
        directoryOffset: tail.readUInt32LE(offset + 16),
        eocdOffset: start + offset,
        tail,
        tailStart: start,
        tailOffset: offset,
      };
    }
  }

  return null;
}

/**
 * Recovers entries by scanning for local file headers. Needed for archives whose
 * central directory is missing entirely - a truncated download still holds
 * perfectly readable pages up to the cut, and showing those beats showing none.
 */
function scanLocalHeaders(fd, fileSize) {
  const CHUNK = 1024 * 1024;
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const offsets = [];

  let position = 0;
  let carry = Buffer.alloc(0);
  while (position < fileSize) {
    const chunk = readChunk(fd, position, Math.min(CHUNK, fileSize - position));
    if (chunk.length === 0) {
      break;
    }
    const haystack = Buffer.concat([carry, chunk]);
    const base = position - carry.length;

    let at = haystack.indexOf(signature);
    while (at !== -1) {
      offsets.push(base + at);
      at = haystack.indexOf(signature, at + 1);
    }

    carry = haystack.subarray(Math.max(0, haystack.length - 3));
    position += chunk.length;
  }

  const entries = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const localOffset = offsets[index];
    const header = readChunk(fd, localOffset, 30);
    if (header.length < 30) {
      continue;
    }

    const flags = header.readUInt16LE(6);
    const method = header.readUInt16LE(8);
    let compressedSize = header.readUInt32LE(18);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const name = readChunk(fd, localOffset + 30, nameLength).toString('utf8');

    // With a data descriptor the size is only known after the payload, so fall
    // back to the gap before the next header.
    if ((flags & 0x08) !== 0 || compressedSize === 0) {
      const next = index + 1 < offsets.length ? offsets[index + 1] : fileSize;
      compressedSize = Math.max(0, next - (localOffset + 30 + nameLength + extraLength));
    }

    if (name && !name.endsWith('/')) {
      entries.push({ name, method, compressedSize, uncompressedSize: 0, localOffset });
    }
  }

  return entries;
}

export function readZipEntries(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < EOCD_MIN) {
      throw new Error('File is too small to be a zip archive.');
    }

    const eocd = findEndOfCentralDirectory(fd, fileSize);
    if (!eocd) {
      const recovered = scanLocalHeaders(fd, fileSize);
      if (recovered.length > 0) {
        console.warn(`[Zip] ${filePath}: no central directory; recovered ${recovered.length} entr${recovered.length === 1 ? 'y' : 'ies'} by scanning.`);
        return recovered;
      }
      throw new Error('This archive is damaged: no zip directory could be read.');
    }

    // Zip64 uses sentinel values in the classic record. Comic archives are far
    // below the 4GB limit, so report it rather than silently mis-reading.
    if (eocd.directoryOffset === 0xffffffff || eocd.entryCount === 0xffff) {
      const locatorAt = eocd.tailOffset - 20;
      if (locatorAt >= 0 && eocd.tail.readUInt32LE(locatorAt) === SIG_EOCD64_LOCATOR) {
        throw new Error('Zip64 archives are not supported.');
      }
    }

    const directory = readChunk(fd, eocd.directoryOffset, eocd.directorySize);
    const entries = [];
    let cursor = 0;

    while (cursor + 46 <= directory.length) {
      if (directory.readUInt32LE(cursor) !== SIG_CENTRAL) {
        break;
      }

      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

export function readZipEntryData(filePath, entry) {
  const fd = fs.openSync(filePath, 'r');
  try {
    // The central directory's name/extra lengths can disagree with the local
    // header's, so always re-read the local header to find the data offset.
    const localHeader = readChunk(fd, entry.localOffset, 30);
    if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`Bad local header for "${entry.name}".`);
    }

    const nameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const raw = readChunk(fd, dataOffset, entry.compressedSize);

    if (entry.method === METHOD_STORE) {
      return raw;
    }
    if (entry.method === METHOD_DEFLATE) {
      try {
        return zlib.inflateRawSync(raw);
      } catch (error) {
        // A recovered entry can run past the end of a truncated file; salvage
        // whatever decompressed cleanly.
        const partial = zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        if (partial && partial.length > 0) {
          return partial;
        }
        throw error;
      }
    }

    throw new Error(`Unsupported zip compression method ${entry.method} for "${entry.name}".`);
  } finally {
    fs.closeSync(fd);
  }
}

export function looksLikeZip(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const magic = readChunk(fd, 0, 4);
    // "PK\x03\x04", or an empty/spanned archive marker.
    return magic.length === 4
      && magic[0] === 0x50 && magic[1] === 0x4b
      && (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07);
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
