'use strict';

/*
 * 复用浏览器端的质量规则与推荐去重函数，避免管道另写一套阈值。
 * 这些脚本是 IIFE，必须在 window/location 存在的环境中加载。
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
global.window = global;
global.location = { href: 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/') };

require(path.join(root, 'assets/js/config.js'));
require(path.join(root, 'assets/js/quality.js'));
require(path.join(root, 'assets/js/recommender.js'));

module.exports = {
  root,
  config: global.APP_CONFIG,
  Quality: global.Quality,
  Recommender: global.Recommender
};
