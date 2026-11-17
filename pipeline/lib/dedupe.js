'use strict';

const { config, Recommender } = require('./core');

const MASK64 = (1n << 64n) - 1n;

function canonicalUrl(value) {
  return Recommender.canonicalUrl(value);
}

function normalizeTitle(value) {
  return Recommender.normalizeText(value);
}

function tokenize(text) {
  const value = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ');
  const tokens = [];
  const latin = value.match(/[a-z][a-z0-9'’\-]*/g) || [];
  for (const word of latin) {
    if (word.length >= 3) tokens.push(word);
  }
  const cjkRuns = value.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    const chars = [...run];
    if (chars.length === 1) tokens.push(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function fnv1a64(token) {
  let hash = 0xcbf29ce484222325n;
  for (const char of String(token)) {
    hash ^= BigInt(char.codePointAt(0));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

function simhash(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  const counts = new Map();
  tokens.forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  const vector = new Array(64).fill(0);
  for (const [token, count] of counts) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit++) {
      vector[bit] += ((hash >> BigInt(bit)) & 1n) === 1n ? count : -count;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (vector[bit] > 0) hash |= (1n << BigInt(bit));
  }
  return hash;
}

function hamming(a, b) {
  let value = (a ^ b) & MASK64;
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function hashHex(hash) {
  return hash == null ? '' : hash.toString(16).padStart(16, '0');
}

function articleFingerprint(article) {
  if (!article) return { guid: '', url: '', title: '', sourceTitle: '' };
  return {
    guid: String(article.guid || article.content_id || '').trim(),
    url: canonicalUrl(article.url),
    title: normalizeTitle(article.title_original),
    sourceTitle: String(article.source_id || '') + '|' + normalizeTitle(article.title_original)
  };
}

function createIndex(articles, fuzzyConfig) {
  const fuzzy = { ...((fuzzyConfig || config.dedupe || {}).fuzzy || {}) };
  const index = {
    guids: new Set(),
    urls: new Set(),
    titles: new Set(),
    sourceTitles: new Set(),
    entries: [],
    fuzzy
  };
  for (const article of articles || []) addToIndex(index, article);
  return index;
}

function addToIndex(index, article, bodyText) {
  const fingerprint = articleFingerprint(article);
  if (fingerprint.guid) index.guids.add(fingerprint.guid);
  if (fingerprint.url) index.urls.add(fingerprint.url);
  if (fingerprint.title) index.titles.add(fingerprint.title);
  if (fingerprint.sourceTitle) index.sourceTitles.add(fingerprint.sourceTitle);
  const body = String(bodyText || '').trim();
  const hash = body ? simhash(body) : null;
  index.entries.push({
    article,
    fingerprint,
    simhash: hash
  });
  return index;
}

function evaluateCandidate(candidate, index) {
  const fingerprint = articleFingerprint(candidate);
  if (fingerprint.guid && index.guids.has(fingerprint.guid)) {
    return { duplicate: { code: 'exact_guid', label: 'guid/id 完全一致' }, suspect: null };
  }
  if (fingerprint.url && index.urls.has(fingerprint.url)) {
    return { duplicate: { code: 'exact_url', label: '规范化 URL 完全一致' }, suspect: null };
  }
  if (fingerprint.title && index.titles.has(fingerprint.title)) {
    return { duplicate: { code: 'exact_title', label: '标题完全一致' }, suspect: null };
  }
  if (fingerprint.sourceTitle && index.sourceTitles.has(fingerprint.sourceTitle)) {
    return { duplicate: { code: 'exact_source_title', label: '同一来源 + 标题完全一致' }, suspect: null };
  }

  const fuzzy = index.fuzzy || {};
  if (!fuzzy.enabled || !candidate._body_text) return { duplicate: null, suspect: null };
  const hash = simhash(candidate._body_text);
  if (!hash) return { duplicate: null, suspect: null };
  if ((tokenize(candidate._body_text).length || 0) < (fuzzy.min_tokens || 20)) {
    return { duplicate: null, suspect: null };
  }

  let closest = null;
  for (const entry of index.entries) {
    if (!entry.simhash) continue;
    const distance = hamming(hash, entry.simhash);
    if (!closest || distance < closest.distance) {
      closest = { distance, entry, hash };
    }
  }
  if (!closest) return { duplicate: null, suspect: null };
  if (closest.distance <= fuzzy.max_distance) {
    return {
      duplicate: {
        code: 'fuzzy_body',
        label: '正文 SimHash 汉明距离 ' + closest.distance + ' ≤ ' + fuzzy.max_distance
      },
      suspect: null,
      distance: closest.distance
    };
  }
  const suspectMax = fuzzy.suspect_max_distance == null ? fuzzy.max_distance + 2 : fuzzy.suspect_max_distance;
  const suspectMin = fuzzy.suspect_min_distance == null ? fuzzy.max_distance + 1 : fuzzy.suspect_min_distance;
  if (closest.distance >= suspectMin && closest.distance <= suspectMax) {
    return {
      duplicate: null,
      suspect: {
        code: 'fuzzy_suspect',
        label: '正文 SimHash 距离 ' + closest.distance + '，位于临界区，保留人工抽检',
        distance: closest.distance
      }
    };
  }
  return { duplicate: null, suspect: null };
}

module.exports = {
  addToIndex,
  articleFingerprint,
  canonicalUrl,
  createIndex,
  evaluateCandidate,
  hamming,
  hashHex,
  normalizeTitle,
  simhash,
  tokenize
};
