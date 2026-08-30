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

export function readZipEntries(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < EOCD_MIN) {
      throw new Error('File is too small to be a zip archive.');
    }

    const eocd = findEndOfCentralDirectory(fd, fileSize);
    if (!eocd) {
      throw new Error('No zip end-of-central-directory record found.');
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
      return zlib.inflateRawSync(raw);
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
