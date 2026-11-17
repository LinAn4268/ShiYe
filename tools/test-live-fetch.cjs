/* 实时抓取测试：纯函数、组装合规、RSS 解析、网络抓取流程（mock fetch）。
 * 重点验证：抓取的条目能过质量筛选、摘要不超限、去重与排除生效、失败不崩。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
let pass = 0;
const queue = [];
function ok(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log('✓ ' + name); pass++; }
    catch (e) { console.error('✗ ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; }
  });
}

// 读取源数据
const configSrc = fs.readFileSync(path.join(root, 'assets/js/config.js'), 'utf8');
const qualitySrc = fs.readFileSync(path.join(root, 'assets/js/quality.js'), 'utf8');
const liveSrc = fs.readFileSync(path.join(root, 'assets/js/live-fetch.js'), 'utf8');
const sources = JSON.parse(fs.readFileSync(path.join(root, 'data/sources.json'), 'utf8')).sources;
const categories = JSON.parse(fs.readFileSync(path.join(root, 'data/domains.json'), 'utf8')).categories;
const sourceMap = new Map(sources.map((s) => [s.id, s]));

// 最小 DOMParser mock：把 RSS XML 解析成 getElementsByTagName 可用的结构。
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .trim();
}
function makeEl(localName, text) {
  const children = [];
  return {
    localName, nodeName: localName, textContent: text,
    getElementsByTagName(name) { return name === '*' ? children : children.filter((c) => c.localName === name); },
    add(child) { children.push(child); return this; }
  };
}
function MockDOMParser() {}
MockDOMParser.prototype.parseFromString = function (xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const item = makeEl('item', '');
    const fields = {
      title: /<title>([\s\S]*?)<\/title>/i,
      link: /<link>([\s\S]*?)<\/link>/i,
      guid: /<guid[^>]*>([\s\S]*?)<\/guid>/i,
      pubDate: /<pubDate>([\s\S]*?)<\/pubDate>/i,
      description: /<description>([\s\S]*?)<\/description>/i,
      creator: /<dc:creator>([\s\S]*?)<\/dc:creator>/i,
      author: /<author>([\s\S]*?)<\/author>/i
    };
    for (const key of Object.keys(fields)) {
      const f = fields[key].exec(block);
      if (f) item.add(makeEl(key, decodeXml(f[1])));
    }
    items.push(item);
  }
  return {
    getElementsByTagName(name) { return name === 'parsererror' ? [] : items; }
  };
};

function loadLive(fetchImpl) {
  // 浏览器中 window 就是全局对象：让 window === global === sandbox，
  // 这样 live-fetch.js 里 global.DOMParser / global.fetch 都能取到。
  const sandbox = {
    console, AbortController,
    DOMParser: MockDOMParser,
    setTimeout: (fn) => { if (fn) fn(); return 0; },
    clearTimeout: () => {},
    fetch: fetchImpl || (async () => { throw new Error('no fetch'); })
  };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(configSrc, sandbox);
  vm.runInContext(qualitySrc, sandbox);
  vm.runInContext(liveSrc, sandbox);
  return { LiveFetch: sandbox.LiveFetch, Quality: sandbox.Quality, cfg: sandbox.APP_CONFIG };
}

const RSS = (titles) => '<?xml version="1.0"?><rss version="2.0"><channel>' +
  titles.map((t, i) =>
    '<item><title>' + t + '</title>' +
    '<link>https://science.nasa.gov/news/item-' + i + '-' + t.replace(/[^a-z0-9]/gi, '').slice(0, 8) + '/</link>' +
    '<pubDate>Tue, 17 Nov 2026 05:0' + (i % 10) + ':00 +0000</pubDate>' +
    '<description>Astronomy picture of the day shows the milky way versus aurora over a dark sky. ' +
    'Researchers observed the galaxy structure and published new findings about how the aurora forms. ' +
    'The post ' + t + ' appeared first on NASA Science.</description>' +
    '<dc:creator>NASA Science Team</dc:creator></item>'
  ).join('') + '</channel></rss>';

// ---- 1. 纯工具函数 ----
ok('normalizeText 做 NFKC + 小写 + 压缩空白', () => {
  const { LiveFetch } = loadLive();
  assert.strictEqual(LiveFetch.normalizeText('  Hello   WORLD  '), 'hello world');
  assert.strictEqual(LiveFetch.normalizeText('ＡＢＣ'), 'abc');
});

ok('stripBoilerplate 去掉 "The post…appeared first on…" 尾巴', () => {
  const { LiveFetch } = loadLive();
  const out = LiveFetch.stripBoilerplate('Some real content here. The post Foo appeared first on NASA Science.');
  assert.strictEqual(out, 'Some real content here.');
});

ok('wordCount / hashId 稳定', () => {
  const { LiveFetch } = loadLive();
  assert.strictEqual(LiveFetch.wordCount('one two  three'), 3);
  assert.strictEqual(LiveFetch.hashId('abc'), LiveFetch.hashId('abc'));
  assert.notStrictEqual(LiveFetch.hashId('abc'), LiveFetch.hashId('abd'));
});

ok('summaryLimit 与 quality 一致（英文 10% / 400 字上限）', () => {
  const { LiveFetch, cfg } = loadLive();
  const q = cfg.quality;
  const body = 1500;
  const expected = Math.min(q.summaryMaxChars, Math.floor(body * q.charsPerEnglishWord * q.summaryMaxRatio));
  assert.strictEqual(LiveFetch.summaryLimit({ body_words: body, language: 'en' }, cfg), expected);
});

ok('pickCategory 关键词命中领域，未知词回退 default_category', () => {
  const { LiveFetch } = loadLive();
  assert.strictEqual(LiveFetch.pickCategory('quantum entanglement photon', {}, categories).id, 'future-frontier');
  assert.strictEqual(LiveFetch.pickCategory('mars rover perseverance', {}, categories).id, 'science-nature');
  assert.strictEqual(LiveFetch.pickCategory('something unmatched', { default_category: 'science-nature' }, categories).id, 'science-nature');
});

// ---- 2. assembleArticle 组装后过质量筛选 ----
ok('assembleArticle 产出通过 Quality.evaluate 的合规条目', () => {
  const { LiveFetch, Quality, cfg } = loadLive();
  const now = Quality.parseDate(cfg.snapshotDate) || new Date();
  const feed = { id: 'nasa-science', source_id: 'nasa', url: 'https://science.nasa.gov/feed/', default_category: 'science-nature' };
  const desc = 'Astronomy picture of the day compares the milky way and aurora. Researchers studied galaxy structure and aurora formation in detail.';
  const article = LiveFetch.assembleArticle({
    title: 'Astronomy Picture of the Day Milky Way versus Aurora',
    title_zh: '每日天文图片：银河系与极光',
    summary_zh: '每日天文图片展示了夜空中的银河系与极光对比，研究人员观测了星系结构并公布了极光形成的新发现。',
    description: desc, link: 'https://science.nasa.gov/image-article/apod-milky-way-aurora/',
    pubDate: 'Tue, 17 Nov 2026 05:05:00 +0000', creator: 'NASA Science Team', feed
  }, cfg.refresh.liveFetch, sourceMap.get('nasa'), categories, cfg, now);
  assert(article, '应产出文章');
  const r = Quality.evaluate(article, sourceMap.get('nasa'),
    categories.find((c) => c.id === article.category), cfg, now);
  assert(r.ok, '应过质量筛选，实际:' + r.reasons.map((x) => x.code || x).join(','));
  assert(article.id.startsWith('live-'), '实时条目 id 应以 live- 开头');
});

ok('摘要按上限截断，超长摘要不超限', () => {
  const { LiveFetch, cfg } = loadLive();
  const now = new Date();
  const feed = { id: 'nasa-science', source_id: 'nasa', url: 'https://science.nasa.gov/feed/', default_category: 'science-nature' };
  const long = '详细内容 '.repeat(300);
  const article = LiveFetch.assembleArticle({
    title: 'Long title', title_zh: '长标题', summary_zh: long,
    description: 'some english words here', link: 'https://science.nasa.gov/x/',
    pubDate: 'Tue, 17 Nov 2026 05:05:00 +0000', feed
  }, cfg.refresh.liveFetch, sourceMap.get('nasa'), categories, cfg, now);
  assert(article);
  const limit = Math.min(cfg.quality.summaryMaxChars,
    Math.floor(article.body_words * cfg.quality.charsPerEnglishWord * cfg.quality.summaryMaxRatio));
  assert([...article.summary_zh].length <= limit, '摘要不得超过上限 ' + limit);
});

ok('不允许翻译的来源返回 null', () => {
  const { LiveFetch, cfg } = loadLive();
  const feed = { id: 'nist', source_id: 'nist', url: 'https://www.nist.gov/feed', default_category: 'science-nature' };
  const badSource = Object.assign({}, sourceMap.get('nist'), { translation_allowed: false });
  const article = LiveFetch.assembleArticle({
    title: 'T', title_zh: '标题', summary_zh: '摘要', description: 'words',
    link: 'https://x/', pubDate: 'Tue, 17 Nov 2026 05:05:00 +0000', feed
  }, cfg.refresh.liveFetch, badSource, categories, cfg, new Date());
  assert.strictEqual(article, null);
});

// ---- 3. parseRss ----
ok('parseRss 解析 item 的标题/链接/日期/描述/作者', () => {
  const { LiveFetch } = loadLive();
  const items = LiveFetch.parseRss(RSS(['First Item', 'Second Item']));
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].title, 'First Item');
  assert(items[0].link.indexOf('item-0') >= 0);
  assert(items[0].description.indexOf('milky way') >= 0);
  assert.strictEqual(items[0].creator, 'NASA Science Team');
});

// ---- 4. fetchBatch：mock fetch 走完整抓取→翻译→组装流程 ----
ok('fetchBatch 抓取并翻译，排除已用 URL，产出合规条目', async () => {
  const rss = RSS(['Alpha News', 'Beta News', 'Gamma News']);
  const fetchImpl = async (url) => {
    if (url.indexOf('mymemory') >= 0) {
      // 从 q 参数取回原文，回译成可识别的中文
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '');
      const zh = '汉化-' + q.slice(0, 20);
      return { ok: true, text: async () => JSON.stringify({ responseData: { translatedText: zh } }) };
    }
    // RSS 代理请求
    return { ok: true, text: async () => rss };
  };
  const { LiveFetch, Quality, cfg } = loadLive(fetchImpl);
  const now = Quality.parseDate(cfg.snapshotDate) || new Date();
  const batch = await LiveFetch.fetchBatch(cfg, sources, categories, {
    limit: 2, excludeUrls: [], excludeTitles: [], now
  });
  assert.strictEqual(batch.articles.length, 2, '应产出 2 条');
  batch.articles.forEach((a) => {
    assert(a.title_zh.indexOf('汉化-') === 0, '标题应被汉化: ' + a.title_zh);
    const r = Quality.evaluate(a, sourceMap.get(a.source_id),
      categories.find((c) => c.id === a.category), cfg, now);
    assert(r.ok, '抓取条目应过质量筛选: ' + r.reasons.map((x) => x.code || x).join(','));
  });
  // 两条 URL 不同
  assert.notStrictEqual(batch.articles[0].url, batch.articles[1].url);
});

ok('fetchBatch 排除已用标题后自动跳过', async () => {
  const rss = RSS(['Alpha News', 'Beta News']);
  const fetchImpl = async (url) => {
    if (url.indexOf('mymemory') >= 0) {
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '');
      return { ok: true, text: async () => JSON.stringify({ responseData: { translatedText: '汉化-' + q.slice(0, 10) } }) };
    }
    return { ok: true, text: async () => rss };
  };
  const { LiveFetch, cfg } = loadLive(fetchImpl);
  const batch = await LiveFetch.fetchBatch(cfg, sources, categories, {
    limit: 5,
    excludeUrls: [],
    excludeTitles: [LiveFetch.normalizeText('Alpha News')],
    now: new Date()
  });
  assert.strictEqual(batch.articles.length, 1, '排除 Alpha 后只剩 1 条');
  assert(batch.articles[0].title_original.indexOf('Beta') >= 0);
});

ok('fetchBatch 在网络全部失败时返回空数组与错误，不抛出', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const { LiveFetch, cfg } = loadLive(fetchImpl);
  const batch = await LiveFetch.fetchBatch(cfg, sources, categories, { limit: 3, now: new Date() });
  assert.strictEqual(batch.articles.length, 0);
  assert(batch.error, '应有错误信息');
  assert(batch.errors.length > 0, '应记录各源失败原因');
});

// 顺序执行所有测试
(async () => {
  for (const task of queue) await task();
  console.log('\n实时抓取测试完成：' + pass + '/' + queue.length + ' 通过');
})();
