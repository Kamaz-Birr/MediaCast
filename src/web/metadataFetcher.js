const https = require('https');
const path = require('path');

// In-memory cache for metadata lookups to avoid repeated API calls
const metadataCache = new Map();

function extractMovieTitle(filename) {
  const baseName = path.basename(filename, path.extname(filename));
  // Remove common patterns like year (2020), quality (1080p, BluRay, etc.)
  const cleaned = baseName
    .replace(/[._]+/g, ' ') // Convert dot/underscore separated names to words
    .replace(/\s*\(\d{4}\)\s*/g, '') // Remove (YYYY)
    .replace(/\s*\[\d{4}\]\s*/g, '') // Remove [YYYY]
    .replace(/\b(19|20)\d{2}\b/g, '') // Remove plain standalone year tokens
    .replace(/\b(S\d{1,2}E\d{1,2}|E\d{1,2})\b/gi, '') // Remove episode tokens
    .replace(/\s*(1080p|720p|480p|2160p|4K|UHD|HDTV|BluRay|DVDRip|WEB-DL|x264|x265|H.264|H.265)\s*/gi, '') // Remove quality
    .replace(/\s*(AC3|AAC|MP3|DTS|FLAC|TrueHD)\s*/gi, '') // Remove audio codecs
    .replace(/\b(EXTENDED|REMASTERED|DIRECTORS CUT|UNRATED|PROPER|REPACK)\b/gi, '') // Remove common release tags
    .replace(/\s*-\s*\[.*?\]\s*/g, '') // Remove group tags like [GROUP]
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  return cleaned;
}

function fetchFromTmdb(movieTitle) {
  const apiKey = process.env.TMDB_API_KEY || 'REDACTED_TMDB_KEY';
  if (!apiKey) {
    return Promise.resolve(null);
  }

  const encodedTitle = encodeURIComponent(movieTitle);
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${encodedTitle}`;

  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const result = parsed.results && parsed.results[0];
            if (result && result.poster_path) {
              resolve({
                title: result.title,
                year: result.release_date ? result.release_date.split('-')[0] : null,
                posterUrl: `https://image.tmdb.org/t/p/w400${result.poster_path}`,
                plot: result.overview || null,
                imdbRating: null,
                tmdbId: result.id,
              });
            } else {
              resolve(null);
            }
          } catch (err) {
            resolve(null);
          }
        });
      })
      .on('error', () => {
        resolve(null);
      });
  });
}

function fetchFromOmdb(movieTitle) {
  const apiKey = process.env.OMDB_API_KEY || 'REDACTED_OMDB_KEY';
  if (!apiKey) {
    return Promise.resolve(null);
  }

  const encodedTitle = encodeURIComponent(movieTitle);
  const url = `https://www.omdbapi.com/?apikey=${apiKey}&t=${encodedTitle}&type=movie`;

  return new Promise((resolve) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.Response === 'True' && parsed.Poster !== 'N/A') {
              resolve({
                title: parsed.Title,
                year: parsed.Year,
                posterUrl: parsed.Poster,
                plot: parsed.Plot && parsed.Plot !== 'N/A' ? parsed.Plot : null,
                imdbRating: parsed.imdbRating && parsed.imdbRating !== 'N/A' ? parsed.imdbRating : null,
                imdbId: parsed.imdbID,
              });
            } else {
              resolve(null);
            }
          } catch (err) {
            resolve(null);
          }
        });
      })
      .on('error', () => {
        resolve(null);
      });
  });
}

function getPlaceholderPosterUrl() {
  // Return a data URI for a placeholder poster image (100x150 gradient)
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 450%22%3E%3Cdefs%3E%3ClinearGradient id=%22grad%22 x1=%220%25%22 y1=%220%25%22 x2=%22100%25%22 y2=%22100%25%22%3E%3Cstop offset=%220%25%22 style=%22stop-color:%238B7355;stop-opacity:1%22 /%3E%3Cstop offset=%22100%25%22 style=%22stop-color:%23D2B48C;stop-opacity:1%22 /%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=%22300%22 height=%22450%22 fill=%22url(%23grad)%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 font-size=%2224%22 fill=%22%23fff%22 font-family=%22Arial%22%3E[No Poster]%3C/text%3E%3C/svg%3E';
}

async function fetchMovieMetadata(movieTitle) {
  const cacheKey = movieTitle.toLowerCase();

  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }

  // TMDB is preferred for poster availability, OMDB for IMDb rating and plot.
  const tmdbMetadata = await fetchFromTmdb(movieTitle);
  const omdbMetadata = await fetchFromOmdb(movieTitle);

  let metadata = null;
  if (tmdbMetadata || omdbMetadata) {
    metadata = {
      title: (tmdbMetadata && tmdbMetadata.title) || (omdbMetadata && omdbMetadata.title) || movieTitle,
      year: (tmdbMetadata && tmdbMetadata.year) || (omdbMetadata && omdbMetadata.year) || null,
      posterUrl: (tmdbMetadata && tmdbMetadata.posterUrl) || (omdbMetadata && omdbMetadata.posterUrl) || getPlaceholderPosterUrl(),
      plot: (omdbMetadata && omdbMetadata.plot) || (tmdbMetadata && tmdbMetadata.plot) || null,
      imdbRating: (omdbMetadata && omdbMetadata.imdbRating) || null,
      tmdbId: tmdbMetadata ? tmdbMetadata.tmdbId : null,
      imdbId: omdbMetadata ? omdbMetadata.imdbId : null,
    };
  }

  if (!metadata) {
    // Return placeholder if no metadata found from either API
    const placeholder = {
      title: movieTitle,
      posterUrl: getPlaceholderPosterUrl(),
      plot: null,
      imdbRating: null,
      year: null,
      tmdbId: null,
      imdbId: null,
    };
    metadataCache.set(cacheKey, placeholder);
    return placeholder;
  }

  metadataCache.set(cacheKey, metadata);
  return metadata;
}

async function fetchMetadataForLibrary(mediaItems) {
  const results = [];

  for (const item of mediaItems) {
    const title = extractMovieTitle(item.name);
    const metadata = await fetchMovieMetadata(title);
    results.push({
      ...item,
      movieTitle: title,
      metadata,
    });
  }

  return results;
}

module.exports = {
  fetchMovieMetadata,
  fetchMetadataForLibrary,
  extractMovieTitle,
};
