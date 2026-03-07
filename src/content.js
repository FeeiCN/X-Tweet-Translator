const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};

let settings = { ...DEFAULT_SETTINGS };

init();

async function init() {
  settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  scanTweets();
  observeTimeline();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') {
      return;
    }

    for (const [key, value] of Object.entries(changes)) {
      settings[key] = value.newValue;
    }

    scanTweets();
  });
}

function observeTimeline() {
  const observer = new MutationObserver(() => {
    window.clearTimeout(observeTimeline.timer);
    observeTimeline.timer = window.setTimeout(scanTweets, 250);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

async function scanTweets() {
  if (!settings.enabled) {
    return;
  }

  hideAdTweets();

  bindTranslatableNodes(document.querySelectorAll('[data-testid="tweetText"]'), {
    showButton: true,
    forceAutoTranslate: false
  });
  bindTranslatableNodes(findArticleCardTitleNodes(), {
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

function hideAdTweets() {
  const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');

  for (const article of tweetArticles) {
    if (article.dataset.xAdHidden === '1') {
      continue;
    }

    if (!isAdTweet(article)) {
      continue;
    }

    article.dataset.xAdHidden = '1';
    const wrapper = article.closest('div[data-testid="cellInnerDiv"]') || article;
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

function findArticleCardTitleNodes() {
  const titleNodes = new Set();
  const mediaCards = document.querySelectorAll('[data-testid="card.layoutLarge.media"]');

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

function bindTranslatableNodes(nodes, options) {
  const { showButton = true, forceAutoTranslate = false, placeAfterCardWrapper = false } = options || {};

  for (const textBlock of nodes) {
    if (!textBlock || textBlock.dataset.xTranslateBound === '1') {
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

  if (container.dataset.lastSource === text && result.textContent) {
    result.hidden = false;
    button.textContent = buildTranslateButtonText(container.dataset.providerLabel || '');
    return;
  }

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
    container.dataset.providerLabel = response.providerLabel || '';
    result.textContent = response.translatedText;
    result.hidden = false;
  } catch (error) {
    result.textContent = `Translation error: ${error.message}`;
    result.hidden = false;
  } finally {
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
