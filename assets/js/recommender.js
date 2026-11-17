/* 加权分层抽样：先保证领域覆盖，再在约束内按权重抽取，并尽量错开同一来源。 */
(function (global) {
  'use strict';

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function canonicalUrl(value) {
    try {
      const url = new URL(value, location.href);
      url.hash = '';
      url.protocol = url.protocol.toLowerCase();
      url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
      if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
        url.port = '';
      }
      let path = url.pathname.replace(/\/+$/, '');
      if (!path) path = '/';
      const tracking = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|vero_id$)/i;
      const params = [...url.searchParams.entries()]
        .filter(([key]) => !tracking.test(key))
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      const query = params.length ? '?' + params.map(([key, val]) => encodeURIComponent(key) + '=' + encodeURIComponent(val)).join('&') : '';
      return url.origin + path + query;
    } catch (error) {
      return String(value || '').trim();
    }
  }

  function bigrams(text) {
    const chars = [...text];
    if (chars.length < 2) return chars;
    const out = [];
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    return out;
  }

  function titleSimilarity(a, b) {
    const left = bigrams(normalizeText(a));
    const right = bigrams(normalizeText(b));
    if (!left.length || !right.length) return 0;
    const counts = new Map();
    left.forEach((gram) => counts.set(gram, (counts.get(gram) || 0) + 1));
    let overlap = 0;
    right.forEach((gram) => {
      const count = counts.get(gram) || 0;
      if (count > 0) {
        overlap++;
        counts.set(gram, count - 1);
      }
    });
    return (2 * overlap) / (left.length + right.length);
  }

  function buildPool(articles, sources, categories, config, now) {
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const categoryMap = new Map(categories.map((category) => [category.id, category]));
    const evaluated = [];
    const rejected = [];

    for (const article of articles) {
      const source = sourceMap.get(article.source_id);
      const category = categoryMap.get(article.category);
      const result = global.Quality.evaluate(article, source, category, config, now);
      const entry = { article, source, category, quality: result };
      if (result.ok && source && category) evaluated.push(entry);
      else rejected.push({
        article,
        reasons: result.reasons,
        score: result.score,
        source,
        category
      });
    }

    evaluated.sort((a, b) => b.quality.score - a.quality.score);
    const kept = [];
    const dropped = [];

    for (const entry of evaluated) {
      const article = entry.article;
      const url = canonicalUrl(article.url);
      const title = normalizeText(article.title_original);
      let duplicate = null;

      for (const existing of kept) {
        const other = existing.article;
        if (canonicalUrl(other.url) === url) {
          duplicate = { code: 'duplicate_url', label: '同一 URL' };
          break;
        }
        if (normalizeText(other.title_original) === title) {
          duplicate = { code: 'duplicate_title', label: '同一标题' };
          break;
        }
        if (other.source_id === article.source_id && normalizeText(other.title_original) === title) {
          duplicate = { code: 'duplicate_source_title', label: '同一来源 + 标题' };
          break;
        }
        if (article.event_key && other.event_key && article.event_key === other.event_key) {
          duplicate = { code: 'duplicate_event', label: '同一事件（保留加权分最高的一条）' };
          break;
        }
        if (titleSimilarity(other.title_original, article.title_original) > 0.9) {
          duplicate = { code: 'duplicate_similar_title', label: '标题相似度超过 90%' };
          break;
        }
      }

      if (duplicate) {
        dropped.push({ article, reasons: [duplicate], score: entry.quality.score, source: entry.source });
      } else {
        kept.push(entry);
      }
    }

    return { items: kept, rejected, dropped };
  }

  function hiddenByState(item, state) {
    if (!state) return false;
    if (state.hiddenIds && state.hiddenIds.includes(item.article.id)) return true;
    if (state.hiddenEvents && state.hiddenEvents.includes(item.article.event_key)) return true;
    if (state.hiddenTags && item.article.tags.some((tag) => state.hiddenTags.includes(tag))) return true;
    return false;
  }

  function filterItems(items, options) {
    const category = options.categoryFilter || 'all';
    const tag = options.tagFilter || 'all';
    return items.filter((item) => {
      if (hiddenByState(item, options.state)) return false;
      if (category !== 'all' && item.article.category !== category) return false;
      if (tag !== 'all' && !item.article.tags.includes(tag)) return false;
      return true;
    });
  }

  function categoryCounts(items, options) {
    const counts = new Map();
    for (const item of filterItems(items, { ...options, categoryFilter: 'all', tagFilter: 'all' })) {
      counts.set(item.article.category, (counts.get(item.article.category) || 0) + 1);
    }
    return counts;
  }

  function tagCounts(items, options, categoryId) {
    const counts = new Map();
    for (const item of filterItems(items, { ...options, categoryFilter: categoryId, tagFilter: 'all' })) {
      item.article.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
    }
    return counts;
  }

  function weightedPick(candidates, weightOf) {
    let total = 0;
    const weighted = candidates.map((candidate) => {
      const weight = Math.max(0.0001, weightOf(candidate));
      total += weight;
      return { candidate, weight };
    });
    if (total <= 0) return null;
    let cursor = Math.random() * total;
    for (const entry of weighted) {
      cursor -= entry.weight;
      if (cursor <= 0) return entry.candidate;
    }
    return weighted[weighted.length - 1].candidate;
  }

  function arrangeForSources(items, maximum) {
    const runOf = (list) => {
      let run = 0;
      let previous = null;
      for (const item of list) {
        if (item.article.source_id === previous) run++;
        else {
          run = 1;
          previous = item.article.source_id;
        }
        if (run > maximum) return true;
      }
      return false;
    };

    if (!runOf(items)) return items;
    for (let attempt = 0; attempt < 240; attempt++) {
      const shuffled = items.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      if (!runOf(shuffled)) return shuffled;
    }

    const remaining = items.slice();
    const output = [];
    while (remaining.length) {
      let index = 0;
      for (let i = 0; i < remaining.length; i++) {
        const source = remaining[i].article.source_id;
        const tail = output.slice(-maximum);
        if (tail.length < maximum || !tail.every((item) => item.article.source_id === source)) {
          index = i;
          break;
        }
      }
      output.push(remaining.splice(index, 1)[0]);
    }
    return output;
  }

  function isStaleSource(source, config, now) {
    if (!source) return true;
    const snapshot = now || global.Quality.parseDate(config.snapshotDate);
    const last = global.Quality.parseDate(source.last_item_at);
    const days = global.Quality.daysBetween(last, snapshot);
    return days == null || days > config.sampling.staleSourceDays;
  }

  function sample(items, options) {
    const config = options.config;
    const batchSize = options.batchSize || config.batchSize;
    const relaxedCategory = (options.categoryFilter || 'all') !== 'all';
    const maxPerCategory = relaxedCategory ? batchSize : config.maxPerCategory;
    const maxPerTag = config.maxPerTag;
    const filtered = filterItems(items, options);
    const availableBefore = filtered.length;

    if (!filtered.length) {
      return { items: [], meta: { available: 0, categories: 0, relaxed: relaxedCategory, note: '当前筛选下没有可用内容。' } };
    }

    const readIds = new Set(options.state && options.state.readIds ? options.state.readIds : []);
    const lastBatchIds = new Set(options.state && options.state.lastBatchIds ? options.state.lastBatchIds : []);
    const selected = [];
    const usedTags = new Set();
    const categorySelected = new Map();
    const sourceSelected = new Map();
    let gradeC = 0;

    const allows = (item) => {
      if (selected.includes(item)) return false;
      const category = item.article.category;
      if ((categorySelected.get(category) || 0) >= maxPerCategory) return false;
      if (gradeC >= config.maxPerGradeC && item.source.grade === 'C') return false;
      if (item.article.tags.some((tag) => usedTags.has(tag))) return false;
      return true;
    };

    const weightOf = (item) => {
      let weight = Math.pow(Math.max(0.5, item.quality.score), config.sampling.scoreExponent);
      if (readIds.has(item.article.id)) weight *= config.sampling.readPenalty;
      if (lastBatchIds.has(item.article.id)) weight *= config.sampling.lastBatchPenalty;
      const sourceCount = sourceSelected.get(item.article.source_id) || 0;
      if (sourceCount > 0) weight *= Math.pow(config.sampling.sourceReusePenalty, sourceCount);
      if (isStaleSource(item.source, config)) weight *= config.sampling.staleSourcePenalty;
      if ((categorySelected.get(item.article.category) || 0) === 0) weight *= 1.8;
      return weight;
    };

    const add = (item) => {
      selected.push(item);
      item.article.tags.forEach((tag) => usedTags.add(tag));
      categorySelected.set(item.article.category, (categorySelected.get(item.article.category) || 0) + 1);
      sourceSelected.set(item.article.source_id, (sourceSelected.get(item.article.source_id) || 0) + 1);
      if (item.source.grade === 'C') gradeC++;
    };

    const categories = [...new Set(filtered.map((item) => item.article.category))];
    const coverageGoal = relaxedCategory
      ? 1
      : Math.min(config.minCategories, categories.length, batchSize);

    while (selected.length < coverageGoal) {
      const uncovered = categories.filter((category) => (categorySelected.get(category) || 0) === 0);
      const candidates = filtered.filter((item) => uncovered.includes(item.article.category) && allows(item));
      if (!candidates.length) break;
      const chosen = weightedPick(candidates, weightOf);
      if (!chosen) break;
      add(chosen);
    }

    let guard = 0;
    while (selected.length < batchSize && guard++ < batchSize * 40) {
      const candidates = filtered.filter(allows);
      if (!candidates.length) break;
      const chosen = weightedPick(candidates, weightOf);
      if (!chosen) break;
      add(chosen);
    }

    const arranged = arrangeForSources(selected, config.maxConsecutiveSource);
    const covered = new Set(arranged.map((item) => item.article.category)).size;
    const average = arranged.length
      ? arranged.reduce((sum, item) => sum + item.quality.score, 0) / arranged.length
      : 0;
    const notes = [];
    if (relaxedCategory) notes.push('单一领域筛选时，已放宽领域覆盖与同领域 3 条上限。');
    if (arranged.length < batchSize) {
      notes.push('受“同标签最多 1 条”等约束影响，本批可用内容不足 ' + batchSize + ' 条，未用重复内容凑数。');
    }
    if (!relaxedCategory && covered < config.minCategories) {
      notes.push('当前来源池不足以覆盖 ' + config.minCategories + ' 个领域，已展示可用内容。');
    }

    return {
      items: arranged,
      meta: {
        available: availableBefore,
        categories: covered,
        average: Math.round(average * 100) / 100,
        relaxed: relaxedCategory,
        notes,
        sourceCount: new Set(arranged.map((item) => item.article.source_id)).size
      }
    };
  }

  global.Recommender = {
    buildPool,
    sample,
    filterItems,
    categoryCounts,
    tagCounts,
    canonicalUrl,
    normalizeText,
    titleSimilarity,
    isStaleSource
  };
})(window);
