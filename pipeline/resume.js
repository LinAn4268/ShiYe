#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { asArray, parseArgs } = require('./lib/util');
const { resumeSources } = require('./lib/resume');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      '用法：node pipeline/resume.js --source-id <id> --reason <人工复核结论>',
      '只恢复来源抓取；不会恢复已下架内容，也不会撤销 takedown 记录。',
      '  --source-id <id>   必填，可重复或逗号分隔',
      '  --reason <text>    必填，人工复核结论',
      '  --dry-run          只显示将要恢复的来源',
      '  --help             显示帮助'
    ].join('\n') + '\n');
    return;
  }
  const ids = [...new Set(asArray(args.sourceId).flatMap((value) => String(value).split(',')).map((s) => s.trim()).filter(Boolean))];
  const result = await resumeSources({
    root: path.resolve(__dirname, '..'),
    sourceIds: ids,
    reason: args.reason,
    dryRun: Boolean(args.dryRun),
    actor: args.actor
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('[resume] ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}
