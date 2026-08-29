import https from 'https';
import path from 'path';

// In-memory cache for metadata lookups to avoid repeated API calls
const metadataCache = new Map();

// Keys come from the environment or from configureMetadataApiKeys(); they are never
// baked into the source. Without them, lookups are skipped and posters fall back to
// the local placeholder.
let tmdbApiKey = String(process.env.TMDB_API_KEY || '').trim();
let omdbApiKey = String(process.env.OMDB_API_KEY || '').trim();
let missingKeyWarningShown = false;

export function configureMetadataApiKeys(keys = {}) {
  if (keys && typeof keys === 'object') {
    if (keys.tmdbApiKey !== undefined) {
      tmdbApiKey = String(keys.tmdbApiKey || '').trim();
    }
    if (keys.omdbApiKey !== undefined) {
      omdbApiKey = String(keys.omdbApiKey || '').trim();
    }
  }

  return {
    tmdb: Boolean(tmdbApiKey),
    omdb: Boolean(omdbApiKey),
  };
}

function warnIfNoApiKeys() {
  if (missingKeyWarningShown || tmdbApiKey || omdbApiKey) {
    return;
  }

  missingKeyWarningShown = true;
  console.warn('[Metadata] No TMDB/OMDB API key configured — posters, plots and ratings will be placeholders.');
  console.warn('[Metadata] Set TMDB_API_KEY / OMDB_API_KEY, or add "tmdbApiKey" / "omdbApiKey" to cast-ui.json.');
}

export function extractMovieTitle(filename) {
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

function fetchFromTmdb(title, isSeries = false) {
  const apiKey = tmdbApiKey;
  if (!apiKey) {
    return Promise.resolve(null);
  }

  const encodedTitle = encodeURIComponent(title);
  const typePath = isSeries ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/search/${typePath}?api_key=${apiKey}&query=${encodedTitle}`;

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
                title: isSeries ? result.name : result.title,
                year: isSeries
                  ? (result.first_air_date ? result.first_air_date.split('-')[0] : null)
                  : (result.release_date ? result.release_date.split('-')[0] : null),
                posterUrl: `https://image.tmdb.org/t/p/w400${result.poster_path}`,
                plot: result.overview || null,
                rating: Number.isFinite(Number(result.vote_average)) && Number(result.vote_average) > 0
                  ? String(Math.round(Number(result.vote_average) * 10) / 10)
                  : null,
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

function fetchFromOmdb(title, isSeries = false) {
  const apiKey = omdbApiKey;
  if (!apiKey) {
    return Promise.resolve(null);
  }

  const encodedTitle = encodeURIComponent(title);
  const omdbType = isSeries ? 'series' : 'movie';
  const url = `https://www.omdbapi.com/?apikey=${apiKey}&t=${encodedTitle}&type=${omdbType}`;

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

function fetchEpisodeFromTmdb(seriesTitle, seasonNumber, episodeNumber) {
  const apiKey = tmdbApiKey;
  if (!apiKey || !Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber)) {
    return Promise.resolve(null);
  }

  const encodedTitle = encodeURIComponent(seriesTitle);
  const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${encodedTitle}`;

  return new Promise((resolve) => {
    https
      .get(searchUrl, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const show = parsed.results && parsed.results[0];
            if (!show || !show.id) {
              resolve(null);
              return;
            }

            const detailsUrl = `https://api.themoviedb.org/3/tv/${show.id}/season/${seasonNumber}/episode/${episodeNumber}?api_key=${apiKey}`;
            https
              .get(detailsUrl, (detailsRes) => {
                let detailsData = '';
                detailsRes.on('data', (chunk) => {
                  detailsData += chunk;
                });
                detailsRes.on('end', () => {
                  try {
                    const episode = JSON.parse(detailsData);
                    if (episode && episode.name) {
                      resolve({
                        title: episode.name,
                        year: episode.air_date ? episode.air_date.split('-')[0] : null,
                        posterUrl: episode.still_path ? `https://image.tmdb.org/t/p/w500${episode.still_path}` : null,
                        plot: episode.overview || null,
                        imdbRating: episode.vote_average ? String(Math.round(episode.vote_average * 10) / 10) : null,
                      });
                    } else {
                      resolve(null);
                    }
                  } catch {
                    resolve(null);
                  }
                });
              })
              .on('error', () => {
                resolve(null);
              });
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => {
        resolve(null);
      });
  });
}

function fetchEpisodeFromOmdb(seriesTitle, seasonNumber, episodeNumber) {
  const apiKey = omdbApiKey;
  if (!apiKey || !Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber)) {
    return Promise.resolve(null);
  }

  const encodedTitle = encodeURIComponent(seriesTitle);
  const url = `https://www.omdbapi.com/?apikey=${apiKey}&t=${encodedTitle}&Season=${seasonNumber}&Episode=${episodeNumber}`;

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
            if (parsed.Response === 'True') {
              resolve({
                title: parsed.Title || null,
                year: parsed.Released && parsed.Released !== 'N/A' ? String(parsed.Released).trim().slice(-4) : null,
                posterUrl: parsed.Poster && parsed.Poster !== 'N/A' ? parsed.Poster : null,
                plot: parsed.Plot && parsed.Plot !== 'N/A' ? parsed.Plot : null,
                imdbRating: parsed.imdbRating && parsed.imdbRating !== 'N/A' ? parsed.imdbRating : null,
              });
            } else {
              resolve(null);
            }
          } catch {
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

async function fetchTitleMetadata(title, isSeries = false) {
  warnIfNoApiKeys();
  const cacheKey = `${isSeries ? 'series' : 'movie'}:${title.toLowerCase()}`;

  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }

  // TMDB is preferred for poster availability, OMDB for IMDb rating and plot.
  const tmdbMetadata = await fetchFromTmdb(title, isSeries);
  const omdbMetadata = await fetchFromOmdb(title, isSeries);

  let metadata = null;
  if (tmdbMetadata || omdbMetadata) {
    metadata = {
      title: (tmdbMetadata && tmdbMetadata.title) || (omdbMetadata && omdbMetadata.title) || title,
      year: (tmdbMetadata && tmdbMetadata.year) || (omdbMetadata && omdbMetadata.year) || null,
      posterUrl: (tmdbMetadata && tmdbMetadata.posterUrl) || (omdbMetadata && omdbMetadata.posterUrl) || getPlaceholderPosterUrl(),
      plot: (omdbMetadata && omdbMetadata.plot) || (tmdbMetadata && tmdbMetadata.plot) || null,
      // OMDB gives a true IMDb score; TMDB's vote_average stands in when OMDB is unavailable.
      // ratingSource keeps the UI from labelling a TMDB score as IMDb.
      imdbRating: (omdbMetadata && omdbMetadata.imdbRating) || (tmdbMetadata && tmdbMetadata.rating) || null,
      ratingSource: (omdbMetadata && omdbMetadata.imdbRating)
        ? 'IMDb'
        : ((tmdbMetadata && tmdbMetadata.rating) ? 'TMDB' : null),
      tmdbId: tmdbMetadata ? tmdbMetadata.tmdbId : null,
      imdbId: omdbMetadata ? omdbMetadata.imdbId : null,
    };
  }

  if (!metadata) {
    // Return placeholder if no metadata found from either API
    const placeholder = {
      title,
      posterUrl: getPlaceholderPosterUrl(),
      plot: null,
      imdbRating: null,
      ratingSource: null,
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

export async function fetchMovieMetadata(movieTitle) {
  return fetchTitleMetadata(movieTitle, false);
}

export async function fetchSeriesMetadata(seriesTitle) {
  return fetchTitleMetadata(seriesTitle, true);
}

export async function fetchEpisodeMetadata(seriesTitle, seasonNumber, episodeNumber, fallbackTitle = null) {
  const cacheKey = `episode:${seriesTitle.toLowerCase()}:s${seasonNumber}:e${episodeNumber}`;
  if (metadataCache.has(cacheKey)) {
    return metadataCache.get(cacheKey);
  }

  const tmdbEpisode = await fetchEpisodeFromTmdb(seriesTitle, seasonNumber, episodeNumber);
  const omdbEpisode = await fetchEpisodeFromOmdb(seriesTitle, seasonNumber, episodeNumber);

  const metadata = {
    title: (omdbEpisode && omdbEpisode.title) || (tmdbEpisode && tmdbEpisode.title) || fallbackTitle || `Episode ${episodeNumber}`,
    year: (omdbEpisode && omdbEpisode.year) || (tmdbEpisode && tmdbEpisode.year) || null,
    posterUrl: (omdbEpisode && omdbEpisode.posterUrl) || (tmdbEpisode && tmdbEpisode.posterUrl) || null,
    plot: (omdbEpisode && omdbEpisode.plot) || (tmdbEpisode && tmdbEpisode.plot) || null,
    imdbRating: (omdbEpisode && omdbEpisode.imdbRating) || (tmdbEpisode && tmdbEpisode.imdbRating) || null,
    ratingSource: (omdbEpisode && omdbEpisode.imdbRating)
      ? 'IMDb'
      : ((tmdbEpisode && tmdbEpisode.imdbRating) ? 'TMDB' : null),
  };

  metadataCache.set(cacheKey, metadata);
  return metadata;
}

export async function fetchMetadataForLibrary(mediaItems) {
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
