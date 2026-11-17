'use strict';

const { config: coreConfig, Quality } = require('./core');
const { clamp, countWords, countSentences, normalizeSpace } = require('./util');

function routeFor(source, item, routing, categories) {
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const text = [
    item.title,
    item.summary_text,
    item.content_text,
    (item.categories || []).join(' ')
  ].join(' ').toLowerCase();
  let matched = null;
  for (const route of (routing && routing.routes) || []) {
    if (!route.pattern) continue;
    let regex;
    try {
      regex = new RegExp(route.pattern, 'i');
    } catch (error) {
      continue;
    }
    if (regex.test(text)) {
      matched = route;
      break;
    }
  }
  const fallback = routing || {};
  const categoryId = (matched && matched.category) || fallback.category;
  const category = categoryMap.get(categoryId);
  if (!category) return { category: null, tags: [], language: fallback.language || 'en', matched: Boolean(matched) };

  const candidates = [];
  if (matched && Array.isArray(matched.tags)) candidates.push(...matched.tags);
  if (Array.isArray(fallback.tags)) candidates.push(...fallback.tags);
  const valid = [...new Set(candidates)].filter((tag) => category.tags.includes(tag));
  for (const feedCategory of item.categories || []) {
    if (category.tags.includes(feedCategory)) valid.push(feedCategory);
  }
  return {
    category,
    tags: [...new Set(valid.length ? valid : [category.tags[0]])].slice(0, 2),
    language: (matched && matched.language) || fallback.language || 'en',
    matched: Boolean(matched),
    routePattern: matched ? matched.pattern : ''
  };
}

function qualitySignals(text, language, route) {
  const value = normalizeSpace(text);
  const bodyWords = countWords(value, language);
  const latin = value.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
  const unique = new Set(latin.map((token) => token.toLowerCase())).size;
  const lexicalRatio = latin.length ? unique / latin.length : 0;
  const infoRatio = Number(clamp(lexicalRatio * 1.35, 0.15, 0.92).toFixed(2));
  const numbers = (value.match(/\b\d[\d,.%]*\b/g) || []).length;
  const links = (value.match(/https?:\/\//g) || []).length;
  const quotes = (value.match(/[“”"「」『』]/g) || []).length;
  const paragraphs = value.split(/\n{2,}/).filter(Boolean).length;
  const sentences = countSentences(value);
  const density = Number(clamp(1 + Math.min(2, numbers / 4) + Math.min(1, paragraphs / 3) + (sentences > 3 ? 1 : 0), 1, 5).toFixed(2));
  const fact = Number(clamp(2 + (numbers ? 1 : 0) + (links ? 0.5 : 0) + (quotes ? 0.5 : 0) + (sentences >= 3 ? 0.5 : 0), 2, 5).toFixed(2));
  const representative = Number(clamp((route && route.matched ? 4 : 3) + ((route && route.tags.length > 1) ? 0.5 : 0), 1, 5).toFixed(2));
  return {
    body_words: bodyWords,
    info_ratio: infoRatio,
    density_score: density,
    fact_score: fact,
    representativeness: representative,
    lexical_ratio: Number(lexicalRatio.toFixed(3)),
    sentence_count: sentences
  };
}

function preScreen(article, source, category, config, now) {
  const quality = config.quality;
  const reasons = [];
  const reject = (code) => {
    if (!reasons.some((item) => item.code === code)) reasons.push({ code, label: Quality.REASON[code] || code });
  };
  if (article.takedown && article.takedown.status === 'removed') reject('taken_down');
  if (!source || source.status !== 'active') reject('source_inactive');
  if (!source || !source.license_basis) reject('license_missing');
  if (source && source.grade === 'D') reject('grade_d');
  if (source && source.translation_allowed !== true) reject('translation_forbidden');

  const minimum = article.language === 'zh' ? 200 : quality.minBodyWords;
  if (!article.body_words || article.body_words < minimum) reject('too_short');
  if (Number(article.info_ratio) < quality.minInfoRatio) reject('low_info_ratio');
  if (Number(article.density_score) < quality.minDensityScore) reject('low_density');
  if (Quality.clickbaitHit(article, quality)) reject('clickbait');

  const published = Quality.parseDate(article.published_at);
  const snapshot = now || Quality.parseDate(config.snapshotDate);
  const ageDays = Quality.daysBetween(published, snapshot);
  if (category && category.max_age_days != null && ageDays != null && ageDays > category.max_age_days) {
    reject('stale');
  }
  const weights = Quality.weightsFor(article.category, quality);
  const parts = {
    source: (quality.sourceGradeScores[source && source.grade] || 0),
    density: Number(article.density_score) || 0,
    fact: Number(article.fact_score) || 0,
    freshness: Quality.freshnessScore(ageDays, quality.freshnessBands),
    representative: Number(article.representativeness) || 0
  };
  const score = Math.round(Quality.weightedScore(parts, weights) * 100) / 100;
  if (score < quality.threshold) reject('below_threshold');
  return {
    ok: reasons.length === 0,
    reasons,
    score,
    parts,
    weights,
    ageDays,
    summaryLimit: Quality.summaryLimit(article, quality)
  };
}

function finalScreen(article, source, category, config, now) {
  return Quality.evaluate(article, source, category, config, now);
}

module.exports = {
  coreConfig,
  finalScreen,
  preScreen,
  qualitySignals,
  routeFor
};
