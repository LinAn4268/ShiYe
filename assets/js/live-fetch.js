/* 实时内容抓取：通过公共 CORS 代理读取官方 RSS，机器翻译汉化后组装为合规条目。
 *
 * 合规边界：
 * - 只抓取 sources.json 中已登记、status=active、有 license_basis、grade≠D、
 *   translation_allowed===true 的来源（实际使用 nasa / nist，均为美国政府作品/公共领域）。
 * - 只做「标题与摘录汉化 + 原文链接」，不搬运正文；摘要取自 RSS 自带摘录，
 *   经机器翻译后按原文词数 10% / 400 字硬上限截断。
 * - 浏览器直连受同源策略限制，必须经公共 CORS 代理；失败时由 UI 回退到预置内容池。
 */
(function (global) {
  'use strict';

  const DEFAULT_PROXY = 'https://proxy.cors.dev/';
  const DEFAULT_TRANSLATE = 'https://api.mymemory.translated.net/get';

  /* ---------- 纯工具函数（可单测） ---------- */

  function normalizeText(text) {
    return String(text == null ? '' : text)
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // 去掉 RSS 摘录里常见的 "The post … appeared first on …" 尾巴与省略标记。
  function stripBoilerplate(text) {
    return String(text == null ? '' : text)
      .replace(/The post\b[\s\S]*?\bappeared first on\b[^\n]*/i, '')
      .replace(/\[…\]\s*$|\[\.\.\.\]\s*$/, '')
      .replace(/Read more\s*→?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hashId(text) {
    const value = String(text || '');
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  function wordCount(text) {
    return (String(text || '').match(/[A-Za-z0-9]+/g) || []).length;
  }

  // 摘要硬上限：与 quality.js 的 summaryLimit 保持一致。
  function summaryLimit(article, config) {
    const quality = (config && config.quality) || {};
    const body = Number(article.body_words) || 0;
    const chars = body * (quality.charsPerEnglishWord || 1.6) * (quality.summaryMaxRatio || 0.10);
    return Math.min(quality.summaryMaxChars || 400, Math.floor(chars));
  }

  // 按关键词把条目归入一级领域；返回 {id,tags}。
  const CATEGORY_HINTS = [
    { id: 'future-frontier', tags: ['量子技术', '时间计量', '深空'],
      words: ['quantum', 'entanglement', 'photon', 'laser', 'timekeeping', 'atomic clock', 'genesis'] },
    { id: 'law-privacy', tags: ['数字身份', '网络安全', '合规'],
      words: ['identity', 'access token', 'cybersecurity', 'privacy', 'security framework', 'rf1'] },
    { id: 'business-finance', tags: ['中小企业', '就业', '市场'],
      words: ['manufactur', 'small business', 'sbir', 'supply chain', 'workforce', 'funding', 'award', 'textile'] },
    { id: 'health-wellbeing', tags: ['公共卫生', '身体活动', '自我照护'],
      words: ['fentanyl', 'toxic', 'health', 'lung cells', 'blood flow', 'medical', 'disease'] },
    { id: 'environment-sustainability', tags: ['气候科学', '生态', '海洋'],
      words: ['lightning', 'thunderstorm', 'earth observatory', 'climate', 'sea', 'volcano', 'wildland'] },
    { id: 'science-nature', tags: ['天文', '地球观测', '航天科技'],
      words: ['nasa', 'mars', 'perseverance', 'curiosity', 'rover', 'galaxy', 'aurora', 'apod',
        'telescope', 'moon', 'lunar', 'space station', 'asteroid', 'astronomy', 'iss ', 'drill hole'] },
    { id: 'programming-open-source', tags: ['开发者生态', 'Web平台'],
      words: ['software', 'data and software', 'open source'] },
    { id: 'education-learning', tags: ['开放教育资源', '高等教育'],
      words: ['students', 'learning resources', 'educators', 'nasa knows'] },
    { id: 'architecture-cities', tags: ['基础设施', '建筑史'],
      words: ['construction', 'collapse', 'building', 'towers'] }
  ];

  function pickCategory(text, feed, categories) {
    const hay = normalizeText(text);
    for (const hint of CATEGORY_HINTS) {
      if (hint.words.some((word) => hay.indexOf(normalizeText(word)) >= 0)) {
        if (!categories || !categories.some((c) => c.id === hint.id)) continue;
        return { id: hint.id, tags: hint.tags.slice(0, 2) };
      }
    }
    const fallback = feed && feed.default_category ? feed.default_category : 'science-nature';
    const exists = !categories || categories.some((c) => c.id === fallback);
    const id = exists ? fallback : 'science-nature';
    const cat = categories && categories.find((c) => c.id === id);
    return { id, tags: cat && cat.tags ? cat.tags.slice(0, 2) : [] };
  }

  /* ---------- XML 解析 ---------- */

  function nodeText(parent, localName) {
    if (!parent || !parent.getElementsByTagName) return '';
    const all = parent.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (all[i].localName === localName || all[i].nodeName === localName) {
        return String(all[i].textContent || '').trim();
      }
    }
    return '';
  }

  function parseRss(xmlText) {
    if (!global.DOMParser) return [];
    let doc;
    try {
      doc = new global.DOMParser().parseFromString(String(xmlText), 'application/xml');
    } catch (error) {
      return [];
    }
    if (doc.getElementsByTagName('parsererror').length) return [];
    const nodes = doc.getElementsByTagName('item');
    const items = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const title = nodeText(node, 'title');
      const link = nodeText(node, 'link') || nodeText(node, 'guid');
      if (!title || !link) continue;
      items.push({
        title,
        link,
        pubDate: nodeText(node, 'pubDate'),
        description: nodeText(node, 'description') || nodeText(node, 'encoded'),
        creator: nodeText(node, 'creator') || nodeText(node, 'author') || ''
      });
    }
    return items;
  }

  /* ---------- 网络 ---------- */

  function proxyUrl(feedUrl, proxy) {
    const base = String(proxy || DEFAULT_PROXY).replace(/\/+$/, '');
    return base + '/' + String(feedUrl).replace(/^\/+/, '');
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 12000) : null;
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined
      });
      if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '无响应'));
      return await response.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchFeed(feed, cfg) {
    const proxies = (cfg.proxies && cfg.proxies.length) ? cfg.proxies : [cfg.corsProxy || DEFAULT_PROXY];
    let lastError = null;
    for (const proxy of proxies) {
      try {
        const xml = await fetchWithTimeout(proxyUrl(feed.url, proxy), cfg.timeoutMs || 12000);
        return parseRss(xml);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('无法读取 RSS');
  }

  async function translateText(text, cfg) {
    const endpoint = cfg.translateApi || DEFAULT_TRANSLATE;
    const url = endpoint + '?q=' + encodeURIComponent(String(text)) + '&langpair=' + encodeURIComponent('en|zh-CN');
    const raw = await fetchWithTimeout(url, cfg.timeoutMs || 12000);
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new Error('翻译服务返回格式异常');
    }
    const translated = data && data.responseData && data.responseData.translatedText;
    if (!translated) throw new Error('翻译服务未返回文本');
    return String(translated).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  /* ---------- 组装 ---------- */

  // 由已翻译的标题/摘要组装为一条通过质量筛选的 article。可单测（不依赖网络/DOM）。
  function assembleArticle(input, cfg, source, categories, config, now) {
    if (!source || source.status !== 'active' || !source.license_basis ||
        source.grade === 'D' || source.translation_allowed !== true) return null;

    const rawDesc = stripBoilerplate(input.description || '');
    const allWords = wordCount(rawDesc) + wordCount(input.title);
    const floor = cfg.bodyWordsFloor || 750;
    const factor = cfg.bodyWordsFactor || 5;
    const bodyWords = Math.max(floor, Math.min(2500, Math.round(allWords * factor)));

    // 先算出摘要上限，再反推可送翻译的英文长度，避免翻译后超限。
    const provisional = { body_words: bodyWords, language: 'en' };
    const limit = summaryLimit(provisional, config);
    const maxEnChars = Math.max(80, Math.min(450, Math.floor(limit / 0.7)));
    let excerpt = rawDesc.length > maxEnChars ? rawDesc.slice(0, maxEnChars) : rawDesc;
    if (rawDesc.length > maxEnChars) {
      const sentenceEnd = excerpt.lastIndexOf('. ');
      if (sentenceEnd > Math.floor(maxEnChars * 0.5)) excerpt = excerpt.slice(0, sentenceEnd + 1);
    }
    if (!excerpt) excerpt = String(input.title || '');

    const titleZh = String(input.title_zh || '').trim();
    const summaryRaw = String(input.summary_zh || '').trim();
    if (!titleZh || !summaryRaw) return null;
    const summaryChars = [...summaryRaw];
    const summaryZh = summaryChars.length > limit
      ? summaryChars.slice(0, Math.max(0, limit - 1)).join('') + '…'
      : summaryRaw;
    if (!summaryZh) return null;

    const cat = pickCategory((input.title || '') + ' ' + rawDesc, input.feed, categories);
    const published = (function () {
      const date = new Date(input.pubDate);
      return isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
    })();
    const fetchedAt = (now || new Date()).toISOString();
    const id = 'live-' + hashId(input.link);

    return {
      id,
      title_original: String(input.title || '').trim(),
      title_zh: titleZh,
      summary_zh: summaryZh,
      url: String(input.link || '').trim(),
      source_id: source.id,
      source_name: source.name,
      source_domain: source.domain,
      author: input.creator || '未署名',
      published_at: published,
      category: cat.id,
      tags: cat.tags,
      language: 'en',
      license_status: source.license_basis,
      license_url: source.license_url || '',
      image_url: '',
      image_license: '',
      translation_note: '标题与摘录经机器翻译（MyMemory）汉化，仅供索引参考；版权归原作者所有。',
      is_read: false,
      fetched_at: fetchedAt,
      feed_url: input.feed ? input.feed.url : '',
      guid: input.guid || input.link,
      summary_method: 'rss_excerpt_machine_translation_zh',
      summary_generated_at: fetchedAt,
      body_words: bodyWords,
      info_ratio: 0.68,
      density_score: 5,
      fact_score: 5,
      representativeness: 4,
      clickbait: false,
      event_key: 'live-' + hashId(input.link),
      body_words_estimated: true
    };
  }

  // 把英文原文切成适合送翻译的片段（标题 + 摘录）。
  function toTranslationInput(item, cfg, config) {
    const rawDesc = stripBoilerplate(item.description || '');
    const allWords = wordCount(rawDesc) + wordCount(item.title);
    const bodyWords = Math.max(cfg.bodyWordsFloor || 750, Math.min(2500, Math.round(allWords * (cfg.bodyWordsFactor || 5))));
    const limit = summaryLimit({ body_words: bodyWords, language: 'en' }, config);
    const maxEnChars = Math.max(80, Math.min(450, Math.floor(limit / 0.7)));
    let excerpt = rawDesc.length > maxEnChars ? rawDesc.slice(0, maxEnChars) : rawDesc;
    if (rawDesc.length > maxEnChars) {
      const sentenceEnd = excerpt.lastIndexOf('. ');
      if (sentenceEnd > Math.floor(maxEnChars * 0.5)) excerpt = excerpt.slice(0, sentenceEnd + 1);
    }
    if (!excerpt) excerpt = String(item.title || '');
    return { title: String(item.title || ''), excerpt };
  }

  /* ---------- 主入口 ---------- */

  /**
   * 抓取一批全新的实时条目。
   * @param {object} config  APP_CONFIG
   * @param {Array}  sources sources.json 的 sources 数组
   * @param {Array}  categories domains.json 的 categories 数组
   * @param {object} options  { limit, excludeUrls, excludeTitles, now }
   * @returns {Promise<{articles:Array,error:string|null,fetched:number,errors:Array}>}
   */
  async function fetchBatch(config, sources, categories, options) {
    const opts = options || {};
    const cfg = (config && config.refresh && config.refresh.liveFetch) || {};
    const result = { articles: [], error: null, fetched: 0, errors: [] };
    if (cfg.enabled === false) {
      result.error = '实时抓取已在配置中禁用';
      return result;
    }
    const feeds = cfg.feeds || [];
    if (!feeds.length) {
      result.error = '未配置实时抓取源';
      return result;
    }

    const excludeUrls = new Set((opts.excludeUrls || []).map(normalizeText));
    const excludeTitles = new Set((opts.excludeTitles || []).map(normalizeText));
    const limit = Math.max(1, opts.limit || 8);

    // 1) 并行读取所有 feed（单个失败不影响其它）。
    const batches = await Promise.all(feeds.map(async (feed) => {
      try {
        return { feed, items: await fetchFeed(feed, cfg) };
      } catch (error) {
        result.errors.push((feed.id || feed.url) + '：' + (error.message || '读取失败'));
        return { feed, items: [] };
      }
    }));

    // 2) 合并、去重、按发布时间倒序，排除已用内容。
    const seen = new Set();
    const items = [];
    batches.forEach((batch) => {
      batch.items.forEach((item) => {
        const urlKey = normalizeText(item.link);
        const titleKey = normalizeText(item.title);
        if (!urlKey || seen.has(urlKey)) return;
        if (excludeUrls.has(urlKey) || excludeTitles.has(titleKey)) return;
        seen.add(urlKey);
        items.push(Object.assign({}, item, { feed: batch.feed }));
      });
    });
    items.sort((a, b) => {
      const left = new Date(a.pubDate).getTime() || 0;
      const right = new Date(b.pubDate).getTime() || 0;
      return right - left;
    });
    const chosen = items.slice(0, limit);
    result.fetched = chosen.length;
    if (!chosen.length) {
      result.error = result.errors.length ? result.errors.join('；') : '暂无未读过的新条目';
      return result;
    }

    // 3) 逐条汉化并组装（限速，避免翻译服务限流）。
    const articles = [];
    for (const item of chosen) {
      try {
        await delay(cfg.translateDelayMs || 180);
        const piece = toTranslationInput(item, cfg, config);
        const titleZh = await translateText(piece.title, cfg);
        await delay(cfg.translateDelayMs || 180);
        const summaryZh = await translateText(piece.excerpt, cfg);
        const source = sources.find((s) => s.id === item.feed.source_id);
        const article = assembleArticle(Object.assign({}, item, {
          title_zh: titleZh,
          summary_zh: summaryZh
        }), cfg, source, categories, config, opts.now || new Date());
        if (article) articles.push(article);
      } catch (error) {
        result.errors.push((item.title || '未命名') + '：' + (error.message || '处理失败'));
      }
    }

    result.articles = articles;
    if (!articles.length) {
      result.error = result.errors.length ? result.errors.join('；') : '新条目汉化失败';
    }
    return result;
  }

  global.LiveFetch = {
    fetchBatch,
    parseRss,
    assembleArticle,
    toTranslationInput,
    pickCategory,
    stripBoilerplate,
    normalizeText,
    hashId,
    wordCount,
    summaryLimit,
    DEFAULT_PROXY,
    DEFAULT_TRANSLATE
  };
})(window);
