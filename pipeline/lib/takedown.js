'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  appendJsonLine,
  asArray,
  ensureDir,
  nowIso,
  readJson,
  writeJsonAtomic
} = require('./util');
const { acquireLock, rebuildFallback } = require('./publish');
const { loadTakedowns, saveTakedowns } = require('./state');

async function applyTakedown(options) {
  const root = options.root;
  const now = options.now || nowIso();
  const sourceIds = [...new Set(asArray(options.sourceIds).flatMap((value) => String(value).split(',')).map((s) => s.trim()).filter(Boolean))];
  const requestedIds = new Set(asArray(options.contentIds).flatMap((value) => String(value).split(',')).map((s) => s.trim()).filter(Boolean));
  if (!sourceIds.length && !requestedIds.size) {
    throw new Error('takedown 需要至少一个 --source-id 或 --content-id');
  }
  if (!options.reason) throw new Error('takedown 必须填写 --reason');

  let release = null;
  if (!options.dryRun) {
    release = await acquireLock(root, {
      timeoutMs: options.lockTimeoutMs,
      label: 'takedown:' + (options.recordId || '')
    });
  }
  try {
  const articlesFile = path.join(root, 'data', 'articles.json');
  const sourcesFile = path.join(root, 'data', 'sources.json');
  const articlesDoc = readJson(articlesFile);
  const sourcesDoc = readJson(sourcesFile);
  const articles = Array.isArray(articlesDoc.articles) ? articlesDoc.articles : [];
  const sources = sourcesDoc.sources || [];

  const affected = [];
  const remaining = [];
  for (const article of articles) {
    const contentId = article.content_id || article.id;
    const hit = requestedIds.has(contentId) || requestedIds.has(article.id) || sourceIds.includes(article.source_id);
    if (!hit) {
      remaining.push(article);
      continue;
    }
    affected.push(article);
    if (!options.hardDelete) {
      article.takedown = {
        status: 'removed',
        reason: options.reason,
        notice: options.notice || '',
        at: now,
        record_id: options.recordId || ''
      };
      remaining.push(article);
    }
  }

  const touchedSources = new Set(sourceIds);
  for (const article of affected) touchedSources.add(article.source_id);
  for (const source of sources) {
    if (!touchedSources.has(source.id)) continue;
    source.status = 'paused';
    source.paused_at = now;
    source.pause_reason = 'takedown：' + options.reason;
    source.pending_review = true;
  }

  const takedowns = loadTakedowns(root);
  const recordId = options.recordId || 'td_' + now.replace(/[-:T]/g, '').slice(0, 15);
  const record = {
    id: recordId,
    at: now,
    action: options.hardDelete ? 'hard_delete' : 'mark_removed',
    reason: options.reason,
    notice: options.notice || '',
    actor: options.actor || 'operator',
    source_ids: [...touchedSources],
    content_ids: affected.map((article) => article.content_id || article.id),
    affected_count: affected.length
  };
  for (const sourceId of touchedSources) {
    takedowns.sources[sourceId] = {
      active: true,
      paused_at: now,
      reason: options.reason,
      notice: options.notice || '',
      record_id: recordId
    };
  }
  for (const article of affected) {
    const contentId = article.content_id || article.id;
    takedowns.contents[contentId] = {
      removed: true,
      hard_deleted: Boolean(options.hardDelete),
      source_id: article.source_id,
      at: now,
      reason: options.reason,
      record_id: recordId
    };
  }
  takedowns.records = takedowns.records || [];
  takedowns.records.push(record);

  if (!options.dryRun) {
    if (options.hardDelete) {
      articlesDoc.articles = remaining;
      articlesDoc.updated_at = now;
      writeJsonAtomic(articlesFile, articlesDoc);
    } else if (affected.length) {
      articlesDoc.updated_at = now;
      writeJsonAtomic(articlesFile, articlesDoc);
    }
    if (touchedSources.size) {
      sourcesDoc.updated_at = now.slice(0, 10);
      writeJsonAtomic(sourcesFile, sourcesDoc);
    }
    saveTakedowns(root, takedowns);
    const logDir = path.join(root, 'pipeline', 'logs');
    ensureDir(logDir);
    appendJsonLine(path.join(logDir, 'takedowns.jsonl'), record);
    record.fallback = rebuildFallback(root);
  } else {
    record.fallback = { ok: false, skipped: true, message: 'dry-run：未写入、未重建 fallback' };
  }
  return record;
  } finally {
    if (release) release();
  }
}

module.exports = { applyTakedown };
