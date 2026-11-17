/* 界面渲染与交互：筛选、批次、已读、隐藏、来源台账与质检视图。 */
(function (global) {
  'use strict';

  const App = {
    config: null,
    domainsDoc: null,
    categories: [],
    sourcesDoc: null,
    sources: [],
    articlesDoc: null,
    articles: [],
    freshPool: [],
    auditDoc: null,
    pool: [],
    rejected: [],
    dropped: [],
    sourceMap: new Map(),
    categoryMap: new Map(),
    state: null,
    filters: { category: 'all', tag: 'all' },
    batch: [],
    meta: null,
    issue: 1,
    view: 'feed',
    sourceGrade: 'all',
    busy: false,
    refreshing: false
  };

  const LANG = {
    en: '英文',
    zh: '中文',
    ja: '日文',
    fr: '法文',
    de: '德文',
    es: '西班牙文',
    ko: '韩文'
  };

  const REASON_FLAG = {
    high: { label: '通过率偏高 · 复核等级', cls: 'high' },
    low: { label: '通过率偏低 · 考虑降级', cls: 'low' },
    ok: { label: '区间正常', cls: 'ok' }
  };

  let toastTimer = null;
  let delegated = false;

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return [...(root || document).querySelectorAll(selector)];
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function hostOf(value) {
    try {
      return new URL(value).hostname.replace(/^www\./, '');
    } catch (error) {
      return '';
    }
  }

  function formatDate(value) {
    if (!value) return '未标注';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '未标注';
    return date.getFullYear() + '.' + String(date.getMonth() + 1).padStart(2, '0') + '.' + String(date.getDate()).padStart(2, '0');
  }

  function languageName(code) {
    return LANG[code] || (code ? String(code).toUpperCase() : '未标注');
  }

  function sourceFor(article) {
    return App.sourceMap.get(article.source_id) || null;
  }

  function accentFor(categoryId) {
    const category = App.categoryMap.get(categoryId);
    return category && category.accent ? category.accent : '#b3472f';
  }

  function categoryName(categoryId) {
    const category = App.categoryMap.get(categoryId);
    return category ? category.name : categoryId;
  }

  function showToast(message) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
  }

  function setTheme(theme) {
    const resolved = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolved;
    const button = $('#theme-toggle');
    if (button) {
      button.setAttribute('aria-label', resolved === 'dark' ? '切换到浅色主题' : '切换到深色主题');
      button.title = button.getAttribute('aria-label');
      const icon = $('.theme-icon', button);
      if (icon) icon.textContent = resolved === 'dark' ? '☀' : '◐';
    }
  }

  function initTheme() {
    const stored = global.Store.getPreference('theme', null);
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored);
      return;
    }
    const prefersDark = global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }

  function availablePalettes() {
    const list = (App.config && App.config.palettes) || [];
    return list.length ? list : [{ id: 'vermilion', name: '朱砂', swatch: '#b3472f' }];
  }

  function setPalette(id, persist) {
    const palettes = availablePalettes();
    const chosen = palettes.find((item) => item.id === id) || palettes[0];
    if (!chosen) return;
    const root = document.documentElement;
    if (chosen.id === 'vermilion') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', chosen.id);
    $all('.palette-dot').forEach((dot) => {
      dot.setAttribute('aria-pressed', String(dot.dataset.palette === chosen.id));
    });
    if (persist) global.Store.setPreference('palette', chosen.id);
  }

  function initPalette() {
    const picker = $('#palette-picker');
    if (picker) {
      picker.innerHTML = availablePalettes().map((item) =>
        '<button type="button" class="palette-dot" data-palette="' + item.id + '"' +
        ' style="--dot:' + item.swatch + '" aria-pressed="false"' +
        ' title="' + item.name + '" aria-label="主题颜色：' + item.name + '"></button>'
      ).join('');
    }
    const stored = global.Store.getPreference('palette', null);
    setPalette(stored || 'vermilion', false);
  }

  // 从候选中按质量分加权随机取 n 条（不重复）。
  function pickWeighted(candidates, n) {
    const pool = candidates.slice();
    const picked = [];
    while (picked.length < n && pool.length) {
      const weights = pool.map((entry) => Math.pow(Math.max(0.5, entry.quality ? entry.quality.score : 3), 2.2));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let cursor = Math.random() * total;
      let index = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        cursor -= weights[i];
        if (cursor <= 0) { index = i; break; }
      }
      picked.push(pool.splice(index, 1)[0]);
    }
    return picked;
  }

  // 内容刷新：保留标记「感兴趣」的卡片，剔除其余，并从"新内容池"换入全新内容。
  // 若配置了 crawlApi，则先触发后端真实爬取并重读数据；静态站默认使用预置新内容池。
  async function refreshContent() {
    if (App.refreshing) return;
    App.refreshing = true;
    const button = $('#refresh-button');
    const originalHTML = button ? button.innerHTML : '';
    if (button) { button.disabled = true; button.textContent = '正在获取新内容…'; }

    try {
      const cfg = App.config.refresh || {};
      let crawlMode = false;

      // 可选：触发真实后端爬取并重读数据（把新抓取内容并入内容池与新内容池）。
      if (cfg.crawlApi) {
        try {
          const response = await fetch(cfg.crawlApi, { method: 'POST', credentials: 'omit' });
          crawlMode = !!(response && response.ok);
        } catch (error) {
          console.warn('触发爬取接口失败，改用预置新内容池：', error);
        }
        if (crawlMode) {
          const data = await global.DataLoader.loadAll(App.config, { bust: true });
          App.domainsDoc = data.domains;
          App.categories = (data.domains && data.domains.categories) || App.categories;
          App.sourcesDoc = data.sources;
          App.sources = (data.sources && data.sources.sources) || App.sources;
          App.articlesDoc = data.articles;
          App.articles = (data.articles && data.articles.articles) || App.articles;
          App.auditDoc = data.audit || {};
          App.sourceMap = new Map(App.sources.map((source) => [source.id, source]));
          App.categoryMap = new Map(App.categories.map((category) => [category.id, category]));
          App.state = global.Store.getState();
          const now = global.Quality.parseDate(App.config.snapshotDate) || new Date();
          if (global.CustomTags) global.CustomTags.applyTo(App.articles);
          const rebuilt = global.Recommender.buildPool(App.articles, App.sources, App.categories, App.config, now);
          App.pool = rebuilt.items;
          App.freshPool = global.Recommender.buildPool(
            (data.freshArticles && data.freshArticles.articles) || [],
            App.sources, App.categories, App.config, now
          ).items;
          const stamp = data.articles && data.articles.snapshot_at;
          const label = $('#snapshot-label');
          if (stamp && label) label.textContent = '快照 ' + String(stamp).slice(0, 10).replace(/-/g, '.');
        }
      }

      // 1) 保留当前批次中标记「感兴趣」的卡片。
      const interested = new Set((App.state && App.state.interestedIds) || global.Store.getState().interestedIds);
      const kept = App.batch.filter((entry) => interested.has(entry.article.id));

      // 2) 从新内容池换入全新内容：排除已在批次、已换入过的内容，并遵守当前筛选。
      const used = new Set(global.Store.getUsedFreshIds());
      const inBatch = new Set(kept.map((entry) => entry.article.id));
      const needed = Math.max(0, App.config.batchSize - kept.length);
      let candidates = App.freshPool.filter((entry) =>
        !used.has(entry.article.id) && !inBatch.has(entry.article.id));
      if (App.filters.category !== 'all' || App.filters.tag !== 'all') {
        const allowed = global.Recommender.filterItems(candidates, {
          state: App.state,
          categoryFilter: App.filters.category,
          tagFilter: App.filters.tag
        });
        if (allowed.length) candidates = allowed;
      }
      const picked = pickWeighted(candidates, needed);

      // 3) 记录已换入的新内容 id，避免反复出现。
      if (picked.length) global.Store.addUsedFreshIds(picked.map((entry) => entry.article.id));

      // 4) 组装新批次（保留感兴趣 + 换入新内容）。
      const combined = global.Recommender.arrangeForSources
        ? global.Recommender.arrangeForSources(kept.concat(picked), App.config.maxConsecutiveSource)
        : kept.concat(picked);
      App.batch = combined;
      App.meta = {
        available: App.freshPool.length,
        categories: new Set(combined.map((entry) => entry.article.category)).size,
        sourceCount: new Set(combined.map((entry) => entry.article.source_id)).size,
        notes: []
      };
      if (kept.length) App.meta.notes.push('已保留 ' + kept.length + ' 条标记「感兴趣」的内容。');
      if (picked.length) App.meta.notes.push('已换入 ' + picked.length + ' 条新内容。');
      if (combined.length < App.config.batchSize) {
        App.meta.notes.push('新内容池暂时用尽，已展示可用内容，未用重复内容凑数。');
      }
      if (combined.length) global.Store.setLastBatch(combined.map((entry) => entry.article.id));
      App.issue += 1;
      global.Store.setPreference('issue', App.issue);
      renderFeed();

      const modeText = crawlMode ? '已触发爬取并读取最新内容' : '已从预置新内容池换入';
      showToast(modeText + '：保留 ' + kept.length + ' 条感兴趣，换入 ' + picked.length + ' 条新内容。');
    } catch (error) {
      console.error('内容刷新失败：', error);
      showToast('刷新失败：' + (error && error.message ? error.message : '未知错误'));
    } finally {
      App.refreshing = false;
      if (button) {
        button.disabled = false;
        button.innerHTML = originalHTML;
      }
    }
  }

  function renderCategoryChips() {
    const row = $('#category-chips');
    if (!row) return;
    const counts = global.Recommender.categoryCounts(App.pool, { state: App.state });
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const allButton = row.querySelector('[data-category="all"]');
    if (allButton) {
      allButton.classList.toggle('is-active', App.filters.category === 'all');
      allButton.setAttribute('aria-pressed', String(App.filters.category === 'all'));
      const count = $('#count-all');
      if (count) count.textContent = total;
    }

    App.categories.forEach((category) => {
      let button = row.querySelector('[data-category="' + category.id + '"]');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'chip';
        button.dataset.category = category.id;
        button.innerHTML = escapeHTML(category.name) + ' <span class="chip-count"></span>';
        row.appendChild(button);
      }
      const count = counts.get(category.id) || 0;
      button.classList.toggle('is-active', App.filters.category === category.id);
      button.setAttribute('aria-pressed', String(App.filters.category === category.id));
      button.disabled = count === 0;
      $('.chip-count', button).textContent = count;
    });
  }

  function renderTagFilter() {
    const container = $('#tag-filter');
    const row = $('#tag-chips');
    if (!container || !row) return;
    const hasCustom = global.CustomTags && global.CustomTags.getAll().length > 0;
    if (App.filters.category === 'all' && !hasCustom) {
      container.hidden = true;
      row.innerHTML = '';
      return;
    }
    const counts = global.Recommender.tagCounts(App.pool, { state: App.state }, App.filters.category);
    const tags = [...counts.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    if (!tags.length) {
      container.hidden = true;
      row.innerHTML = '';
      return;
    }
    container.hidden = false;
    row.innerHTML = [
      '<button type="button" class="chip' + (App.filters.tag === 'all' ? ' is-active' : '') + '" data-tag="all" aria-pressed="' + (App.filters.tag === 'all') + '">全部标签</button>'
    ].concat(tags.map(([tag, count]) => (
      '<button type="button" class="chip' + (App.filters.tag === tag ? ' is-active' : '') + '" data-tag="' + escapeHTML(tag) + '" aria-pressed="' + (App.filters.tag === tag) + '">' +
      escapeHTML(tag) + ' <span class="chip-count">' + count + '</span></button>'
    ))).join('');
  }

  function currentFilterLabel() {
    if (App.filters.category === 'all') return '全部领域 · 21 类';
    const name = categoryName(App.filters.category);
    return App.filters.tag === 'all' ? name : name + ' · ' + App.filters.tag;
  }

  function renderFilterMeta() {
    const mode = $('#filter-mode');
    if (mode) mode.textContent = currentFilterLabel();
  }

  function cardHTML(item, index) {
    const article = item.article;
    const source = item.source || sourceFor(article);
    const category = item.category || App.categoryMap.get(article.category);
    const accent = accentFor(article.category);
    const read = App.state.readIds.includes(article.id);
    const interested = (App.state.interestedIds || []).includes(article.id);
    const url = safeUrl(article.url);
    const homepage = safeUrl(source && source.homepage) || (url ? new URL(url).origin : '#');
    const author = article.author || '未署名';
    const published = formatDate(article.published_at);
    const language = languageName(article.language);
    const translationNote = article.translation_note || '中文标题与摘要为摘录提炼，非全文翻译。';
    const license = article.license_status || (source && source.license_basis) || '未标注';
    const licenseUrl = safeUrl(article.license_url || (source && source.license_url) || '');
    const summary = article.summary_zh || '本条目暂无中文摘要。';
    const qualityScore = item.quality ? item.quality.score.toFixed(2) : '—';
    const classic = item.quality && item.quality.classic;
    const trace = item.quality ? [
      ['来源', item.quality.parts.source],
      ['密度', item.quality.parts.density],
      ['事实', item.quality.parts.fact],
      ['时效', item.quality.parts.freshness],
      ['代表', item.quality.parts.representative]
    ] : [];

    const traceHTML = trace.map(([label, value]) => (
      '<div class="trace-part"><span>' + label + '</span><strong>' + Number(value).toFixed(1) + '</strong>' +
      '<div class="trace-bar"><i style="width:' + Math.max(0, Math.min(100, Number(value) / 5 * 100)) + '%"></i></div></div>'
    )).join('');

    const tags = (article.tags || []).slice(0, 5).map((tag) => '<span class="tag">' + escapeHTML(tag) + '</span>').join('');
    const grade = source ? source.grade : '?';
    const domain = article.source_domain || (source && source.domain) || hostOf(article.url);

    return '' +
      '<article class="story-card' + (read ? ' is-read' : '') + '" data-id="' + escapeHTML(article.id) + '" style="--card-accent:' + escapeHTML(accent) + ';animation-delay:' + Math.min(index * 35, 280) + 'ms">' +
        '<div class="card-top">' +
          '<span class="card-index">' + String(index + 1).padStart(2, '0') + '</span>' +
          '<span class="card-domain"><span class="card-domain-dot"></span>' + escapeHTML(category ? category.name : article.category) + '</span>' +
          (read ? '<span class="card-read-badge">已读</span>' : '') +
          '<span class="card-grade" title="来源等级">' + escapeHTML(grade) + ' 级</span>' +
        '</div>' +
        '<h2 class="card-title"><a href="' + escapeHTML(url || '#') + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(article.title_zh || article.title_original) + '</a></h2>' +
        '<p class="card-summary">' + escapeHTML(summary) + '</p>' +
        (article.title_original ? '<div class="card-original"><a href="' + escapeHTML(url || '#') + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(article.title_original) + '</a></div>' : '') +
        (tags ? '<div class="card-tags">' + tags + '</div>' : '') +
        '<div class="card-meta">' +
          '<div class="meta-row"><span class="meta-label">来源</span><span class="meta-value"><a href="' + escapeHTML(homepage) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(article.source_name || (source && source.name) || domain) + '</a> · ' + escapeHTML(domain) + '</span></div>' +
          '<div class="meta-row"><span class="meta-label">作者</span><span class="meta-value">' + escapeHTML(author) + '</span></div>' +
          '<div class="meta-row"><span class="meta-label">发布</span><span class="meta-value">' + escapeHTML(published) + ' · 原文 ' + escapeHTML(language) + '</span></div>' +
        '</div>' +
        '<div class="card-license">' +
          '<span class="license-badge">授权</span>' +
          '<span>' + (licenseUrl ? '<a href="' + escapeHTML(licenseUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(license) + '</a>' : escapeHTML(license)) + ' · 摘要汉化，非全文翻译' + (classic ? '<span class="card-flag">经典 / 长尾</span>' : '') + '</span>' +
        '</div>' +
        '<div class="card-actions">' +
          '<a class="action-link" href="' + escapeHTML(url || '#') + '" target="_blank" rel="noopener noreferrer">阅读原文 ↗</a>' +
          '<button type="button" class="action-button' + (read ? ' is-read' : '') + '" data-action="read" data-id="' + escapeHTML(article.id) + '" aria-pressed="' + read + '">' + (read ? '已读' : '标记已读') + '</button>' +
          '<button type="button" class="action-button interested-button' + (interested ? ' is-interested' : '') + '" data-action="interested" data-id="' + escapeHTML(article.id) + '" aria-pressed="' + interested + '" title="刷新内容时保留标记了感兴趣的内容">' + (interested ? '★ 感兴趣' : '☆ 感兴趣') + '</button>' +
          '<button type="button" class="action-button" data-action="hide" data-id="' + escapeHTML(article.id) + '">不再推荐</button>' +
          '<span class="action-spacer"></span>' +
          '<div class="card-menu-wrap">' +
            '<button type="button" class="action-button" data-action="menu" aria-haspopup="true" aria-expanded="false">导出 ▾</button>' +
            '<div class="export-menu" hidden>' +
              '<button type="button" data-export="pdf" data-id="' + escapeHTML(article.id) + '">PDF <small>A4 · 可打印</small></button>' +
              '<button type="button" data-export="png" data-id="' + escapeHTML(article.id) + '">PNG <small>2× 长图</small></button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<details class="card-trace-details">' +
          '<summary>质量分 ' + qualityScore + ' <span>/ 5</span> · 查看构成</summary>' +
          '<div class="card-trace">' + traceHTML + '</div>' +
          '<p class="card-footnote">摘要 ' + (article.summary_zh ? [...article.summary_zh].length : 0) + ' 字 · 上限 ' + (item.quality ? item.quality.summaryLimit : '—') + ' 字 · ' + escapeHTML(translationNote) + '</p>' +
        '</details>' +
      '</article>';
  }

  function renderBatchMeta() {
    const meta = App.meta || {};
    $('#batch-count').textContent = App.batch.length;
    $('#batch-categories').textContent = (meta.categories || 0) + ' 类';
    $('#batch-score').textContent = meta.average ? meta.average.toFixed(2) : '—';
    $('#batch-sources').textContent = (meta.sourceCount || 0) + ' 个';
    const note = $('#batch-note');
    if (note) {
      if (meta.notes && meta.notes.length) note.textContent = meta.notes[0];
      else if (!App.batch.length) note.textContent = '当前筛选下没有通过质量筛选的条目。';
      else note.textContent = '已读与上一批内容已自动降权；束内不重复二级标签。';
    }
    $('#issue-number').textContent = String(App.issue).padStart(3, '0');
  }

  function renderFeed(options) {
    const opts = options || {};
    const grid = $('#card-grid');
    const status = $('#feed-status');
    const empty = $('#empty-state');
    if (!grid) return;

    renderCategoryChips();
    renderTagFilter();
    renderFilterMeta();
    renderBatchMeta();

    if (opts.loading) {
      grid.hidden = true;
      empty.hidden = true;
      status.hidden = false;
      return;
    }

    status.hidden = true;
    if (!App.batch.length) {
      grid.hidden = true;
      grid.innerHTML = '';
      empty.hidden = false;
      const available = global.Recommender.filterItems(App.pool, {
        state: App.state,
        categoryFilter: App.filters.category,
        tagFilter: App.filters.tag
      }).length;
      const copy = $('#empty-copy');
      if (copy) {
        copy.textContent = available
          ? '当前筛选下可用内容不足，或都被“不再推荐”排除。换一个领域、恢复隐藏内容，或重置筛选再看看。'
          : '这个筛选组合下没有通过四层质量筛选的内容。换一个领域，或重置筛选再看看。';
      }
      return;
    }

    empty.hidden = true;
    grid.hidden = false;
    grid.innerHTML = App.batch.map(cardHTML).join('');
    const cards = $all('.story-card', grid);
    cards.forEach((card) => card.classList.add('is-entering'));
  }

  function refreshBatch(reason) {
    if (App.busy) return;
    App.busy = true;
    const loadingTimer = setTimeout(() => renderFeed({ loading: true }), 40);

    let result;
    try {
      result = global.Recommender.sample(App.pool, {
        config: App.config,
        batchSize: App.config.batchSize,
        categoryFilter: App.filters.category,
        tagFilter: App.filters.tag,
        state: App.state
      });
    } catch (error) {
      clearTimeout(loadingTimer);
      App.busy = false;
      renderFeed({ loading: false });
      showToast('抽取失败：' + (error && error.message ? error.message : '未知错误'));
      console.error(error);
      return;
    }

    setTimeout(() => {
      clearTimeout(loadingTimer);
      App.batch = result.items || [];
      App.meta = result.meta || {};
      if (reason === 'shuffle') {
        App.issue += 1;
        global.Store.setPreference('issue', App.issue);
      }
      if (App.batch.length) global.Store.setLastBatch(App.batch.map((item) => item.article.id));
      renderFeed();
      App.busy = false;
      if (reason === 'shuffle') {
        showToast(App.batch.length ? '已换一批，并尽量避开上一批内容。' : '当前筛选下没有可换的内容。');
      }
    }, reason === 'shuffle' ? 180 : 60);
  }

  function setCategory(categoryId) {
    if (categoryId !== 'all' && !App.categoryMap.has(categoryId)) return;
    App.filters.category = categoryId;
    App.filters.tag = 'all';
    refreshBatch('filter');
  }

  function setTag(tag) {
    App.filters.tag = tag;
    refreshBatch('filter');
  }

  function resetFilters() {
    App.filters.category = 'all';
    App.filters.tag = 'all';
    refreshBatch('filter');
  }

  function toggleRead(id) {
    const item = App.batch.find((entry) => entry.article.id === id);
    if (!item) return;
    const currentlyRead = App.state.readIds.includes(id);
    App.state = global.Store.markRead(id, !currentlyRead);
    const card = document.querySelector('.story-card[data-id="' + CSS.escape(id) + '"]');
    if (card) {
      card.classList.toggle('is-read', !currentlyRead);
      const button = card.querySelector('[data-action="read"]');
      if (button) {
        button.classList.toggle('is-read', !currentlyRead);
        button.textContent = currentlyRead ? '标记已读' : '已读';
        button.setAttribute('aria-pressed', String(!currentlyRead));
      }
      const top = card.querySelector('.card-top');
      let badge = card.querySelector('.card-read-badge');
      if (!currentlyRead && !badge && top) {
        badge = document.createElement('span');
        badge.className = 'card-read-badge';
        badge.textContent = '已读';
        const grade = card.querySelector('.card-grade');
        if (grade) top.insertBefore(badge, grade);
        else top.appendChild(badge);
      } else if (currentlyRead && badge) {
        badge.remove();
      }
    }
    showToast(currentlyRead ? App.config.messages.unread : App.config.messages.read);
  }

  function hideArticle(id) {
    const item = App.batch.find((entry) => entry.article.id === id);
    if (!item) return;
    App.state = global.Store.hideSimilar(item.article);
    App.batch = App.batch.filter((entry) => entry.article.id !== id);
    const grid = $('#card-grid');
    const card = grid && grid.querySelector('.story-card[data-id="' + CSS.escape(id) + '"]');
    if (card) {
      card.style.transition = 'opacity .2s ease, transform .2s ease';
      card.style.opacity = '0';
      card.style.transform = 'translateY(6px)';
    }
    showToast(App.config.messages.hidden);
    setTimeout(() => {
      App.meta = App.meta || {};
      App.meta.categories = new Set(App.batch.map((entry) => entry.article.category)).size;
      App.meta.sourceCount = new Set(App.batch.map((entry) => entry.article.source_id)).size;
      renderFeed();
      if (App.batch.length) global.Store.setLastBatch(App.batch.map((entry) => entry.article.id));
    }, 210);
  }

  function toggleInterested(id) {
    App.state = global.Store.markInterested(id, !App.state.interestedIds.includes(id));
    const active = App.state.interestedIds.includes(id);
    const card = document.querySelector('.story-card[data-id="' + CSS.escape(id) + '"]');
    if (card) {
      const button = card.querySelector('[data-action="interested"]');
      if (button) {
        button.classList.toggle('is-interested', active);
        button.textContent = active ? '★ 感兴趣' : '☆ 感兴趣';
        button.setAttribute('aria-pressed', String(active));
      }
    }
    showToast(active ? '已标记感兴趣，刷新内容时会保留这条。' : '已取消感兴趣标记。');
  }

  function toggleExportMenu(button) {
    const wrap = button.closest('.card-menu-wrap');
    if (!wrap) return;
    const menu = wrap.querySelector('.export-menu');
    const isOpen = menu && !menu.hidden;
    $all('.export-menu').forEach((node) => { node.hidden = true; });
    $all('[data-action="menu"]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
    if (menu && !isOpen) {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    }
  }

  function closeExportMenus() {
    $all('.export-menu').forEach((node) => { node.hidden = true; });
    $all('[data-action="menu"]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
  }

  function sourceCardHTML(source) {
    const paused = source.status === 'paused';
    const excluded = !paused && source.status !== 'active';
    const homepage = safeUrl(source.homepage) || '#';
    const licenseUrl = safeUrl(source.license_url);
    const reviewDue = source.next_review_at && source.next_review_at <= App.config.snapshotDate.slice(0, 10);
    const stale = !excluded && !paused && global.Recommender.isStaleSource(source, App.config);
    const statusClass = paused ? ' paused' : excluded ? ' excluded' : stale ? ' stale' : '';
    const statusLabel = paused ? '暂停 · 待复核' : excluded ? '已排除 / 反例' : stale ? '在池 · 降权' : '在池';
    const statusTitle = paused
      ? (source.pause_reason || '抓取连续失败，已暂停，等待人工复核；不会自动恢复')
      : stale ? '最近 7 天无有效新条目，已自动降低抽样权重' : '';
    const translationText = source.translation_allowed
      ? '允许（须署名 / 保留许可）'
      : '不允许 · 不生成摘要';
    const fulltextText = source.fulltext_allowed ? '允许（仍按默认边界）' : '否 · 仅摘要 + 链接';
    const feed = source.feed_url || source.access_method || '—';

    return '' +
      '<article class="source-card' + (excluded ? ' is-excluded' : '') + '">' +
        '<div class="source-head">' +
          '<span class="source-grade grade-' + escapeHTML(source.grade) + '">' + escapeHTML(source.grade) + '</span>' +
          '<div><h3 class="source-name">' + escapeHTML(source.name) + '</h3><p class="source-domain"><a href="' + escapeHTML(homepage) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(source.domain) + ' ↗</a></p></div>' +
          '<span class="source-status' + statusClass + '"' + (statusTitle ? ' title="' + escapeHTML(statusTitle) + '"' : '') + '>' + statusLabel + '</span>' +
        '</div>' +
        '<dl class="source-grid">' +
          '<div class="source-field wide"><dt>等级理由</dt><dd>' + escapeHTML(source.grade_reason || '—') + '</dd></div>' +
          '<div class="source-field"><dt>获取方式</dt><dd>' + escapeHTML(source.access_method || '—') + '</dd></div>' +
          '<div class="source-field"><dt>请求间隔</dt><dd>' + escapeHTML(String(source.request_interval_minutes || '—')) + ' 分钟 / 次</dd></div>' +
          '<div class="source-field wide"><dt>许可依据</dt><dd>' +
            (licenseUrl ? '<a href="' + escapeHTML(licenseUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHTML(source.license_basis || '未标注') + ' ↗</a>' : escapeHTML(source.license_basis || '未标注')) +
          '</dd></div>' +
          '<div class="source-field"><dt>robots 核查</dt><dd>' + escapeHTML(source.robots_check || '—') + '</dd></div>' +
          '<div class="source-field"><dt>全文输出</dt><dd>' + escapeHTML(fulltextText) + '</dd></div>' +
          '<div class="source-field"><dt>翻译 / 衍生</dt><dd>' + escapeHTML(translationText) + '</dd></div>' +
          '<div class="source-field"><dt>最近条目</dt><dd>' + escapeHTML(source.last_item_at || '—') + (stale ? ' · 已降权' : '') + '</dd></div>' +
          '<div class="source-field wide"><dt>Feed / API / 入口</dt><dd>' + escapeHTML(feed) + '</dd></div>' +
          '<div class="source-field wide"><dt>边界备注</dt><dd>' + escapeHTML(source.fulltext_note || source.notes || '—') + '</dd></div>' +
        '</dl>' +
        '<div class="source-review"><span>最近复核 ' + escapeHTML(source.reviewed_at || '—') + ' · 下次 ' + escapeHTML(source.next_review_at || '—') + '</span><span class="' + (excluded || paused || reviewDue ? 'review-flag' : 'review-flag ok') + '">' + (paused ? '暂停待复核' : excluded ? '暂停使用' : reviewDue ? '待复核' : '复核在期内') + '</span></div>' +
      '</article>';
  }

  function renderSources() {
    const list = $('#source-list');
    if (!list) return;
    const active = App.sources.filter((source) => source.status === 'active');
    const paused = App.sources.filter((source) => source.status === 'paused');
    const excluded = App.sources.filter((source) => source.status === 'excluded');
    $('#source-active-count').textContent = active.length;
    $('#source-excluded-count').textContent = excluded.length;
    const snapshot = App.config.snapshotDate.slice(0, 10);
    $('#source-review-count').textContent = active.concat(paused).filter((source) => !source.next_review_at || source.next_review_at <= snapshot || source.status === 'paused').length;

    const filtered = App.sources.filter((source) => {
      if (App.sourceGrade === 'all') return true;
      if (App.sourceGrade === 'excluded') return source.status !== 'active';
      return source.status === 'active' && source.grade === App.sourceGrade;
    });
    list.innerHTML = filtered.length
      ? filtered.map(sourceCardHTML).join('')
      : '<div class="empty-state"><span class="empty-mark">空</span><h2>没有这一等级的来源。</h2><p>来源等级决定审查强度，不决定免检资格。</p></div>';
    const note = $('#source-toolbar-note');
    if (note) note.textContent = '当前显示 ' + filtered.length + ' / ' + App.sources.length + ' 个来源 · 等级不等于免检' + (paused.length ? ' · ' + paused.length + ' 个来源待人工复核' : '');
  }

  function renderMethod() {
    const rejected = (App.auditDoc && App.auditDoc.rejected) || [];
    const auditBody = $('#audit-body');
    if (auditBody) {
      auditBody.innerHTML = rejected.map((entry) => {
        const reasons = (entry.reasons || []).map((reason) => '<span class="reason-chip">' + escapeHTML(reason.label || reason.code) + '</span>').join('');
        return '<tr>' +
          '<td><span class="table-title">' + escapeHTML(entry.title_original) + '</span><span class="table-sub">' + escapeHTML(entry.id) + ' · ' + escapeHTML(entry.published_at || '—') + '</span></td>' +
          '<td>' + escapeHTML(entry.source_name) + '<br><span class="table-sub">' + escapeHTML(entry.source_grade) + ' 级</span></td>' +
          '<td>' + escapeHTML(categoryName(entry.domain)) + '</td>' +
          '<td class="score-cell">' + Number(entry.score || 0).toFixed(2) + '</td>' +
          '<td><div class="reason-list">' + reasons + '</div></td>' +
        '</tr>';
      }).join('');
    }

    const passRates = (App.auditDoc && App.auditDoc.source_pass_rates) || [];
    const healthBody = $('#source-health-body');
    if (healthBody) {
      healthBody.innerHTML = passRates.map((row) => {
        const flag = REASON_FLAG[row.flag] || REASON_FLAG.ok;
        return '<tr>' +
          '<td>' + escapeHTML(row.source_name) + '<span class="table-sub">' + escapeHTML(row.source_id) + '</span></td>' +
          '<td class="score-cell">' + row.submitted + '</td>' +
          '<td class="score-cell">' + row.passed + '</td>' +
          '<td class="score-cell">' + (Number(row.rate) * 100).toFixed(1) + '%</td>' +
          '<td><span class="flag-badge ' + flag.cls + '">' + flag.label + '</span></td>' +
        '</tr>';
      }).join('');
    }

    const traceBody = $('#trace-body');
    if (traceBody) {
      traceBody.innerHTML = App.pool.slice(0, 10).map((item) => {
        const q = item.quality;
        const pct = Math.max(0, Math.min(100, q.score / 5 * 100));
        return '<tr>' +
          '<td><span class="table-title">' + escapeHTML(item.article.title_zh) + '</span><span class="table-sub">' + escapeHTML(item.article.id) + '</span></td>' +
          '<td>' + escapeHTML(categoryName(item.article.category)) + '</td>' +
          '<td>' + escapeHTML(item.source.name) + '<span class="table-sub">' + escapeHTML(item.source.grade) + ' 级</span></td>' +
          '<td class="bar-cell"><span class="score-cell">' + q.score.toFixed(2) + '</span><div class="trace-score-bar"><i style="width:' + pct + '%"></i></div></td>' +
          '<td class="score-cell">' + q.summaryChars + ' / ' + q.summaryLimit + '</td>' +
          '<td>' + (q.classic ? '<span class="flag-badge high">经典 / 长尾</span>' : (q.ageDays == null ? '—' : q.ageDays + ' 天')) + '</td>' +
          '<td>' + (item.article.tags || []).map((tag) => '<span class="tag">' + escapeHTML(tag) + '</span>').join(' ') + '</td>' +
        '</tr>';
      }).join('');
    }

    const passed = App.pool.length;
    const total = passed + rejected.length;
    $('#audit-passed').textContent = passed;
    $('#audit-rejected').textContent = rejected.length;
    $('#audit-rate').textContent = total ? Math.round(passed / total * 100) + '%' : '—';

    const configList = $('#config-list');
    if (configList) {
      const rows = [
        ['批次大小', App.config.batchSize + ' 条'],
        ['最少覆盖领域', App.config.minCategories + ' 类'],
        ['同领域上限', App.config.maxPerCategory + ' 条'],
        ['同标签上限', App.config.maxPerTag + ' 条'],
        ['同来源连续上限', App.config.maxConsecutiveSource + ' 条'],
        ['C 级单批上限', App.config.maxPerGradeC + ' 条'],
        ['加权分阈值', App.config.quality.threshold.toFixed(1)],
        ['摘要硬上限', App.config.quality.summaryMaxChars + ' 字 / 正文 ' + (App.config.quality.summaryMaxRatio * 100) + '%'],
        ['默认权重', '来源 .25 / 密度 .25 / 事实 .20 / 时效 .15 / 代表 .15'],
        ['科技类权重', '来源 .20 / 密度 .25 / 事实 .20 / 时效 .25 / 代表 .10'],
        ['科学类权重', '来源 .25 / 密度 .20 / 事实 .30 / 时效 .10 / 代表 .15'],
        ['已读 / 上批 / 同源权重', App.config.sampling.readPenalty + ' / ' + App.config.sampling.lastBatchPenalty + ' / ' + App.config.sampling.sourceReusePenalty],
        ['导出 PNG 倍率', App.config.export.pngScale + '×'],
        ['二维码显示 / 源尺寸', App.config.export.qrDisplayPx + 'px / ' + App.config.export.qrSourcePx + 'px'],
        ['A4 模板', App.config.export.a4CssWidth + ' × ' + App.config.export.a4CssHeight + ' px']
      ];
      configList.innerHTML = rows.map(([key, value]) => '<div><dt>' + escapeHTML(key) + '</dt><dd>' + escapeHTML(value) + '</dd></div>').join('');
    }
  }

  function existingTagNames() {
    const set = new Set();
    App.pool.forEach((item) => (item.article.tags || []).forEach((tag) => set.add(tag)));
    if (global.CustomTags) global.CustomTags.getAll().forEach((rule) => set.add(rule.name));
    return [...set];
  }

  function populateTagCategories() {
    const select = $('#tag-category-input');
    if (!select || select.options.length > 1) return;
    const fragment = document.createDocumentFragment();
    App.categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      fragment.appendChild(option);
    });
    select.appendChild(fragment);
  }

  function renderTagRules() {
    const list = $('#tag-rule-list');
    const count = $('#tag-rule-count');
    if (!list) return;
    const rules = global.CustomTags ? global.CustomTags.getAll() : [];
    if (count) count.textContent = String(rules.length);
    if (!rules.length) {
      list.innerHTML = '<p class="tag-empty">还没有标签规则。用上面的表单创建一个吧。</p>';
      return;
    }
    list.innerHTML = rules.map((rule) => {
      const hits = global.CustomTags.countFor(rule, App.articles);
      const scope = rule.category === 'all'
        ? '全部领域'
        : (App.categoryMap.get(rule.category) ? App.categoryMap.get(rule.category).name : rule.category);
      return '<div class="tag-rule" data-rule-id="' + escapeHTML(rule.id) + '">' +
        '<div class="tag-rule-head">' +
          '<span class="tag-rule-name"># ' + escapeHTML(rule.name) + '</span>' +
          '<button type="button" class="tag-rule-delete" data-action="delete-tag" data-rule-id="' + escapeHTML(rule.id) + '" aria-label="删除标签 ' + escapeHTML(rule.name) + '">删除</button>' +
        '</div>' +
        '<div class="tag-rule-meta">' + escapeHTML(scope) + ' · 命中 <strong>' + hits + '</strong> 条 · 关键词 ' + rule.keywords.length + ' 个</div>' +
        '<div class="tag-rule-keywords">' + rule.keywords.map((word) => '<span class="tag-keyword">' + escapeHTML(word) + '</span>').join('') + '</div>' +
      '</div>';
    }).join('');
  }

  function applyCustomTags(reason) {
    if (!global.CustomTags) return;
    const result = global.CustomTags.applyTo(App.articles);
    const built = global.Recommender.buildPool(App.articles, App.sources, App.categories, App.config,
      global.Quality.parseDate(App.config.snapshotDate) || new Date());
    App.pool = built.items;
    App.rejected = built.rejected;
    App.dropped = built.dropped;
    renderTagRules();
    if (reason === 'created' && result.applied) {
      showToast('已应用标签，命中 ' + result.touched + ' 条内容。');
    }
    refreshBatch(reason === 'created' ? 'filter' : (reason || 'filter'));
  }

  function handleCreateTag(event) {
    event.preventDefault();
    const message = $('#tag-form-message');
    const name = ($('#tag-name-input') || {}).value;
    const category = ($('#tag-category-input') || {}).value || 'all';
    const keywords = ($('#tag-keywords-input') || {}).value;
    const result = global.CustomTags.add(name, category, keywords, existingTagNames());
    if (!result.ok) {
      if (message) { message.textContent = result.error; message.className = 'tag-form-message is-error'; }
      return;
    }
    if (message) { message.textContent = '已创建标签“' + result.rule.name + '”。'; message.className = 'tag-form-message is-ok'; }
    $('#tag-name-input').value = '';
    $('#tag-keywords-input').value = '';
    applyCustomTags('created');
  }

  function handleDeleteTag(button) {
    const id = button.dataset.ruleId;
    const result = global.CustomTags.remove(id);
    if (!result.ok) { showToast(result.error); return; }
    global.CustomTags.removeFrom(App.articles, result.rule.name);
    if (App.filters.tag === result.rule.name) App.filters.tag = 'all';
    applyCustomTags('filter');
    showToast('已删除标签“' + result.rule.name + '”。');
  }

  function showView(view) {
    const valid = ['feed', 'tags', 'sources', 'method'];
    App.view = valid.includes(view) ? view : 'feed';
    $all('.view').forEach((section) => { section.hidden = section.id !== 'view-' + App.view; });
    $all('.nav-link').forEach((button) => {
      const active = button.dataset.view === App.view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (App.view === 'tags') { populateTagCategories(); renderTagRules(); }
    if (App.view === 'sources') renderSources();
    if (App.view === 'method') renderMethod();
    const target = document.getElementById('view-' + App.view);
    if (target) {
      const top = target.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  function bindEvents() {
    if (delegated) return;
    delegated = true;

    $all('.nav-link').forEach((button) => {
      button.addEventListener('click', () => showView(button.dataset.view));
    });

    const themeButton = $('#theme-toggle');
    if (themeButton) {
      themeButton.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        global.Store.setPreference('theme', next);
      });
    }

    const palettePicker = $('#palette-picker');
    if (palettePicker) {
      palettePicker.addEventListener('click', (event) => {
        const dot = event.target.closest('.palette-dot');
        if (dot) setPalette(dot.dataset.palette, true);
      });
    }

    const refreshButton = $('#refresh-button');
    if (refreshButton) refreshButton.addEventListener('click', refreshContent);

    const shuffle = $('#shuffle-button');
    if (shuffle) shuffle.addEventListener('click', () => refreshBatch('shuffle'));

    const explain = $('#explain-button');
    if (explain) explain.addEventListener('click', () => showView('method'));

    const reset = $('#reset-filters');
    if (reset) reset.addEventListener('click', resetFilters);

    const manageTags = $('#manage-tags-button');
    if (manageTags) manageTags.addEventListener('click', () => showView('tags'));

    const tagForm = $('#tag-create-form');
    if (tagForm) tagForm.addEventListener('submit', handleCreateTag);

    const tagRuleList = $('#tag-rule-list');
    if (tagRuleList) {
      tagRuleList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action="delete-tag"]');
        if (button) handleDeleteTag(button);
      });
    }

    const categoryChips = $('#category-chips');
    if (categoryChips) {
      categoryChips.addEventListener('click', (event) => {
        const button = event.target.closest('[data-category]');
        if (!button || button.disabled) return;
        setCategory(button.dataset.category);
      });
    }

    const tagChips = $('#tag-chips');
    if (tagChips) {
      tagChips.addEventListener('click', (event) => {
        const button = event.target.closest('[data-tag]');
        if (!button) return;
        setTag(button.dataset.tag);
      });
    }

    const gradeChips = $('#source-grade-chips');
    if (gradeChips) {
      gradeChips.addEventListener('click', (event) => {
        const button = event.target.closest('[data-grade]');
        if (!button) return;
        App.sourceGrade = button.dataset.grade;
        $all('.chip', gradeChips).forEach((chip) => {
          const active = chip === button;
          chip.classList.toggle('is-active', active);
          chip.setAttribute('aria-pressed', String(active));
        });
        renderSources();
      });
    }

    const grid = $('#card-grid');
    if (grid) {
      grid.addEventListener('click', (event) => {
        const menuButton = event.target.closest('[data-action="menu"]');
        if (menuButton) {
          event.stopPropagation();
          toggleExportMenu(menuButton);
          return;
        }
        const readButton = event.target.closest('[data-action="read"]');
        if (readButton) {
          toggleRead(readButton.dataset.id);
          return;
        }
        const hideButton = event.target.closest('[data-action="hide"]');
        if (hideButton) {
          hideArticle(hideButton.dataset.id);
          return;
        }
        const interestedButton = event.target.closest('[data-action="interested"]');
        if (interestedButton) {
          toggleInterested(interestedButton.dataset.id);
          return;
        }
        const exportButton = event.target.closest('[data-export]');
        if (exportButton) {
          const item = App.batch.find((entry) => entry.article.id === exportButton.dataset.id);
          closeExportMenus();
          if (item && global.Exporter) {
            global.Exporter.exportArticle(item.article, exportButton.dataset.export, App);
          }
          return;
        }
        if (!event.target.closest('.card-menu-wrap')) closeExportMenus();
      });
    }

    document.addEventListener('click', (event) => {
      if (!event.target.closest('.card-menu-wrap')) closeExportMenus();
    });

    document.addEventListener('keydown', (event) => {
      const tag = (event.target && event.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'r' || event.key === 'R') {
        if (!$('#export-overlay').hidden) return;
        if (App.view !== 'feed') showView('feed');
        refreshBatch('shuffle');
      }
      if (event.key === 'Escape') {
        closeExportMenus();
        if (global.Exporter && global.Exporter.isOpen()) global.Exporter.close();
      }
    });

    const emptyReset = $('#empty-reset');
    if (emptyReset) emptyReset.addEventListener('click', resetFilters);

    const clearHidden = $('#empty-clear-hidden');
    if (clearHidden) {
      clearHidden.addEventListener('click', () => {
        App.state = global.Store.clearHidden();
        refreshBatch('filter');
        showToast('已恢复被“不再推荐”隐藏的内容。');
      });
    }

    const overlay = $('#export-overlay');
    if (overlay) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay && global.Exporter) global.Exporter.close();
      });
    }
  }

  function boot(data) {
    App.config = global.APP_CONFIG;
    App.domainsDoc = data.domains;
    App.categories = (data.domains && data.domains.categories) || [];
    App.sourcesDoc = data.sources;
    App.sources = (data.sources && data.sources.sources) || [];
    App.articlesDoc = data.articles;
    App.articles = (data.articles && data.articles.articles) || [];
    App.auditDoc = data.audit || {};
    App.sourceMap = new Map(App.sources.map((source) => [source.id, source]));
    App.categoryMap = new Map(App.categories.map((category) => [category.id, category]));
    App.state = global.Store.getState();

    const now = global.Quality.parseDate(App.config.snapshotDate) || new Date();
    const customResult = global.CustomTags ? global.CustomTags.applyTo(App.articles) : null;
    if (customResult && customResult.applied) {
      console.info('[自定义标签] 已套用 ' + customResult.rules + ' 条规则，命中 ' + customResult.touched + ' 条内容。');
    }
    const built = global.Recommender.buildPool(App.articles, App.sources, App.categories, App.config, now);
    App.pool = built.items;
    App.rejected = built.rejected;
    App.dropped = built.dropped;

    // 新内容池：用于「刷新内容」时换入全新主题（独立于主池，避免重复凑数）。
    const freshArticles = (data.freshArticles && data.freshArticles.articles) || [];
    App.freshPool = global.Recommender.buildPool(
      freshArticles, App.sources, App.categories, App.config, now
    ).items;

    initTheme();
    initPalette();
    bindEvents();

    const search = new URLSearchParams(location.search);
    const initialCategory = search.get('category');
    if (initialCategory && App.categoryMap.has(initialCategory)) App.filters.category = initialCategory;
    const initialTag = search.get('tag');
    if (initialTag) App.filters.tag = initialTag;

    App.issue = Number(global.Store.getPreference('issue', 1)) || 1;
    renderFeed({ loading: true });
    setTimeout(() => refreshBatch('initial'), 260);

    const loadingCopy = $('.loading-copy');
    if (loadingCopy) loadingCopy.textContent = '正在筛选来源、核对摘要与许可……';
  }

  global.UI = { boot, App, showToast, showView };
})(window);
