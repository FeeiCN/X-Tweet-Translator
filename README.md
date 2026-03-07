# X Tweet Translator

一个用于在 X（Twitter）时间线上翻译推文的 Chrome 插件 MVP。

## 当前功能

- 自动识别页面中的推文正文（`data-testid="tweetText"`）
- 支持自动翻译可见推文
- 支持手动点击 `Translate` 翻译单条推文
- 翻译结果本地缓存（7 天过期），减少重复请求
- 翻译请求节流（最小 800ms 间隔），降低接口抖动
- 自动隐藏带有 `Ad` 标识的广告推文
- Popup 中可配置：
  - 插件开关
  - 自动翻译开关
  - 目标语言

## 技术方案（MVP）

- `content script` 注入到 `x.com` 页面，负责识别推文并渲染翻译 UI
- `service worker` 统一发起翻译请求（当前接 MyMemory 免费接口）
- 后台会自动做基础语言识别（zh/ja/ko/ru/en）后再调用接口，避免 `AUTO` 参数报错
- 后台包含请求去重、请求节流、翻译缓存逻辑
- `chrome.storage.sync` 保存用户设置
- `chrome.storage.local` 保存翻译缓存

## 本地运行

1. 打开 Chrome，进入 `chrome://extensions`
2. 打开右上角 `开发者模式`
3. 点击 `加载已解压的扩展程序`
4. 选择本项目目录：

```text
/Users/feei/Documents/auto-translate
```

5. 打开 `https://x.com` 验证效果

## Changelog

> 规则：每次 `manifest.json` 版本号变更时，必须同步更新本节。

### v0.1.5
- 新增翻译缓存（`chrome.storage.local`，7 天 TTL）
- 新增请求去重与节流（最小 800ms 间隔）
- 新增合规文档：`PRIVACY.md`、`STORE_LISTING.md`

### v0.1.4
- 新增插件 Logo 与多尺寸图标（16/32/48/128）
- Popup 顶部展示品牌图标
- 统一项目名为 `X Tweet Translator`

### v0.1.3
- 中文推文默认跳过，不注入翻译入口
- 后台增加中文兜底（中文不发翻译请求）

### v0.1.2
- 新增广告推文隐藏（识别 `Ad/广告` 标签）

### v0.1.1
- 修复 MyMemory `AUTO` 源语言报错
- 增加源语言规范化与基础识别逻辑

### v0.1.0
- 初始化 Chrome MV3 插件 MVP
- 支持推文识别、手动/自动翻译、Popup 设置

## 注意事项

- 这是 MVP，MyMemory 免费接口有配额和稳定性限制。
- 后续建议替换为可控翻译服务（如 DeepL / OpenAI / 自建服务）。
- X 页面 DOM 可能变化，选择器需要持续维护。

## 合规与上架文档

- 隐私政策草案：[PRIVACY.md](/Users/feei/Documents/auto-translate/PRIVACY.md)
- Chrome Web Store 上架文案草案：[STORE_LISTING.md](/Users/feei/Documents/auto-translate/STORE_LISTING.md)
