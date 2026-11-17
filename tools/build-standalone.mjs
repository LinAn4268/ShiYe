#!/usr/bin/env node
/**
 * 生成单文件站点：docs/index.html
 * 用途：无法使用 Git 推送时，可直接把 docs/ 上传到 GitHub，
 * 将 Pages 的发布目录设为 /docs 即可；页面仍可离线双击打开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const css = [
  '/* assets/css/styles.css */',
  read('assets/css/styles.css'),
  '/* assets/css/export.css */',
  read('assets/css/export.css')
].join('\n');

let html = read('index.html');

const styleTag = `<style>\n${css}\n  </style>`;
html = html.replace(
  /  <link rel="stylesheet" href="assets\/css\/styles\.css">\n  <link rel="stylesheet" href="assets\/css\/export\.css">/,
  `  ${styleTag}`
);

html = html.replace(/  <script src="([^"]+)"><\/script>/g, (match, relative) => {
  const code = read(relative).replace(/<\/script/gi, '<\\/script');
  const flag = relative === 'assets/js/config.js'
    ? '  <script>window.__KUAYU_SINGLE_FILE__ = true;</script>\n'
    : '';
  return `${flag}  <script>\n${code}\n  </script>`;
});

if (/<script src=|<link rel="stylesheet" href="assets\//.test(html)) {
  throw new Error('仍有未内联的本地资源，请检查 index.html');
}

const output = path.join(root, 'docs');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), html, 'utf8');
fs.writeFileSync(path.join(output, '.nojekyll'), '', 'utf8');

const bytes = Buffer.byteLength(html, 'utf8');
console.log(`已生成 docs/index.html（${(bytes / 1024).toFixed(1)} KB）`);
console.log('GitHub Pages 可将发布目录设为 /docs，或上传 docs/index.html 后重命名为 index.html。');
