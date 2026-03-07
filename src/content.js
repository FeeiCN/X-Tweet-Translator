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

  const tweetTextBlocks = document.querySelectorAll('[data-testid="tweetText"]');

  for (const textBlock of tweetTextBlocks) {
    if (textBlock.dataset.xTranslateBound === '1') {
      continue;
    }

    if (isChineseText(textBlock.innerText || '')) {
      textBlock.dataset.xTranslateBound = '1';
      continue;
    }

    textBlock.dataset.xTranslateBound = '1';
    attachTranslatorUI(textBlock);

    if (settings.autoTranslate) {
      translateAndRender(textBlock);
    }
  }
}

function isChineseText(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
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

function attachTranslatorUI(textBlock) {
  const container = document.createElement('div');
  container.className = 'xt-translate-container';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xt-translate-btn';
  button.textContent = 'Translate';

  const result = document.createElement('div');
  result.className = 'xt-translate-result';
  result.hidden = true;

  button.addEventListener('click', () => translateAndRender(textBlock));

  container.appendChild(button);
  container.appendChild(result);
  textBlock.insertAdjacentElement('afterend', container);
}

async function translateAndRender(textBlock) {
  const container = textBlock.nextElementSibling;
  if (!container?.classList.contains('xt-translate-container')) {
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
    return;
  }

  button.disabled = true;
  button.textContent = 'Translating...';

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
    result.textContent = response.translatedText;
    result.hidden = false;
  } catch (error) {
    result.textContent = `Translation error: ${error.message}`;
    result.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Translate';
  }
}
