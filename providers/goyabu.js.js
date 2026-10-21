// Provider Goyabu para o Nuvio
// Portado da extensão Aniyomi pt.goyabu v14.5 (Goyabu.kt + extractor do Blogger)

const BASE = 'https://goyabu.io';
// Chave v3 da API do TMDB configurada para garantir o acesso
const TMDB_API_KEY = '1f542823a8b25124b2f1530919313cb1'; 
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const SITE_HEADERS = { 'User-Agent': UA, Referer: BASE, Origin: BASE };

// ---------------------------------------------------------------------------
// Helpers de string
// ---------------------------------------------------------------------------
function after(str, delim, missing) {
  const i = str.indexOf(delim);
  return i === -1 ? (missing === undefined ? '' : missing) : str.slice(i + delim.length);
}

function before(str, delim) {
  const i = str.indexOf(delim);
  return i === -1 ? str : str.slice(0, i);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Base64 -> string (compatível com Hermes/React Native)
function base64Decode(input) {
  let s = String(input).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  let out = '';
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(escape(out));
  } catch (e) {
    return out;
  }
}

// "encrypted" do Goyabu = Base64 + string invertida
function decodeBloggerUrl(attr) {
  return base64Decode(attr).split('').reverse().join('');
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter++;
  });
  return inter / (ta.size + tb.size - inter);
}

async function getText(url, headers) {
  const res = await fetch(url, { headers: headers || SITE_HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.text();
}

// ---------------------------------------------------------------------------
// TMDB -> Títulos candidatos
// ---------------------------------------------------------------------------
async function getTmdbTitles(tmdbId, mediaType) {
  const kind = mediaType === 'movie' ? 'movie' : 'tv';
  const titles = [];
  for (const lang of ['pt-BR', 'en-US']) {
    try {
      const url =
        'https://api.themoviedb.org/3/' + kind + '/' + tmdbId + '?api_key=' + TMDB_API_KEY + '&language=' + lang;
      const j = JSON.parse(await getText(url, { 'User-Agent': UA }));
      [j.name, j.title, j.original_name, j.original_title].forEach((t) => {
        if (t && titles.indexOf(t) === -1) titles.push(t);
      });
    } catch (e) {
      /* ignora falhas pontuais */
    }
  }
  return titles;
}

// ---------------------------------------------------------------------------
// Busca no site: GET /?s=<query>
// ---------------------------------------------------------------------------
function parseSearchResults(html) {
  const results = [];
  const re = /<article[^>]*class="[^"]*boxAN[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const href = (/<a[^>]*href="([^"]+)"/.exec(block) || [])[1];
    const title = (/<div[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block) || [])[1];
    if (href && title) {
      results.push({
        url: href.indexOf('http') === 0 ? href : BASE + href,
        title: title.replace(/<[^>]+>/g, '').trim(),
      });
    }
  }
  return results;
}

async function findAnimePage(titles, season) {
  let best = null;
  for (const title of titles) {
    const queries = season && season > 1 ? [title + ' ' + season, title] : [title];
    for (const q of queries) {
      let html;
      try {
        html = await getText(BASE + '/?s=' + encodeURIComponent(q));
      } catch (e) {
        continue;
      }
      for (const r of parseSearchResults(html)) {
        const score = similarity(title, r.title);
        if (!best || score > best.score) best = { score, url: r.url, title: r.title };
      }
      if (best && best.score >= 0.99) return best;
    }
  }
  return best && best.score >= 0.5 ? best : null;
}

// ---------------------------------------------------------------------------
// Lista de episódios
// ---------------------------------------------------------------------------
function parseAllEpisodes(html) {
  const idx = html.indexOf('const allEpisodes');
  if (idx === -1) return [];
  let rest = html.slice(idx + 'const allEpisodes'.length).replace(/^\s+/, '');
  if (rest[0] !== '=') return [];
  const json = before(rest.slice(1), ';').trim();
  if (!json) return [];
  try {
    return JSON.parse(json).reverse();
  } catch (e) {
    return [];
  }
}

function episodeUrlOf(ep) {
  const keys = ['url', 'link', 'href', 'permalink', 'slug'];
  for (const k of keys) {
    if (typeof ep[k] === 'string' && ep[k]) {
      const v = ep[k];
      if (v.indexOf('http') === 0) return v;
      return BASE + (v[0] === '/' ? '' : '/') + v;
    }
  }
  return null;
}

function episodeNumberOf(ep) {
  const keys = ['episodio', 'episode', 'numero', 'number', 'num', 'ep'];
  for (const k of keys) {
    const n = parseInt(ep[k], 10);
    if (!isNaN(n)) return n;
  }
  const txt = String(ep.title || ep.name || ep.titulo || '');
  const m = /(\d+)/.exec(txt);
  return m ? parseInt(m[1], 10) : null;
}

function pickEpisode(list, wanted) {
  const byNumber = list.filter((ep) => episodeNumberOf(ep) === wanted)[0];
  if (byNumber) return byNumber;
  return list[wanted - 1] || null;
}

// ---------------------------------------------------------------------------
// Extractor do Blogger
// ---------------------------------------------------------------------------
function qualityFromFormat(id) {
  const m = /^\s*(\d+)/.exec(String(id));
  switch (m ? m[1] : '') {
    case '7':
      return '240p';
    case '18':
      return '360p';
    case '22':
      return '720p';
    case '37':
      return '1080p';
    default:
      return 'Unknown';
  }
}

function parsePageStreams(body) {
  if (body.indexOf('errorContainer') !== -1) return [];
  const section = before(after(body, '"streams":[', ''), ']');
  const out = [];
  section.split('},').forEach((part) => {
    if (part.indexOf('"play_url":"') === -1) return;
    let url = before(after(part, '"play_url":"'), '"');
    if (!url.trim()) return;
    url = url.replace(/\\u0026/g, '&').replace(/\\u003d/g, '=').replace(/\\\//g, '/');
    const fmt = before(after(part, '"format_id":'), '}');
    out.push({ url, quality: qualityFromFormat(fmt) });
  });
  return out;
}

function jsonUnescapeTwice(s) {
  try {
    const once = JSON.parse('"' + s + '"');
    return JSON.parse('"' + once + '"');
  } catch (e) {
    return null;
  }
}

async function fetchBatchExecute(videoUrl, body) {
  const tokenMatch = /[?&]token=([^&#]*)/.exec(videoUrl);
  const token = tokenMatch ? tokenMatch[1] : '';
  if (!token.trim()) return [];

  const sid = before(after(body, 'FdrFJe":"'), '"');
  const bl = before(after(body, 'cfb2h":"'), '"');
  const reqid = String(Math.floor(Date.now() / 1000) % 86400);

  const endpoint =
    'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute' +
    '?rpcids=WcwnYd&source-path=%2Fvideo.g' +
    '&f.sid=' + encodeURIComponent(sid) +
    '&bl=' + encodeURIComponent(bl) +
    '&hl=en-US&_reqid=' + reqid + '&rt=c';

  const reqBody =
    'f.req=%5B%5B%5B%22WcwnYd%22%2C%22%5B%5C%22' + token + '%5C%22%2C%5C%22%5C%22%2C0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      priority: 'u=1, i',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'User-Agent': UA,
      'x-same-domain': '1',
      Referer: 'https://www.blogger.com/',
    },
    body: reqBody,
  });
  if (!res.ok) return [];
  const text = await res.text();
  if (text.indexOf('https://') === -1) return [];

  const BQ = '\\"';
  const inner = before(after(text, '[[' + BQ, ''), ']]]');
  const parts = (BQ + inner + ']').split('],[');
  const out = [];
  parts.forEach((part) => {
    const raw = before(after(part, BQ, ''), BQ);
    if (!raw.trim()) return;
    const url = jsonUnescapeTwice(raw);
    if (!url) return;
    const fmt = before(after(part, '[', part), ']');
    out.push({ url, quality: qualityFromFormat(fmt) });
  });
  return out;
}

async function extractBlogger(videoUrl) {
  if (videoUrl.indexOf('blogger.com') === -1) return [];
  const body = await getText(videoUrl, SITE_HEADERS);
  const direct = parsePageStreams(body);
  if (direct.length) return direct;
  return fetchBatchExecute(videoUrl, body);
}

// ---------------------------------------------------------------------------
// Página do episódio
// ---------------------------------------------------------------------------
async function getEpisodeVideos(episodeUrl) {
  const html = await getText(episodeUrl);
  const re = /data-blogger-url-encrypted\s*=\s*["']([^"']+)["']/g;
  const encrypted = [];
  let m;
  while ((m = re.exec(html))) encrypted.push(m[1]);

  const lists = await Promise.all(
    encrypted.map((enc) =>
      extractBlogger(decodeBloggerUrl(enc)).catch(() => [])
    )
  );
  return [].concat.apply([], lists);
}

// ---------------------------------------------------------------------------
// Ponto de entrada do Nuvio
// ---------------------------------------------------------------------------
async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const titles = await getTmdbTitles(tmdbId, mediaType);
    if (!titles.length) return [];

    const anime = await findAnimePage(titles, mediaType === 'movie' ? 1 : season);
    if (!anime) return [];

    const animeHtml = await getText(anime.url);
    const episodes = parseAllEpisodes(animeHtml);
    const wanted = mediaType === 'movie' ? 1 : episode;
    const ep = pickEpisode(episodes, wanted);
    if (!ep) return [];

    const epUrl = episodeUrlOf(ep);
    if (!epUrl) return [];

    const videos = await getEpisodeVideos(epUrl);
    const seen = {};
    const streams = [];
    videos.forEach((v) => {
      if (seen[v.url]) return;
      seen[v.url] = true;
      streams.push({
        name: 'Goyabu',
        title: 'Blogger - ' + v.quality + ' (' + anime.title + ')',
        url: v.url,
        quality: v.quality,
        headers: { 'User-Agent': UA },
      });
    });

    const rank = (q) => parseInt(q, 10) || 0;
    streams.sort((a, b) => rank(b.quality) - rank(a.quality));
    return streams;
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams };

module.exports._internal = {
  decodeBloggerUrl,
  parsePageStreams,
  jsonUnescapeTwice,
  parseAllEpisodes,
  parseSearchResults,
  qualityFromFormat,
};