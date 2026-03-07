const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const CACHE_VERSION = 'v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_MIN_INTERVAL_MS = 800;

const inflightRequests = new Map();
let lastRequestAt = 0;
let throttleQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'translate') {
    return;
  }

  translateText(message)
    .then((translatedText) => sendResponse({ ok: true, translatedText }))
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || 'Translation failed' });
    });

  return true;
});

async function translateText({ text, sourceLanguage = '', targetLanguage = 'zh-CN' }) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) {
    throw new Error('Empty text');
  }

  const maxLength = 450;
  const safeText = cleanText.length > maxLength ? `${cleanText.slice(0, maxLength)}...` : cleanText;
  const normalizedTarget = normalizeLanguageCode(targetLanguage) || 'zh-CN';
  const normalizedSource =
    normalizeLanguageCode(sourceLanguage) ||
    detectSourceLanguage(safeText);

  if (normalizedSource.toLowerCase().startsWith('zh')) {
    return safeText;
  }

  if (normalizedSource.toLowerCase() === normalizedTarget.toLowerCase()) {
    return safeText;
  }

  const cacheKey = buildCacheKey({
    sourceLanguage: normalizedSource,
    targetLanguage: normalizedTarget,
    text: safeText
  });

  const cached = await getCachedTranslation(cacheKey);
  if (cached) {
    return cached;
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const requestPromise = fetchAndCacheTranslation({
    cacheKey,
    safeText,
    normalizedSource,
    normalizedTarget
  }).finally(() => {
    inflightRequests.delete(cacheKey);
  });

  inflightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

async function fetchAndCacheTranslation({
  cacheKey,
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  await waitForThrottleWindow();

  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', safeText);
  url.searchParams.set('langpair', `${normalizedSource}|${normalizedTarget}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const responseStatus = Number(data?.responseStatus || 0);
  if (responseStatus >= 400) {
    throw new Error(data?.responseDetails || `API error ${responseStatus}`);
  }

  const translatedText = data?.responseData?.translatedText?.trim();

  if (!translatedText) {
    throw new Error('No translated text returned');
  }

  await setCachedTranslation(cacheKey, translatedText);
  return translatedText;
}

async function waitForThrottleWindow() {
  const task = throttleQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, REQUEST_MIN_INTERVAL_MS - (now - lastRequestAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestAt = Date.now();
  });

  throttleQueue = task.catch(() => {});
  await task;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCacheKey({ sourceLanguage, targetLanguage, text }) {
  const raw = `${CACHE_VERSION}|${sourceLanguage}|${targetLanguage}|${text}`;
  return `translation:${simpleHash(raw)}`;
}

function simpleHash(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }

  return (hash >>> 0).toString(36);
}

async function getCachedTranslation(cacheKey) {
  const stored = await chrome.storage.local.get(cacheKey);
  const record = stored?.[cacheKey];
  if (!record?.value || typeof record?.createdAt !== 'number') {
    return '';
  }

  if (Date.now() - record.createdAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(cacheKey);
    return '';
  }

  return record.value;
}

async function setCachedTranslation(cacheKey, value) {
  await chrome.storage.local.set({
    [cacheKey]: {
      value,
      createdAt: Date.now()
    }
  });
}

function normalizeLanguageCode(input) {
  if (!input) {
    return '';
  }

  const value = String(input).trim();
  if (!value) {
    return '';
  }
  if (value.toLowerCase() === 'auto') {
    return '';
  }

  if (value.includes('-')) {
    const [base, region] = value.split('-');
    if (!base || !region) {
      return '';
    }

    return `${base.toLowerCase()}-${region.toUpperCase()}`;
  }

  return value.toLowerCase();
}

function detectSourceLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) {
    return 'ja';
  }

  if (/[\uac00-\ud7af]/.test(text)) {
    return 'ko';
  }

  if (/[\u4e00-\u9fff]/.test(text)) {
    return 'zh-CN';
  }

  if (/[\u0400-\u04ff]/.test(text)) {
    return 'ru';
  }

  return 'en';
}
