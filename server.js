const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { items } = require("./catalog.json");

const TOKEN = process.env.TMDB_READ_ACCESS_TOKEN;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const PAGE_SIZE = 40;
const cache = new Map();
const pending = new Map();

const sections = [...new Set(items.map(x => x.section))]
  .map((name, i) => ({ id: `mxcat_${i}`, name }));

const manifest = {
  id: "org.cinemexicano.videoteca500",
  version: "2.1.0",
  name: "La gran videoteca del cine mexicano 🇲🇽",
  description: "500 títulos organizados por época y figuras. Carteles y fichas enriquecidos desde TMDB cuando hay coincidencia fiable. Catálogo informativo; no contiene streams.",
  resources: ["catalog", "meta"],
  types: ["movie"],
  idPrefixes: ["mx:"],
  catalogs: sections.map(s => ({
    type: "movie", id: s.id, name: s.name, extra: [{ name: "skip", isRequired: false }]
  }))
};

function normalize(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es").replace(/[^a-z0-9]+/g, " ").trim();
}
function similarity(a, b) {
  const aa = new Set(normalize(a).split(" ").filter(Boolean));
  const bb = new Set(normalize(b).split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const t of aa) if (bb.has(t)) common++;
  return common / (aa.size + bb.size - common);
}
async function tmdb(path) {
  if (!TOKEN) throw new Error("Falta TMDB_READ_ACCESS_TOKEN en Render");
  const response = await fetch(`${TMDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, accept: "application/json" }
  });
  if (!response.ok) throw new Error(`TMDB respondió ${response.status}`);
  return response.json();
}
function bestMatch(item, results) {
  const year = Number(item.year);
  let best = null, bestScore = 0;
  for (const r of results || []) {
    const titleScore = Math.max(
      similarity(item.name, r.title),
      similarity(item.name, r.original_title)
    );
    const resultYear = Number(String(r.release_date || "").slice(0, 4));
    const yearDiff = resultYear ? Math.abs(year - resultYear) : 99;
    const country = (r.origin_country || []).includes("MX");
    const spanish = r.original_language === "es";
    const score = titleScore * 0.78 + (yearDiff === 0 ? 0.18 : yearDiff === 1 ? 0.12 : yearDiff === 2 ? 0.05 : 0) + (country ? 0.08 : 0) + (spanish ? 0.03 : 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  // Reject weak title matches and distant release years to avoid wrong posters.
  if (!best || bestScore < 0.82) return null;
  const resultYear = Number(String(best.release_date || "").slice(0, 4));
  if (resultYear && Math.abs(year - resultYear) > 2) return null;
  return { ...best, _confidence: bestScore };
}
async function lookup(item) {
  if (cache.has(item.id)) return cache.get(item.id);
  if (pending.has(item.id)) return pending.get(item.id);
  const task = (async () => {
    try {
      const q = encodeURIComponent(item.name);
      const year = Number(item.year);
      let data = await tmdb(`/search/movie?query=${q}&include_adult=false&language=es-ES&primary_release_year=${year}`);
      let match = bestMatch(item, data.results);
      if (!match) {
        data = await tmdb(`/search/movie?query=${q}&include_adult=false&language=es-ES`);
        match = bestMatch(item, data.results);
      }
      cache.set(item.id, match);
      return match;
    } catch (err) {
      console.error(`TMDB lookup falló para ${item.name}: ${err.message}`);
      return null;
    } finally {
      pending.delete(item.id);
    }
  })();
  pending.set(item.id, task);
  return task;
}
async function mapLimit(rows, limit, fn) {
  const result = new Array(rows.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= rows.length) return;
      result[i] = await fn(rows[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  return result;
}
function posterUrl(path) {
  return path ? `${IMAGE_BASE}${path}` : undefined;
}
function catalogMeta(item, match) {
  const meta = {
    id: item.id, type: "movie", name: item.name,
    releaseInfo: String(item.year),
    description: match && match.overview ? match.overview : `${item.section} · ${item.year}`
  };
  const poster = posterUrl(match && match.poster_path);
  const background = posterUrl(match && match.backdrop_path);
  if (poster) meta.poster = poster;
  if (background) meta.background = background;
  if (match && match.vote_average) meta.rating = String(match.vote_average.toFixed(1));
  return meta;
}
async function fullMeta(item) {
  const match = await lookup(item);
  const meta = catalogMeta(item, match);
  if (!match) return meta;
  try {
    const details = await tmdb(`/movie/${match.id}?language=es-ES`);
    const credits = await tmdb(`/movie/${match.id}/credits?language=es-ES`);
    if (details.overview) meta.description = details.overview;
    if (details.runtime) meta.runtime = `${details.runtime} min`;
    if (details.genres) meta.genres = details.genres.map(g => g.name);
    if (details.release_date) meta.releaseInfo = details.release_date.slice(0, 4);
    const directors = (credits.crew || []).filter(p => p.job === "Director").map(p => p.name);
    const cast = (credits.cast || []).slice(0, 12).map(p => p.name);
    if (directors.length) meta.director = directors;
    if (cast.length) meta.cast = cast;
    if (details.production_countries) meta.country = details.production_countries.map(c => c.name).join(", ");
    if (details.poster_path) meta.poster = posterUrl(details.poster_path);
    if (details.backdrop_path) meta.background = posterUrl(details.backdrop_path);
  } catch (err) {
    console.error(`No se pudieron completar detalles de ${item.name}: ${err.message}`);
  }
  return meta;
}

const builder = new addonBuilder(manifest);
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie") return { metas: [] };
  const section = sections.find(s => s.id === id);
  if (!section) return { metas: [] };
  let rows = items.filter(x => x.section === section.name);
  if (extra && extra.search) {
    const q = normalize(extra.search);
    rows = rows.filter(x => normalize(x.name).includes(q));
  }
  const unique = [...new Map(rows.map(x => [x.id, x])).values()];
  const skip = Math.max(0, Number(extra && extra.skip) || 0);
  const page = unique.slice(skip, skip + PAGE_SIZE);
  const matches = await mapLimit(page, 6, lookup);
  return { metas: page.map((item, i) => catalogMeta(item, matches[i])) };
});
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "movie") return { meta: null };
  const item = items.find(x => x.id === id);
  if (!item) return { meta: null };
  return { meta: await fullMeta(item) };
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
