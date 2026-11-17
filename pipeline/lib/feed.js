'use strict';

const { decodeEntities, stripHtml, normalizeSpace, countWords } = require('./util');

function firstMatch(xml, names) {
  for (const name of names) {
    const re = new RegExp('<(?:[\\w-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '>', 'i');
    const match = xml.match(re);
    if (match) return match[1];
  }
  return '';
}

function allMatches(xml, names) {
  const out = [];
  for (const name of names) {
    const re = new RegExp('<(?:[\\w-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '>', 'gi');
    let match;
    while ((match = re.exec(xml))) out.push(match[1]);
  }
  return out;
}

function tagText(xml, names) {
  return normalizeSpace(stripHtml(firstMatch(xml, names)));
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((match) => match[1]);
  if (!links.length) return '';
  const preferred = links.find((attrs) => /rel\s*=\s*["']alternate["']/i.test(attrs)) ||
    links.find((attrs) => !/rel\s*=\s*["'](?:self|enclosure|edit)["']/i.test(attrs)) ||
    links[0];
  const href = preferred.match(/href\s*=\s*["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]).trim() : '';
}

function authorOf(block) {
  const atom = firstMatch(block, ['author']);
  if (atom && /<name\b/i.test(atom)) return normalizeSpace(stripHtml(firstMatch(atom, ['name'])));
  const creator = tagText(block, ['creator', 'author']);
  return creator.replace(/<[^>]+>/g, '').trim();
}

function dateOf(block) {
  const raw = firstMatch(block, ['published', 'pubDate', 'updated', 'date', 'dc:date']);
  if (!raw) return '';
  const value = normalizeSpace(stripHtml(raw));
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function linkOf(block) {
  const atom = atomLink(block);
  if (atom) return atom;
  const plain = firstMatch(block, ['link']);
  if (plain) {
    const text = decodeEntities(stripHtml(plain)).trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  const guid = firstMatch(block, ['guid', 'id']);
  const idText = decodeEntities(stripHtml(guid)).trim();
  return /^https?:\/\//i.test(idText) ? idText : '';
}

function categoriesOf(block) {
  const values = [];
  for (const raw of allMatches(block, ['category'])) {
    const text = decodeEntities(stripHtml(raw));
    if (text) values.push(text);
  }
  for (const match of block.matchAll(/<category\b[^>]*term\s*=\s*["']([^"']+)["'][^>]*\/?>/gi)) {
    values.push(decodeEntities(match[1]));
  }
  return [...new Set(values.map((value) => normalizeSpace(value)).filter(Boolean))];
}

function parseFeed(xmlText) {
  const xml = String(xmlText || '');
  if (!/<(?:rss|feed)\b/i.test(xml)) {
    throw new Error('不是可识别的 RSS/Atom 文档');
  }
  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (!blocks.length) {
    blocks.push(...[...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]));
  }
  const items = [];
  for (const block of blocks) {
    const title = tagText(block, ['title']);
    const link = linkOf(block);
    if (!title || !link) continue;
    const summaryHtml = firstMatch(block, ['description', 'summary', 'content']);
    const contentHtml = firstMatch(block, ['encoded', 'content']);
    const guid = tagText(block, ['guid', 'id']) || link;
    items.push({
      title,
      link,
      guid,
      published_at: dateOf(block),
      author: authorOf(block),
      summary_html: summaryHtml,
      content_html: contentHtml,
      summary_text: normalizeSpace(stripHtml(summaryHtml)),
      content_text: normalizeSpace(stripHtml(contentHtml)),
      categories: categoriesOf(block),
      language: ''
    });
  }
  return items;
}

function parseRobots(text, userAgent, pathname) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const index = line.indexOf(':');
    if (index < 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (!value) continue;
      current.rules.push({ type: key, path: value });
    } else if (key === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay > 0) current.crawlDelay = delay;
    }
  }

  const uaLower = String(userAgent || '').toLowerCase();
  const matching = groups.filter((group) => group.agents.some((agent) => {
    if (agent === '*') return true;
    const token = agent.split('/')[0].trim();
    return token && uaLower.includes(token);
  }));
  const rules = matching.flatMap((group) => group.rules);
  const crawlDelay = Math.max(0, ...matching.map((group) => group.crawlDelay || 0));
  let best = null;
  for (const rule of rules) {
    let pattern = rule.path;
    let endAnchored = false;
    if (pattern.endsWith('$')) {
      pattern = pattern.slice(0, -1);
      endAnchored = true;
    }
    const regex = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (endAnchored ? '$' : ''));
    if (!regex.test(pathname)) continue;
    if (!best || rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.type === 'allow')) {
      best = rule;
    }
  }
  return {
    allowed: !best || best.type === 'allow',
    crawlDelay,
    rule: best ? best.type + ' ' + best.path : 'no matching rule'
  };
}

async function fetchWithRedirect(url, options) {
  const fetchImpl = options.fetchImpl || global.fetch;
  let current = url;
  for (let i = 0; i <= options.maxRedirects; i++) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error('重定向次数超过上限');
}

async function robotsCheck(source, sourceState, options) {
  const feedUrl = new URL(source.feed_url);
  const robotsUrl = feedUrl.origin + '/robots.txt';
  const cacheMs = (options.robotsCacheHours || 24) * 3600000;
  const checkedAt = Date.parse(sourceState.robots && sourceState.robots.checked_at);
  if (!options.force &&
    Number.isFinite(checkedAt) &&
    Date.now() - checkedAt < cacheMs &&
    sourceState.robots.checked_url === robotsUrl) {
    return {
      allowed: sourceState.robots.allowed !== false,
      crawlDelay: sourceState.robots.crawl_delay_seconds || 0,
      cached: true,
      reason: 'robots 缓存'
    };
  }

  let response;
  try {
    response = await fetchWithRedirect(robotsUrl, {
      fetchImpl: options.fetchImpl,
      headers: {
        'user-agent': options.userAgent,
        accept: 'text/plain,*/*;q=0.8'
      },
      timeoutMs: options.timeoutMs,
      maxRedirects: options.maxRedirects
    });
  } catch (error) {
    const previous = sourceState.robots || {};
    sourceState.robots = {
      checked_at: new Date().toISOString(),
      allowed: previous.allowed !== false && source.robots_allowed !== false,
      crawl_delay_seconds: previous.crawl_delay_seconds || 0,
      checked_url: robotsUrl,
      warning: 'robots.txt 拉取失败，沿用已登记核查结果：' + error.message
    };
    return { allowed: sourceState.robots.allowed, crawlDelay: sourceState.robots.crawl_delay_seconds, cached: false, reason: 'robots 拉取失败，按来源登记值' };
  }

  const status = response.response.status;
  if (status === 404 || status === 410) {
    sourceState.robots = {
      checked_at: new Date().toISOString(),
      allowed: true,
      crawl_delay_seconds: 0,
      checked_url: robotsUrl,
      reason: 'robots.txt 不存在（404/410），按无限制处理'
    };
    return { allowed: true, crawlDelay: 0, cached: false, reason: 'robots 404' };
  }
  if (status === 401 || status === 403) {
    sourceState.robots = {
      checked_at: new Date().toISOString(),
      allowed: false,
      crawl_delay_seconds: 0,
      checked_url: robotsUrl,
      reason: 'robots.txt 拒绝访问'
    };
    return { allowed: false, crawlDelay: 0, cached: false, reason: 'robots 拒绝' };
  }
  if (!response.response.ok) {
    const previous = sourceState.robots || {};
    sourceState.robots = {
      checked_at: new Date().toISOString(),
      allowed: previous.allowed !== false && source.robots_allowed !== false,
      crawl_delay_seconds: previous.crawl_delay_seconds || 0,
      checked_url: robotsUrl,
      warning: 'robots.txt HTTP ' + status + '，沿用已登记核查结果'
    };
    return { allowed: sourceState.robots.allowed, crawlDelay: sourceState.robots.crawl_delay_seconds, cached: false, reason: 'robots HTTP ' + status };
  }

  const text = await response.response.text();
  const pathname = feedUrl.pathname || '/';
  const policy = parseRobots(text, options.userAgent, pathname);
  sourceState.robots = {
    checked_at: new Date().toISOString(),
    allowed: policy.allowed,
    crawl_delay_seconds: policy.crawlDelay,
    checked_url: robotsUrl,
    reason: policy.rule
  };
  return { ...policy, cached: false, reason: policy.rule };
}

function feedPathLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch (error) {
    return '';
  }
}

async function fetchSource(source, sourceState, options) {
  const config = options.config;
  if (!source.feed_url) {
    return { status: 'failed', error: '来源未配置 feed_url', items: [] };
  }
  if (source.robots_allowed === false) {
    return { status: 'robots_denied', error: '来源登记的 robots_allowed=false', items: [] };
  }

  const policy = await robotsCheck(source, sourceState, {
    fetchImpl: options.fetchImpl,
    timeoutMs: config.http.timeout_ms,
    maxRedirects: config.http.max_redirects,
    userAgent: config.http.user_agent,
    robotsCacheHours: config.http.robots_cache_hours,
    force: options.force
  });
  if (!policy.allowed) {
    return { status: 'robots_denied', error: 'robots 不允许抓取 ' + feedPathLabel(source.feed_url), items: [], robots: policy };
  }
  if (policy.crawlDelay) {
    const minimum = policy.crawlDelay * 60000;
    sourceState.interval_minutes = Math.max(Number(sourceState.interval_minutes) || 0, minimum / 60000);
  }

  const headers = {
    'user-agent': config.http.user_agent,
    accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
    'accept-language': 'en;q=0.9,zh-CN;q=0.6'
  };
  if (sourceState.etag) headers['if-none-match'] = sourceState.etag;
  if (sourceState.last_modified) headers['if-modified-since'] = sourceState.last_modified;

  let result;
  try {
    result = await fetchWithRedirect(source.feed_url, {
      fetchImpl: options.fetchImpl,
      headers,
      timeoutMs: config.http.timeout_ms,
      maxRedirects: config.http.max_redirects
    });
  } catch (error) {
    return { status: 'failed', error: error.name === 'TimeoutError' ? '请求超时' : error.message, items: [] };
  }

  const response = result.response;
  const headersOut = {
    etag: response.headers.get('etag') || '',
    lastModified: response.headers.get('last-modified') || ''
  };
  if (response.status === 304) {
    return { status: '304', items: [], headers: headersOut, finalUrl: result.finalUrl };
  }
  if (!response.ok) {
    return {
      status: 'failed',
      error: 'HTTP ' + response.status,
      httpStatus: response.status,
      headers: headersOut,
      finalUrl: result.finalUrl,
      items: []
    };
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    return { status: 'failed', error: '读取响应失败：' + error.message, items: [], headers: headersOut };
  }
  if (Buffer.byteLength(text, 'utf8') > config.http.max_bytes) {
    return { status: 'failed', error: '响应超过 max_bytes 限制', items: [], headers: headersOut };
  }

  let items;
  try {
    items = parseFeed(text);
  } catch (error) {
    return { status: 'failed', error: '解析失败：' + error.message, items: [], headers: headersOut };
  }

  return {
    status: items.length ? '200' : 'empty',
    items,
    headers: headersOut,
    finalUrl: result.finalUrl,
    bytes: Buffer.byteLength(text, 'utf8'),
    parse: { itemCount: items.length }
  };
}

module.exports = {
  fetchSource,
  parseFeed,
  parseRobots,
  robotsCheck
};
