/*
 * 将 assets/css/export.css 生成为可内联到 SVG foreignObject 的 JS 常量。
 * 用法：node tools/build-export-css.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = await readFile(join(root, 'assets/css/export.css'), 'utf8');
const out = '/* 自动生成，请勿手改；修改 assets/css/export.css 后运行 node tools/build-export-css.mjs */\n' +
  'window.EXPORT_CSS = ' + JSON.stringify(css) + ';\n';
await writeFile(join(root, 'assets/js/export-styles.js'), out, 'utf8');
console.log('export-styles.js 已生成：' + out.length + ' chars');
