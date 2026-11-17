#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs } = require('./lib/util');
const { runPipeline } = require('./update');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      '用法：node pipeline/scheduler.js [选项]',
      '  --tick <秒>        调度器检查间隔，默认 60 秒；来源间隔仍由 config 控制',
      '  --source-id <id>   只调度指定来源，可重复',
      '  --once             只运行一次后退出',
      '  --help             显示帮助',
      '说明：这是内置调度器；生产也可用系统 cron / Windows 计划任务直接调用 update.js。'
    ].join('\n') + '\n');
    return;
  }
  const tick = Math.max(10, Number(args.tick) || 60) * 1000;
  let stopping = false;
  let busy = false;
  const stop = () => {
    stopping = true;
    process.stdout.write('[scheduler] 收到停止信号；当前一轮结束后退出。\n');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  do {
    if (busy) {
      await wait(tick);
      continue;
    }
    busy = true;
    try {
      const result = await runPipeline({
        root: path.resolve(__dirname, '..'),
        sourceId: args.sourceId,
        force: Boolean(args.force)
      });
      process.stdout.write(JSON.stringify({
        at: new Date().toISOString(),
        run_id: result.run_id,
        counters: result.counters,
        publish: result.publish || null
      }) + '\n');
    } catch (error) {
      process.stderr.write('[scheduler] 本轮失败：' + (error.stack || error.message) + '\n');
    } finally {
      busy = false;
    }
    if (!args.once && !stopping) await wait(tick);
  } while (!args.once && !stopping);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('[scheduler] ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}
