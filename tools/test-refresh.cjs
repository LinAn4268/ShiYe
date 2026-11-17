/* 新刷新逻辑测试：新内容池合规、感兴趣/已换入状态的持久化、加权挑选。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
let pass = 0;
function ok(name, fn) {
  try { fn(); console.log('✓ ' + name); pass++; }
  catch (e) { console.error('✗ ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

// ---- 1. 新内容池合规：全部通过四层质量筛选 ----
ok('新内容池 28 条全部通过质量筛选且主题唯一', () => {
  const sandbox = { window: {}, console };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/config.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/quality.js'), 'utf8'), sandbox);
  const cfg = sandbox.window.APP_CONFIG;
  const Quality = sandbox.window.Quality;
  const fresh = JSON.parse(fs.readFileSync(path.join(root, 'data/fresh-articles.json'), 'utf8'));
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'data/sources.json'), 'utf8')).sources;
  const categories = JSON.parse(fs.readFileSync(path.join(root, 'data/domains.json'), 'utf8')).categories;
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const now = Quality.parseDate(cfg.snapshotDate) || new Date();
  let failed = 0;
  for (const a of fresh.articles) {
    const r = Quality.evaluate(a, sourceMap.get(a.source_id), catMap.get(a.category), cfg, now);
    if (!r.ok) { failed++; console.error('    ' + a.id + ': ' + r.reasons.map((x) => x.code || x).join(',')); }
  }
  assert.strictEqual(failed, 0, failed + ' 条新内容未通过质量筛选');
  assert.strictEqual(fresh.articles.length, 28, '新内容池应为 28 条');
  const urls = new Set(fresh.articles.map((a) => a.url));
  assert.strictEqual(urls.size, 28, '新内容 URL 应唯一');
});

// ---- 2. storage.js 感兴趣/已换入集合持久化 ----
function loadStorage(seed) {
  const store = Object.assign({}, seed || {});
  const sandbox = { window: { APP_CONFIG: { storagePrefix: 'test.v1.' } }, console };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/storage.js'), 'utf8'), sandbox);
  return { Store: sandbox.window.Store, store };
}

ok('感兴趣标记可增删并在 getState 中读取', () => {
  const { Store } = loadStorage();
  let state = Store.markInterested('a01', true);
  assert(state.interestedIds.includes('a01'));
  assert(Store.isInterested('a01'));
  state = Store.markInterested('a02', true);
  assert.strictEqual(state.interestedIds.length, 2);
  state = Store.markInterested('a01', false);
  assert(!state.interestedIds.includes('a01'));
  assert(!Store.isInterested('a01'));
});

ok('已换入新内容 id 去重合并持久化', () => {
  const { Store } = loadStorage();
  Store.addUsedFreshIds(['f01', 'f02', 'f01']);
  let used = Store.getUsedFreshIds();
  assert.strictEqual(used.length, 2, '重复 id 应去重');
  Store.addUsedFreshIds(['f02', 'f03']);
  used = JSON.parse(JSON.stringify(Store.getUsedFreshIds()));
  assert.deepStrictEqual(used.slice().sort(), ['f01', 'f02', 'f03']);
});

ok('损坏的 interestedIds 数据退化为 []', () => {
  const { Store } = loadStorage({ 'test.v1.interestedIds': '{bad json' });
  const state = JSON.parse(JSON.stringify(Store.getState()));
  assert.deepStrictEqual(state.interestedIds, []);
});

// ---- 3. recommender 导出 arrangeForSources ----
ok('arrangeForSources 已全局导出且遵守同源连续上限', () => {
  const sandbox = { window: {}, console };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/recommender.js'), 'utf8'), sandbox);
  assert.strictEqual(typeof sandbox.window.Recommender.arrangeForSources, 'function');
  const items = ['n', 'n', 'n', 'n', 'b', 'b'].map((src, i) => ({
    article: { source_id: src, id: 'x' + i }, quality: { score: 3 }
  }));
  const arranged = sandbox.window.Recommender.arrangeForSources(items, 2);
  let run = 0, prev = null, max = 0;
  for (const it of arranged) {
    run = it.article.source_id === prev ? run + 1 : 1;
    prev = it.article.source_id;
    max = Math.max(max, run);
  }
  assert(max <= 2, '同源连续不应超过 2，实际 ' + max);
});

console.log('\n新刷新逻辑测试全部通过：' + pass + ' 项');
