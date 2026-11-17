'use strict';

const path = require('node:path');
const { readJson, writeJsonAtomic, ensureDir, nowIso } = require('./util');

function statePaths(root) {
  const dir = path.join(root, 'pipeline', 'state');
  return {
    dir,
    update: path.join(dir, 'update-state.json'),
    processing: path.join(dir, 'processing.json'),
    queue: path.join(dir, 'manual-queue.json'),
    takedowns: path.join(dir, 'takedowns.json'),
    lock: path.join(dir, 'update.lock')
  };
}

function defaultState() {
  return {
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    last_run_at: null,
    last_run_id: null,
    sources: {}
  };
}

function defaultSourceState(source, routing) {
  const interval = Number(routing && routing.interval_minutes) || Number(source.request_interval_minutes) || 360;
  return {
    created_at: nowIso(),
    etag: '',
    last_modified: '',
    last_request_at: null,
    last_success_at: null,
    last_304_at: null,
    last_item_at: null,
    last_empty_feed_at: null,
    consecutive_failures: 0,
    empty_feed_streak: 0,
    empty_feed_warning: false,
    low_activity: false,
    low_activity_since: null,
    recheck_due_at: null,
    paused: false,
    pending_review: false,
    pause_reason: '',
    paused_at: null,
    next_run_at: null,
    interval_minutes: interval,
    last_status: 'never',
    last_error: '',
    robots: {
      checked_at: null,
      allowed: true,
      crawl_delay_seconds: 0,
      checked_url: ''
    }
  };
}

function loadState(root) {
  const file = statePaths(root).update;
  const state = readJson(file, defaultState());
  if (!state.sources || typeof state.sources !== 'object') state.sources = {};
  return state;
}

function saveState(root, state) {
  const paths = statePaths(root);
  ensureDir(paths.dir);
  state.updated_at = nowIso();
  writeJsonAtomic(paths.update, state);
}

function sourceState(state, source, routing) {
  if (!state.sources[source.id]) {
    state.sources[source.id] = defaultSourceState(source, routing);
  }
  const item = state.sources[source.id];
  if (!item.robots) item.robots = defaultSourceState(source, routing).robots;
  if (!Number.isFinite(Number(item.interval_minutes)) || Number(item.interval_minutes) <= 0) {
    item.interval_minutes = Number(routing && routing.interval_minutes) || Number(source.request_interval_minutes) || 360;
  }
  return item;
}

function loadProcessing(root) {
  return readJson(statePaths(root).processing, { version: 1, updated_at: nowIso(), items: {} });
}

function saveProcessing(root, value) {
  const paths = statePaths(root);
  ensureDir(paths.dir);
  value.updated_at = nowIso();
  writeJsonAtomic(paths.processing, value);
}

function loadQueue(root) {
  return readJson(statePaths(root).queue, { version: 1, updated_at: nowIso(), items: [] });
}

function saveQueue(root, value) {
  const paths = statePaths(root);
  ensureDir(paths.dir);
  value.updated_at = nowIso();
  writeJsonAtomic(paths.queue, value);
}

function queueManual(root, record) {
  const queue = loadQueue(root);
  const found = queue.items.find((item) => item.content_id === record.content_id);
  if (found) {
    found.attempts = (found.attempts || 1) + 1;
    found.last_seen_at = nowIso();
    found.reason = record.reason || found.reason;
  } else {
    queue.items.push({ ...record, created_at: nowIso(), last_seen_at: nowIso(), attempts: 1 });
  }
  saveQueue(root, queue);
  return queue;
}

function loadTakedowns(root) {
  return readJson(statePaths(root).takedowns, {
    version: 1,
    updated_at: nowIso(),
    sources: {},
    contents: {}
  });
}

function saveTakedowns(root, value) {
  const paths = statePaths(root);
  ensureDir(paths.dir);
  value.updated_at = nowIso();
  writeJsonAtomic(paths.takedowns, value);
}

function updateLowActivity(item, now, days) {
  const current = new Date(now).getTime();
  if (!item.last_item_at) {
    // 新来源不能一上来就被判低活跃：从首次观察到“没有条目”开始计时。
    item.low_activity_since = item.low_activity_since || item.created_at || nowIso(now);
    const since = Date.parse(item.low_activity_since);
    const stale = Number.isFinite(since) && (current - since) > days * 86400000;
    item.low_activity = stale;
    if (stale && !item.recheck_due_at) item.recheck_due_at = new Date(current + 90 * 86400000).toISOString();
    return stale;
  }
  const published = Date.parse(item.last_item_at);
  const stale = !Number.isFinite(published) || (current - published) > days * 86400000;
  item.low_activity = stale;
  if (stale) {
    item.low_activity_since = item.low_activity_since || nowIso(now);
    if (!item.recheck_due_at) item.recheck_due_at = new Date(current + 90 * 86400000).toISOString();
  }
  if (!stale) item.low_activity_since = null;
  return stale;
}

module.exports = {
  defaultSourceState,
  defaultState,
  loadProcessing,
  loadQueue,
  loadState,
  loadTakedowns,
  queueManual,
  saveProcessing,
  saveQueue,
  saveState,
  saveTakedowns,
  sourceState,
  statePaths,
  updateLowActivity
};
