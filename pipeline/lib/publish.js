'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readJson, writeJsonAtomic, ensureDir, nowIso, contentId } = require('./util');
const { createIndex, evaluateCandidate } = require('./dedupe');

function stamp(value) {
  return new Date(value || Date.now()).toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

async function acquireLock(root, options) {
  const opts = options || {};
  const dir = path.join(root, 'pipeline', 'state');
  ensureDir(dir);
  const file = path.join(dir, 'update.lock');
  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const staleMs = Number(opts.staleMs) || 30 * 60 * 1000;
  const started = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso(), label: opts.label || 'update' }) + '\n');
      fs.closeSync(fd);
      return function release() {
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (current.pid === process.pid) fs.unlinkSync(file);
        } catch (error) {
          try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (_) { /* lock disappeared, retry */ }
      if (Date.now() - started >= timeoutMs) {
        const err = new Error('获取更新锁超时：另一个更新进程仍在运行');
        err.code = 'LOCK_TIMEOUT';
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function backupArticles(root, now, limit) {
  const history = path.join(root, 'pipeline', 'history');
  ensureDir(history);
  const source = path.join(root, 'data', 'articles.json');
  if (!fs.existsSync(source)) return '';
  const file = path.join(history, 'articles-' + stamp(now) + '.json');
  fs.copyFileSync(source, file);
  const files = fs.readdirSync(history)
    .filter((name) => /^articles-.*\.json$/.test(name))
    .map((name) => ({ name, time: fs.statSync(path.join(history, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const old of files.slice(Number(limit) || 20)) {
    try { fs.unlinkSync(path.join(history, old.name)); } catch (_) { /* ignore */ }
  }
  return file;
}

function rebuildFallback(root) {
  const script = path.join(root, 'tools', 'build-fallback.mjs');
  if (!fs.existsSync(script)) return { ok: false, skipped: true, message: '未找到 tools/build-fallback.mjs' };
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    return { ok: false, message: (result.stderr || result.stdout || 'fallback 构建失败').trim() };
  }
  return { ok: true, message: (result.stdout || '').trim() };
}

function appendArticles(options) {
  const root = options.root;
  const articlesFile = path.join(root, 'data', 'articles.json');
  const sourcesFile = path.join(root, 'data', 'sources.json');
  const now = options.now || new Date().toISOString();
  const incoming = options.articles || [];
  if (!incoming.length) return { accepted: [], dropped: [], written: 0, history: '', fallback: null };

  const articleDoc = readJson(articlesFile);
  const sourceDoc = readJson(sourcesFile);
  const existing = Array.isArray(articleDoc.articles) ? articleDoc.articles : [];
  const index = createIndex(existing, options.dedupe);
  const accepted = [];
  const dropped = [];

  for (const article of incoming) {
    if (existing.some((item) => item.id === article.id || (article.content_id && item.content_id === article.content_id))) {
      dropped.push({ article, reason: { code: 'content_id_exists', label: 'content_id 已存在，幂等跳过' } });
      continue;
    }
    const check = evaluateCandidate(article, index);
    if (check.duplicate) {
      dropped.push({ article, reason: check.duplicate });
      continue;
    }
    accepted.push(article);
    existing.push(article);
    index.guids.add(String(article.guid || article.content_id || ''));
    index.urls.add(require('./dedupe').canonicalUrl(article.url));
    index.titles.add(require('./dedupe').normalizeTitle(article.title_original));
    index.sourceTitles.add(String(article.source_id) + '|' + require('./dedupe').normalizeTitle(article.title_original));
  }

  if (!accepted.length) return { accepted, dropped, written: 0, history: '', fallback: null };

  const history = backupArticles(root, now, options.historyLimit);
  articleDoc.snapshot_at = now;
  articleDoc.articles = existing;
  articleDoc.updated_at = now;
  writeJsonAtomic(articlesFile, articleDoc);

  const touched = new Map();
  for (const article of accepted) {
    const previous = touched.get(article.source_id);
    if (!previous || article.published_at > previous) touched.set(article.source_id, article.published_at || now);
  }
  for (const source of sourceDoc.sources || []) {
    if (!touched.has(source.id)) continue;
    source.last_item_at = now.slice(0, 10);
    source.last_pipeline_item_at = now;
  }
  sourceDoc.updated_at = now.slice(0, 10);
  writeJsonAtomic(sourcesFile, sourceDoc);

  const manifest = {
    published_at: now,
    count: accepted.length,
    content_ids: accepted.map((article) => article.id),
    sources: [...touched.keys()],
    dropped: dropped.length,
    history
  };
  const manifestFile = path.join(root, 'pipeline', 'history', 'publish-' + stamp(now) + '.json');
  writeJsonAtomic(manifestFile, manifest);

  let fallback = null;
  if (options.rebuildFallback !== false) fallback = rebuildFallback(root);
  return { accepted, dropped, written: accepted.length, history, manifest: manifestFile, fallback };
}

module.exports = {
  acquireLock,
  appendArticles,
  backupArticles,
  rebuildFallback,
  stamp
};
