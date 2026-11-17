#!/usr/bin/env node
/* 自定义标签引擎测试：用 Node vm 加载 custom-tags.js，注入 mock Store。零浏览器依赖。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'assets/js/custom-tags.js'), 'utf8');

function makeEngine() {
  const mem = {};
  const store = {
    getCustomTags() { return mem.tags ? JSON.parse(JSON.stringify(mem.tags)) : []; },
    saveCustomTags(rules) { mem.tags = JSON.parse(JSON.stringify(rules)); return true; }
  };
  const sandbox = { window: {}, Store: store, Date, Set, Array, String, Math, JSON, console };
  sandbox.window.Store = store;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'custom-tags.js' });
  // 引擎读取的是 global.Store（即 sandbox.Store）
  sandbox.window.Store = store;
  return { engine: sandbox.window.CustomTags, mem, store };
}

function article(overrides) {
  return Object.assign({
    id: 'a01',
    category: 'science-nature',
    title_original: 'A Global Rebound for Mangroves',
    title_zh: '红树林的全球回升',
    summary_zh: '卫星数据显示红树林面积在 2010 年后重新增长。',
    source_name: 'NASA',
    source_domain: 'science.nasa.gov',
    tags: ['地球观测'],
    event_key: 'mangrove'
  }, overrides || {});
}

const results = [];
function test(name, fn) {
  try { fn(); results.push([true, name]); console.log('✓ ' + name); }
  catch (error) { results.push([false, name, error]); console.log('✗ ' + name + '\n  ' + error.message); }
}

test('创建规则并校验名称/关键词', () => {
  const { engine } = makeEngine();
  const r = engine.add('红树林', 'science-nature', '红树林, mangrove； 卫星', ['地球观测']);
  assert.equal(r.ok, true);
  assert.equal(r.rule.name, '红树林');
  assert.deepEqual(JSON.parse(JSON.stringify(r.rule.keywords)), ['红树林', 'mangrove', '卫星']);
});

test('名称与已有标签重复时被拒绝', () => {
  const { engine } = makeEngine();
  const r = engine.add('地球观测', 'all', '卫星', ['地球观测']);
  assert.equal(r.ok, false);
  assert.match(r.error, /已存在/);
});

test('关键词匹配命中文章并幂等打标签', () => {
  const { engine } = makeEngine();
  engine.add('红树林', 'science-nature', 'mangrove', []);
  const a = article();
  const first = engine.applyTo([a]);
  assert.equal(first.applied, 1);
  assert.equal(first.touched, 1);
  assert.ok(a.tags.includes('红树林'));
  const second = engine.applyTo([a]);
  assert.equal(second.applied, 0, '重复套用不应重复添加');
  assert.equal(a.tags.filter((t) => t === '红树林').length, 1);
});

test('领域范围生效：不匹配领域不打标签', () => {
  const { engine } = makeEngine();
  engine.add('红树林', 'business-finance', 'mangrove', []);
  const a = article();
  engine.applyTo([a]);
  assert.equal(a.tags.includes('红树林'), false);
});

test('全部领域规则可跨领域命中', () => {
  const { engine } = makeEngine();
  engine.add('碳汇', 'all', 'carbon', []);
  const a = article({ summary_zh: '相关研究关注 carbon 储存。' });
  engine.applyTo([a]);
  assert.ok(a.tags.includes('碳汇'));
});

test('删除规则后从文章移除标签', () => {
  const { engine } = makeEngine();
  const r = engine.add('红树林', 'all', 'mangrove', []);
  const a = article();
  engine.applyTo([a]);
  assert.ok(a.tags.includes('红树林'));
  const del = engine.remove(r.rule.id);
  assert.equal(del.ok, true);
  engine.removeFrom([a], del.rule.name);
  assert.equal(a.tags.includes('红树林'), false);
});

test('损坏的 localStorage 数据退化为 []，不崩溃', () => {
  const { engine, store } = makeEngine();
  store.saveCustomTags({ bad: true });
  assert.deepEqual(JSON.parse(JSON.stringify(engine.getAll())), []);
  store.saveCustomTags([{ id: 'x' }, null, { name: 'ok', id: 'y', keywords: ['a'] }]);
  const all = engine.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'ok');
});

test('countFor 统计命中条数', () => {
  const { engine } = makeEngine();
  const r = engine.add('红树林', 'all', 'mangrove', []).rule;
  const list = [article(), article({ id: 'a02', title_original: 'Unrelated', title_zh: '无关', summary_zh: '无', tags: [] })];
  assert.equal(engine.countFor(r, list), 1);
});

test('规则数量上限 40', () => {
  const { engine, mem } = makeEngine();
  const rules = [];
  for (let i = 0; i < 40; i++) rules.push({ id: 'r' + i, name: 't' + i, category: 'all', keywords: ['k' + i], created_at: '' });
  mem.tags = rules;
  const r = engine.add('第41个', 'all', 'x', []);
  assert.equal(r.ok, false);
  assert.match(r.error, /最多/);
});

const failed = results.filter((r) => !r[0]);
if (failed.length) {
  console.error('\n自定义标签测试失败：' + failed.length + '/' + results.length);
  process.exit(1);
} else {
  console.log('\n自定义标签测试全部通过：' + results.length + ' 项');
}
