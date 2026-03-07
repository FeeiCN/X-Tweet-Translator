const DEFAULT_SETTINGS = {
  enabled: true,
  autoTranslate: true,
  targetLanguage: 'zh-CN'
};

const enabledEl = document.getElementById('enabled');
const autoTranslateEl = document.getElementById('autoTranslate');
const targetLanguageEl = document.getElementById('targetLanguage');

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  enabledEl.checked = settings.enabled;
  autoTranslateEl.checked = settings.autoTranslate;
  targetLanguageEl.value = settings.targetLanguage;

  enabledEl.addEventListener('change', persist);
  autoTranslateEl.addEventListener('change', persist);
  targetLanguageEl.addEventListener('change', persist);
}

async function persist() {
  await chrome.storage.sync.set({
    enabled: enabledEl.checked,
    autoTranslate: autoTranslateEl.checked,
    targetLanguage: targetLanguageEl.value
  });
}
