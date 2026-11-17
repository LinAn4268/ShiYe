#!/usr/bin/env node
/*
 * 将 data/*.json 打包为 data/fallback-data.js。
 * 目的：双击 index.html（file://）时无需 fetch，也能读取同一份静态快照。
 * 用法：node tools/build-fallback.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(readFileSync(resolve(root, 'data', name), 'utf8'));

const data = {
  domains: read('domains.json'),
  sources: read('sources.json'),
  articles: read('articles.json'),
  audit: read('audit.json')
};

const banner = `/*
 * 自动生成，请勿直接编辑。
 * 由 tools/build-fallback.mjs 从 data/domains.json、sources.json、articles.json、audit.json 打包。
 * 修改数据后运行：node tools/build-fallback.mjs
 */
window.__KUAYU_DATA__ = ${JSON.stringify(data, null, 2)};
`;

writeFileSync(resolve(root, 'data', 'fallback-data.js'), banner, 'utf8');
const count = Array.isArray(data.articles) ? data.articles.length : (data.articles.articles || []).length;
console.log(`[fallback] wrote data/fallback-data.js (${count} articles)`);
