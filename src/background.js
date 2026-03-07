const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};
const CACHE_VERSION = 'v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_MIN_INTERVAL_MS = 800;
const MAX_RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1200;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const TRANSLATION_PROVIDERS = [
  { id: 'mymemory' },
  { id: 'googlegtx' },
  { id: 'libretranslate' }
];

const inflightRequests = new Map();
let lastRequestAt = 0;
let throttleQueue = Promise.resolve();
const providerCooldownUntil = {};
let currentProviderIndex = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'translate') {
    return;
  }

  translateText(message)
    .then((payload) => sendResponse({ ok: true, ...payload }))
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
    return {
      translatedText: safeText,
      providerId: 'local',
      providerLabel: getProviderLabel('local')
    };
  }

  if (normalizedSource.toLowerCase() === normalizedTarget.toLowerCase()) {
    return {
      translatedText: safeText,
      providerId: 'local',
      providerLabel: getProviderLabel('local')
    };
  }

  const cacheKey = buildCacheKey({
    sourceLanguage: normalizedSource,
    targetLanguage: normalizedTarget,
    text: safeText
  });

  const cached = await getCachedTranslation(cacheKey);
  if (cached) {
    const cachedProviderId = cached.providerId || 'mymemory';
    return {
      translatedText: cached.value,
      providerId: cachedProviderId,
      providerLabel: `${getProviderLabel(cachedProviderId)}(Cache)`
    };
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
  const providers = getProviderOrder();
  const errors = [];

  for (const provider of providers) {
    const cooldownMs = getProviderCooldownMs(provider.id);
    if (cooldownMs > 0) {
      errors.push(`${provider.id}: rate-limited (${Math.ceil(cooldownMs / 1000)}s left)`);
      continue;
    }

    try {
      const translatedText = await runProviderWithRetries({
        provider,
        safeText,
        normalizedSource,
        normalizedTarget
      });

      currentProviderIndex = TRANSLATION_PROVIDERS.findIndex((item) => item.id === provider.id);
      await setCachedTranslation(cacheKey, translatedText, provider.id);
      return {
        translatedText,
        providerId: provider.id,
        providerLabel: getProviderLabel(provider.id)
      };
    } catch (error) {
      if (error?.isRateLimited) {
        const cooldownMs = error.retryAfterMs || RATE_LIMIT_COOLDOWN_MS;
        setProviderCooldown(provider.id, cooldownMs);
        errors.push(`${provider.id}: ${buildRateLimitMessage(cooldownMs)}`);
        continue;
      }

      errors.push(`${provider.id}: ${error.message || 'Translation failed'}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`All providers failed. ${errors.join(' | ')}`);
  }

  throw new Error('No translation providers available');
}

async function runProviderWithRetries({
  provider,
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await waitForThrottleWindow();
      return await requestTranslation({
        provider,
        safeText,
        normalizedSource,
        normalizedTarget
      });
    } catch (error) {
      lastError = error;
      if (error?.isRateLimited) {
        throw error;
      }

      const isLastAttempt = attempt === MAX_RETRY_ATTEMPTS;
      if (isLastAttempt || !isRetryableError(error)) {
        throw error;
      }

      await sleep(getRetryDelayMs(attempt));
    }
  }

  throw lastError || new Error('Translation failed');
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

function getRetryDelayMs(attempt) {
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function isRetryableError(error) {
  const message = String(error?.message || '');
  return (
    message.startsWith('HTTP 5') ||
    message.startsWith('HTTP 429') ||
    message.startsWith('API error 5') ||
    message.startsWith('API error 429') ||
    message.includes('Failed to fetch')
  );
}

function buildRateLimitMessage(cooldownMs) {
  const seconds = Math.max(1, Math.ceil(cooldownMs / 1000));
  return `Rate limited by translation provider. Retry in about ${seconds}s.`;
}

async function requestTranslation({
  provider,
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  if (provider.id === 'mymemory') {
    return requestMyMemory({
      safeText,
      normalizedSource,
      normalizedTarget
    });
  }

  if (provider.id === 'googlegtx') {
    return requestGoogleGTX({
      safeText,
      normalizedSource,
      normalizedTarget
    });
  }

  if (provider.id === 'libretranslate') {
    return requestLibreTranslate({
      safeText,
      normalizedSource,
      normalizedTarget
    });
  }

  throw new Error(`Unknown provider: ${provider.id}`);
}

async function requestMyMemory({
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', safeText);
  url.searchParams.set('langpair', `${normalizedSource}|${normalizedTarget}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  });

  if (response.status === 429) {
    throw rateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')));
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const responseStatus = Number(data?.responseStatus || 0);
  if (responseStatus === 429) {
    throw rateLimitError(RATE_LIMIT_COOLDOWN_MS);
  }

  const responseDetails = String(data?.responseDetails || '');
  if (/quota exceeded|too many requests|rate limit/i.test(responseDetails)) {
    throw rateLimitError(RATE_LIMIT_COOLDOWN_MS);
  }

  if (responseStatus >= 400) {
    throw new Error(data?.responseDetails || `API error ${responseStatus}`);
  }

  const translatedText = data?.responseData?.translatedText?.trim();
  if (!translatedText) {
    throw new Error('No translated text returned');
  }

  return translatedText;
}

async function requestLibreTranslate({
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const source = mapLanguageForLibreTranslate(normalizedSource);
  const target = mapLanguageForLibreTranslate(normalizedTarget);

  const response = await fetch('https://libretranslate.com/translate', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: safeText,
      source,
      target,
      format: 'text'
    })
  });

  if (response.status === 429) {
    throw rateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')));
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (response.status === 400 && contentType.includes('application/json')) {
    const data = await response.json();
    const errorText = String(data?.error || '').trim();
    throw new Error(errorText || 'HTTP 400');
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const translatedText = String(data?.translatedText || '').trim();
  if (!translatedText) {
    const errorText = String(data?.error || '').trim();
    if (/too many requests|rate limit/i.test(errorText)) {
      throw rateLimitError(RATE_LIMIT_COOLDOWN_MS);
    }
    throw new Error(errorText || 'No translated text returned');
  }

  return translatedText;
}

async function requestGoogleGTX({
  safeText,
  normalizedSource,
  normalizedTarget
}) {
  const source = mapLanguageForGoogle(normalizedSource);
  const target = mapLanguageForGoogle(normalizedTarget);

  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', source);
  url.searchParams.set('tl', target);
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', safeText);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*'
    }
  });

  if (response.status === 429) {
    throw rateLimitError(parseRetryAfterMs(response.headers.get('Retry-After')));
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const translatedText = segments
    .map((segment) => (Array.isArray(segment) ? String(segment[0] || '') : ''))
    .join('')
    .trim();

  if (!translatedText) {
    throw new Error('No translated text returned');
  }

  return translatedText;
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) {
    return RATE_LIMIT_COOLDOWN_MS;
  }

  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.round(asSeconds * 1000);
  }

  return RATE_LIMIT_COOLDOWN_MS;
}

function rateLimitError(retryAfterMs) {
  const error = new Error('HTTP 429');
  error.isRateLimited = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function getProviderOrder() {
  const size = TRANSLATION_PROVIDERS.length;
  const start = ((currentProviderIndex % size) + size) % size;
  const ordered = [];

  for (let i = 0; i < size; i += 1) {
    ordered.push(TRANSLATION_PROVIDERS[(start + i) % size]);
  }

  return ordered;
}

function setProviderCooldown(providerId, cooldownMs) {
  providerCooldownUntil[providerId] = Date.now() + Math.max(1, cooldownMs);
}

function getProviderCooldownMs(providerId) {
  const until = providerCooldownUntil[providerId] || 0;
  return Math.max(0, until - Date.now());
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
  if (!record) {
    return '';
  }

  if (typeof record === 'string') {
    return {
      value: record,
      createdAt: Date.now(),
      providerId: 'cache'
    };
  }

  if (!record?.value || typeof record?.createdAt !== 'number') {
    return '';
  }

  if (Date.now() - record.createdAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(cacheKey);
    return '';
  }

  return {
    value: record.value,
    createdAt: record.createdAt,
    providerId: record.providerId || 'cache'
  };
}

async function setCachedTranslation(cacheKey, value, providerId) {
  await chrome.storage.local.set({
    [cacheKey]: {
      value,
      createdAt: Date.now(),
      providerId
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

function mapLanguageForLibreTranslate(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) {
    return 'auto';
  }

  if (normalized.startsWith('zh')) {
    return 'zh';
  }

  if (normalized.includes('-')) {
    return normalized.split('-')[0];
  }

  return normalized;
}

function mapLanguageForGoogle(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) {
    return 'auto';
  }

  return normalized;
}

function getProviderLabel(providerId) {
  if (providerId === 'mymemory') {
    return 'MyMemory';
  }
  if (providerId === 'googlegtx') {
    return 'Google GTX';
  }
  if (providerId === 'libretranslate') {
    return 'LibreTranslate';
  }
  if (providerId === 'local') {
    return 'Local';
  }
  if (providerId === 'cache') {
    return 'MyMemory';
  }

  return 'MyMemory';
}
