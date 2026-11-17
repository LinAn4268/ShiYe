#!/usr/bin/env node
/*
 * 无第三方依赖的静态验收脚本。
 * 用法：node tools/validate.cjs
 *
 * 覆盖：数据完整性、四层筛选、12 条抽样约束、领域/标签筛选、
 * localStorage 已读与隐藏、二维码容量、PDF 结构、导出 CSS 与离线资源。
 * 它不能替代真实浏览器中的视觉/下载验收；原因见 README「已知限制」。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'));
const readText = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

global.window = global;
global.location = { href: 'file:///C:/kuayu/index.html' };
global.localStorage = {
  data: Object.create(null),
  getItem(key) { return this.data[key] == null ? null : this.data[key]; },
  setItem(key, value) { this.data[key] = String(value); },
  removeItem(key) { delete this.data[key]; }
};

require(path.join(ROOT, 'assets/js/config.js'));
require(path.join(ROOT, 'assets/js/quality.js'));
require(path.join(ROOT, 'assets/js/recommender.js'));
require(path.join(ROOT, 'assets/js/storage.js'));
require(path.join(ROOT, 'assets/js/qrcode.js'));
require(path.join(ROOT, 'assets/js/pdf-lite.js'));

const config = global.APP_CONFIG;
const domainDoc = readJson('domains.json');
const sourceDoc = readJson('sources.json');
const articleDoc = readJson('articles.json');
const auditDoc = readJson('audit.json');
const categories = domainDoc.categories;
const sources = sourceDoc.sources;
const articles = articleDoc.articles;
const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log('  ok  ' + name);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.error('  FAIL ' + name + '\n       ' + error.message);
  }
}

function basePdfData() {
  return {
    title: '测试 PDF',
    author: '拾页',
    subject: '导出测试',
    keywords: ['测试', 'PDF'],
    createdAt: new Date('2026-11-16T10:00:00+08:00')
  };
}

async function main() {
  const built = global.Recommender.buildPool(articles, sources, categories, config, new Date(config.snapshotDate));
  const pool = built.items;

  console.log('\n[1] 配置文件与领域');
  await check('21 个一级领域，id 唯一', () => {
    assert.equal(categories.length, 21);
    assert.equal(new Set(categories.map((item) => item.id)).size, 21);
    assert.ok(categories.every((item) => item.name && item.tags.length));
  });
  await check('二级标签在领域内唯一', () => {
    for (const category of categories) {
      assert.equal(new Set(category.tags).size, category.tags.length, category.id);
    }
  });
  await check('active 来源字段齐全，默认不输出全文', () => {
    const required = ['id', 'name', 'domain', 'homepage', 'grade', 'access_method', 'license_basis',
      'robots_check', 'reviewed_at', 'next_review_at', 'status', 'fulltext_allowed', 'translation_allowed'];
    const active = sources.filter((source) => source.status === 'active');
    assert.equal(active.length, 12);
    for (const source of active) {
      for (const key of required) {
        assert.ok(source[key] !== undefined && source[key] !== '', source.id + ' 缺 ' + key);
      }
      assert.ok(['A', 'B', 'C', 'D'].includes(source.grade), source.id + ' 等级非法');
      assert.equal(source.fulltext_allowed, false, source.id + ' 不应默认允许全文');
      assert.equal(typeof source.translation_allowed, 'boolean', source.id + ' 缺少翻译许可');
      assert.match(source.reviewed_at, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(source.next_review_at, /^\d{4}-\d{2}-\d{2}$/);
    }
  });
  await check('排除源只作为反例，不进入文章池', () => {
    const excluded = new Set(sources.filter((source) => source.status !== 'active').map((source) => source.id));
    assert.ok(excluded.size >= 1);
    assert.ok(articles.every((article) => !excluded.has(article.source_id)));
  });
  await check('超过 7 天无新条目的来源标记为降权，新来源不降权', () => {
    const owid = sources.find((source) => source.id === 'owid');
    const unesco = sources.find((source) => source.id === 'unesco');
    assert.ok(owid && unesco);
    assert.equal(global.Recommender.isStaleSource(owid, config), false);
    assert.equal(global.Recommender.isStaleSource(unesco, config), true);
    assert.ok(config.sampling.staleSourcePenalty > 0 && config.sampling.staleSourcePenalty < 1);
  });

  console.log('\n[2] 文章元数据与摘要上限');
  await check('36 条演示文章，URL / 标题 / event_key 唯一', () => {
    assert.equal(articles.length, 36);
    assert.equal(new Set(articles.map((item) => item.id)).size, articles.length);
    assert.equal(new Set(articles.map((item) => item.url)).size, articles.length);
    assert.equal(new Set(articles.map((item) => item.title_original)).size, articles.length);
    assert.equal(new Set(articles.map((item) => item.event_key)).size, articles.length);
  });
  await check('每条文章的来源、领域、标签都能在配置中找到', () => {
    const sourceIds = new Set(sources.map((item) => item.id));
    const categoryMap = new Map(categories.map((item) => [item.id, item]));
    for (const article of articles) {
      assert.ok(sourceIds.has(article.source_id), article.id);
      const category = categoryMap.get(article.category);
      assert.ok(category, article.id);
      assert.ok(article.tags.length > 0, article.id);
      for (const tag of article.tags) assert.ok(category.tags.includes(tag), article.id + ' 未知标签 ' + tag);
      assert.match(article.url, /^https:\/\//, article.id);
      assert.match(article.published_at, /^\d{4}-\d{2}-\d{2}/, article.id);
      assert.ok(article.title_original && article.title_zh && article.summary_zh, article.id);
      assert.ok(article.license_status && article.license_url, article.id + ' 缺授权字段');
      assert.ok(article.image_license, article.id + ' 缺图片许可说明');
    }
  });
  await check('标题党词库只在事实增量不足时否决', () => {
    const sample = Object.assign({}, articles[0]);
    sample.title_zh = '震惊！所有人都该看的真相';
    sample.fact_score = 2;
    assert.equal(global.Quality.clickbaitHit(sample, config.quality), true);
    sample.fact_score = 5;
    assert.equal(global.Quality.clickbaitHit(sample, config.quality), false);
  });
  await check('四层筛选后 36 条通过，摘要不超硬上限', () => {
    assert.equal(pool.length, 36);
    assert.equal(built.rejected.length, 0);
    assert.equal(built.dropped.length, 0);
    for (const item of pool) {
      const length = [...(item.article.summary_zh || '')].length;
      assert.ok(item.quality.score >= 3.0, item.article.id + ' 分数不足');
      assert.ok(length <= item.quality.summaryLimit, item.article.id + ' 摘要超限');
      assert.ok(length <= 400, item.article.id + ' 摘要超过 400 字');
      assert.equal(item.quality.reasons.length, 0);
    }
  });

  console.log('\n[3] 抽样约束（300 轮）');
  await check('每轮 12 条、覆盖 >=8 领域、单领域 <=3、单标签 <=1、同源连续 <=2、C 级 <=3', () => {
    for (let round = 0; round < 300; round++) {
      const result = global.Recommender.sample(pool, { config, batchSize: 12, state: global.Store.getState() });
      assert.equal(result.items.length, 12, '第 ' + round + ' 轮不是 12 条');
      assert.ok(result.meta.categories >= 8, '第 ' + round + ' 轮只覆盖 ' + result.meta.categories + ' 类');
      const catCounts = new Map();
      const tagCounts = new Map();
      let sourceRun = 1;
      let gradeC = 0;
      result.items.forEach((item, index) => {
        const category = item.article.category;
        catCounts.set(category, (catCounts.get(category) || 0) + 1);
        for (const tag of item.article.tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        if (item.source.grade === 'C') gradeC++;
        if (index > 0 && result.items[index - 1].article.source_id === item.article.source_id) sourceRun++;
        else sourceRun = 1;
        assert.ok(sourceRun <= 2, '同源连续超过 2 条');
      });
      assert.ok([...catCounts.values()].every((count) => count <= 3));
      assert.ok([...tagCounts.values()].every((count) => count <= 1));
      assert.ok(gradeC <= 3);
      assert.equal(new Set(result.items.map((item) => item.article.id)).size, 12);
    }
  });
  await check('21 个领域筛选均只返回本领域内容', () => {
    for (const category of categories) {
      const result = global.Recommender.sample(pool, {
        config, batchSize: 12, categoryFilter: category.id, state: global.Store.getState()
      });
      assert.ok(result.items.length > 0, category.id);
      assert.ok(result.items.every((item) => item.article.category === category.id), category.id);
    }
  });
  await check('二级标签筛选生效', () => {
    const sample = pool.find((item) => item.article.tags.length > 1);
    const tag = sample.article.tags[1];
    const result = global.Recommender.sample(pool, {
      config,
      batchSize: 12,
      categoryFilter: sample.article.category,
      tagFilter: tag,
      state: global.Store.getState()
    });
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every((item) => item.article.tags.includes(tag)));
  });

  console.log('\n[4] 本机状态与推荐池隔离');
  await check('已读写入 localStorage，取消后恢复', () => {
    const article = articles[0];
    const after = global.Store.markRead(article.id, true);
    assert.ok(after.readIds.includes(article.id));
    assert.ok(global.Recommender.filterItems(pool, { state: after }).length > 0);
    global.Store.markRead(article.id, false);
    assert.ok(!global.Store.getState().readIds.includes(article.id));
  });
  await check('“不再推荐类似内容”隐藏本文、同事件与同标签', () => {
    const article = articles[0];
    const after = global.Store.hideSimilar(article);
    assert.ok(after.hiddenIds.includes(article.id));
    assert.ok(after.hiddenEvents.includes(article.event_key));
    for (const tag of article.tags) assert.ok(after.hiddenTags.includes(tag));
    assert.ok(!global.Recommender.filterItems(pool, { state: after }).some((item) => item.article.id === article.id));
    global.Store.clearHidden();
    assert.equal(global.Store.getState().hiddenIds.length, 0);
  });

  console.log('\n[5] 二维码');
  await check('36 条原文 URL 均可编码，版本 <= 20', () => {
    for (const article of articles) {
      const qr = global.QRCodeLite.encode(article.url);
      assert.ok(qr && qr.modules && qr.size >= 21);
      assert.ok(qr.version >= 1 && qr.version <= 20, article.id);
      assert.equal(qr.modules.length, qr.size);
      assert.equal(qr.modules[0].length, qr.size);
    }
    const longest = articles.slice().sort((a, b) => b.url.length - a.url.length)[0];
    assert.equal(longest.url.length, 179);
    assert.ok(global.QRCodeLite.encode(longest.url).version <= 20);
  });

  console.log('\n[6] PDF 结构与元数据');
  await check('PDF header、xref 偏移、页面、链接与 UTF-16 元数据可解析', async () => {
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
    const blob = global.PDFLite.buildImagePdf([{
      jpeg: new Uint8Array(jpeg),
      width: 1588,
      height: 2246,
      links: [{ url: 'https://www.nasa.gov/', x: 50, y: 50, width: 200, height: 20 }]
    }], Object.assign(basePdfData(), { title: '测试 PDF' }));
    const buffer = Buffer.from(await blob.arrayBuffer());
    const text = buffer.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'));
    assert.ok(text.includes('/Type /Page'));
    assert.ok(text.includes('/URI (https://www.nasa.gov/)'));
    assert.ok(text.includes('/Title <FEFF'));
    const xrefStart = Number((text.match(/startxref\s+(\d+)/) || [])[1]);
    assert.ok(xrefStart > 0);
    assert.equal(text.slice(xrefStart, xrefStart + 4), 'xref');
    const entries = [...text.slice(xrefStart).matchAll(/^(\d{10}) 00000 n/gm)].map((match) => Number(match[1]));
    const offsets = [...text.matchAll(/(\d+) 0 obj/g)].map((match) => Number(match.index));
    assert.equal(entries.length, offsets.length);
    assert.ok(entries.every((value, index) => value === offsets[index]));
  });

  console.log('\n[7] 导出 CSS、离线资源与内嵌快照');
  await check('导出 CSS 无 flex/grid/oklch/color-mix/backdrop-filter/外链资源', () => {
    const css = readText('assets/css/export.css');
    assert.ok(!/display\s*:\s*(flex|grid)\b/i.test(css));
    assert.ok(!/oklch\s*\(|color-mix\s*\(|backdrop-filter/i.test(css));
    assert.ok(!/@font-face|url\s*\(/i.test(css));
    assert.ok(css.includes('.export-doc') && css.includes('.ex-qr-wrap'));
  });
  await check('index.html 资源均存在，无远程脚本，ID 唯一', () => {
    const html = readText('index.html');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      assert.ok(!/^https?:/i.test(match[1]), '存在远程脚本');
      assert.ok(fs.existsSync(path.join(ROOT, match[1])), match[1]);
    }
    for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
      if (/^https?:/i.test(match[1])) continue;
      assert.ok(fs.existsSync(path.join(ROOT, match[1])), match[1]);
    }
    assert.ok(readText('assets/js/ui.js').includes('rel="noopener noreferrer"'));
    assert.ok(readText('assets/js/exporter.js').includes('noopener'));
    assert.ok(html.includes('不替代原文'));
  });
  await check('内嵌快照与四个 JSON 完全一致', () => {
    const sandbox = { window: {} };
    vm.runInNewContext(readText('data/fallback-data.js'), sandbox, { filename: 'fallback-data.js' });
    const embedded = sandbox.window.__KUAYU_DATA__;
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(embedded.domains), plain(domainDoc));
    assert.deepEqual(plain(embedded.sources), plain(sourceDoc));
    assert.deepEqual(plain(embedded.articles), plain(articleDoc));
    assert.deepEqual(plain(embedded.audit), plain(auditDoc));
  });
  await check('导出 CSS 已内联，避免 foreignObject 依赖外部 link', () => {
    const sandbox = { window: {} };
    vm.runInNewContext(readText('assets/js/export-styles.js'), sandbox, { filename: 'export-styles.js' });
    assert.equal(sandbox.window.EXPORT_CSS, readText('assets/css/export.css'));
  });

  const failed = checks.filter((item) => !item.ok);
  console.log('\n' + (failed.length ? '验收失败：' + failed.length + ' 项' : '全部静态验收通过：' + checks.length + ' 项'));
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
