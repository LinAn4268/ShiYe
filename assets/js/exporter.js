/*
 * 导出工作台：独立模板、字体等待、图片跨域预检、二维码、PNG 长图与 A4 分页 PDF。
 * 不截取卡片 DOM，不使用 html2canvas / allowTaint。
 */
(function (global) {
  'use strict';

  const state = {
    open: false,
    busy: false,
    token: 0,
    article: null,
    format: null,
    app: null,
    doc: null,
    css: '',
    lastError: '',
    previousFocus: null
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

  function $(selector, root) {
    return (root || document).querySelector(selector);
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
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return match[1] + '.' + match[2] + '.' + match[3];
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '未标注';
    return date.getFullYear() + '.' + String(date.getMonth() + 1).padStart(2, '0') + '.' + String(date.getDate()).padStart(2, '0');
  }

  function stampDate(date) {
    const value = date instanceof Date ? date : new Date();
    return value.getFullYear() + String(value.getMonth() + 1).padStart(2, '0') + String(value.getDate()).padStart(2, '0');
  }

  function languageName(code) {
    return LANG[code] || (code ? String(code).toUpperCase() : '未标注');
  }

  function summaryLimitFor(article, config) {
    const quality = (config && config.quality) || {};
    const bodyWords = Number(article.body_words) || 0;
    const perWord = article.language === 'zh' ? 1 : (Number(quality.charsPerEnglishWord) || 1.6);
    const ratio = Number(quality.summaryMaxRatio) || 0.10;
    const ratioLimit = Math.floor(bodyWords * perWord * ratio);
    const hardLimit = Number(quality.summaryMaxChars) || 400;
    return bodyWords ? Math.min(hardLimit, Math.max(1, ratioLimit)) : hardLimit;
  }

  function categoryOf(article, app) {
    return (app && app.categoryMap && app.categoryMap.get(article.category)) || {
      name: article.category || '未分类',
      short: article.category || '未分类',
      accent: '#b3472f'
    };
  }

  function sourceOf(article, app) {
    return (app && app.sourceMap && app.sourceMap.get(article.source_id)) || {};
  }

  function setStatus(text, progress) {
    const status = $('#export-status');
    if (status) status.textContent = text;
    const bar = $('#export-overlay .export-progress span');
    if (bar && Number.isFinite(progress)) bar.style.width = Math.max(0, Math.min(100, progress)) + '%';
  }

  function setDetail(text) {
    const detail = $('#export-detail');
    if (detail) detail.textContent = text;
  }

  function toast(message) {
    if (global.UI && typeof global.UI.showToast === 'function') global.UI.showToast(message);
  }

  function nextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
  }

  function ensureToken(token) {
    if (token !== state.token) {
      const error = new Error('导出已取消。');
      error.cancelled = true;
      throw error;
    }
  }

  function openOverlay() {
    const overlay = $('#export-overlay');
    if (!overlay) throw new Error('导出面板不存在。');
    state.previousFocus = document.activeElement;
    overlay.hidden = false;
    state.open = true;
    document.body.classList.add('exporting');
    const close = $('#export-close');
    if (close && close.focus) close.focus();
  }

  function closeOverlay() {
    const overlay = $('#export-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    state.open = false;
    document.body.classList.remove('exporting');
    const stage = $('#export-stage');
    if (stage) {
      stage.style.position = '';
      stage.style.left = '';
      stage.style.top = '';
      stage.innerHTML = '';
    }
    const errorBox = $('#export-error');
    if (errorBox) errorBox.hidden = true;
    if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
      state.previousFocus.focus();
    }
    state.previousFocus = null;
  }

  function close() {
    if (state.busy) {
      state.token += 1;
      state.busy = false;
    }
    closeOverlay();
    state.article = null;
    state.format = null;
    state.app = null;
    state.doc = null;
  }

  function isOpen() {
    return state.open;
  }

  function showError(error) {
    const message = error && error.message ? error.message : '导出失败，原因未知。';
    state.lastError = message;
    setStatus('导出没有完成。', 100);
    setDetail('可以重试，或改用打印。打印会保留同一套来源、授权与免责声明。');
    const box = $('#export-error');
    const copy = $('#export-error-copy');
    if (copy) copy.textContent = message;
    if (box) box.hidden = false;
    toast(message);
  }

  function clearError() {
    const box = $('#export-error');
    if (box) box.hidden = true;
  }

  async function prepareFonts() {
    setStatus('正在准备字体…', 14);
    if (!document.fonts) return;
    const samples = [
      '700 35px "Songti SC"',
      '700 35px "STSong"',
      '700 35px "SimSun"',
      '400 14px "Songti SC"',
      '600 10px "PingFang SC"',
      '600 10px "Microsoft YaHei"',
      '400 10px "Consolas"'
    ];
    try {
      await Promise.allSettled(samples.map((font) => document.fonts.load(font, '跨领域优质内容')));
      await Promise.race([document.fonts.ready, delay(4200)]);
    } catch (error) {
      /* 字体 API 不可用时回退到系统字体，不阻断导出。 */
    }
  }

  function qrDataUrl(url) {
    if (!global.QRCodeLite) throw new Error('二维码模块未加载。');
    return global.QRCodeLite.toDataURL(url, {
      size: (global.APP_CONFIG && global.APP_CONFIG.export && global.APP_CONFIG.export.qrSourcePx) || 512,
      quietZone: 4,
      light: '#ffffff',
      dark: '#111111'
    });
  }

  function metaRow(label, value) {
    return '<div class="ex-meta-item"><span class="ex-meta-label">' + escapeHTML(label) + '</span>' +
      '<span class="ex-meta-value">' + escapeHTML(value == null || value === '' ? '未标注' : value) + '</span></div>';
  }

  function footerHTML(pageLabel) {
    return '<div class="ex-footer">' +
      '<p class="ex-disclaimer">内容版权归原作者所有。本页仅为摘要汉化与来源索引，不构成对原文的替代。</p>' +
      '<p class="ex-footer-meta">导出日期 ' + escapeHTML(formatDate(new Date())) + ' · 拾页 · ' + escapeHTML(pageLabel) + '</p>' +
      '</div>';
  }

  function articleFigure(article) {
    if (!article.image_url) return '';
    const src = safeUrl(article.image_url);
    if (!src) return '';
    return '<figure class="ex-figure">' +
      '<img data-export-image data-src="' + escapeHTML(src) + '" alt="来源配图">' +
      '<figcaption class="ex-figure-caption">图片来源：' + escapeHTML(article.image_license || '许可未标注') + '。导出前已做跨域预检；不可达时替换为占位图。</figcaption>' +
      '</figure>';
  }

  function buildTemplate(article, app, mode) {
    const config = (app && app.config) || global.APP_CONFIG || {};
    const category = categoryOf(article, app);
    const source = sourceOf(article, app);
    const title = article.title_zh || article.title_original || '未命名条目';
    const original = article.title_original || '';
    const summary = article.summary_zh || '本条目暂无中文摘要。';
    const tags = (article.tags || []).slice(0, 6);
    const author = article.author || '未署名';
    const published = formatDate(article.published_at);
    const language = languageName(article.language);
    const license = article.license_status || source.license_basis || '未标注';
    const licenseUrl = safeUrl(article.license_url || source.license_url || '');
    const sourceName = article.source_name || source.name || '未标注';
    const domain = article.source_domain || source.domain || hostOf(article.url);
    const homepage = safeUrl(source.homepage) || (safeUrl(article.url) ? new URL(article.url).origin : '');
    const url = safeUrl(article.url);
    const translation = article.translation_note || '中文标题与摘要为摘录提炼，非全文翻译。';
    const limit = summaryLimitFor(article, config);
    const summaryChars = [...summary].length;
    const qr = url ? qrDataUrl(url) : '';
    const tagHTML = '<span class="ex-domain">' + escapeHTML(category.name) + '</span>' +
      tags.map((tag) => '<span class="ex-tag">' + escapeHTML(tag) + '</span>').join('');
    const meta = '<div class="ex-meta">' +
      metaRow('来源站点', sourceName + ' · ' + domain) +
      metaRow('作者', author) +
      metaRow('发布日期', published) +
      metaRow('原文语言', language) +
      metaRow('授权状态', license) +
      metaRow('翻译声明', '中文摘录提炼，非全文翻译') +
      metaRow('最近复核', source.reviewed_at || '未标注') +
      '</div>';

    const top = '<div class="ex-topline">' +
      '<span class="ex-brand">拾页 · PAGE OF EVERYTHING</span>' +
      '<span class="ex-brand-sub">跨领域优质内容随机推荐站 / 中文摘录卡 · ' + escapeHTML(article.id || '') + '</span>' +
      '</div>';

    const linkBlock = '<div class="ex-linkbox">' +
      '<span class="ex-link-label">原文链接 / ORIGINAL URL</span>' +
      '<span class="ex-link-url">' + escapeHTML(url || '链接缺失') + '</span>' +
      '</div>';

    const qrBlock = '<div class="ex-qr-block">' +
      (qr ? '<span class="ex-qr-wrap"><img src="' + qr + '" width="240" height="240" alt="原文链接二维码"></span>' : '') +
      '<span class="ex-qr-caption">扫码阅读原文</span>' +
      '<span class="ex-qr-sub">QR · ECC H · quiet zone 4 · ' + (global.APP_CONFIG && global.APP_CONFIG.export ? global.APP_CONFIG.export.qrDisplayPx || 240 : 240) + 'px display</span>' +
      '</div>';

    const licenseBlock = '<div class="ex-license">' +
      '<strong>授权状态：</strong>' + escapeHTML(license) + '<br>' +
      '许可依据：' + (licenseUrl ? escapeHTML(licenseUrl) : '见来源登记') + '<br>' +
      '翻译/衍生：' + escapeHTML(source.translation_basis || translation) + '<br>' +
      '全文边界：本页不展示原文正文；仅保留标题、中文摘录提炼摘要、来源信息与原文链接。' +
      '</div>';

    const sourceRoute = '<p class="ex-route">来源首页：' + escapeHTML(homepage || '未标注') + ' · 原文链接：' + escapeHTML(url || '未标注') + '</p>';

    const summarySection = '<div class="ex-section">' +
      '<span class="ex-section-title">中文摘录提炼 / EXTRACT</span>' +
      '<p class="ex-summary">' + escapeHTML(summary) + '</p>' +
      '<p class="ex-note">摘要 ' + summaryChars + ' 字 · 原文正文约 ' + (article.body_words || '—') + ' 词/字 · 上限 ' +
      limit + ' 字（原文 10% 与 400 字先到者为准）。以摘录与事实提炼为主，不做风格化改写。</p>' +
      '</div>';

    if (mode === 'png') {
      return '<div class="export-doc mode-png" data-export-mode="png">' +
        '<div class="ex-page">' +
        '<span class="ex-page-no">PNG / SINGLE PAGE</span>' +
        top +
        '<p class="ex-kicker">EXCERPT · SOURCE INDEX · TRANSLATION NOTE</p>' +
        '<h1 class="ex-title">' + escapeHTML(title) + '</h1>' +
        (original ? '<p class="ex-original">' + escapeHTML(original) + '</p>' : '') +
        '<div style="margin:0 0 13px">' + tagHTML + '</div>' +
        meta +
        articleFigure(article) +
        summarySection +
        linkBlock +
        qrBlock +
        licenseBlock +
        sourceRoute +
        footerHTML('单页长图') +
        '</div></div>';
    }

    const page1 = '<div class="ex-page" data-export-page="1">' +
      '<span class="ex-page-no">01 / 02</span>' +
      top +
      '<p class="ex-kicker">EXCERPT · SOURCE INDEX · TRANSLATION NOTE</p>' +
      '<h1 class="ex-title">' + escapeHTML(title) + '</h1>' +
      (original ? '<p class="ex-original">' + escapeHTML(original) + '</p>' : '') +
      '<div style="margin:0 0 10px">' + tagHTML + '</div>' +
      meta +
      summarySection +
      '<p class="ex-note">本页为中文摘录，不是原文替代。完整来源入口、授权状态与二维码见下一页。</p>' +
      footerHTML('第 1 / 2 页') +
      '</div>';

    const page2 = '<div class="ex-page" data-export-page="2">' +
      '<span class="ex-page-no">02 / 02</span>' +
      top +
      '<p class="ex-kicker">SOURCE / PERMISSION / LINK</p>' +
      '<h2 class="ex-page-title">把来源，放回它该在的位置。</h2>' +
      '<p class="ex-route">这一页只保留核验入口：原文地址、来源站点、作者、发布日期、原文语言、授权状态与翻译声明。若 PDF 中的文字链接不可点击，二维码是强制兜底。</p>' +
      '<div class="ex-meta">' +
      metaRow('来源站点', sourceName + ' · ' + domain) +
      metaRow('来源首页', homepage || '未标注') +
      metaRow('原文链接', url || '未标注') +
      metaRow('授权状态', license) +
      '</div>' +
      linkBlock +
      qrBlock +
      licenseBlock +
      '<p class="ex-note">后台保留：抓取时间戳 ' + escapeHTML(article.fetched_at || '未标注') +
      ' · feed ' + escapeHTML(article.feed_url || source.feed_url || '未标注') +
      ' · guid ' + escapeHTML(article.guid || '未标注') +
      ' · 摘要方式 ' + escapeHTML(article.summary_method || '未标注') +
      '。复核日期 ' + escapeHTML(source.reviewed_at || '未标注') + '。</p>' +
      footerHTML('第 2 / 2 页') +
      '</div>';

    return '<div class="export-doc mode-pdf" data-export-mode="pdf">' + page1 + page2 + '</div>';
  }

  async function getCss() {
    if (state.css) return state.css;
    if (global.EXPORT_CSS) {
      state.css = global.EXPORT_CSS;
      return state.css;
    }
    try {
      const response = await fetch('assets/css/export.css', { cache: 'force-cache' });
      if (response.ok) state.css = await response.text();
    } catch (error) {
      state.css = '';
    }
    return state.css;
  }

  async function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取图片数据失败。'));
      reader.readAsDataURL(blob);
    });
  }

  function replaceImageWithPlaceholder(img) {
    const figure = img.closest ? img.closest('.ex-figure') : null;
    const placeholder = document.createElement('div');
    placeholder.className = 'ex-placeholder-image';
    placeholder.textContent = '来源图片未通过跨域预检，已使用占位图';
    if (figure && figure.parentNode) figure.parentNode.replaceChild(placeholder, figure);
    else if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
  }

  async function preflightImages(doc) {
    const images = [...doc.querySelectorAll('img[data-export-image]')];
    const problems = [];
    for (let index = 0; index < images.length; index++) {
      const img = images[index];
      setStatus('正在预检图片（' + (index + 1) + ' / ' + images.length + '）…', 22 + Math.round(index / Math.max(1, images.length) * 12));
      const raw = img.getAttribute('data-src') || img.getAttribute('src') || '';
      try {
        if (!raw) throw new Error('图片地址为空');
        if (/^data:image\//i.test(raw)) {
          img.src = raw;
          img.removeAttribute('data-export-image');
          continue;
        }
        const base = new URL(raw, location.href);
        if (!/^https?:$/.test(base.protocol)) throw new Error('不是 HTTP(S) 图片');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
          response = await fetch(base.href, {
            mode: 'cors',
            credentials: 'omit',
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const type = response.headers.get('content-type') || '';
        if (!/^image\//i.test(type)) throw new Error('响应不是图片（' + (type || '无 content-type') + '）');
        const finalUrl = new URL(response.url || base.href);
        if (finalUrl.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) {
          throw new Error('图片被重定向到非来源主机：' + finalUrl.hostname);
        }
        const blob = await response.blob();
        if (blob.size > 8 * 1024 * 1024) throw new Error('图片超过 8MB，已跳过');
        const dataUrl = await blobToDataURL(blob);
        img.src = dataUrl;
        img.removeAttribute('data-src');
        img.removeAttribute('data-export-image');
        await new Promise((resolve, reject) => {
          if (img.complete && img.naturalWidth) return resolve();
          img.onload = resolve;
          img.onerror = () => reject(new Error('图片解码失败'));
        });
      } catch (error) {
        problems.push(error.message);
        replaceImageWithPlaceholder(img);
      }
    }
    if (problems.length) {
      toast('有 ' + problems.length + ' 张来源图片未通过预检，已替换为 CSS 占位图。');
    }
    return problems;
  }

  function makeSvg(node, width, height, css, mode) {
    const clone = node.cloneNode(true);
    clone.style.width = width + 'px';
    clone.style.height = height + 'px';
    clone.style.minHeight = height + 'px';
    clone.style.overflow = 'hidden';
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const style = document.createElement('style');
    style.textContent = css || '';
    clone.insertBefore(style, clone.firstChild);

    let root = clone;
    if (!root.classList.contains('export-doc')) {
      root = document.createElement('div');
      root.className = 'export-doc mode-' + mode;
      root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      root.style.width = width + 'px';
      root.style.height = height + 'px';
      root.style.background = '#fffdf8';
      root.style.overflow = 'hidden';
      root.appendChild(clone);
      const rootStyle = document.createElement('style');
      rootStyle.textContent = css || '';
      root.insertBefore(rootStyle, root.firstChild);
    }

    const serialized = new XMLSerializer().serializeToString(root);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
      '<foreignObject x="0" y="0" width="' + width + '" height="' + height + '">' +
      serialized +
      '</foreignObject></svg>';
  }

  async function rasterize(node, width, height, scale, mode, mime, quality) {
    const config = global.APP_CONFIG || {};
    const maxPixels = Number(config.export && config.export.maxCanvasPixels) || 32000000;
    if (width * height * scale * scale > maxPixels) {
      throw new Error('页面尺寸超出单张画布上限（' + Math.round(width * height * scale * scale / 1000000) + 'MP）。请改用 PDF 或打印。');
    }
    const css = await getCss();
    const svg = makeSvg(node, width, height, css, mode);
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const image = new Image();
    image.decoding = 'sync';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('模板渲染超时。可能是字体或离屏 DOM 未被浏览器支持。')), 12000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('浏览器未能把导出模板渲染为图片。')); };
      image.src = dataUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器无法创建画布。');
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(image, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('画布导出失败，可能是图片或画布过大。'));
      }, mime, quality);
    });
    return { blob, width: canvas.width, height: canvas.height };
  }

  function linkRects(page) {
    const link = page.querySelector('.ex-link-url');
    if (!link) return [];
    const box = page.getBoundingClientRect();
    const rect = link.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    return [{
      x: rect.left - box.left,
      y: rect.top - box.top,
      width: rect.width,
      height: rect.height,
      url: state.article && state.article.url ? state.article.url : ''
    }];
  }

  function sanitizeFileName(value) {
    const cleaned = String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.\-\s]+|[.\-\s]+$/g, '');
    return [...cleaned].slice(0, 96).join('') || 'export';
  }

  function exportFileName(article, app, extension) {
    const category = categoryOf(article, app);
    const title = [...String(article.title_zh || article.title_original || '未命名')].slice(0, 20).join('');
    return sanitizeFileName(category.name + '-' + title + '-' + stampDate(new Date())) + '.' + extension;
  }

  function fileForBlob(blob, name) {
    try {
      return new File([blob], name, { type: blob.type || 'application/octet-stream' });
    } catch (error) {
      return null;
    }
  }

  async function deliver(blob, fileName, format) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      const file = fileForBlob(blob, fileName);
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '拾页 · 中文摘录卡' });
          return;
        } catch (error) {
          if (error && error.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) {
        URL.revokeObjectURL(url);
        throw new Error('iOS 浏览器阻止了新窗口。请使用“改用打印”，或长按预览保存。');
      }
      setTimeout(() => URL.revokeObjectURL(url), 90000);
      toast('已在新窗口打开，请长按图片或文件保存。');
      return;
    }

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 45000);
    toast((format === 'pdf' ? 'PDF' : 'PNG') + ' 已生成，正在下载。');
  }

  async function renderPdf(article, app) {
    const pages = [...state.doc.querySelectorAll('.ex-page')];
    if (!pages.length) throw new Error('PDF 模板没有页面。');
    const pageImages = [];
    for (let index = 0; index < pages.length; index++) {
      setStatus('正在生成 PDF 第 ' + (index + 1) + ' / ' + pages.length + ' 页…', 48 + Math.round(index / pages.length * 36));
      const links = linkRects(pages[index]);
      const result = await rasterize(pages[index], 794, 1123, 2, 'pdf', 'image/jpeg', 0.93);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());
      pageImages.push({ jpeg: bytes, width: result.width, height: result.height, links });
    }
    const category = categoryOf(article, app);
    const tags = (article.tags || []).slice(0, 6);
    setStatus('正在封装 PDF 与元数据…', 88);
    const blob = global.PDFLite.buildImagePdf(pageImages, {
      title: article.title_zh || article.title_original || '中文摘录卡',
      author: article.author || '未署名',
      subject: '来源：' + (article.source_name || '') + ' · 原文：' + (article.url || ''),
      keywords: ['中文摘要', '来源索引', category.name].concat(tags).join(', '),
      createdAt: new Date()
    });
    await deliver(blob, exportFileName(article, app, 'pdf'), 'pdf');
  }

  async function renderPng(article, app) {
    setStatus('正在测量长图…', 42);
    const height = Math.ceil(state.doc.getBoundingClientRect().height);
    if (!height || height < 200) throw new Error('导出模板高度异常，无法生成长图。');
    const scale = Number((global.APP_CONFIG && global.APP_CONFIG.export && global.APP_CONFIG.export.pngScale) || 2);
    setStatus('正在生成 2× PNG 长图…', 58);
    const result = await rasterize(state.doc, 794, height, scale, 'png', 'image/png');
    setStatus('正在准备下载…', 92);
    await deliver(result.blob, exportFileName(article, app, 'png'), 'png');
  }

  function printCurrent() {
    const article = state.article;
    const app = state.app;
    if (!article) {
      toast('没有可打印的条目。');
      return;
    }
    try {
      const printRoot = $('#print-root');
      if (!printRoot) throw new Error('打印容器不存在。');
      const doc = buildTemplate(article, app, 'pdf');
      printRoot.innerHTML = doc;
      printRoot.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-printing');
      const cleanup = () => {
        document.body.classList.remove('is-printing');
        printRoot.innerHTML = '';
        printRoot.setAttribute('aria-hidden', 'true');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      setTimeout(() => {
        window.print();
        setTimeout(cleanup, 1500);
      }, 60);
    } catch (error) {
      showError(error);
    }
  }

  async function exportArticle(article, format, app) {
    if (state.busy) return;
    if (!article || !article.id) {
      toast('条目信息不完整，无法导出。');
      return;
    }
    if (!/^https?:/i.test(String(article.url || ''))) {
      toast('原文链接无效，无法生成可核验的导出物。');
      return;
    }
    const token = ++state.token;
    state.busy = true;
    state.article = article;
    state.format = format;
    state.app = app;
    state.lastError = '';
    clearError();

    try {
      openOverlay();
      setStatus('正在准备字体…', 8);
      setDetail('导出为独立模板：重新排版、强制浅色，不截取卡片，不影响筛选和已读状态。');
      const html = buildTemplate(article, app, format === 'png' ? 'png' : 'pdf');
      const stage = $('#export-stage');
      if (!stage) throw new Error('导出舞台不存在。');
      stage.style.position = 'fixed';
      stage.style.left = '-9999px';
      stage.style.top = '0';
      stage.style.width = '794px';
      stage.innerHTML = html;
      state.doc = stage.firstElementChild;
      if (!state.doc) throw new Error('导出模板创建失败。');
      await nextFrame();
      ensureToken(token);

      await prepareFonts();
      ensureToken(token);
      await getCss();
      setStatus('正在预检图片与链接…', 20);
      await preflightImages(state.doc);
      ensureToken(token);
      await nextFrame();

      if (format === 'png') await renderPng(article, app);
      else await renderPdf(article, app);
      ensureToken(token);

      setStatus('已生成，正在下载…', 100);
      setDetail('导出物只包含当前这一条内容。');
      await delay(480);
      if (token === state.token) {
        closeOverlay();
        state.busy = false;
      }
    } catch (error) {
      if (error && error.cancelled) return;
      if (token === state.token) showError(error);
    } finally {
      if (token === state.token) state.busy = false;
    }
  }

  function bind() {
    const closeButton = $('#export-close');
    if (closeButton) closeButton.addEventListener('click', close);
    const retry = $('#export-retry');
    if (retry) {
      retry.addEventListener('click', () => {
        if (!state.article) return;
        clearError();
        exportArticle(state.article, state.format || 'pdf', state.app);
      });
    }
    const print = $('#export-print');
    if (print) print.addEventListener('click', printCurrent);
  }

  bind();

  global.Exporter = {
    exportArticle,
    isOpen,
    close,
    printCurrent
  };
})(window);
