/* 用户自定义标签：规则存 localStorage，每次加载时对全部已载入文章重新匹配。
   不改变来源许可、质量评分与已有数据结构；新内容只要被载入就会自动套用规则。 */
(function (global) {
  'use strict';

  const MAX_RULES = 40;
  const MAX_NAME = 20;
  const MAX_KEYWORDS = 12;
  const MAX_KEYWORD_LENGTH = 60;

  function uniqueId() {
    return 'ct_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalize(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function storage() {
    return global.Store || null;
  }

  /** 读取全部规则；任何损坏数据都退化为 []，不影响页面启动。 */
  function getAll() {
    const store = storage();
    if (!store || typeof store.getCustomTags !== 'function') return [];
    const raw = store.getCustomTags();
    if (!Array.isArray(raw)) return [];
    return raw.filter((rule) => (
      rule && typeof rule.id === 'string' && typeof rule.name === 'string' &&
      rule.name.length <= MAX_NAME && Array.isArray(rule.keywords)
    )).map((rule) => ({
      id: rule.id,
      name: rule.name,
      category: typeof rule.category === 'string' ? rule.category : 'all',
      keywords: rule.keywords
        .filter((word) => typeof word === 'string' && word.trim())
        .slice(0, MAX_KEYWORDS),
      created_at: rule.created_at || ''
    }));
  }

  function saveAll(rules) {
    const store = storage();
    if (!store || typeof store.saveCustomTags !== 'function') return false;
    return store.saveCustomTags(rules.slice(0, MAX_RULES));
  }

  function validate(name, category, keywords, existingTags) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    if (!cleanName) return { ok: false, error: '请输入标签名称。' };
    const words = String(keywords || '')
      .split(/[,，\n;；]/)
      .map((word) => word.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .filter((word, index, list) => list.indexOf(word) === index)
      .slice(0, MAX_KEYWORDS);
    if (!words.length) return { ok: false, error: '请至少填写一个关键词。' };
    if (words.some((word) => word.length > MAX_KEYWORD_LENGTH)) {
      return { ok: false, error: '单个关键词不能超过 ' + MAX_KEYWORD_LENGTH + ' 个字符。' };
    }
    const taken = new Set((existingTags || []).map((tag) => normalize(tag)));
    if (taken.has(normalize(cleanName))) {
      return { ok: false, error: '“' + cleanName + '”已存在，请换一个名称。' };
    }
    return { ok: true, value: { name: cleanName, category: category || 'all', keywords: words } };
  }

  function add(name, category, keywords, existingTags) {
    const checked = validate(name, category, keywords, existingTags);
    if (!checked.ok) return checked;
    const rules = getAll();
    if (rules.length >= MAX_RULES) return { ok: false, error: '最多保存 ' + MAX_RULES + ' 个自定义标签。' };
    const rule = Object.assign({ id: uniqueId(), created_at: new Date().toISOString() }, checked.value);
    rules.push(rule);
    if (!saveAll(rules)) return { ok: false, error: '浏览器拒绝保存，请检查隐私模式或存储权限。' };
    return { ok: true, rule };
  }

  function remove(id) {
    const rules = getAll();
    const target = rules.find((rule) => rule.id === id);
    if (!target) return { ok: false, error: '标签不存在。' };
    if (!saveAll(rules.filter((rule) => rule.id !== id))) {
      return { ok: false, error: '浏览器拒绝保存，请检查隐私模式或存储权限。' };
    }
    return { ok: true, rule: target };
  }

  function matches(rule, article) {
    if (!rule.keywords.length) return false;
    if (rule.category !== 'all' && rule.category !== article.category) return false;
    const haystack = normalize([
      article.title_original,
      article.title_zh,
      article.summary_zh,
      article.source_name,
      article.source_domain,
      (article.tags || []).join(' ')
    ].join(' '));
    return rule.keywords.some((word) => haystack.indexOf(normalize(word)) !== -1);
  }

  /** 对所有已载入文章幂等套用规则；返回命中统计，供界面提示。 */
  function applyTo(articles) {
    const rules = getAll();
    let touched = 0;
    let applied = 0;
    (articles || []).forEach((article) => {
      if (!article || !Array.isArray(article.tags)) return;
      let changed = false;
      rules.forEach((rule) => {
        if (!matches(rule, article)) return;
        if (article.tags.indexOf(rule.name) !== -1) return;
        article.tags.push(rule.name);
        applied++;
        changed = true;
      });
      if (changed) touched++;
    });
    return { rules: rules.length, touched, applied };
  }

  /** 删除规则后，从内存中的文章对象移除其标签名，界面立即生效。 */
  function removeFrom(articles, name) {
    let touched = 0;
    (articles || []).forEach((article) => {
      if (!article || !Array.isArray(article.tags)) return;
      const index = article.tags.indexOf(name);
      if (index !== -1) {
        article.tags.splice(index, 1);
        touched++;
      }
    });
    return touched;
  }

  /** 规则下当前命中的条数，用于管理面板展示。 */
  function countFor(rule, articles) {
    return (articles || []).filter((article) => article && matches(rule, article)).length;
  }

  function nameSet() {
    return new Set(getAll().map((rule) => rule.name));
  }

  global.CustomTags = {
    getAll,
    add,
    remove,
    matches,
    applyTo,
    removeFrom,
    countFor,
    nameSet,
    MAX_RULES,
    MAX_NAME
  };
})(window);
