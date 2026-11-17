/* 启动：装载数据，失败时给出可操作的兜底提示。 */
(function (global) {
  'use strict';

  function renderFatal(error) {
    const status = document.getElementById('feed-status');
    const grid = document.getElementById('card-grid');
    if (grid) grid.hidden = true;
    if (!status) return;
    status.hidden = false;
    status.innerHTML = '' +
      '<div class="empty-state" style="margin-top:0">' +
        '<span class="empty-mark">!</span>' +
        '<h2>页面没有成功装载内容。</h2>' +
        '<p>静态数据读取失败，或本地文件模式缺少内嵌快照。请用本地 HTTP 服务打开，或确认 data/fallback-data.js 已生成。</p>' +
        '<div class="empty-actions">' +
          '<button type="button" class="button button-primary" id="fatal-reload">重新加载</button>' +
          '<button type="button" class="button button-quiet" id="fatal-details">查看错误</button>' +
        '</div>' +
        '<pre id="fatal-error" style="display:none;text-align:left;white-space:pre-wrap;margin-top:18px;font-size:11px;color:var(--muted)"></pre>' +
      '</div>';
    const reload = document.getElementById('fatal-reload');
    if (reload) reload.addEventListener('click', () => location.reload());
    const details = document.getElementById('fatal-details');
    const pre = document.getElementById('fatal-error');
    if (details && pre) {
      details.addEventListener('click', () => {
        pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
        pre.textContent = String(error && (error.stack || error.message) || error || '未知错误');
      });
    }
    console.error(error);
  }

  async function boot() {
    const config = global.APP_CONFIG;
    if (!config) {
      renderFatal(new Error('APP_CONFIG 未加载。'));
      return;
    }
    try {
      const data = await global.DataLoader.loadAll(config);
      global.UI.boot(data);
      document.documentElement.classList.add('app-ready');
    } catch (error) {
      renderFatal(error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})(window);
