import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

// Read-aloud has two halves that are worth keeping apart: turning a chapter into
// speakable sentences (pure text work, no engine involved) and getting audio for
// one of those sentences (the engine). Only the second half needs Piper.

// Abbreviations that end in a full stop without ending the sentence. Without
// these the reader stops dead in the middle of "Mr. Carden said...".
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'sr', 'jr', 'rev', 'hon', 'fr',
  'lt', 'col', 'gen', 'capt', 'sgt', 'cmdr', 'maj', 'adm', 'gov', 'pres',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
  'no', 'vol', 'ch', 'ed', 'eds', 'fig', 'pp', 'op', 'cf', 'al',
  'etc', 'inc', 'ltd', 'co', 'vs', 'approx', 'est', 'min', 'max',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
]);

const CLOSERS = '"”’\')]}';

function isAbbreviation(text, dotIndex) {
  // Walk back over the word that ends at this full stop.
  let start = dotIndex - 1;
  while (start >= 0 && /[A-Za-z.]/.test(text[start])) {
    start -= 1;
  }
  const word = text.slice(start + 1, dotIndex).toLowerCase().replace(/\.$/, '');
  if (!word) {
    return false;
  }
  if (ABBREVIATIONS.has(word)) {
    return true;
  }
  // A single initial, as in "J. R. R. Tolkien".
  return word.length === 1 && /[a-z]/.test(word);
}

/**
 * Splits text into sentences for speaking. Offsets are relative to the text
 * that was passed in, so a caller can map a sentence back onto the page.
 */
export function segmentSentences(text, options = {}) {
  const source = String(text || '');
  const minLength = Number.isFinite(options.minLength) ? options.minLength : 2;
  const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 320;
  const sentences = [];

  let start = 0;
  let index = 0;

  const push = (from, to) => {
    const raw = source.slice(from, to);
    const trimmedStart = from + (raw.length - raw.trimStart().length);
    const trimmedEnd = to - (raw.length - raw.trimEnd().length);
    const value = source.slice(trimmedStart, trimmedEnd);
    // Anything with no letters or digits is punctuation or scene decoration.
    if (value.length >= minLength && /[\p{L}\p{N}]/u.test(value)) {
      sentences.push({ start: trimmedStart, end: trimmedEnd, text: value });
    }
  };

  while (index < source.length) {
    const char = source[index];

    if (char === '.' || char === '!' || char === '?' || char === '…') {
      if (char === '.' && isAbbreviation(source, index)) {
        index += 1;
        continue;
      }

      // Take any run of terminators plus the quotes and brackets that close
      // with them, so speech keeps '"Run!" she said.' in one piece.
      let end = index + 1;
      while (end < source.length && '.!?…'.includes(source[end])) {
        end += 1;
      }
      while (end < source.length && CLOSERS.includes(source[end])) {
        end += 1;
      }

      // A terminator with no following space is usually inside a token.
      const next = source[end];
      if (next !== undefined && !/[\s]/.test(next) && !CLOSERS.includes(source[end - 1])) {
        index = end;
        continue;
      }

      // Closing a quotation does not always end the sentence: in
      // '"Run!" she cried.' the attribution belongs with the speech. A
      // continuation is recognised by the next word starting in lower case.
      const closedQuote = end > index + 1 && CLOSERS.includes(source[end - 1]);
      if (closedQuote) {
        const rest = source.slice(end);
        const continuation = /^\s+\p{Ll}/u.test(rest);
        if (continuation) {
          index = end;
          continue;
        }
      }

      push(start, end);
      start = end;
      index = end;
      continue;
    }

    // A blank line ends a sentence even without punctuation, which is how
    // headings and verse behave.
    if (char === '\n' && /^\s*\n/.test(source.slice(index))) {
      push(start, index);
      const skip = /^\s+/.exec(source.slice(index));
      start = index + (skip ? skip[0].length : 1);
      index = start;
      continue;
    }

    index += 1;
  }

  push(start, source.length);

  // A sentence longer than the engine handles comfortably is split at clause
  // boundaries, so playback stays responsive and highlighting stays useful.
  const out = [];
  for (const sentence of sentences) {
    if (sentence.text.length <= maxLength) {
      out.push(sentence);
      continue;
    }

    let cursor = 0;
    while (cursor < sentence.text.length) {
      let cut = Math.min(cursor + maxLength, sentence.text.length);
      if (cut < sentence.text.length) {
        const window = sentence.text.slice(cursor, cut);
        const breakAt = Math.max(
          window.lastIndexOf('; '), window.lastIndexOf(', '),
          window.lastIndexOf(' — '), window.lastIndexOf(' - '),
        );
        if (breakAt > maxLength * 0.4) {
          cut = cursor + breakAt + 1;
        } else {
          const space = window.lastIndexOf(' ');
          if (space > maxLength * 0.4) {
            cut = cursor + space;
          }
        }
      }

      const piece = sentence.text.slice(cursor, cut);
      const lead = piece.length - piece.trimStart().length;
      const tail = piece.length - piece.trimEnd().length;
      const value = piece.trim();
      if (value) {
        out.push({
          start: sentence.start + cursor + lead,
          end: sentence.start + cut - tail,
          text: value,
        });
      }
      cursor = cut;
    }
  }

  return out;
}

const SKIP_TAGS = /<(script|style|head|svg)\b[\s\S]*?<\/\1\s*>/gi;

/**
 * The plain text of a chapter, in the same character space the reader uses for
 * highlights and bookmarks, so a spoken sentence can be highlighted in place.
 * The reader measures offsets with Range.toString() over the rendered body,
 * which is the concatenation of its text nodes - tags contribute nothing.
 */
export function chapterSpeechText(html) {
  let text = String(html || '').replace(SKIP_TAGS, '');

  // Drop everything before <body> so the head's title text is not spoken and
  // does not shift the offsets.
  const bodyOpen = /<body\b[^>]*>/i.exec(text);
  if (bodyOpen) {
    text = text.slice(bodyOpen.index + bodyOpen[0].length);
  }
  const bodyClose = /<\/body\s*>/i.exec(text);
  if (bodyClose) {
    text = text.slice(0, bodyClose.index);
  }

  // Replacing a tag with nothing keeps offsets aligned with the rendered text.
  // The HTML parser also normalises CRLF and a lone CR to LF inside text
  // nodes, so a book with Windows line endings would otherwise drift by one
  // character per line and put every highlight in the wrong place.
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  return decodeEntities(text.replace(/<[^>]*>/g, ''))
    .split(CR + LF).join(LF)
    .split(CR).join(LF);
}

// The parser turns entities into single characters, so the offsets only line up
// with the page if the same thing happens here.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
  bull: '•', prime: '′', Prime: '″',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  copy: '©', reg: '®', trade: '™', deg: '°',
  frac12: '½', frac14: '¼', frac34: '¾',
  times: '×', divide: '÷', middot: '·', shy: '­',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', ae: 'æ', oslash: 'ø', aring: 'å',
};

export function decodeEntities(input) {
  return String(input || '').replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      // An unknown entity is left as written, which is what a parser does when
      // it cannot resolve one.
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
        ? NAMED_ENTITIES[body]
        : match;
    },
  );
}

/** Sentences of a chapter, offset into the reader's own character space. */
export function speechSentences(html) {
  return segmentSentences(chapterSpeechText(html));
}

// ---------------------------------------------------------------------------
// Piper
// ---------------------------------------------------------------------------

const VOICE_EXTENSION = '.onnx';

function executableName() {
  return process.platform === 'win32' ? 'piper.exe' : 'piper';
}

/**
 * Piper is optional: the reader falls back to the browser's own voices when it
 * is not installed. Everything lives under the app's config folder so a user
 * can drop a voice in without touching the executable.
 */
export function findPiper(baseDir) {
  const root = path.resolve(baseDir || '');
  const candidates = [
    path.join(root, executableName()),
    path.join(root, 'piper', executableName()),
    path.join(root, 'bin', executableName()),
  ];

  const binary = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;

  const voices = [];
  const voiceDirs = [root, path.join(root, 'voices'), path.join(root, 'piper')];
  for (const dir of voiceDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(VOICE_EXTENSION)) {
        continue;
      }
      const modelPath = path.join(dir, entry.name);
      // Piper needs the matching .json config beside the model.
      if (!fs.existsSync(modelPath + '.json') && !fs.existsSync(modelPath.replace(/\.onnx$/i, '.json'))) {
        continue;
      }
      if (!voices.some((voice) => voice.id === entry.name)) {
        voices.push({
          id: entry.name,
          label: voiceLabel(entry.name),
          path: modelPath,
        });
      }
    }
  }

  voices.sort((a, b) => a.label.localeCompare(b.label));
  return { binary, voices, available: Boolean(binary && voices.length > 0) };
}

function voiceLabel(fileName) {
  // en_GB-alba-medium.onnx -> "Alba (en GB, medium)"
  const stem = fileName.replace(/\.onnx$/i, '');
  const parts = stem.split('-');
  if (parts.length >= 2) {
    const locale = parts[0].replace('_', '-');
    const name = parts[1].replace(/_/g, ' ');
    const quality = parts[2] ? ', ' + parts[2] : '';
    return name.charAt(0).toUpperCase() + name.slice(1) + ' (' + locale + quality + ')';
  }
  return stem;
}

export function speechCacheKey(voiceId, rate, text) {
  return crypto.createHash('sha1')
    .update(String(voiceId) + '|' + String(rate) + '|' + String(text))
    .digest('hex');
}

/**
 * Renders one sentence to WAV. Piper writes raw audio on stdout when asked for
 * "-", so the header is added here rather than shelling out to anything else.
 */
export function synthesiseWithPiper(options) {
  const {
    binary,
    voicePath,
    text,
    lengthScale = 1,
    sentenceSilenceSec = 0.2,
    timeoutMs = 30000,
  } = options;

  return new Promise((resolve, reject) => {
    const args = [
      '--model', voicePath,
      '--output_raw',
      '--length_scale', String(lengthScale),
      '--sentence_silence', String(sentenceSilenceSec),
    ];

    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('The speech engine took too long to answer.'));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));

    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('The speech engine could not be started: ' + error.message));
      }
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const raw = Buffer.concat(chunks);
      if (code !== 0 || raw.length === 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim().split('\n').pop() || '';
        reject(new Error('The speech engine failed' + (detail ? ': ' + detail : '.')));
        return;
      }

      resolve(wavFromPcm(raw, readVoiceSampleRate(voicePath)));
    });

    child.stdin.end(String(text || '') + '\n');
  });
}

function readVoiceSampleRate(voicePath) {
  const configCandidates = [voicePath + '.json', voicePath.replace(/\.onnx$/i, '.json')];
  for (const candidate of configCandidates) {
    try {
      const config = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const rate = Number(config?.audio?.sample_rate);
      if (Number.isFinite(rate) && rate > 0) {
        return rate;
      }
    } catch {
      // Fall through to the Piper default.
    }
  }
  return 22050;
}

/** Piper emits headerless 16-bit mono PCM, so give the browser a real WAV. */
export function wavFromPcm(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export function defaultSpeechDir(configPath) {
  return path.join(path.dirname(configPath), 'speech');
}

export function tempSpeechDir() {
  return path.join(os.tmpdir(), 'mediacast-speech');
}
