#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  appendJsonLine,
  asArray,
  contentId,
  ensureDir,
  normalizeSpace,
  nowIso,
  parseArgs,
  readJson,
  stripHtml,
  writeJsonAtomic
} = require('./lib/util');
const { config: siteConfig, Quality } = require('./lib/core');
const { fetchSource } = require('./lib/feed');
const { createIndex, evaluateCandidate, addToIndex, normalizeTitle } = require('./lib/dedupe');
const { preScreen, qualitySignals, routeFor } = require('./lib/quality-gate');
const { extractWithLLM, truncateSummary } = require('./lib/llm');
const { acquireLock, appendArticles } = require('./lib/publish');
const { loadProcessing, loadQueue, loadState, loadTakedowns, queueManual, saveProcessing, saveQueue, saveState, sourceState, updateLowActivity } = require('./lib/state');

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('无效的 --now 时间：' + value);
  return date;
}

function makeRunId(now) {
  return 'run_' + now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

function logPath(root, dryRun, now) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return path.join(root, 'pipeline', 'logs', (dryRun ? 'dry-run-' : 'update-') + day + '.log');
}

function chooseBody(item) {
  const content = normalizeSpace(stripHtml(item.content_text || item.content_html || ''));
  const summary = normalizeSpace(stripHtml(item.summary_text || item.summary_html || ''));
  if (content.length >= summary.length) return content;
  return summary;
}

function sourceRouting(config, source) {
  return config.routing && config.routing[source.id] ? config.routing[source.id] : {};
}

function sourceInterval(source, routing) {
  return Number(routing.interval_minutes) || Number(source.request_interval_minutes) || 360;
}

function markPaused(item, reason, now) {
  item.paused = true;
  item.pending_review = true;
  item.pause_reason = reason;
  item.paused_at = now;
  item.last_error = reason;
}

function makeArticle(source, route, item, body, signals, cid, now) {
  const published = item.published_at || '';
  return {
    id: cid,
    content_id: cid,
    title_original: normalizeSpace(item.title),
    title_zh: '',
    summary_zh: '',
    url: item.link,
    source_id: source.id,
    source_name: source.name,
    source_domain: source.domain,
    author: normalizeSpace(item.author) || '未署名',
    published_at: published,
    category: route.category.id,
    tags: route.tags,
    language: route.language,
    license_status: source.license_basis,
    license_url: source.license_url || '',
    image_url: '',
    image_license: '未使用来源图片（CSS 占位）',
    translation_note: '',
    summary_method: '',
    summary_generated_at: '',
    is_read: false,
    fetched_at: now,
    feed_url: source.feed_url,
    guid: item.guid || item.link,
    body_words: signals.body_words,
    info_ratio: signals.info_ratio,
    density_score: signals.density_score,
    fact_score: signals.fact_score,
    representativeness: signals.representativeness,
    clickbait: false,
    event_key: 'pipeline:' + source.id + ':' + normalizeTitle(item.title).slice(0, 160)
  };
}

function recordDrop(log, run, layer, source, article, reason, stage) {
  run.dropped++;
  run.droppedReasons.push({
    layer,
    source_id: source ? source.id : '',
    content_id: article ? (article.content_id || article.id || '') : '',
    title: article ? article.title_original : '',
    reason: reason.code || reason,
    label: reason.label || '',
    stage: stage || ''
  });
  log({
    layer,
    status: 'discarded',
    source_id: source ? source.id : '',
    content_id: article ? (article.content_id || article.id || '') : '',
    title: article ? article.title_original : '',
    reason: reason.code || reason,
    label: reason.label || '',
    stage: stage || ''
  });
}

function buildLog(root, runId, dryRun, now) {
  const file = logPath(root, dryRun, now);
  ensureDir(path.dirname(file));
  return function log(event) {
    appendJsonLine(file, { ts: nowIso(), run_id: runId, dry_run: Boolean(dryRun), ...event });
  };
}

async function runPipeline(options) {
  const opts = options || {};
  const root = opts.root || path.resolve(__dirname, '..');
  const now = asDate(opts.now || new Date());
  const nowText = now.toISOString();
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const config = opts.config || readJson(path.join(root, 'pipeline', 'config.json'));
  const runId = makeRunId(now);
  const log = buildLog(root, runId, dryRun, now);
  const run = {
    run_id: runId,
    dry_run: dryRun,
    started_at: nowText,
    sources: {},
    counters: {
      sources_checked: 0,
      status_304: 0,
      status_200: 0,
      status_empty: 0,
      status_failed: 0,
      skipped: 0,
      exact_duplicates: 0,
      fuzzy_duplicates: 0,
      fuzzy_suspects: 0,
      screening_rejected: 0,
      title_only_queued: 0,
      processing_ok: 0,
      processing_failed: 0,
      processing_truncated: 0,
      processing_would: 0,
      published: 0,
      dropped: 0
    },
    dropped: 0,
    droppedReasons: [],
    notes: []
  };
  let release = null;
  if (!dryRun) {
    release = await acquireLock(root, {
      timeoutMs: config.publish && config.publish.lock_timeout_ms,
      staleMs: config.publish && config.publish.lock_stale_ms,
      label: runId
    });
  }

  try {
  const sourceDoc = readJson(path.join(root, 'data', 'sources.json'));
  const categoriesDoc = readJson(path.join(root, 'data', 'domains.json'));
  const articlesDoc = readJson(path.join(root, 'data', 'articles.json'));
  const categories = categoriesDoc.categories || [];
  const takedowns = loadTakedowns(root);
  const state = loadState(root);
  const processing = loadProcessing(root);
  const queue = loadQueue(root);
  const selected = new Set(asArray(opts.sourceId).flatMap((value) => String(value).split(',')).map((s) => s.trim()).filter(Boolean));
  const existing = Array.isArray(articlesDoc.articles) ? articlesDoc.articles : [];
  const index = createIndex(existing, config.dedupe);
  const pendingPublish = [];
  const autoPaused = new Set();
  const queueBefore = JSON.stringify(queue.items || []);

  function sourceLog(source, event) {
    log({ ...event, source_id: source.id, source_name: source.name });
  }

  const activeSources = (sourceDoc.sources || []).filter((source) => {
      if (selected.size && !selected.has(source.id)) return false;
      return source.status === 'active' || source.status === 'paused';
    });
    for (const source of activeSources) {
      if (source.status !== 'active') {
        run.counters.skipped++;
        run.sources[source.id] = { status: 'paused', new_items: 0, published: 0, dropped: 0 };
        sourceLog(source, { layer: 'fetch', status: 'skipped', reason: 'source_paused', message: source.pause_reason || '来源已暂停，等待人工复核' });
        continue;
      }
      const routing = sourceRouting(config, source);
      const health = sourceState(state, source, routing);
      if (!health.last_item_at && source.last_item_at) health.last_item_at = source.last_item_at;
      if (!health.interval_minutes) health.interval_minutes = sourceInterval(source, routing);
      run.sources[source.id] = { status: 'pending', new_items: 0, published: 0, dropped: 0 };

      if (health.paused || health.pending_review) {
        run.counters.skipped++;
        run.sources[source.id].status = 'paused';
        sourceLog(source, { layer: 'fetch', status: 'skipped', reason: 'paused_pending_review', message: health.pause_reason || '来源已暂停，等待人工复核' });
        continue;
      }
      const next = health.next_run_at ? Date.parse(health.next_run_at) : 0;
      if (!force && Number.isFinite(next) && next > now.getTime()) {
        run.counters.skipped++;
        run.sources[source.id].status = 'interval_wait';
        sourceLog(source, { layer: 'fetch', status: 'skipped', reason: 'interval_wait', next_run_at: health.next_run_at });
        continue;
      }

      run.counters.sources_checked++;
      health.last_request_at = nowText;
      health.interval_minutes = sourceInterval(source, routing);
      health.next_run_at = new Date(now.getTime() + health.interval_minutes * 60000).toISOString();
      sourceLog(source, { layer: 'fetch', status: 'request', interval_minutes: health.interval_minutes, force });

      let result;
      try {
        result = await fetchSource(source, health, {
          config,
          force,
          fetchImpl: opts.fetchImpl
        });
      } catch (error) {
        result = { status: 'failed', error: error.message, items: [] };
      }

      if (result.status === '304') {
        run.counters.status_304++;
        health.last_304_at = nowText;
        health.last_status = '304';
        health.last_error = '';
        if (result.headers) {
          health.etag = result.headers.etag || health.etag;
          health.last_modified = result.headers.lastModified || health.last_modified;
        }
        run.sources[source.id].status = '304';
        sourceLog(source, {
          layer: 'fetch', status: '304',
          consecutive_failures: health.consecutive_failures,
          empty_feed_streak: health.empty_feed_streak,
          message: '内容未变；未重置失败次数或空 feed 警告'
        });
      } else if (result.status === 'empty') {
        run.counters.status_empty++;
        health.last_success_at = nowText;
        health.last_empty_feed_at = nowText;
        health.empty_feed_streak = (health.empty_feed_streak || 0) + 1;
        health.empty_feed_warning = health.empty_feed_streak >= 2;
        health.last_status = 'empty';
        health.last_error = '';
        health.etag = (result.headers && result.headers.etag) || health.etag;
        health.last_modified = (result.headers && result.headers.lastModified) || health.last_modified;
        run.sources[source.id].status = 'empty';
        sourceLog(source, { layer: 'fetch', status: 'empty', empty_feed_streak: health.empty_feed_streak, warning: health.empty_feed_warning });
      } else if (result.status === '200') {
        run.counters.status_200++;
        health.last_success_at = nowText;
        health.last_status = '200';
        health.last_error = '';
        health.consecutive_failures = 0;
        health.empty_feed_streak = 0;
        health.empty_feed_warning = false;
        health.etag = (result.headers && result.headers.etag) || health.etag;
        health.last_modified = (result.headers && result.headers.lastModified) || health.last_modified;
        run.sources[source.id].status = '200';
        sourceLog(source, { layer: 'fetch', status: '200', items: result.items.length });
      } else {
        run.counters.status_failed++;
        health.consecutive_failures = (health.consecutive_failures || 0) + 1;
        health.last_status = 'failed';
        health.last_error = result.error || result.status;
        if (health.consecutive_failures >= (config.health.failure_threshold || 5)) {
          markPaused(health, '连续抓取失败 ' + health.consecutive_failures + ' 次：' + health.last_error, nowText);
          autoPaused.add(source.id);
          sourceLog(source, { layer: 'fetch', status: 'paused', consecutive_failures: health.consecutive_failures, reason: 'failure_threshold', message: health.pause_reason });
        } else {
          sourceLog(source, { layer: 'fetch', status: 'failed', consecutive_failures: health.consecutive_failures, error: health.last_error });
        }
        run.sources[source.id].status = health.paused ? 'paused' : 'failed';
      }

      const wasLow = health.low_activity;
      if (updateLowActivity(health, now, config.health.low_activity_days || 7)) {
        if (!wasLow) {
          health.interval_minutes = Math.min(1440, Math.max(health.interval_minutes, 1440));
          health.next_run_at = new Date(now.getTime() + health.interval_minutes * 60000).toISOString();
          sourceLog(source, { layer: 'health', status: 'low_activity', message: '连续 7 天无有效条目，已降频；进入 90 天复核队列' });
        }
      }

      const beforeNew = run.sources[source.id].new_items;
      for (const item of result.items || []) {
        if (!item.title || !item.link) continue;
        const body = chooseBody(item);
        const cid = contentId(item.guid, item.link, item.title);
        const route = routeFor(source, item, routing, categories);
        if (!route.category) {
          recordDrop(log, run, 'route', source, { content_id: cid, title_original: item.title }, { code: 'no_category', label: '无法映射到合法一级领域' });
          run.sources[source.id].dropped++;
          continue;
        }
        if (takedowns.contents[cid] && takedowns.contents[cid].removed) {
          recordDrop(log, run, 'dedupe', source, { content_id: cid, title_original: item.title }, { code: 'takedown', label: '该内容已下架，禁止重新进入推荐池' });
          run.sources[source.id].dropped++;
          continue;
        }
        const candidate = {
          id: cid,
          content_id: cid,
          guid: item.guid || item.link,
          url: item.link,
          title_original: normalizeSpace(item.title),
          source_id: source.id,
          _body_text: source.fulltext_allowed === true ? body : ''
        };
        const check = evaluateCandidate(candidate, index);
        if (check.duplicate) {
          run.counters.exact_duplicates++;
          if (check.duplicate.code === 'fuzzy_body') {
            run.counters.exact_duplicates--;
            run.counters.fuzzy_duplicates++;
          }
          recordDrop(log, run, 'dedupe', source, candidate, check.duplicate);
          run.sources[source.id].dropped++;
          continue;
        }
        if (check.suspect) {
          run.counters.fuzzy_suspects++;
          sourceLog(source, { layer: 'dedupe', status: 'suspect', content_id: cid, reason: check.suspect.code, message: check.suspect.label });
        }

        // 许可禁止翻译/衍生的来源只保留标题索引，不生成摘要，也不进入推荐池。
        // 这保持了既有 Quality.evaluate 的 translation_forbidden 硬否决。
        if (source.translation_allowed !== true) {
          run.counters.title_only_queued++;
          const record = {
            content_id: cid,
            status: 'title_only',
            reason: '来源未授权翻译/衍生，仅保留标题与链接，不生成摘要',
            source_id: source.id,
            source_name: source.name,
            title_original: item.title,
            url: item.link,
            author: item.author || '未署名',
            published_at: item.published_at || '',
            language: route.language,
            category: route.category.id,
            tags: route.tags,
            fetched_at: nowText
          };
          if (!dryRun) queueManual(root, record);
          sourceLog(source, { layer: 'processing', status: 'title_only_queued', content_id: cid });
          continue;
        }

        const signals = qualitySignals(body, route.language, route);
        const article = makeArticle(source, route, item, body, signals, cid, nowText);
        const pre = preScreen(article, source, route.category, siteConfig, now);
        if (!pre.ok) {
          run.counters.screening_rejected++;
          const primary = pre.reasons[0] || { code: 'screened_out', label: '筛选未通过' };
          recordDrop(log, run, 'screen', source, article, primary, pre.reasons.map((reason) => reason.code).join(','));
          run.sources[source.id].dropped++;
          continue;
        }

        const previous = processing.items[cid];
        if (previous && previous.status === 'failed' && (previous.attempts || 0) >= 3) {
          run.counters.processing_failed++;
          sourceLog(source, { layer: 'processing', status: 'skipped_failed', content_id: cid, message: '同一内容连续失败 3 次，不再自动重试' });
          continue;
        }

        if (dryRun) {
          run.counters.processing_would++;
          sourceLog(source, {
            layer: 'processing', status: 'would_process', content_id: cid,
            summary_limit: pre.summaryLimit,
            category: route.category.id,
            tags: route.tags,
            message: 'dry-run：仅计算，不调用 LLM、不写内容池'
          });
          continue;
        }

        processing.items[cid] = {
          status: 'processing',
          attempts: (previous && previous.attempts) || 0,
          source_id: source.id,
          url: item.link,
          title_original: article.title_original,
          updated_at: nowText
        };
        let extracted;
        try {
          const llmOptions = { fetchImpl: opts.llmFetchImpl };
          extracted = opts.llmImpl
            ? await opts.llmImpl(article, body, pre.summaryLimit, config.llm, llmOptions)
            : await extractWithLLM(article, body, pre.summaryLimit, config.llm, llmOptions);
        } catch (error) {
          const attempts = ((processing.items[cid] && processing.items[cid].attempts) || 0) + 1;
          processing.items[cid] = {
            status: attempts >= 3 ? 'failed' : 'retry',
            attempts,
            source_id: source.id,
            url: item.link,
            title_original: article.title_original,
            last_error: error.message,
            code: error.code || 'llm_error',
            updated_at: nowText
          };
          run.counters.processing_failed++;
          recordDrop(log, run, 'process', source, article, { code: error.code || 'llm_error', label: error.message }, 'llm');
          if (error.code === 'empty_summary' || error.code === 'empty_response' || error.code === 'invalid_format') {
            queueManual(root, {
              content_id: cid,
              status: 'manual_review',
              reason: error.message,
              source_id: source.id,
              source_name: source.name,
              title_original: article.title_original,
              url: item.link,
              attempts
            });
          }
          continue;
        }

        const truncated = truncateSummary(extracted.summary_zh, pre.summaryLimit);
        if (!truncated.summary_zh) {
          const attempts = ((processing.items[cid] && processing.items[cid].attempts) || 0) + 1;
          processing.items[cid] = {
            status: 'failed', attempts, source_id: source.id, url: item.link,
            title_original: article.title_original, last_error: '摘要为空', code: 'empty_summary', updated_at: nowText
          };
          run.counters.processing_failed++;
          recordDrop(log, run, 'process', source, article, { code: 'empty_summary', label: '摘要为空或截断后为空，进入人工队列' }, 'validate');
          queueManual(root, {
            content_id: cid, status: 'manual_review', reason: '摘要为空或截断后为空',
            source_id: source.id, source_name: source.name, title_original: article.title_original,
            url: item.link, attempts
          });
          continue;
        }
        article.title_zh = extracted.title_zh;
        article.summary_zh = truncated.summary_zh;
        article.translation_note = '由 AI/机器翻译，仅供参考。' + (truncated.truncated ? ' 摘要已截断。' : '');
        article.summary_method = 'llm:' + ((config.llm && config.llm.model) || 'unknown');
        article.summary_generated_at = nowText;
        article.summary_truncated = truncated.truncated;
        processing.items[cid] = {
          status: 'done',
          attempts: ((previous && previous.attempts) || 0) + 1,
          source_id: source.id,
          url: item.link,
          title_original: article.title_original,
          updated_at: nowText
        };
        run.counters.processing_ok++;
        if (truncated.truncated) run.counters.processing_truncated++;

        const final = Quality.evaluate(article, source, route.category, siteConfig, now);
        if (!final.ok) {
          run.counters.screening_rejected++;
          recordDrop(log, run, 'screen', source, article, final.reasons[0] || { code: 'screened_out', label: '最终校验未通过' }, final.reasons.map((reason) => reason.code).join(','));
          continue;
        }
        addToIndex(index, article, source.fulltext_allowed === true ? body : '');
        pendingPublish.push(article);
        run.sources[source.id].new_items++;
        sourceLog(source, {
          layer: 'process',
          status: truncated.truncated ? 'truncated' : 'ok',
          content_id: cid,
          summary_chars: [...truncated.summary_zh].length,
          summary_limit: pre.summaryLimit,
          score: final.score
        });
      }
      if (run.sources[source.id].new_items > beforeNew) {
        health.last_item_at = nowText.slice(0, 10);
        health.low_activity = false;
        health.low_activity_since = null;
      }
    }

    if (!dryRun && autoPaused.size) {
      const sourceFile = path.join(root, 'data', 'sources.json');
      const latestSourceDoc = readJson(sourceFile);
      for (const item of latestSourceDoc.sources || []) {
        if (!autoPaused.has(item.id)) continue;
        const health = sourceState(state, item, sourceRouting(config, item));
        item.status = 'paused';
        item.pending_review = true;
        item.pause_reason = health.pause_reason || '连续抓取失败，等待人工复核';
        item.paused_at = health.paused_at || nowText;
        item.updated_at = nowText;
      }
      latestSourceDoc.updated_at = nowText.slice(0, 10);
      writeJsonAtomic(sourceFile, latestSourceDoc);
    }

    if (!dryRun && pendingPublish.length) {
      const result = appendArticles({
        root,
        articles: pendingPublish,
        now: nowText,
        dedupe: config.dedupe,
        historyLimit: config.publish && config.publish.history_limit,
        rebuildFallback: !(config.publish && config.publish.rebuild_fallback === false)
      });
      run.counters.published = result.written;
      run.publish = {
        written: result.written,
        dropped: result.dropped.length,
        history: result.history,
        fallback: result.fallback
      };
      for (const drop of result.dropped) {
        recordDrop(log, run, 'publish', { id: drop.article.source_id, name: drop.article.source_name }, drop.article, drop.reason, 'idempotent');
      }
      for (const article of result.accepted) {
        const existingSource = run.sources[article.source_id];
        if (existingSource) existingSource.published++;
      }
    } else if (!dryRun) {
      run.counters.published = 0;
    }

    if (dryRun) {
      run.notes.push('dry-run 未调用 LLM、未写内容池、未保存 state、未重建 fallback。');
    } else {
      state.last_run_at = nowText;
      state.last_run_id = runId;
      saveState(root, state);
      saveProcessing(root, processing);
      if (JSON.stringify(queue.items || []) !== queueBefore) saveQueue(root, queue);
    }
    run.counters.dropped = run.dropped;
    run.finished_at = nowIso();
    log({ layer: 'run', status: 'summary', counters: run.counters, sources: run.sources, notes: run.notes });
    return run;
  } finally {
    if (release) release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      '用法：node pipeline/update.js [选项]',
      '  --source-id <id>   只处理指定来源，可重复或逗号分隔',
      '  --dry-run          只抓取、去重、筛选、计算；不调用 LLM、不写内容池/state',
      '  --force            忽略间隔和 robots 缓存（不恢复已暂停来源）',
      '  --now <ISO>        测试用固定时间',
      '  --help             显示帮助'
    ].join('\n') + '\n');
    return;
  }
  const result = await runPipeline({
    sourceId: args.sourceId,
    dryRun: Boolean(args.dryRun),
    force: Boolean(args.force),
    now: args.now
  });
  process.stdout.write(JSON.stringify({
    run_id: result.run_id,
    dry_run: result.dry_run,
    counters: result.counters,
    publish: result.publish || null,
    notes: result.notes
  }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('[update] ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { runPipeline, chooseBody };
