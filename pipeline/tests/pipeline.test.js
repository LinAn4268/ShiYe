'use strict';

/*
 * 零依赖验收测试：node pipeline/tests/pipeline.test.js
 * 使用临时目录与注入的 fetch/LLM，不访问真实网络，不消耗 API。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const { runPipeline } = require('../update');
const { applyTakedown } = require('../lib/takedown');
const { resumeSources } = require('../lib/resume');
const { acquireLock, appendArticles } = require('../lib/publish');
const { createIndex, evaluateCandidate, simhash, canonicalUrl, hamming } = require('../lib/dedupe');
const { parseRobots } = require('../lib/feed');
const { loadState, saveState, loadQueue } = require('../lib/state');
const { config: siteConfig, Quality } = require('../lib/core');
const { readJson } = require('../lib/util');

const baseConfig = readJson(path.join(projectRoot, 'pipeline', 'config.json'));
const now = '2026-11-16T12:00:00.000Z';
const feedUrl = 'https://fixture.example/feed.xml';
const articleUrl = 'https://fixture.example/2026/11/story';

function bodyOf(seed) {
  const words = ['fixture', 'policy', 'research', 'data', 'public', 'report', 'system', 'people'];
  const out = [];
  for (let i = 0; i < 160; i++) {
    out.push(i % 5 === 0 ? '42' : words[(i + seed) % words.length] + (i % 11));
  }
  return out.join(' ') + '.';
}

function rss(options) {
  const value = options || {};
  return '<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><item>' +
    '<title>' + (value.title || 'Fixture story') + '</title>' +
    '<link>' + (value.link || articleUrl) + '</link>' +
    '<guid>' + (value.guid || 'guid-1') + '</guid>' +
    '<pubDate>Sun, 15 Nov 2026 09:00:00 GMT</pubDate>' +
    '<author>Fixture Desk</author>' +
    '<description><![CDATA[' + (value.body || bodyOf(1)) + ']]></description>' +
    '</item></channel></rss>';
}

function fetchFor(options) {
  const value = options || {};
  return async function fetchImpl(input) {
    const url = String(input);
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (value.mode === '304') {
      return new Response(null, { status: 304, headers: { etag: '"v2"' } });
    }
    if (value.mode === 'fail') {
      return new Response('server error', { status: 500 });
    }
    return new Response(value.xml || rss(), {
      status: 200,
      headers: { etag: '"v1"', 'last-modified': 'Sun, 16 Nov 2026 00:00:00 GMT' }
    });
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuayu-pipeline-'));
  fs.cpSync(path.join(projectRoot, 'data'), path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pipeline', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pipeline', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pipeline', 'history'), { recursive: true });
  const source = {
    id: 'fixture',
    name: 'Fixture Source',
    domain: 'fixture.example',
    homepage: 'https://fixture.example/',
    grade: 'A',
    access_method: 'official RSS',
    feed_url: feedUrl,
    license_basis: 'Public domain',
    license_url: 'https://fixture.example/license',
    robots_check: 'allow',
    robots_allowed: true,
    fulltext_allowed: true,
    fulltext_note: 'test fixture only',
    translation_allowed: true,
    translation_basis: 'test fixture only',
    reviewed_at: '2026-11-01',
    next_review_at: '2027-02-01',
    last_item_at: '2026-11-14',
    request_interval_minutes: 60,
    status: 'active'
  };
  const sourceDoc = readJson(path.join(dir, 'data', 'sources.json'));
  sourceDoc.sources = [source];
  fs.writeFileSync(path.join(dir, 'data', 'sources.json'), JSON.stringify(sourceDoc, null, 2) + '\n');
  const articleDoc = readJson(path.join(dir, 'data', 'articles.json'));
  articleDoc.articles = [];
  fs.writeFileSync(path.join(dir, 'data', 'articles.json'), JSON.stringify(articleDoc, null, 2) + '\n');
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.publish.rebuild_fallback = false;
  config.publish.lock_timeout_ms = 150;
  config.publish.lock_stale_ms = 600000;
  config.http.robots_cache_hours = 1;
  config.health.failure_threshold = 5;
  config.routing = {
    fixture: {
      category: 'tech-ai',
      language: 'en',
      tags: ['人工智能'],
      interval_minutes: 60,
      routes: [{ pattern: 'fixture', category: 'tech-ai', tags: ['人工智能'] }]
    }
  };
  config.llm.api_key_env = '';
  return { dir, source, config };
}

function readArticles(dir) {
  return readJson(path.join(dir, 'data', 'articles.json')).articles;
}

function llmFactory(options) {
  const value = options || {};
  const state = { calls: 0 };
  async function llmImpl() {
    state.calls++;
    if (value.error) throw value.error;
    return {
      title_zh: value.title_zh || '测试标题：公共数据研究',
      summary_zh: value.summary_zh == null ? '测试摘要：报告给出四十二项数据。' : value.summary_zh,
      key_points: [],
      translation_note: '由 AI/机器翻译，仅供参考。'
    };
  }
  return { llmImpl, state };
}

async function run(name, fn) {
  process.stdout.write('… ' + name + '\n');
  await fn();
  process.stdout.write('✓ ' + name + '\n');
}

async function main() {
  const tempDirs = [];
  try {
    await run('条件请求 304 不重置健康状态，且不重复发布', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      const llm = llmFactory();
      const requests = [];
      const baseFetch = fetchFor();
      const recordingFetch = async (url, init) => {
        if (!String(url).endsWith('/robots.txt')) requests.push({ url: String(url), headers: (init && init.headers) || {} });
        return baseFetch(url, init);
      };
      const first = await runPipeline({
        root: dir, config, now, sourceId: 'fixture',
        fetchImpl: recordingFetch, llmImpl: llm.llmImpl
      });
      assert.equal(first.counters.published, 1);
      assert.equal(readArticles(dir).length, 1);
      assert.equal(llm.state.calls, 1);

      const state = loadState(dir);
      state.sources.fixture.consecutive_failures = 4;
      state.sources.fixture.empty_feed_streak = 2;
      state.sources.fixture.empty_feed_warning = true;
      state.sources.fixture.etag = '"v1"';
      state.sources.fixture.next_run_at = null;
      saveState(dir, state);
      const second = await runPipeline({
        root: dir, config, now: '2026-11-16T14:00:00.000Z', sourceId: 'fixture',
        fetchImpl: async (url, init) => {
          if (!String(url).endsWith('/robots.txt')) requests.push({ url: String(url), headers: (init && init.headers) || {} });
          return fetchFor({ mode: '304' })(url, init);
        },
        llmImpl: llm.llmImpl
      });
      assert.equal(second.counters.status_304, 1);
      assert.equal(requests.at(-1).headers['if-none-match'], '"v1"', '第二次请求必须带 If-None-Match');
      assert.equal(requests.at(-1).headers['if-modified-since'], 'Sun, 16 Nov 2026 00:00:00 GMT', '第二次请求必须带 If-Modified-Since');
      assert.equal(second.counters.exact_duplicates, 0);
      assert.equal(readArticles(dir).length, 1);
      const after = loadState(dir).sources.fixture;
      assert.equal(after.consecutive_failures, 4, '304 不得重置连续失败次数');
      assert.equal(after.empty_feed_streak, 2, '304 不得重置空 feed 警告');
      assert.equal(after.low_activity, false);
      assert.ok(after.last_304_at);
    });

    await run('精确去重与模糊去重/临界区', async () => {
      const config = { dedupe: baseConfig.dedupe };
      const base = { id: 'x1', content_id: 'x1', guid: 'g1', url: 'https://www.example.com/a/?utm_source=x#h', title_original: 'Same title', source_id: 's' };
      const index = createIndex([base], config.dedupe);
      assert.equal(canonicalUrl('https://www.example.com/a/?utm_source=x#h'), 'https://example.com/a');
      const exact = evaluateCandidate({ ...base, id: 'x2', guid: 'g2', url: 'https://example.com/a/', title_original: 'Other' }, index);
      assert.equal(exact.duplicate.code, 'exact_url');

      const body = bodyOf(2);
      const fuzzyIndex = createIndex([{ ...base, url: 'https://example.com/fuzzy', title_original: 'Fuzzy one' }], config.dedupe);
      fuzzyIndex.entries[0].simhash = simhash(body);
      const fuzzy = evaluateCandidate({
        id: 'x3', guid: 'g3', url: 'https://example.com/fuzzy-2', title_original: 'Fuzzy two',
        source_id: 's2', _body_text: body
      }, fuzzyIndex);
      assert.equal(fuzzy.duplicate.code, 'fuzzy_body');

      fuzzyIndex.entries[0].simhash = simhash(body) ^ 0b1111n;
      const suspect = evaluateCandidate({
        id: 'x4', guid: 'g4', url: 'https://example.com/fuzzy-3', title_original: 'Fuzzy three',
        source_id: 's3', _body_text: body
      }, fuzzyIndex);
      assert.equal(suspect.duplicate, null);
      assert.equal(suspect.suspect.code, 'fuzzy_suspect');
      assert.equal(hamming(simhash(body) ^ 0b1111n, simhash(body)), 4);
    });

    await run('robots 的 $ 结尾规则', async () => {
      const text = 'User-agent: *\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\n';
      assert.equal(parseRobots(text, 'KuayuPipeline/1.0', '/private/public/x').allowed, true);
      assert.equal(parseRobots(text, 'KuayuPipeline/1.0', '/private/x').allowed, false);
      assert.equal(parseRobots(text, 'KuayuPipeline/1.0', '/downloads/a.pdf').allowed, false);
      assert.equal(parseRobots(text, 'KuayuPipeline/1.0', '/downloads/a.pdf?x=1').allowed, true);
    });

    await run('dry-run 不调用 LLM、不写内容池和 state，日志独立', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      let called = 0;
      const before = fs.existsSync(path.join(dir, 'pipeline', 'state', 'update-state.json'));
      const result = await runPipeline({
        root: dir, config, now, sourceId: 'fixture', dryRun: true,
        fetchImpl: fetchFor({ xml: rss({ title: 'Dry story', link: 'https://fixture.example/dry', guid: 'dry-1' }) }),
        llmImpl: async () => { called++; throw new Error('dry-run 不应调用 LLM'); }
      });
      assert.equal(called, 0);
      assert.equal(result.counters.processing_would, 1);
      assert.equal(readArticles(dir).length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'pipeline', 'state', 'update-state.json')), before);
      const log = fs.readFileSync(path.join(dir, 'pipeline', 'logs', 'dry-run-20261116.log'), 'utf8');
      assert.match(log, /"dry_run":true/);
      assert.match(log, /"status":"would_process"/);
    });

    await run('文件锁阻止并发写入', async () => {
      const { dir } = setup();
      tempDirs.push(dir);
      const release = await acquireLock(dir, { timeoutMs: 500, label: 'test-1' });
      await assert.rejects(
        () => acquireLock(dir, { timeoutMs: 120, label: 'test-2' }),
        (error) => error && error.code === 'LOCK_TIMEOUT'
      );
      release();
      const releaseAgain = await acquireLock(dir, { timeoutMs: 500, label: 'test-3' });
      releaseAgain();
    });

    await run('发布幂等且不覆盖已有内容/已读字段', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      const article = {
        id: 'c_existing',
        content_id: 'c_existing',
        guid: 'g_existing',
        url: 'https://fixture.example/existing',
        title_original: 'Existing article',
        title_zh: '已有文章',
        summary_zh: '已有摘要。',
        source_id: 'fixture',
        source_name: 'Fixture Source',
        published_at: '2026-11-15',
        is_read: true
      };
      const articlesFile = path.join(dir, 'data', 'articles.json');
      const doc = readJson(articlesFile);
      doc.articles = [article];
      fs.writeFileSync(articlesFile, JSON.stringify(doc, null, 2) + '\n');
      const before = fs.readFileSync(articlesFile, 'utf8');
      const result = appendArticles({
        root: dir,
        articles: [{ ...article, title_zh: '试图覆盖', is_read: false }],
        now,
        dedupe: config.dedupe,
        historyLimit: 20,
        rebuildFallback: false
      });
      assert.equal(result.written, 0);
      assert.equal(fs.readFileSync(articlesFile, 'utf8'), before, '幂等跳过不得改写已有文章/已读字段');
    });

    await run('禁止翻译来源只进入人工队列，不生成摘要', async () => {
      const { dir, config, source } = setup();
      tempDirs.push(dir);
      const sourceDoc = readJson(path.join(dir, 'data', 'sources.json'));
      sourceDoc.sources[0].translation_allowed = false;
      fs.writeFileSync(path.join(dir, 'data', 'sources.json'), JSON.stringify(sourceDoc, null, 2) + '\n');
      let called = 0;
      const result = await runPipeline({
        root: dir, config, now, sourceId: source.id,
        fetchImpl: fetchFor(), llmImpl: async () => { called++; throw new Error('不应调用'); }
      });
      assert.equal(called, 0);
      assert.equal(result.counters.title_only_queued, 1);
      assert.equal(readArticles(dir).length, 0);
      const queue = loadQueue(dir);
      assert.equal(queue.items[0].status, 'title_only');
      assert.equal(queue.items[0].summary_zh, undefined);
    });

    await run('摘要硬上限确定性截断，空摘要进入人工队列', async () => {
      const first = setup();
      tempDirs.push(first.dir);
      const long = llmFactory({ summary_zh: '摘要内容。'.repeat(80) });
      const firstRun = await runPipeline({
        root: first.dir, config: first.config, now, sourceId: 'fixture',
        fetchImpl: fetchFor(), llmImpl: long.llmImpl
      });
      assert.equal(firstRun.counters.processing_truncated, 1);
      assert.equal(long.state.calls, 1, '截断不得二次调用 LLM');
      const article = readArticles(first.dir)[0];
      assert.ok([...article.summary_zh].length <= 25);
      assert.match(article.translation_note, /摘要已截断/);

      const second = setup();
      tempDirs.push(second.dir);
      const empty = llmFactory({ summary_zh: '' });
      const secondRun = await runPipeline({
        root: second.dir, config: second.config, now, sourceId: 'fixture',
        fetchImpl: fetchFor(), llmImpl: empty.llmImpl
      });
      assert.equal(secondRun.counters.processing_failed, 1);
      assert.equal(readArticles(second.dir).length, 0);
      assert.ok(loadQueue(second.dir).items.some((item) => item.status === 'manual_review'));
    });

    await run('同一内容失败 3 次后不再自动重试', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      let calls = 0;
      const failing = async () => {
        calls++;
        const error = new Error('模型返回格式错误');
        error.code = 'invalid_format';
        throw error;
      };
      for (let i = 0; i < 3; i++) {
        await runPipeline({
          root: dir, config, sourceId: 'fixture', force: true,
          now: new Date(Date.parse(now) + i * 3600000).toISOString(),
          fetchImpl: fetchFor({ xml: rss({ title: 'Retry story', link: 'https://fixture.example/retry', guid: 'retry-1' }) }),
          llmImpl: failing
        });
      }
      const fourth = await runPipeline({
        root: dir, config, sourceId: 'fixture', force: true,
        now: '2026-11-17T12:00:00.000Z',
        fetchImpl: fetchFor({ xml: rss({ title: 'Retry story', link: 'https://fixture.example/retry', guid: 'retry-1' }) }),
        llmImpl: failing
      });
      assert.equal(calls, 3, '第 4 次不得再调用模型');
      assert.equal(fourth.counters.published, 0);
      assert.equal(readArticles(dir).length, 0);
    });

    await run('连续失败暂停来源且成功请求不自动恢复；7 天无条目降频', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      for (let i = 0; i < 5; i++) {
        await runPipeline({
          root: dir, config, sourceId: 'fixture', force: true,
          now: new Date(Date.parse(now) + i * 3600000).toISOString(),
          fetchImpl: fetchFor({ mode: 'fail' }),
          llmImpl: llmFactory().llmImpl
        });
      }
      let health = loadState(dir).sources.fixture;
      assert.equal(health.paused, true);
      assert.equal(health.consecutive_failures, 5);
      assert.equal(readJson(path.join(dir, 'data', 'sources.json')).sources[0].status, 'paused', '连续失败必须同步暂停来源台账');
      assert.equal(readJson(path.join(dir, 'data', 'sources.json')).sources[0].pending_review, true);
      const skipped = await runPipeline({
        root: dir, config, sourceId: 'fixture', force: true,
        now: new Date(Date.parse(now) + 8 * 3600000).toISOString(),
        fetchImpl: fetchFor(),
        llmImpl: llmFactory().llmImpl
      });
      assert.equal(skipped.counters.skipped, 1);
      assert.equal(readArticles(dir).length, 0);

      const low = setup();
      tempDirs.push(low.dir);
      const lowState = loadState(low.dir);
      lowState.sources.fixture = {
        ...require('../lib/state').defaultSourceState(low.source, low.config.routing.fixture),
        last_item_at: '2026-11-01',
        etag: '"v1"'
      };
      saveState(low.dir, lowState);
      const lowRun = await runPipeline({
        root: low.dir, config: low.config, sourceId: 'fixture', force: true, now,
        fetchImpl: fetchFor({ mode: '304' }),
        llmImpl: llmFactory().llmImpl
      });
      const after = loadState(low.dir).sources.fixture;
      assert.equal(after.low_activity, true);
      assert.equal(after.interval_minutes, 1440);
      assert.ok(after.recheck_due_at, '低活跃来源应写入 90 天复核到期时间');
      assert.ok(Date.parse(after.recheck_due_at) > Date.parse(now), '复核时间应晚于当前时间');
      assert.equal(lowRun.counters.status_304, 1);
    });

    await run('takedown 下架历史内容并暂停来源，恢复来源不恢复内容', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      const llm = llmFactory();
      await runPipeline({ root: dir, config, now, sourceId: 'fixture', fetchImpl: fetchFor(), llmImpl: llm.llmImpl });
      assert.equal(readArticles(dir).length, 1);
      const article = readArticles(dir)[0];
      const record = await applyTakedown({
        root: dir,
        sourceIds: ['fixture'],
        contentIds: [article.id],
        reason: '测试投诉',
        notice: 'notice-1'
      });
      assert.equal(record.affected_count, 1);
      assert.equal(readJson(path.join(dir, 'data', 'sources.json')).sources[0].status, 'paused');
      const removed = readArticles(dir)[0];
      assert.equal(removed.takedown.status, 'removed');

      const resumed = await resumeSources({ root: dir, sourceIds: ['fixture'], reason: '人工复核完成' });
      assert.equal(resumed.resumed.length, 1);
      assert.equal(readJson(path.join(dir, 'data', 'sources.json')).sources[0].status, 'active');
      const stillRemoved = readArticles(dir)[0];
      assert.equal(stillRemoved.takedown.status, 'removed');
      const category = readJson(path.join(dir, 'data', 'domains.json')).categories.find((item) => item.id === stillRemoved.category);
      const evaluated = Quality.evaluate(stillRemoved, readJson(path.join(dir, 'data', 'sources.json')).sources[0], category, siteConfig, new Date(now));
      assert.equal(evaluated.ok, false);
      assert.ok(evaluated.reasons.some((item) => item.code === 'taken_down'));
    });

    await run('运行日志记录来源、层级和原因', async () => {
      const { dir, config } = setup();
      tempDirs.push(dir);
      await runPipeline({
        root: dir, config, sourceId: 'fixture', now,
        fetchImpl: fetchFor({ xml: rss({ body: 'short', title: 'Too short' }) }),
        llmImpl: llmFactory().llmImpl
      });
      const log = fs.readFileSync(path.join(dir, 'pipeline', 'logs', 'update-20261116.log'), 'utf8');
      assert.match(log, /"layer":"screen"/);
      assert.match(log, /"source_id":"fixture"/);
      assert.match(log, /"reason":"too_short"/);
    });
  } finally {
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }
}

main().then(() => {
  process.stdout.write('\n全部管道测试通过。\n');
}).catch((error) => {
  process.stderr.write('\n管道测试失败：' + (error.stack || error.message) + '\n');
  process.exitCode = 1;
});
