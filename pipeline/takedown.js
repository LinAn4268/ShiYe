#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs } = require('./lib/util');
const { applyTakedown } = require('./lib/takedown');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      '用法：node pipeline/takedown.js --reason <原因> [选项]',
      '  --source-id <id>     下架该来源的全部已发布内容，并暂停来源；可重复',
      '  --content-id <id>    下架指定 content_id；可重复或逗号分隔',
      '  --reason <text>      必填，下架原因',
      '  --notice <text>      通知来源/编号',
      '  --hard-delete        物理删除文章（默认标记 removed，保留可查记录）',
      '  --dry-run            只显示影响，不写文件',
      '  --help               显示帮助'
    ].join('\n') + '\n');
    return;
  }
  if (!args.reason) throw new Error('必须提供 --reason');
  const root = path.resolve(__dirname, '..');
  const record = await applyTakedown({
    root,
    sourceIds: args.sourceId,
    contentIds: args.contentId,
    reason: args.reason,
    notice: args.notice,
    hardDelete: Boolean(args.hardDelete),
    dryRun: Boolean(args.dryRun)
  });
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('[takedown] ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { applyTakedown };
