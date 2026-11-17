'use strict';

const path = require('node:path');
const { appendJsonLine, ensureDir, nowIso, readJson, writeJsonAtomic } = require('./util');
const { loadState, saveState, sourceState } = require('./state');
const { acquireLock, rebuildFallback } = require('./publish');

async function resumeSources(options) {
  const root = options.root;
  const ids = [...new Set((options.sourceIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) throw new Error('必须提供 --source-id');
  if (!options.reason) throw new Error('必须提供 --reason（人工复核结论）');
  let release = null;
  if (!options.dryRun) {
    release = await acquireLock(root, {
      timeoutMs: options.lockTimeoutMs,
      label: 'resume'
    });
  }
  try {
  const sourceFile = path.join(root, 'data', 'sources.json');
  const sourceDoc = readJson(sourceFile);
  const state = loadState(root);
  const now = nowIso();
  const resumed = [];
  for (const id of ids) {
    const source = (sourceDoc.sources || []).find((item) => item.id === id);
    if (!source) throw new Error('来源不存在：' + id);
    if (source.status !== 'paused') throw new Error('来源不是暂停状态，拒绝恢复：' + id);
    const health = sourceState(state, source, { interval_minutes: source.request_interval_minutes });
    if (!options.dryRun) {
      source.status = 'active';
      source.paused_at = null;
      source.pause_reason = '';
      source.pending_review = false;
      source.updated_at = now;
      health.paused = false;
      health.pending_review = false;
      health.pause_reason = '';
      health.paused_at = null;
      health.consecutive_failures = 0;
      health.last_error = '';
      health.last_status = 'resumed';
      health.next_run_at = now;
    }
    resumed.push({ id, name: source.name, dry_run: Boolean(options.dryRun) });
  }
  if (!options.dryRun) {
    sourceDoc.updated_at = now.slice(0, 10);
    writeJsonAtomic(sourceFile, sourceDoc);
    saveState(root, state);
    const dir = path.join(root, 'pipeline', 'logs');
    ensureDir(dir);
    appendJsonLine(path.join(dir, 'resume.jsonl'), { at: now, sources: ids, reason: options.reason, actor: options.actor || 'operator' });
  }
  const fallback = options.dryRun ? { ok: false, skipped: true, message: 'dry-run：未重建 fallback' } : rebuildFallback(root);
  return { resumed, fallback, note: '仅恢复抓取；已下架内容不会恢复。' };
  } finally {
    if (release) release();
  }
}

module.exports = { resumeSources };
