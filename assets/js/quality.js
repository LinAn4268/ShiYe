/* 四层质量筛选：来源准入、硬性否决、加权评分、领域适配。 */
(function (global) {
  'use strict';

  const REASON = {
    source_inactive: '来源已暂停或移出推荐池',
    source_unknown: '来源未登记，无法核验许可',
    license_missing: '缺少可核验的许可依据',
    translation_forbidden: '来源条款禁止翻译或衍生作品',
    grade_d: 'D 级来源（匿名 / 无法追溯）',
    no_summary: '未生成中文摘录摘要',
    summary_over_limit: '摘要超过正文 10% 或 400 字硬上限',
    too_short: '有效正文低于最低字数',
    low_info_ratio: '实质信息占比低于 30%',
    clickbait: '标题党且正文无事实增量',
    stale: '超出领域时效窗口',
    low_density: '信息密度低于最低要求',
    below_threshold: '加权总分低于 3.0',
    taken_down: '内容已因投诉下架，不再进入推荐池'
  };

  function parseDate(value) {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time) : null;
  }

  function daysBetween(older, newer) {
    if (!older || !newer) return null;
    return Math.floor((newer.getTime() - older.getTime()) / 86400000);
  }

  function freshnessScore(days, bands) {
    if (days == null) return 2;
    for (const band of bands) {
      if (days <= band.maxDays) return band.score;
    }
    return 1;
  }

  function sourceScore(grade, scores) {
    return scores[grade] == null ? 0 : scores[grade];
  }

  function weightsFor(categoryId, quality) {
    return quality.categoryWeights[categoryId] || quality.defaultWeights;
  }

  function weightedScore(parts, weights) {
    let total = 0;
    let weightSum = 0;
    for (const key of Object.keys(weights)) {
      const value = Number(parts[key]) || 0;
      total += value * weights[key];
      weightSum += weights[key];
    }
    return weightSum > 0 ? total / weightSum : 0;
  }

  function summaryLimit(article, quality) {
    const ratio = quality.summaryMaxRatio;
    const chars = article.language === 'zh'
      ? article.body_words * ratio
      : article.body_words * quality.charsPerEnglishWord * ratio;
    return Math.min(quality.summaryMaxChars, Math.floor(chars));
  }

  function clickbaitHit(article, quality) {
    if (article.clickbait === true) return true;
    const title = (String(article.title_zh || '') + ' ' + String(article.title_original || '')).toLowerCase();
    const terms = quality.clickbaitTerms || [];
    const lexicalHit = terms.some((term) => title.includes(String(term).toLowerCase()));
    // 命中词库不直接否决；只有事实核验分偏低（无对应事实增量）时才视为标题党。
    return lexicalHit && Number(article.fact_score) < 4;
  }

  function evaluate(article, source, category, config, now) {
    const quality = config.quality;
    const reasons = [];
    const reject = (code) => {
      if (!reasons.some((item) => item.code === code)) {
        reasons.push({ code, label: REASON[code] || code });
      }
    };

    if (article.takedown && article.takedown.status === 'removed') reject('taken_down');
    if (!source || source.status !== 'active') reject('source_inactive');
    if (!source || !source.license_basis) reject('license_missing');
    if (source && source.grade === 'D') reject('grade_d');
    if (source && source.translation_allowed !== true) reject('translation_forbidden');

    const text = String(article.summary_zh || '').trim();
    if (!text) reject('no_summary');
    const limit = summaryLimit(article, quality);
    if (text && [...text].length > limit) reject('summary_over_limit');

    const minimum = article.language === 'zh' ? 200 : quality.minBodyWords;
    if (!article.body_words || article.body_words < minimum) reject('too_short');
    if (Number(article.info_ratio) < quality.minInfoRatio) reject('low_info_ratio');
    if (Number(article.density_score) < quality.minDensityScore) reject('low_density');
    if (clickbaitHit(article, quality)) reject('clickbait');

    const published = parseDate(article.published_at);
    const snapshot = now || parseDate(config.snapshotDate);
    const ageDays = daysBetween(published, snapshot);
    const classic = category && category.classic_after_days != null && ageDays != null
      ? ageDays > category.classic_after_days
      : false;
    if (category && category.max_age_days != null && ageDays != null && ageDays > category.max_age_days) {
      reject('stale');
    }

    const weights = weightsFor(article.category, quality);
    const parts = {
      source: sourceScore(source && source.grade, quality.sourceGradeScores),
      density: Number(article.density_score) || 0,
      fact: Number(article.fact_score) || 0,
      freshness: freshnessScore(ageDays, quality.freshnessBands),
      representative: Number(article.representativeness) || 0
    };
    const score = Math.round(weightedScore(parts, weights) * 100) / 100;
    if (score < quality.threshold) reject('below_threshold');

    return {
      ok: reasons.length === 0,
      reasons,
      score,
      parts,
      weights,
      ageDays,
      classic,
      summaryLimit: limit,
      summaryChars: [...text].length
    };
  }

  global.Quality = {
    REASON,
    evaluate,
    parseDate,
    daysBetween,
    freshnessScore,
    summaryLimit,
    clickbaitHit,
    weightedScore,
    weightsFor
  };
})(window);
