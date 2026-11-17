/* 数据装载：HTTP 下读取静态 JSON；file:// 下自动使用内嵌快照。 */
(function (global) {
  'use strict';

  function bustUrl(path, bust) {
    if (!bust) return path;
    const join = path.indexOf('?') >= 0 ? '&' : '?';
    return path + join + '_t=' + Date.now();
  }

  async function fetchJson(path, bust) {
    const response = await fetch(bustUrl(path, bust), { cache: 'no-store' });
    if (!response.ok) throw new Error(path + ' 返回 HTTP ' + response.status);
    return response.json();
  }

  async function loadAll(config, options) {
    const opts = options || {};
    const bust = opts.bust === true && config.refresh && config.refresh.cacheBust;
    const embedded = global.__KUAYU_DATA__;
    const useEmbedded = location.protocol === 'file:' || global.__KUAYU_SINGLE_FILE__ === true;

    if (useEmbedded && !embedded) {
      throw new Error('本地文件模式需要 data/fallback-data.js。请按 README 启动本地服务器，或重新生成内嵌快照。');
    }

    if (useEmbedded) {
      return {
        domains: embedded.domains,
        sources: embedded.sources,
        articles: embedded.articles,
        audit: embedded.audit,
        mode: 'embedded'
      };
    }

    try {
      const [domains, sources, articles, audit] = await Promise.all([
        fetchJson(config.dataFiles.domains, bust),
        fetchJson(config.dataFiles.sources, bust),
        fetchJson(config.dataFiles.articles, bust),
        fetchJson(config.dataFiles.audit, bust)
      ]);
      return { domains, sources, articles, audit, mode: 'http' };
    } catch (error) {
      if (!embedded) throw error;
      console.warn('静态 JSON 读取失败，已回退到内嵌快照：', error);
      return {
        domains: embedded.domains,
        sources: embedded.sources,
        articles: embedded.articles,
        audit: embedded.audit,
        mode: 'embedded'
      };
    }
  }

  global.DataLoader = { loadAll };
})(window);
