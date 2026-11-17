# 拾页 · 跨领域优质内容随机推荐站

从 21 个一级领域中分层抽取 12 条内容，提供**中文摘录提炼摘要 + 真实来源 + 原文链接**。默认不搬运全文，不把 RSS/API 的存在当成转载许可，也不把“来源等级”当成免检资格。

- 当前演示快照：`2026-11-16`
- 36 条演示内容，覆盖 21 个一级领域
- 12 个在池来源，另有 2 个“禁止翻译/衍生”的排除反例
- 纯前端、零运行时依赖，可直接双击 `index.html` 运行
- 导出为独立重排模板，不截取网页卡片；PDF/PNG 均在前端生成
- 演示数据中的图片一律不使用来源图，以 CSS 占位图呈现

> 这是一个**可运行的静态原型**，不是抓取服务。真实抓取、缓存、频率限制、投诉下架和逐源许可复核需要后端或人工流程配合；上线前请按第 10 节重新做合规评估。

---

## 目录

1. [快速启动](#1-快速启动)
2. [网页结构说明](#2-网页结构说明)
3. [目录结构](#3-目录结构)
4. [数据源替换](#4-数据源替换)
5. [领域与标签配置](#5-领域与标签配置)
6. [推荐与质量筛选](#6-推荐与质量筛选)
7. [来源登记与本机状态](#7-来源登记与本机状态)
8. [PDF / PNG 导出](#8-pdf--png-导出)
9. [测试与验收](#9-测试与验收)
10. [合规提示](#10-合规提示)
11. [已知限制与上线建议](#11-已知限制与上线建议)
12. [内容自动更新管道](#12-内容自动更新管道)

---

## 1. 快速启动

### 方式 A：直接双击（最简单）

双击项目根目录的 `index.html`。

`file://` 模式下浏览器通常会阻止 `fetch()` 读取本地 JSON，因此页面会自动使用由构建脚本生成的：

```text
data/fallback-data.js
```

它包含与四个 JSON 完全一致的快照。只要没有改过数据，就能直接打开。

### 方式 B：本地 HTTP 服务（推荐用于开发）

在项目根目录执行：

```bash
python -m http.server 8000
```

然后打开：

```text
http://localhost:8000/
```

使用 Python 3 即可，不需要安装前端框架。也可以用任意静态文件服务器，例如 VS Code Live Server、Caddy、Nginx。

### 修改数据后的重新生成

项目没有打包器，但有两个小的生成脚本。修改 `data/*.json` 后：

```bash
node tools/build-fallback.mjs
```

修改 `assets/css/export.css` 后：

```bash
node tools/build-export-css.mjs
```

要求 Node.js 18+。如果系统没有全局 `node`，可以用你本机的 Node 可执行文件运行同样命令。

校验：

```bash
node tools/validate.cjs
```

本机实测输出为 `全部静态验收通过：20 项`。

---

## 2. 网页结构说明

### 2.1 页面层级

```text
<header>  品牌 / 今日推荐 / 来源登记 / 筛选与规则 / 快照日期 / 主题切换
<main>
  #view-feed       首页推荐
    .hero          标题、说明、“换一批”、本批票据（条数/领域数/均分/来源数）
    .filter-panel  21 个一级领域 chips；选中领域后显示二级标签
    #feed-status   骨架屏与加载文案
    #card-grid     12 张内容卡片
    #empty-state   空状态：换筛选 / 恢复已隐藏内容
    .end-note      摘要 + 链接边界说明
  #view-sources    来源台账
    .ledger-summary  在池 / 排除 / 待复核数量
    #source-list     来源卡：等级、获取方式、许可、robots、全文、翻译、复核日期
    .rhythm-grid     90 天复核、7 天降权、投诉暂停、feed 变化边界
  #view-method     筛选与规则
    四层 pipeline、丢弃原因、来源通过率、前 10 条 trace、配置表
<footer>  版权与非替代声明
<div id="toast"> 轻提示
<div id="export-overlay"> 导出进度 / 失败原因 / 重试 / 打印兜底
<div id="export-stage"> 离屏导出模板（position:fixed;left:-9999px;top:0）
<div id="print-root"> 打印兜底容器
```

### 2.2 卡片包含什么

每张卡片显示：

- 汉化标题（主标题）
- 中文摘要，最多 400 字，且不超过原文正文词数折算后的 10%
- 原文标题（对照用，不折叠全文）
- 一级领域、二级标签
- 来源站点 + 域名（可点回首页）
- 作者；缺失时显示“未署名”
- 发布日期；缺失时显示“未标注”
- 原文语言
- 授权状态与翻译声明
- “阅读原文”（新标签页，`rel="noopener noreferrer"`）
- “已读”“不再推荐类似内容”“导出 PDF/PNG”
- 质量 trace 详情（分数、各分项、摘要长度/上限、时效）

### 2.3 交互状态

| 操作 | 行为 |
| --- | --- |
| 换一批 / 按 `R` | 重新分层抽样；降低上一批内容权重，尽量不重复 |
| 选一级领域 | 只保留该领域；单领域时放宽“覆盖 8 类”和“单领域最多 3 条” |
| 选二级标签 | 仅显示当前领域内具有该标签的内容；无数据标签不渲染 |
| 标记已读 | 写入 localStorage；后续抽样权重乘以 `0.35` |
| 不再推荐类似内容 | 隐藏本文、同 `event_key` 事件、同标签内容 |
| 导出 | 独立离屏 DOM，不影响列表、筛选、已读状态和推荐池 |
| 主题切换 | 深/浅色偏好写入 localStorage；导出模板始终强制浅色 |

### 2.4 前端模块

```text
assets/js/config.js        权重、阈值、抽样参数、导出尺寸
assets/js/data-loader.js   HTTP fetch；file:// 时回退 fallback-data.js
assets/js/quality.js       四层筛选与加权评分
assets/js/recommender.js   去重、分层/加权随机、已读/隐藏/上一批惩罚
assets/js/storage.js       localStorage 封装
assets/js/ui.js            渲染、筛选、事件、来源台账、审计表
assets/js/qrcode.js        自写 QR（Byte 模式，ECC H，v1–v20）
assets/js/pdf-lite.js      自写最小 PDF（JPEG 页 + 元数据 + 链接注释）
assets/js/exporter.js      导出模板、字体等待、图片预检、PNG/PDF、下载兜底
assets/js/main.js          启动入口
assets/js/export-styles.js 由 export.css 生成的内联 CSS
```

加载顺序已经写在 `index.html` 中；`export-styles.js` 必须在 `exporter.js` 之前加载。

---

## 3. 目录结构

```text
跨领域优质内容随机推荐站/
├─ index.html
├─ README.md
├─ assets/
│  ├─ css/
│  │  ├─ styles.css             页面主题与响应式布局
│  │  └─ export.css             导出专用浅色、block 布局
│  └─ js/
│     ├─ config.js
│     ├─ data-loader.js
│     ├─ quality.js
│     ├─ recommender.js
│     ├─ storage.js
│     ├─ ui.js
│     ├─ qrcode.js
│     ├─ pdf-lite.js
│     ├─ exporter.js
│     ├─ export-styles.js       自动生成
│     └─ main.js
├─ data/
│  ├─ domains.json              21 个一级领域与二级标签
│  ├─ sources.json              来源登记 + 复核字段
│  ├─ articles.json             36 条演示快照
│  ├─ audit.json                丢弃样本、来源通过率
│  └─ fallback-data.js          自动生成，供 file:// 使用
├─ pipeline/
│  ├─ config.json               路由、间隔、LLM、去重、锁、健康阈值
│  ├─ update.js                 抓取→去重→筛选→处理→发布主入口
│  ├─ scheduler.js              内置调度器
│  ├─ takedown.js               投诉下架 CLI
│  ├─ resume.js                 人工恢复来源 CLI
│  ├─ lib/                      feed/state/dedupe/quality-gate/llm/publish
│  ├─ tests/pipeline.test.js    12 项注入式测试
│  ├─ state/                    运行时 ETag/健康/锁/队列（不提交内容）
│  ├─ logs/                     运行、dry-run、takedown、resume 日志
│  └─ history/                  发布前备份
└─ tools/
   ├─ build-fallback.mjs
   ├─ build-export-css.mjs
   └─ validate.cjs
```

---

## 4. 数据源替换

### 4.1 先登记来源，再登记文章

一个来源只要缺少以下任一字段，就不应进入推荐池：

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| `id` | 稳定标识，文章通过它关联来源 | `nasa` |
| `name` / `domain` / `homepage` | 名称、域名、可点击首页 | `NASA` / `nasa.gov` |
| `grade` | `A` / `B` / `C` / `D` | `A` |
| `grade_reason` | 定级理由，不能只写等级 | 政府机构、官方统计 |
| `access_method` | 获取方式：官方 RSS/Atom > 官方 API > 书面授权 > 公开网页仅标题链接 | 官方 RSS / Atom |
| `feed_url` | RSS/Atom/API endpoint；没有就写入口页 | `https://www.nasa.gov/news-release/feed/` |
| `license_basis` / `license_url` | 许可依据与链接/编号/可核验路径 | 美国政府作品（公共领域） |
| `robots_check` | robots 核查结果，含 Disallow 与 Crawl-delay 结论 | 允许新闻路径；不抓后台 |
| `robots_allowed` | 布尔值 | `true` |
| `fulltext_allowed` | 是否允许输出全文；演示源一律 `false` | `false` |
| `fulltext_note` | 全文边界说明 | 仅摘要 + 链接 |
| `translation_allowed` | **是否允许翻译/衍生作品** | `true` |
| `translation_basis` | 允许翻译的依据 | CC BY 4.0 允许演绎 |
| `reviewed_at` / `next_review_at` | 最近复核、下一次复核（≤90 天） | `2026-11-16` / `2027-02-14` |
| `last_item_at` | 最近一个有效条目日期；用于 7 天降权 | `2026-11-13` |
| `request_interval_minutes` | 单源请求频率上限 | `60` |
| `status` | `active` / `excluded` / `paused` | `active` |

**RSS 或 API 的存在不构成转载许可。** feed 里输出全文，不等于本站可以使用全文；feed 条款禁止翻译或衍生作品的，不生成摘要，只保留“原文标题 + 链接”模式，演示池中直接排除。

### 4.2 文章的完整字段

`data/articles.json` 顶层为：

```json
{
  "version": 1,
  "snapshot_at": "2026-11-16T09:30:00+08:00",
  "note": "演示快照",
  "articles": []
}
```

单条文章建议包含：

```json
{
  "id": "a01",
  "title_original": "Original title",
  "title_zh": "汉化标题",
  "summary_zh": "中文摘录提炼摘要，不做风格化改写。",
  "url": "https://example.com/original",
  "source_id": "nasa",
  "source_name": "NASA",
  "source_domain": "nasa.gov",
  "author": "作者或“未署名”",
  "published_at": "2026-11-13",
  "category": "science-nature",
  "tags": ["地球观测", "生态"],
  "language": "en",
  "license_status": "美国政府作品 · 公共领域",
  "license_url": "https://www.nasa.gov/nasa-brand-center/images-and-media/",
  "image_url": "",
  "image_license": "未使用来源图片（CSS 占位）",
  "translation_note": "中文摘要由本站编辑，依据公共领域/开放许可；非官方译文。",
  "body_words": 812,
  "info_ratio": 0.72,
  "density_score": 5,
  "fact_score": 5,
  "representativeness": 5,
  "clickbait": false,
  "event_key": "nasa-mangroves-2026-11",
  "fetched_at": "2026-11-16T09:30:00+08:00",
  "feed_url": "https://www.nasa.gov/news-release/feed/",
  "guid": "原始条目 guid/id",
  "summary_method": "人工摘录提炼（演示）",
  "summary_generated_at": "2026-11-16T09:30:00+08:00"
}
```

字段用途：

- `body_words`：外文按词，中文按字；用于 `<100 词 / <200 字` 否决和摘要比例上限。
- `info_ratio`：实质信息占比，低于 `0.30` 否决。
- `density_score`：1–5，加权评分中的信息密度。
- `fact_score`：1–5，事实可核验性。
- `representativeness`：1–5，领域代表性。
- `clickbait`：人工核验结论。标题命中词库但 `fact_score >= 4` 时不直接否决；词库只作为辅助。
- `event_key`：同一事件多篇报道的合并键。去重保留加权分最高的一条。
- `image_url` 为空表示使用 CSS 占位图；有图时必须在 `image_license` 写明许可，导出会做 CORS 预检。

### 4.3 添加一条内容的流程

1. 在 `data/sources.json` 登记来源，字段齐全；`translation_allowed=false` 的来源不要生成摘要。
2. 在 `data/articles.json` 添加文章。摘要长度控制在：

   ```text
   min(400 字, floor(body_words × 1.6 × 0.10))   // 外文
   min(400 字, floor(body_words × 0.10))          // 中文
   ```

3. 摘要只摘录原文要点、提炼核心事实；**不做风格化改写**，不复制原文段落。
4. 运行 `node tools/validate.cjs`，确认新条目没有破坏标签、去重、摘要上限和抽样约束。
5. 运行 `node tools/build-fallback.mjs` 更新 `file://` 快照。
6. 如果改了 `export.css`，再运行 `node tools/build-export-css.mjs`。
7. 在真实浏览器中手动检查：原文链接、已读、不再推荐、PDF/PNG、移动端。

### 4.4 不要做的事

- 不要直接编辑 `data/fallback-data.js` 或 `assets/js/export-styles.js`，它们是生成产物。
- 不要用来源图片，除非有明确许可、公共领域/CC0，并在 `image_license` 留痕。
- 不要把 feed 全文塞进 `summary_zh`，再用折叠/展开/图片化规避展示边界。
- 不要因为来源是 A 级就跳过逐源许可核查。

---

## 5. 领域与标签配置

`data/domains.json` 的每个一级领域包含：

```json
{
  "id": "science-nature",
  "name": "科学与自然",
  "short": "科学",
  "accent": "#486b5a",
  "description": "……",
  "max_age_days": 180,
  "classic_after_days": null,
  "tags": ["天文", "地球科学", "生命科学", "物理", "气候"]
}
```

当前 21 类：

```text
科技与AI / 商业与金融 / 设计与创意 / 科学与自然 / 人文与历史
教育与学习 / 健康与身心 / 环境与可持续 / 产品与运营 / 编程与开源
社会与政策 / 艺术与文化 / 生活方式 / 职业与成长 / 媒体与传播
游戏与娱乐 / 旅行与地理 / 美食与农业 / 建筑与城市 / 法律与隐私
未来与前沿
```

### 新增一级领域

1. 在 `categories` 数组新增 `id`、`name`、`short`、`tags`。
2. 如需要，在 `assets/js/config.js` 的 `CATEGORY_WEIGHTS` 增加领域权重；不加就使用 `defaultWeights`。
3. 给 `max_age_days` 设置时效窗口；人文/历史/艺术/生活方式可设为 `null`，并用 `classic_after_days` 标记“经典/长尾”。
4. 至少要有一篇通过筛选的文章，否则 chips 会显示为 0 并禁用；这是“无数据自动跳过”，不是用空内容占位。

### 新增二级标签

直接把标签字符串加入对应领域的 `tags`。文章标签必须能在其一级领域的 `tags` 中找到，否则校验脚本会报错。无文章的标签在前端自动隐藏。

### 删除领域/标签

先搜索并修改所有引用：

```bash
rg "旧标签|old-category-id" data assets
```

没有 `rg` 时可用编辑器的全局搜索。删除后重新生成 fallback 并跑校验。

---

## 6. 推荐与质量筛选

### 6.1 四层 pipeline

```text
来源准入
  → 硬性否决
  → 加权评分（1–5）
  → 领域适配与时效
  → 通过者进入推荐池
```

#### 第一层：来源准入

| 等级 | 定义 | 处理 |
| --- | --- | --- |
| A | 政府/监管/稿源名单媒体/同行评议期刊/官方统计库 | 直接评分 |
| B | 行业协会白皮书/主流媒体原创/可识别领域专家博客 | 直接评分 |
| C | 企业官网/产品博客/商业报告/普通转载 | 须通过全部否决；单批最多 3 条 |
| D | 匿名/无法追溯/低质聚合/历史违规/利益冲突无法验证 | 不进池 |

#### 第二层：硬性否决

- 外文有效正文 `<100` 词，或中文 `<200` 字。
- 标题/导语命中标题党词库，且没有对应事实增量（`clickbait=true`，或词库命中且 `fact_score < 4`）。
- 实质信息占比 `<30%`。
- 同 URL / 标题相似度 `>90%` / 同 `event_key` 且无新增事实。
- 超出领域时效窗口：
  - 科技、商业、产品、编程：90 天
  - 科学、健康、环境：180 天
  - 人文、历史、艺术、生活方式：不设上限，标“经典/长尾”
- D 级来源。
- **来源条款明确禁止翻译或衍生作品**。

#### 第三层：加权评分

默认权重：

| 分项 | 默认权重 | 5 分标准 |
| --- | --- | --- |
| 来源等级 | 25% | A=5，B=4，C=2 |
| 信息密度 | 25% | 有效观点 ≥25 |
| 事实可核验性 | 20% | 有数据/引用一手来源 |
| 时效性 | 15% | 7 天内 5 分，30 天内 4 分，90 天内 3 分，180 天内 2 分，365 天内 1.5 分 |
| 领域代表性 | 15% | 该领域的典型议题 |

加权总分 `<3.0` 不进池。阈值在 `config.quality.threshold`，不得设为无下限。

#### 第四层：领域适配

- 科技、商业、产品、编程：`source .20 / density .25 / fact .20 / fresh .25 / rep .10`
- 科学、健康、环境：`fact .30 / fresh .10`
- 人文、艺术、建筑、生活方式：`source .20 / density .30 / fact .15 / fresh .05 / rep .30`

### 6.2 12 条抽样约束

`assets/js/recommender.js` 先覆盖领域，再在剩余候选里按权重抽取：

- 每批 12 条。
- 尽量覆盖至少 8 个一级领域。
- 同一一级领域不超过 3 条。
- 同一二级标签不超过 1 条。
- 同一来源连续不超过 2 条。
- C 级来源单批不超过 3 条。
- 单领域筛选时放宽领域覆盖与“同领域 3 条”，否则该领域内容可能凑不满一屏。
- 内容不足时直接少展示并给出说明，不用重复内容凑数。

权重近似为：

```text
score^2.2
× 已读 0.35
× 上一批 0.15
× 同来源重复 0.55^次数
× 7 天无新条目来源 0.65
× 新领域 1.8
```

### 6.3 去重

`buildPool()` 按以下顺序判定重复，保留加权分最高的一条：

1. 规范化 URL（去 hash、统一 hostname、去尾斜杠）。
2. 规范化标题完全相等。
3. 同来源 + 同标题。
4. 同 `event_key`。
5. 标题 bigram 相似度 `>0.9`。

### 6.4 已读、上一批与“不再推荐”

localStorage 键前缀为 `kuayu.v1.`：

| 键 | 内容 |
| --- | --- |
| `readIds` | 已读文章 id |
| `hiddenIds` | 直接隐藏的文章 id |
| `hiddenTags` | 隐藏的标签 |
| `hiddenEvents` | 隐藏的事件 key |
| `lastBatchIds` | 上一批文章 id |
| `pref.theme` | `light` / `dark` |
| `pref.issue` | 当前批次号 |

这些数据只存在浏览器本地，不会上传。导出不会写入或读取用户本地数据。

---

## 7. 来源登记与本机状态

### 7.1 演示在池来源

| id | 来源 | 等级 | 许可依据 | 全文 | 翻译/衍生 |
| --- | --- | --- | --- | --- | --- |
| `nasa` | NASA | A | 美国政府作品 · 公共领域 | 否 | 允许 |
| `nist` | NIST | A | 美国政府作品 · 公共领域 | 否 | 允许 |
| `nps` | U.S. National Park Service | A | 美国政府作品 · 公共领域 | 否 | 允许 |
| `govuk` | GOV.UK | A | Open Government Licence v3.0 | 否 | 允许 |
| `gds` | GOV.UK Service Manual / GDS blog | A | Open Government Licence v3.0 | 否 | 允许 |
| `owid` | Our World in Data | A | CC BY 4.0 | 否 | 允许 |
| `openstax` | OpenStax | B | CC BY 4.0 | 否 | 允许 |
| `unesco` | UNESCO | A | CC BY-SA 3.0 IGO | 否 | 允许 |
| `who` | World Health Organization | A | CC BY-NC-SA 3.0 IGO | 否 | 允许（非商业） |
| `python` | Python Software Foundation blog | B | CC BY-NC-SA 3.0 | 否 | 允许（非商业） |
| `wikimedia` | Wikimedia Foundation | B | CC BY-SA 4.0 | 否 | 允许 |
| `loc` | Library of Congress | A | 美国政府作品，逐篇复核 | 否 | 允许 |

两个排除反例：

- `polygon`：来源条款不允许翻译/衍生，演示中作为 `translation_forbidden` 反例。
- `npr`：同上，且不作为默认推荐源。

所有 active 来源都满足：

- `fulltext_allowed: false`
- `translation_allowed: true`
- `reviewed_at: 2026-11-16`
- `next_review_at: 2027-02-14`（90 天复核周期内）
- 有 `robots_check` 与请求频率上限

### 7.2 7 天无新条目的降权

推荐权重会读取 `last_item_at`。相对当前快照超过 7 天没有有效新条目的来源，权重乘以 `0.65`；来源卡显示“在池 · 降权”。这不是永久移除，但会显著减少其出现概率。若连续无条目持续存在，应人工评估移出。

### 7.3 复核与投诉

- 每 90 天至少复核一次来源等级、条款、robots、翻译/衍生边界。
- 来源卡展示“最近复核 / 下次复核 / 待复核”。
- 收到投诉或 takedown：先把 `status` 改为 `paused` 或 `excluded`，再处理相关文章；不要等到下一轮抓取。
- feed 从摘要变全文、或从全文变摘要，都不改变本站“只摘要 + 链接”的边界。

---

## 8. PDF / PNG 导出

### 8.1 入口与流程

每张卡片的“导出”展开“PDF / PNG”。只导出当前一条。

```text
点击导出
→ 显示“正在准备字体…”
→ 构建独立离屏模板（.export-doc，794px，强制浅色）
→ document.fonts.load(...) + document.fonts.ready
→ 图片 CORS 预检（有图时）
→ SVG foreignObject → canvas
→ PNG 长图，或按 A4 分页的 PDF
→ 下载 / iOS 分享 / 打印兜底
```

### 8.2 模板字段

每条导出物包含：

- 汉化标题（主）
- 原文标题（副）
- 完整中文摘要/要点
- 一级/二级标签
- 来源站点 + 域名
- 作者、发布日期、原文语言
- 授权状态、翻译声明
- 原文链接文本
- 原文链接二维码（旁注“扫码阅读原文”）
- 导出日期
- 底部固定声明：

  > 内容版权归原作者所有。本页仅为摘要汉化与来源索引，不构成对原文的替代。

### 8.3 二维码

- 源图 `512×512`，页面显示 `240×240`。
- 纠错等级 `H`。
- 四周 quiet zone 至少 4 个模块。
- 自写编码器已与 Python `qrcode 8.2` 做 v2–v20 逐模块交叉验证；36 条文章 URL 均可编码，最长 179 字节。

### 8.4 PDF

- 由 `PDFLite.buildImagePdf()` 生成 PDF 1.4。
- A4 单页 `595.28 × 841.89 pt`，对应 CSS `794 × 1123`。
- 每页是一张 JPEG（`/DCTDecode`）全页图。
- 写入 Title / Author / Subject / Keywords 元数据，中文字段用 UTF-16BE hex。
- 优先写入首条可点击链接注释；**若阅读器不支持，二维码是强制兜底**。
- 模板按模块手动分页，不用 `break-inside: avoid` 承担分页。
- 文件名：

  ```text
  {一级领域}-{汉化标题前20字}-{YYYYMMDD}.pdf
  ```

  过滤 `\ / : * ? " < > |` 等非法字符。

### 8.5 PNG

- `scale=2`，可在 `config.export.pngScale` 修改。
- 长图不裁切。
- 文件名规则同上，扩展名 `.png`。

### 8.6 字体与图片兜底

- 导出前显式 `document.fonts.load()` 中文字体样例，并等待 `document.fonts.ready`；4.2 秒超时后继续，不把字体 API 不可用当成失败。
- 有图时逐张 `fetch(..., { mode: 'cors', credentials: 'omit', redirect: 'follow' })` 预检：
  - 必须 2xx；
  - `Content-Type: image/*`；
  - 最终主机与原始主机一致；
  - ≤8MB；
  - 转为 data URL 后再进入渲染管线。
- 预检失败直接替换为 `.ex-placeholder-image`，**不进入渲染管线**。
- 不使用 `allowTaint: true`。
- 演示数据全部 `image_url: ""`，因此当前不会触发图片预检；逻辑已保留。

### 8.7 依赖说明

本项目**没有**引入 `html-to-image`、`html2canvas`、`jsPDF`、`html2pdf.js` 或 CDN 二维码库，原因是本机网络无法稳定获取 CDN 资源，且导出需要离线可运行。当前实现等价于：

| 常规库 | 本项目替代 |
| --- | --- |
| `html-to-image` / `html2canvas` | SVG `foreignObject` + canvas（`exporter.js`） |
| `jsPDF` + `html2canvas` | `PDFLite` 自写最小 PDF（图片页 + 元数据 + 链接） |
| `qrcode` / `qrcode-generator` | `qrcode.js` 自写编码器（ECC H，v1–v20） |

这是有意取舍，不是遗漏。若要在其他环境替换为上述库：

- 保留 `Exporter` 的入口、模板字段、字体等待、图片预检、失败重试/打印兜底。
- `html-to-image` 和 `html2canvas` 都有已知失败模式（跨域图、字体、foreignObject、分页、`oklch()`、`color-mix()`、`backdrop-filter`）；即使换库，也必须保留本项目的预检和 CSS 占位图兜底。
- 换 `jsPDF` 时保留二维码兜底与元数据写入。
- 库文件应**本地托管**，不要依赖运行时 CDN。

### 8.8 移动端

- 桌面：`<a download>` + Blob URL。
- iOS Safari：优先 `navigator.share({ files })`；失败时 `window.open(blobUrl)`，提示长按保存。
- iOS 第三方浏览器：新窗口打开 Blob。
- 全部失败：提示“改用打印”，调用 `window.print()`；打印样式已强制隐藏页面其他部分，只显示 `#print-root`。

---

## 9. 测试与验收

### 9.1 自动校验

```bash
node tools/validate.cjs
```

覆盖 20 项：

1. 21 个领域、id 唯一、标签非空。
2. 二级标签在领域内唯一。
3. active 来源字段齐全，默认不输出全文。
4. 排除源不作为文章池来源。
5. 超过 7 天无新条目的来源标记为降权。
6. 36 条文章 URL / 标题 / event_key 唯一。
7. 来源、领域、标签均可在配置中找到。
8. 标题党词库只在事实增量不足时否决。
9. 四层筛选后 36 条全部通过，摘要不超硬上限。
10. 300 轮抽样：12 条、≥8 领域、单领域 ≤3、单标签 ≤1、同源连续 ≤2、C 级 ≤3。
11. 21 个单领域筛选只返回本领域内容。
12. 二级标签筛选生效。
13. 已读写入/取消与推荐池隔离。
14. “不再推荐类似”隐藏本文、同事件、同标签。
15. 36 条 URL 均可生成 QR，版本 ≤20。
16. PDF header、xref 偏移、页面、链接、UTF-16 元数据可解析。
17. 导出 CSS 无 flex/grid/oklch/color-mix/backdrop-filter/外链资源。
18. index.html 无远程脚本，资源存在，id 唯一。
19. fallback 与四个 JSON 完全一致。
20. 内联导出 CSS 与 `export.css` 完全一致。

### 9.2 语法检查

```bash
node --check assets/js/config.js
node --check assets/js/quality.js
node --check assets/js/recommender.js
node --check assets/js/ui.js
node --check assets/js/exporter.js
node --check assets/js/qrcode.js
```

### 9.3 更新管道测试

```bash
node pipeline/tests/pipeline.test.js
```

测试使用临时目录和注入的 `fetchImpl` / `llmImpl`，不访问真实网络、不需要 API key。覆盖 12 项：

1. 连续两次运行：第二次 304 不重复发布；第二次请求确实带 `If-None-Match` / `If-Modified-Since`，且失败计数、空 feed 警告不被重置。
2. 精确去重：规范化 URL（去 utm）、guid、标题、来源+标题；SimHash 距离 ≤3 判重，4–5 记为“疑似重复”但不丢弃。
3. `robots.txt` 的 `Disallow`、`Allow`、`$` 结尾和 `Crawl-delay`。
4. dry-run 不调用 LLM、不写内容池/state/queue，日志写入独立文件。
5. 文件锁阻止两个更新进程同时写。
6. 发布幂等：已存在 content_id 不覆盖已读字段和原文。
7. 来源 `translation_allowed:false` 时不生成摘要，只入 `title_only` 人工队列。
8. 超长摘要按句子边界确定性截断，不二次调用 LLM；空摘要进入人工队列。
9. 同一内容失败 3 次后不再自动重试。
10. 连续失败达阈值暂停来源且不自动恢复；7 天无有效条目降频。
11. takedown 下架并暂停、恢复不恢复内容。
12. 运行日志可查来源、层级、丢弃原因和计数。

真实网络、真实模型输出质量和跨机器锁不在本机验收范围内，见第 11 节。

### 9.4 本机未完成的浏览器验收

本机只有 Edge 157。无头模式因本机 crashpad/权限问题失败：

```text
OpenProcess: 拒绝访问。 (0x5)
FATAL:mojo...platform_channel.cc:187 Check failed
```

因此以下项目**不能**声称已经在本机完成：

- 真实浏览器中的 3/2/1 列视觉、移动端溢出；
- 实际点击“导出 PDF/PNG”并打开文件；
- iOS Safari 分享/长按保存；
- 图片 CORS 预检在真实跨域图片上的表现。

请在 Chrome / Safari / Edge 正常窗口中按第 9.5 节手工验收。本机只完成了静态逻辑、数据结构、QR 矩阵、PDF 文件结构和 CSS 约束校验。

### 9.5 手工验收清单

- [ ] 打开页面能看到 12 张随机卡片，不是骨架屏卡死。
- [ ] 点“换一批”/按 `R` 能换，且尽量不重复上一批。
- [ ] 21 个领域 chips 可筛选；无数据二级标签不显示。
- [ ] 每批尽量覆盖 ≥8 领域，同一领域 ≤3，同一标签 ≤1。
- [ ] 标记已读后，换批仍保留；刷新后仍在。
- [ ] “不再推荐类似内容”隐藏本文与同标签/同事件内容；恢复按钮可用。
- [ ] 来源台账能看到等级、获取方式、许可、robots、全文、翻译、复核日期。
- [ ] 每张卡片的作者、日期、语言、授权、翻译声明可核对。
- [ ] 手机宽度下筛选器、卡片、导出菜单不溢出。
- [ ] 深色模式下页面正常；导出模板仍为浅色。
- [ ] PDF 打开正常，中文字体无方块/乱码/错位。
- [ ] PNG 长图完整，不被裁切。
- [ ] 导出物只含当前一条，不含列表或其他卡片。
- [ ] 二维码清晰可扫；用手机扫一次原文链接。
- [ ] 图片跨域失败时显示占位图，导出不中断。
- [ ] 导出失败有具体原因、重试和打印兜底。

---

## 10. 合规提示

> 以下为本项目按要求记录的合规边界，不构成法律意见。上线前应由熟悉著作权、新闻信息服务与个人信息保护的律师/合规人员复核。

### 10.1 法释〔2026〕18号相关提示

根据法释〔2026〕18号，报刊转载法定许可仅适用于**纸质报刊出版单位对其自身纸质版内容及版面格式相一致的数字化版本**；**互联网信息服务提供者之间相互转载已发表作品须经许可并付酬**。

本项目采用“摘要 + 链接”模式，降低复制与替代原文的风险，但**不豁免逐源许可核查**。不能因为来源是 A 级、是政府网站、是开放许可，就跳过具体条款核验。

### 10.2 境内公开运营

- 新闻类聚合需相应资质；非新闻内容同样受著作权约束。
- 资质缺位不豁免单篇许可义务。
- 代码和 README 不构成法律意见。

### 10.3 本项目的内容边界

1. 默认模式：**标题 + 中文摘录提炼摘要 + 原文链接**，不展示原文正文。
2. 摘要以摘录原文要点、提炼核心事实为主，**不做风格化改写**。
3. 摘要硬上限：原文正文词数的 10% 或 400 字，以先到者为准。
4. 原文标题可保留用于对照，但不得以折叠、展开、图片化等任何形式嵌入全文。
5. 展示全文的唯一条件：有明确书面许可，或可验证的开放许可（如 CC BY），并在卡片标注许可类型和链接。
6. 图片默认不用来源图；使用时须有许可或为公共领域/CC0，并在 `image_license` 记录；无法确认用占位图。
7. 每张卡片保留：来源站点 + 域名、原文标题 + 链接、作者、发布日期、原文语言、授权状态、翻译声明。
8. 后台/数据层保留：抓取时间、feed URL/API endpoint、原始条目 guid/id、摘要生成方式与时间。
9. 收到投诉或 takedown 立即暂停相关来源/条目；保留处理记录。
10. RSS/API 存在不等于转载许可；feed 输出全文不等于可使用全文；条款禁止翻译/衍生的，不生成摘要。

### 10.4 来源许可摘录

- 美国政府作品：公共领域（NASA、NIST、NPS、LoC 逐篇复核）。
- GOV.UK / GDS：Open Government Licence v3.0，需署名、保留许可链接。
- OWID / OpenStax：CC BY 4.0，需署名、标注修改。
- UNESCO：CC BY-SA 3.0 IGO，需署名、相同方式共享。
- WHO / Python：CC BY-NC-SA 3.0 (IGO)，非商业、署名、相同方式共享。
- Wikimedia：CC BY-SA 4.0，需署名、相同方式共享。

非商业条款的源（WHO、Python）不得用于商业变现；如要商用，应替换为可商用的许可源，或取得单独书面许可。

---

## 11. 已知限制与上线建议

### 11.1 已知限制

1. **演示数据快照**：页面默认仍展示 2026-11-16 的演示快照；`pipeline/update.js` 是可选的本地更新工具，不会在浏览器里自动运行。新闻链接可能失效。
2. **静态前端 + 本地管道**：没有常驻后端、服务器代理、分布式锁或投诉工单；管道是单机 CLI，文件锁只覆盖同一台机器上的进程。生产化仍需服务端缓存、限速、监控和工单。
3. **LLM 摘录为可选路径**：演示数据仍是人工整理的静态摘要；管道只有配置 `KUAYU_LLM_API_KEY` 并真实运行时才调用兼容 OpenAI 的接口。本机没有真实 key，未做在线翻译验收。
4. **演示数据无图片**：图片预检代码存在，但没有真实跨域图片可测。
5. **导出未做真实浏览器验收**：本机 Edge 无头模式失败；PDF/PNG 的实际排版、字体、下载、iOS 分享需在目标浏览器验收。
6. **零依赖导出的取舍**：没有使用 html-to-image / html2canvas / jsPDF，改用自写 foreignObject + canvas 和 PDFLite；复杂 CSS 的支持范围小于成熟库，但模板已限制为纯 block、浅色、无现代色彩函数。
7. **二维码已做矩阵验证**：与 Python qrcode 8.2 v2–v20 逐模块一致，但仍建议用手机实扫一次。
8. **“不再推荐”是本地偏好**：换浏览器/清 localStorage 后失效，不是账号级推荐。
9. **7 天降权依赖 `last_item_at`**：管道发布成功时会更新 `data/sources.json` 的 `last_item_at`，并把运行时健康状态写入独立 state；演示快照仍是手工维护。
10. **不包含登录、评论、搜索、收藏、服务端推荐**。
11. **更新管道未做真实网络/真实模型验收**：测试全部注入 fetch/LLM，能证明规则、锁、幂等、dry-run 和 takedown 逻辑；真实源限速、robots 差异、模型输出质量需在生产环境小流量验证。

### 11.2 生产化建议

- 加后端代理：按源限速、缓存、遵守 robots 的 `Disallow` 与 `Crawl-delay`，不绕过付费墙/登录墙/反爬。
- 来源入库前做人工/半自动许可审查，记录许可编号或条款快照。
- 投诉/takedown 流程接入工单；`status: paused` 立即生效。
- 定时任务更新 `last_item_at`、复核日期和失效链接；连续 7 天无新条目降权，连续无效应移出。
- 生产环境建议 CSP：

  ```text
  default-src 'self';
  img-src 'self' data: https:;
  style-src 'self' 'unsafe-inline';
  script-src 'self';
  connect-src 'self';
  ```

  本项目为了离线运行和内联导出 CSS 使用了内联样式；上线时按实际部署收敛。
- 若接入第三方导出库，请本地托管并保留第八章的预检、重试、打印兜底。

---

## 12. 内容自动更新管道

更新管道是**本地 CLI**，不是网页内常驻服务。它只负责把新内容安全地送进现有 `data/articles.json`；页面的推荐、筛选、已读、隐藏、导出逻辑没有改变。

### 12.1 五层结构与代码入口

```text
抓取 fetch → 去重 dedupe → 筛选 screen → 处理 process → 发布 publish
```

| 层 | 代码 | 输出/落点 |
| --- | --- | --- |
| 抓取 | `pipeline/lib/feed.js`、`pipeline/lib/state.js` | 条目、ETag/Last-Modified、源健康状态 |
| 去重 | `pipeline/lib/dedupe.js` | 通过去重的 `content_id`；丢弃记录 |
| 筛选 | `pipeline/lib/quality-gate.js` + `assets/js/quality.js` | 复用四层规则后的候选 |
| 处理 | `pipeline/lib/llm.js`、`pipeline/update.js` | 汉化标题、摘要、截断标记、人工队列 |
| 发布 | `pipeline/lib/publish.js` | 追加 `data/articles.json`、历史版本、fallback |
| 调度 | `pipeline/update.js`、`pipeline/scheduler.js` | 串行运行与定时触发 |

每层丢弃都会写入运行日志，字段包括 `source_id`、`content_id`、`layer`、`reason`、`stage`；不会进入下一层。

**与现有代码的对接点**

- `data/sources.json`：来源许可、`feed_url`、`translation_allowed`、`fulltext_allowed`、`robots_allowed`、`request_interval_minutes`。管道不修改这些合规字段，只更新 `last_item_at` 和 `status`（暂停/恢复/takedown）。
- `pipeline/config.json`：12 个来源的路由、抓取间隔、LLM、去重阈值、健康阈值、发布锁/历史。
- `assets/js/quality.js`：`Quality.evaluate` / `clickbaitHit` 是唯一四层规则来源；管道不复制阈值、不另写一套筛选。
- `assets/js/recommender.js`：`canonicalUrl` 已过滤 utm/点击参数，`buildPool` 会通过 `taken_down` 拒绝已下架内容。
- `index.html`：不需要改；页面仍只读 JSON/fallback。
- `data/fallback-data.js`：发布或 takedown 后由 `tools/build-fallback.mjs` 重建；否则双击 `index.html` 看不到更新。

### 12.2 运行前准备

要求 Node.js 20+（本机用 DSH 内置 Node v24.21.0 验证）。在项目根执行：

```bash
# 只跑测试，不访问网络
node pipeline/tests/pipeline.test.js

# 选择某个源做 dry-run（不调用 LLM、不写内容池/state）
node pipeline/update.js --dry-run --source-id nasa

# 真正运行（需要 LLM key，且该源允许翻译）
export KUAYU_LLM_API_KEY="sk-..."
node pipeline/update.js --source-id nasa
```

不传 `--source-id` 时按 state 中每个源的间隔决定是否运行。`--force` 只忽略“间隔等待”和 robots 缓存，**不会**绕过 robots 的 Disallow、许可检查、四层筛选、暂停状态或 takedown。

LLM 配置在 `pipeline/config.json` 的 `llm`：

```json
{
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "model": "gpt-4o-mini",
  "api_key_env": "KUAYU_LLM_API_KEY"
}
```

可替换为任意兼容 OpenAI Chat Completions 的服务；模型只负责“摘录提炼 + 忠实标题意译”，不参与质量评分，也不允许改原文链接/来源/作者/发布时间。没有 key 时正常更新会在处理层失败；dry-run 不调用模型。

### 12.3 state、日志与历史

运行时文件全部在 `pipeline/`，不混入内容 JSON：

```text
pipeline/state/update-state.json    ETag、Last-Modified、失败计数、空 feed、暂停/低活跃、recheck_due_at、下次运行
pipeline/state/processing.json      每个 content_id 的处理状态与失败次数
pipeline/state/manual-queue.json    空摘要/格式错误/禁止翻译的 title_only 记录
pipeline/state/takedowns.json       下架记录（含 content_id 列表、原因、通知）
pipeline/state/update.lock          进程级独占锁（30 分钟 stale）
pipeline/history/articles-*.json    发布前备份，保留最近 20 份
pipeline/logs/update-YYYYMMDD.log   正常 JSONL 运行日志
pipeline/logs/dry-run-YYYYMMDD.log  dry-run 独立 JSONL 日志
pipeline/logs/takedowns.jsonl       takedown 审计日志
pipeline/logs/resume.jsonl          人工恢复审计日志
```

为让每周定时任务延续 304/ETag 与健康状态，GitHub Actions 会把 `update-state.json`、`processing.json`、`manual-queue.json`、`takedowns.json` 提交回仓库；`update.lock`、日志和历史备份仍被 `.gitignore` 排除。

关键语义：

- **304 只写 `last_304_at`**。`consecutive_failures`、`empty_feed_streak`、`empty_feed_warning` 保持不变；304 不等于健康。
- 连续失败达到 `health.failure_threshold`（默认 5）→ `paused` + `pending_review`，**不会自动恢复**，只能人工 `resume`。
- 连续 7 天无有效条目（含 304/空 feed）→ `low_activity`，抓取间隔提升到最多 1440 分钟；首次命中时写入 `recheck_due_at`（90 天后），作为复核队列字段，且不会重复刷新。
- 空 feed 连续 2 次 → `empty_feed_warning`，但不自动暂停；先告警，避免把临时故障误判为源死亡。
- `--dry-run` 的日志独立；不写 state、不写 queue、不写内容池、不重建 fallback、不发通知。

### 12.4 调度方式（二选一）

**方式 A：系统 cron（推荐，简单）**

```cron
# 每 15 分钟触发一次；具体源是否运行由 state 中的 interval_minutes 决定
*/15 * * * * cd /srv/kuayu && /usr/bin/node pipeline/update.js >> pipeline/logs/cron.log 2>&1
```

Windows 计划任务等价命令：

```text
程序: C:\Program Files\nodejs\node.exe
参数: pipeline\update.js
起始于: C:\path\to\跨领域优质内容随机推荐站
```

**方式 B：内置调度器**

```bash
# 每 60 秒 tick 一次，按各源间隔串行运行
node pipeline/scheduler.js --tick 60

# 只跑一次（仍遵守各源间隔；等价于 update.js）
node pipeline/scheduler.js --once
```

`--tick` 分钟数可调。两种方式**不要同时启用**，避免同一时间重复抓取；文件锁只能防止写坏数据，不能替代调度去重。

### 12.5 新增来源、暂停与恢复

新增来源仍须先完成许可登记，不能因为“想多更新”自动扩池：

1. 在 `data/sources.json` 增加完整来源：`grade`、`access_method`、`license_basis`、`license_url`、`robots_check`、`robots_allowed`、`fulltext_allowed`、`translation_allowed`、`translation_basis`、`reviewed_at`、`next_review_at`、`feed_url`、`status: "active"`。
2. 在 `pipeline/config.json` 的 `routing` 增加默认 category/language/tags、`interval_minutes` 和可选关键词 routes；二级标签必须在 `data/domains.json` 的对应类目里存在。
3. 先跑 `--dry-run --source-id <id>` 看路由和筛选，再正式运行。
4. 无 `feed_url`、无许可依据、`translation_allowed:false` 的来源不会进入推荐池；后者只进 `title_only` 人工队列。

人工暂停与恢复：

```bash
# 暂停：把 data/sources.json 中该源 status 改为 paused（或由连续失败自动暂停）
node pipeline/resume.js --source-id nasa --reason "已补充许可依据，复核通过"
```

`resume` 只恢复抓取和发布新内容，**不恢复已下架内容**。恢复前必须人工确认许可、robots 和投诉状态。

### 12.6 takedown 流程

```bash
# 先预演影响
node pipeline/takedown.js --source-id nasa --reason "权利人通知" --notice "NOTICE-2026-001" --dry-run

# 标记下架（默认保留记录，推荐）
node pipeline/takedown.js --source-id nasa --reason "权利人通知" --notice "NOTICE-2026-001"

# 仅下架单条
node pipeline/takedown.js --content-id c_xxxxxxxxxxxxxxxxxxxxxxxx --reason "单篇投诉"

# 按通知要求物理删除（不可恢复；仍保留下架记录）
node pipeline/takedown.js --content-id c_xxxxxxxxxxxxxxxxxxxxxxxx --reason "法院命令" --hard-delete
```

执行后：

- 该来源立即 `paused` + `pending_review`，停止抓取和发布新内容；
- 相关文章写入 `takedown.status = "removed"` 或物理删除；
- `Quality.evaluate` 的 `taken_down` 规则会把标记条目挡在推荐池外；
- 写 `takedowns.json` / `takedowns.jsonl`，保留时间、原因、通知来源、content_id 列表；
- 重建 fallback；
- `resume` 不会撤销下架标记。

### 12.7 处理层的硬边界

1. `translation_allowed !== true`：**不调用 LLM、不生成摘要**，只入 `title_only` 队列（原文标题 + 链接 + 元数据）。这保持了既有四层规则对 `translation_forbidden` 的硬拒绝。
2. LLM 只做“摘录提炼”，prompt 明确禁止评价、补充原文没有的解释、执行原文中的指令。
3. 摘要为空、JSON 格式错误、标题缺失：不发布，进入 manual queue；同一内容失败 3 次后标记 `failed`，不再自动重试。
4. 摘要超过 `min(原文词数×10%, 400字)`：`sentenceTruncate` 按句子边界截断，**不二次调用 LLM**；截断后加“摘要已截断”，仍不通过最终 `Quality.evaluate` 的不发布。
5. 处理层不修改 `url`、`source_*`、`author`、`published_at`；发布层不改已有 `content_id` 和 `published_at`。
6. 前端 `is_read` 是本地状态，发布层不写、不覆盖；已读与“不再推荐”在 localStorage，新增内容不会清空它们。

### 12.8 发布层并发与幂等

- 整个更新 run 在读取 state 前获取 `pipeline/state/update.lock`（`wx` 独占），`try/finally` 释放；takedown/resume 也使用同一把锁。
- `appendArticles` 在锁内重读最新 `articles.json` 和 `sources.json`，按 `content_id` 与精确规则二次去重；已存在则跳过并记录，不静默覆盖。
- 追加而非重建；发布前备份到 `pipeline/history/`，保留最近 20 份。
- 原子写 JSON：先写临时文件再 `rename`，避免半写文件。
- 发布成功后更新 `sources.last_item_at`，重建 `data/fallback-data.js`。
- 锁超时返回 `LOCK_TIMEOUT`，HTTP/CLI 失败退出码非 0；不会无限等待。

### 12.9 与验收标准的对应

| 验收点 | 实现/测试 |
| --- | --- |
| 第二次 304 不重复，健康状态不变 | `pipeline/tests/pipeline.test.js` 第 1 项；`update.js` 304 分支 |
| URL/guid 不重复；模糊阈值可配；临界区不丢 | `dedupe.js`；测试第 2 项 |
| 两进程同时写不覆盖 | `publish.acquireLock`；测试第 5 项 |
| 丢弃可查到来源/条目/层级/原因 | `recordDrop` + JSONL 日志；测试第 12 项 |
| 禁止翻译不生成摘要 | `update.js` title_only 分支；测试第 7 项 |
| 空/格式错/超长不原样发布；截断不二次调用 | `llm.js` + `update.js`；测试第 8 项 |
| 追加写入不影响已有内容/已读 | `appendArticles`；测试第 6 项 |
| 7 天低活跃；连续失败暂停且不自动恢复 | `updateLowActivity`、`markPaused`；测试第 10 项 |
| takedown 移出推荐池并留记录；恢复不恢复内容 | `takedown.js`、`Quality.taken_down`；测试第 11 项 |
| dry-run 不调 LLM/不写池/不改 state | `update.js` 短路 + 独立日志；测试第 4 项 |
| 日志区分 304/200/失败/空 feed/去重/筛选/处理/写入 | `run.counters` + 每层日志 |

### 12.10 合规边界（更新管道不改变）

- RSS/API 存在不等于可展示全文；所有演示源 `fulltext_allowed:false`。
- 条款禁止翻译/衍生的来源不生成摘要；本项目用 `title_only` 队列兜底，不把标题/摘要放进推荐池。
- 摘要硬上限不放宽；不因为“想多更新”降低 `quality.threshold` 或跳过否决规则。
- 不自动扩大来源池；新来源必须完成许可依据、robots 核查和复核日期登记。
- 导出仍是独立只读流程，不触发更新；更新也不修改导出模板或导出字段。
- 境内公开运营的新闻聚合资质、转载付酬和逐源许可核查，仍按第 10 节执行；代码和 README 不构成法律意见。

---

## 13. 发布到 GitHub Pages

仓库已包含 `.github/workflows/pages.yml`。推送到 `main` 后，工作流会把 `index.html`、`assets/`、`data/`、`docs/` 复制到 `_site/`，上传为 Pages artifact 并部署；不会把 `pipeline/`、日志、state、临时目录发布到公开站点。

### 13.1 仓库设置

1. 在 GitHub 新建仓库（例如 `kuayu-recommender`），选择 Public。
2. 推送代码后进入 **Settings → Pages**。
3. **Build and deployment → Source** 选择 **GitHub Actions**；工作流也配置了 `enablement: true`，会尝试自动启用 Pages，若组织策略阻止则需手动设置。
4. 打开 **Actions**，等待 `Deploy static site to GitHub Pages` 完成。
5. 站点地址为 `https://<GitHub 用户名>.github.io/<仓库名>/`。

### 13.2 本地推送命令

```bash
git init -b main
git add .
git commit -m "feat: publish cross-domain content recommender"
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

推送需要该仓库的 Contents 写权限。推荐使用 fine-grained PAT，或提前在本机完成 Git 凭据登录；不要把令牌写进仓库文件。

### 13.3 更新发布

后续更新内容后：

```bash
node tools/build-fallback.mjs
node tools/build-standalone.mjs
git add data/ docs/
git commit -m "chore: update content snapshot"
git push
```

工作流会重新部署。页面通过相对路径访问 `data/`，因此在项目子路径 `/仓库名/` 下也能正常工作。

### 13.4 每周一 07:00 自动更新

仓库已包含 `.github/workflows/update-content.yml`：

- **触发时间**：每周一 07:00（Asia/Shanghai）。GitHub Actions cron 使用 UTC，因此写为 `0 23 * * 0`（周日 23:00 UTC）。
- **手动触发**：Actions → `Weekly content update and deploy` → Run workflow。
- **执行内容**：`pipeline/update.js --force` → 重建 `data/fallback-data.js` 与 `docs/index.html` → 有变化才提交 → 部署 GitHub Pages。
- **提交与部署**：没有任何变化不提交；只有 304/健康状态变化时提交 state，但不重新部署；有文章或来源展示变化才重新部署。
- **状态连续性**：`pipeline/state/update-state.json`、`processing.json`、`manual-queue.json`、`takedowns.json` 会随工作流提交回仓库，保证 ETag、304 健康状态、失败次数、人工队列和下架记录跨周延续；`update.lock`、日志和历史备份不提交。
- **内容新鲜度**：`--force` 只跳过“抓取间隔等待”，仍会执行 robots、许可、四层筛选、去重、暂停和 takedown 检查；不会为了更新而放宽质量阈值。

启用步骤：

1. 把完整仓库推送到 GitHub，默认分支为 `main`。
2. **Settings → Secrets and variables → Actions → New repository secret**，新增 `KUAYU_LLM_API_KEY`，值为可用的 OpenAI 兼容 API Key。
3. **Settings → Actions → General → Workflow permissions** 选择 **Read and write permissions**；否则 workflow 无法提交更新。
4. **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
5. 打开 **Actions → Weekly content update and deploy → Run workflow** 做一次手动验证。

注意：

- GitHub 的定时任务可能比 07:00 延迟几分钟到几十分钟，这是平台调度行为，不是管道错误。
- 如果使用 13.5 的“网页上传单文件版 + Deploy from a branch”，没有运行 Node 的环境，**不能自动更新**；那种方式只能手动重新上传 `docs/index.html`。
- 真实模型输出和外部 feed 仍建议首次手动运行后检查 `pipeline/logs/update-YYYYMMDD.log`。
- 自动更新只追加/更新内容数据，不修改读者浏览器里的已读、不再推荐和导出状态。

### 13.5 无 Git 凭据：网页上传单文件版

如果暂时无法配置 Git 凭据，可生成单文件版本：

```bash
node tools/build-standalone.mjs
```

输出 `docs/index.html`（CSS、JS、数据全部内联，约 290 KB），并附带 `docs/.nojekyll`。它不依赖 `assets/` 或 `data/`，可以直接双击打开，也适合在 GitHub 网页上传：

1. 新建 Public 仓库。
2. 进入仓库，选择 **Add file → Upload files**，把整个 `docs` 文件夹拖进去并提交。
3. 进入 **Settings → Pages**。
4. **Build and deployment → Source** 选择 **Deploy from a branch**。
5. 分支选 `main`，目录选 **`/docs`**，保存。
6. 等待 Pages 构建完成，访问 `https://<用户名>.github.io/<仓库名>/`。

单文件版与多文件版内容一致；后续更新内容后重新运行脚本并上传覆盖 `docs/index.html` 即可。

---

## 附：一句话原则

**先有来源许可，再有摘要；先有事实，再有推荐；导出是重新排版，不是截图搬运。**
