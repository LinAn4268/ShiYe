/* 全局配置：领域权重、质量门槛、抽样约束和导出尺寸。 */
(function () {
  'use strict';

  const CATEGORY_WEIGHTS = {
    'tech-ai': { source: 0.20, density: 0.25, fact: 0.20, freshness: 0.25, representative: 0.10 },
    'business-finance': { source: 0.20, density: 0.25, fact: 0.20, freshness: 0.25, representative: 0.10 },
    'product-operations': { source: 0.20, density: 0.25, fact: 0.20, freshness: 0.25, representative: 0.10 },
    'programming-open-source': { source: 0.20, density: 0.25, fact: 0.20, freshness: 0.25, representative: 0.10 },
    'science-nature': { source: 0.25, density: 0.20, fact: 0.30, freshness: 0.10, representative: 0.15 },
    'health-wellbeing': { source: 0.25, density: 0.20, fact: 0.30, freshness: 0.10, representative: 0.15 },
    'environment-sustainability': { source: 0.25, density: 0.20, fact: 0.30, freshness: 0.10, representative: 0.15 },
    'humanities-history': { source: 0.20, density: 0.30, fact: 0.15, freshness: 0.05, representative: 0.30 },
    'arts-culture': { source: 0.20, density: 0.30, fact: 0.15, freshness: 0.05, representative: 0.30 },
    'architecture-cities': { source: 0.20, density: 0.30, fact: 0.15, freshness: 0.05, representative: 0.30 },
    'lifestyle': { source: 0.20, density: 0.30, fact: 0.15, freshness: 0.05, representative: 0.30 }
  };

  window.APP_CONFIG = {
    version: '1.0.0',
    snapshotDate: '2026-11-16T09:30:00+08:00',
    appName: '跨领域优质内容随机推荐站',
    dataFiles: {
      domains: 'data/domains.json',
      sources: 'data/sources.json',
      articles: 'data/articles.json',
      audit: 'data/audit.json'
    },
    batchSize: 12,
    minCategories: 8,
    maxPerCategory: 3,
    maxPerTag: 1,
    maxConsecutiveSource: 2,
    maxPerGradeC: 3,
    quality: {
      threshold: 3.0,
      sourceGradeScores: { A: 5, B: 4, C: 2, D: 1 },
      summaryMaxChars: 400,
      summaryMaxRatio: 0.10,
      charsPerEnglishWord: 1.6,
      minBodyWords: 100,
      minInfoRatio: 0.30,
      minDensityScore: 2,
      freshnessBands: [
        { maxDays: 7, score: 5 },
        { maxDays: 30, score: 4 },
        { maxDays: 90, score: 3 },
        { maxDays: 180, score: 2 },
        { maxDays: 365, score: 1.5 }
      ],
      defaultWeights: { source: 0.25, density: 0.25, fact: 0.20, freshness: 0.15, representative: 0.15 },
      categoryWeights: CATEGORY_WEIGHTS,
      sourcePassRateHigh: 0.90,
      sourcePassRateLow: 0.10,
      sourcePassWindowDays: 30,
      clickbaitTerms: ['震惊', '重磅', '必看', '刷屏', '炸裂', '颠覆', '史上最', '绝了', '疯传', '揭秘', '内幕', '不看后悔', '所有人都', '99%', '彻底改变', '一夜之间', '真相']
    },
    sampling: {
      readPenalty: 0.35,
      lastBatchPenalty: 0.15,
      sourceReusePenalty: 0.55,
      scoreExponent: 2.2,
      attempts: 900,
      staleSourceDays: 7,
      staleSourcePenalty: 0.65
    },
    storagePrefix: 'kuayu.v1.',
    export: {
      pngScale: 2,
      qrDisplayPx: 240,
      qrSourcePx: 512,
      a4CssWidth: 794,
      a4CssHeight: 1123,
      pagePaddingTop: 52,
      pagePaddingBottom: 54,
      pagePaddingX: 58,
      pdfPageWidthPt: 595.28,
      pdfPageHeightPt: 841.89,
      maxCanvasPixels: 32000000
    },
    messages: {
      empty: '这一筛选组合下暂时没有通过质量筛选的内容。',
      noMore: '本轮可用内容已展示完，换一个领域或减少筛选条件试试。',
      hidden: '已减少此类内容的推荐。',
      read: '已标记为已读。',
      unread: '已取消已读标记。'
    }
  };
})();
