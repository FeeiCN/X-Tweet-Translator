const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';
const MEDIA_CARD_SELECTOR = '[data-testid="card.layoutLarge.media"]';
const AD_TWEET_SELECTOR = 'article[data-testid="tweet"]';
const SCAN_DEBOUNCE_MS = 180;

let settings = { ...DEFAULT_SETTINGS };
let timelineObserver = null;
let scanTimer = 0;
const pendingScanRoots = new Set();

init();

async function init() {
  settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  queueScan(document.body || document.documentElement);
  observeTimeline();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') {
      return;
    }

    const previousSettings = { ...settings };
    for (const [key, value] of Object.entries(changes)) {
      settings[key] = value.newValue;
    }

    if (!settings.enabled) {
      cleanupInjectedUI();
      return;
    }

    queueScan(document.body || document.documentElement);

    const targetLanguageChanged = previousSettings.targetLanguage !== settings.targetLanguage;
    const autoTranslateEnabledNow = !previousSettings.autoTranslate && settings.autoTranslate;
    if ((autoTranslateEnabledNow || targetLanguageChanged) && settings.autoTranslate) {
      autoTranslateBoundNodes();
    }
  });
}

function observeTimeline() {
  if (timelineObserver) {
    return;
  }

  if (!document.body) {
    window.setTimeout(observeTimeline, 200);
    return;
  }

  timelineObserver = new MutationObserver((mutations) => {
    if (!settings.enabled) {
      return;
    }

    for (const mutation of mutations) {
      queueScan(mutation.target);
      for (const node of mutation.addedNodes) {
        queueScan(node);
      }
    }
  });

  timelineObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function queueScan(root) {
  const normalizedRoot = normalizeRoot(root);
  if (!normalizedRoot) {
    return;
  }

  pendingScanRoots.add(normalizedRoot);
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(processPendingScans, SCAN_DEBOUNCE_MS);
}

function processPendingScans() {
  scanTimer = 0;
  if (!settings.enabled) {
    pendingScanRoots.clear();
    return;
  }

  const roots = Array.from(pendingScanRoots);
  pendingScanRoots.clear();

  for (const root of roots) {
    scanRoot(root);
  }
}

function normalizeRoot(root) {
  if (!root) {
    return null;
  }

  if (root === document) {
    return document.body || document.documentElement;
  }

  if (root.nodeType === Node.TEXT_NODE) {
    return root.parentElement;
  }

  if (root.nodeType === Node.DOCUMENT_NODE) {
    return document.body || document.documentElement;
  }

  if (root instanceof Element || root instanceof DocumentFragment) {
    return root;
  }

  return null;
}

function scanRoot(root) {
  if (!root) {
    return;
  }

  if (root instanceof Element && !root.isConnected) {
    return;
  }

  hideAdTweets(root);

  bindTranslatableNodes(findNodesBySelector(root, TWEET_TEXT_SELECTOR), {
    showButton: true,
    forceAutoTranslate: false
  });

  bindTranslatableNodes(findArticleCardTitleNodes(root), {
    showButton: false,
    forceAutoTranslate: true,
    placeAfterCardWrapper: true
  });
}

function isChineseText(text) {
  const value = String(text || '');
  if (!value) {
    return false;
  }

  // Japanese text should not be treated as Chinese.
  if (/[\u3040-\u30ff]/.test(value)) {
    return false;
  }

  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value);
}

function hideAdTweets(root) {
  const tweetArticles = findNodesBySelector(root, AD_TWEET_SELECTOR);

  for (const article of tweetArticles) {
    if (article.dataset.xAdHidden === '1') {
      continue;
    }

    if (!isAdTweet(article)) {
      continue;
    }

    article.dataset.xAdHidden = '1';
    const wrapper = article.closest('div[data-testid="cellInnerDiv"]') || article;
    wrapper.dataset.xAdHiddenWrapper = '1';
    wrapper.dataset.xAdOriginalDisplay = wrapper.style.display || '';
    wrapper.style.display = 'none';
  }
}

function isAdTweet(article) {
  const labels = article.querySelectorAll('div[dir="ltr"] > span');
  for (const label of labels) {
    const text = label.textContent?.trim();
    if (text === 'Ad' || text === '广告') {
      return true;
    }
  }

  return false;
}

function findArticleCardTitleNodes(root) {
  const titleNodes = new Set();
  const mediaCards = findNodesBySelector(root, MEDIA_CARD_SELECTOR);

  for (const card of mediaCards) {
    const candidates = card.querySelectorAll('div[dir="ltr"]');
    for (const node of candidates) {
      const text = node.innerText?.trim() || '';
      if (!text || text.length < 8) {
        continue;
      }

      titleNodes.add(node);
      break;
    }
  }

  return titleNodes;
}

function findNodesBySelector(root, selector) {
  const nodes = new Set();
  if (!root || typeof selector !== 'string') {
    return nodes;
  }

  if (root instanceof Element && root.matches(selector)) {
    nodes.add(root);
  }

  if (typeof root.querySelectorAll !== 'function') {
    return nodes;
  }

  for (const node of root.querySelectorAll(selector)) {
    nodes.add(node);
  }

  return nodes;
}

function bindTranslatableNodes(nodes, options) {
  const { showButton = true, forceAutoTranslate = false, placeAfterCardWrapper = false } = options || {};

  for (const textBlock of nodes) {
    if (!textBlock || !(textBlock instanceof Element) || textBlock.dataset.xTranslateBound === '1') {
      continue;
    }

    if (isChineseText(textBlock.innerText || '')) {
      textBlock.dataset.xTranslateBound = '1';
      continue;
    }

    textBlock.dataset.xTranslateBound = '1';
    attachTranslatorUI(textBlock, { showButton, placeAfterCardWrapper });

    if (forceAutoTranslate || settings.autoTranslate) {
      translateAndRender(textBlock);
    }
  }
}

function attachTranslatorUI(textBlock, options) {
  const { showButton = true, placeAfterCardWrapper = false } = options || {};
  const container = document.createElement('div');
  container.className = 'xt-translate-container';
  const containerId = `xt-translate-${Math.random().toString(36).slice(2, 10)}`;
  container.dataset.containerId = containerId;
  textBlock.dataset.xTranslateContainerId = containerId;

  const result = document.createElement('div');
  result.className = 'xt-translate-result';
  result.hidden = true;

  if (showButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'xt-translate-btn';
    button.textContent = buildTranslateButtonText('');
    button.addEventListener('click', () => translateAndRender(textBlock));
    container.appendChild(button);
  }

  container.appendChild(result);
  const cardWrapper = placeAfterCardWrapper
    ? textBlock.closest('[data-testid="card.wrapper"]')
    : null;
  const anchor = cardWrapper || textBlock;
  anchor.insertAdjacentElement('afterend', container);
}

async function translateAndRender(textBlock) {
  const containerId = textBlock.dataset.xTranslateContainerId || '';
  const container = containerId
    ? document.querySelector(`.xt-translate-container[data-container-id="${containerId}"]`)
    : textBlock.nextElementSibling;
  if (!container || !container.classList.contains('xt-translate-container')) {
    return;
  }

  const button = container.querySelector('.xt-translate-btn');
  const result = container.querySelector('.xt-translate-result');

  const text = textBlock.innerText?.trim();
  if (!text) {
    return;
  }

  if (
    container.dataset.lastSource === text &&
    container.dataset.lastTargetLanguage === settings.targetLanguage &&
    result.textContent
  ) {
    result.hidden = false;
    if (button) {
      button.textContent = buildTranslateButtonText(container.dataset.providerLabel || '');
    }
    return;
  }

  if (container.dataset.loading === '1') {
    return;
  }

  container.dataset.loading = '1';

  if (button) {
    button.disabled = true;
    button.textContent = 'Translating...';
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'translate',
      text,
      targetLanguage: settings.targetLanguage
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Translate failed');
    }

    container.dataset.lastSource = text;
    container.dataset.lastTargetLanguage = settings.targetLanguage;
    container.dataset.providerLabel = response.providerLabel || '';
    result.textContent = response.translatedText;
    result.hidden = false;
  } catch (error) {
    result.textContent = `Translation error: ${error.message}`;
    result.hidden = false;
  } finally {
    delete container.dataset.loading;
    if (button) {
      button.disabled = false;
      button.textContent = buildTranslateButtonText(container.dataset.providerLabel || '');
    }
  }
}

function buildTranslateButtonText(providerLabel) {
  if (!providerLabel) {
    return 'X-Tweet-Translator';
  }

  return `X-Tweet-Translator·${providerLabel}`;
}

function cleanupInjectedUI() {
  pendingScanRoots.clear();
  window.clearTimeout(scanTimer);
  scanTimer = 0;

  for (const wrapper of document.querySelectorAll('[data-x-ad-hidden-wrapper="1"]')) {
    const originalDisplay = wrapper.dataset.xAdOriginalDisplay || '';
    if (originalDisplay) {
      wrapper.style.display = originalDisplay;
    } else {
      wrapper.style.removeProperty('display');
    }
    delete wrapper.dataset.xAdHiddenWrapper;
    delete wrapper.dataset.xAdOriginalDisplay;
  }

  for (const article of document.querySelectorAll('article[data-x-ad-hidden="1"]')) {
    delete article.dataset.xAdHidden;
  }

  for (const container of document.querySelectorAll('.xt-translate-container')) {
    container.remove();
  }

  for (const node of document.querySelectorAll('[data-x-translate-bound], [data-x-translate-container-id]')) {
    delete node.dataset.xTranslateBound;
    delete node.dataset.xTranslateContainerId;
  }
}

function autoTranslateBoundNodes() {
  if (!settings.enabled || !settings.autoTranslate) {
    return;
  }

  const boundNodes = document.querySelectorAll('[data-x-translate-bound="1"][data-x-translate-container-id]');
  for (const node of boundNodes) {
    translateAndRender(node);
  }
}
