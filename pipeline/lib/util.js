'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function nowIso(clock) {
  return (clock ? new Date(clock) : new Date()).toISOString();
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function contentId(guid, url, title) {
  const seed = String(guid || '').trim() || (String(url || '') + '\n' + String(title || ''));
  return 'c_' + sha256(seed).slice(0, 24);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

async function writeJsonAtomicAsync(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fsp.rename(temp, file);
}

function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function appendJsonLine(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(value) {
  // Decode first so CDATA markers are removed before tag stripping. A CDATA
  // opener/closer otherwise looks like one HTML tag and the body disappears.
  return decodeEntities(String(value || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(text, language) {
  const value = stripHtml(text);
  if (!value) return 0;
  if (language === 'zh') return [...value.replace(/\s+/g, '')].length;
  return (value.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length;
}

function countSentences(text) {
  const sentences = String(text || '').match(/[^。！？.!?]+[。！？.!?]+/g);
  if (sentences && sentences.length) return sentences.length;
  const t = String(text || '').trim();
  return t ? 1 : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sentenceTruncate(text, limit) {
  const value = String(text || '');
  const chars = [...value];
  if (chars.length <= limit) return { text: value, truncated: false, dropped: 0 };
  if (limit <= 0) return { text: '', truncated: true, dropped: chars.length };
  const units = value.match(/[^。！？.!?]+[。！？.!?]+[”’"']?/g) || [];
  let output = '';
  for (const unit of units) {
    if ([...output + unit].length > limit) break;
    output += unit;
  }
  if (!output) output = chars.slice(0, limit).join('');
  const trimmed = output.trim();
  return { text: trimmed, truncated: true, dropped: chars.length - [...trimmed].length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value = eq >= 0 ? arg.slice(eq + 1) : true;
    if (eq < 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    }
    if (args[key] === undefined) args[key] = value;
    else if (Array.isArray(args[key])) args[key].push(value);
    else args[key] = [args[key], value];
  }
  return args;
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

module.exports = {
  appendJsonLine,
  asArray,
  clamp,
  contentId,
  countSentences,
  countWords,
  dateOnly,
  decodeEntities,
  ensureDir,
  normalizeSpace,
  nowIso,
  parseArgs,
  readJson,
  relative,
  safeHost,
  sentenceTruncate,
  sha256,
  sleep,
  stripHtml,
  writeJsonAtomic,
  writeJsonAtomicAsync,
  writeTextAtomic
};
