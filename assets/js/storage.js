/* localStorage 只保存在本机：已读、已隐藏主题、上一批与界面偏好。 */
(function (global) {
  'use strict';

  const prefix = (global.APP_CONFIG && global.APP_CONFIG.storagePrefix) || 'kuayu.v1.';

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(prefix + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(prefix + key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function uniqueStrings(value) {
    return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string'))] : [];
  }

  function getState() {
    const readIds = uniqueStrings(read('readIds', []));
    const hiddenIds = uniqueStrings(read('hiddenIds', []));
    const hiddenTags = uniqueStrings(read('hiddenTags', []));
    const hiddenEvents = uniqueStrings(read('hiddenEvents', []));
    const lastBatchIds = uniqueStrings(read('lastBatchIds', []));
    const interestedIds = uniqueStrings(read('interestedIds', []));
    return { readIds, hiddenIds, hiddenTags, hiddenEvents, lastBatchIds, interestedIds };
  }

  /* 感兴趣：点击刷新时保留这些卡片。 */
  function markInterested(id, value) {
    const state = getState();
    const set = new Set(state.interestedIds);
    if (value === false) set.delete(id);
    else set.add(id);
    write('interestedIds', [...set]);
    return getState();
  }

  function isInterested(id) {
    return getState().interestedIds.includes(id);
  }

  /* 已换入过的新内容 id：避免同一条新内容被反复换入。 */
  function getUsedFreshIds() {
    return uniqueStrings(read('usedFreshIds', []));
  }

  function addUsedFreshIds(ids) {
    const set = new Set(getUsedFreshIds());
    uniqueStrings(ids).forEach((id) => set.add(id));
    write('usedFreshIds', [...set]);
    return [...set];
  }

  function markRead(id, value) {
    const state = getState();
    const set = new Set(state.readIds);
    if (value === false) set.delete(id);
    else set.add(id);
    write('readIds', [...set]);
    return getState();
  }

  function isRead(id) {
    return getState().readIds.includes(id);
  }

  function hideSimilar(article) {
    const state = getState();
    const hiddenIds = new Set(state.hiddenIds);
    const hiddenTags = new Set(state.hiddenTags);
    const hiddenEvents = new Set(state.hiddenEvents);
    hiddenIds.add(article.id);
    if (article.event_key) hiddenEvents.add(article.event_key);
    (article.tags || []).forEach((tag) => hiddenTags.add(tag));
    write('hiddenIds', [...hiddenIds]);
    write('hiddenTags', [...hiddenTags]);
    write('hiddenEvents', [...hiddenEvents]);
    return getState();
  }

  function clearRead() {
    write('readIds', []);
    return getState();
  }

  function clearHidden() {
    write('hiddenIds', []);
    write('hiddenTags', []);
    write('hiddenEvents', []);
    return getState();
  }

  function setLastBatch(ids) {
    write('lastBatchIds', uniqueStrings(ids));
  }

  function getPreference(key, fallback) {
    return read('pref.' + key, fallback);
  }

  function setPreference(key, value) {
    return write('pref.' + key, value);
  }

  /* 自定义标签规则：与已读/隐藏分开存放，避免相互干扰。 */
  function getCustomTags() {
    const value = read('customTags', []);
    return Array.isArray(value) ? value : [];
  }

  function saveCustomTags(rules) {
    return write('customTags', Array.isArray(rules) ? rules : []);
  }

  global.Store = {
    getState,
    markRead,
    isRead,
    hideSimilar,
    clearRead,
    clearHidden,
    setLastBatch,
    getPreference,
    setPreference,
    getCustomTags,
    saveCustomTags,
    markInterested,
    isInterested,
    getUsedFreshIds,
    addUsedFreshIds
  };
})(window);
