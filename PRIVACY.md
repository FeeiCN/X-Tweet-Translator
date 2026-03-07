# Privacy Policy - X Tweet Translator

Effective date: March 7, 2026

## What this extension does

X Tweet Translator translates tweet text on `x.com` / `twitter.com` pages for the user.

## Data we process

- Tweet text selected for translation
- Extension settings stored in Chrome storage (`enabled`, `autoTranslate`, `targetLanguage`)
- Translation cache entries stored locally in Chrome storage (`chrome.storage.local`)

## How data is used

- Tweet text is sent to the configured translation provider (current MVP: MyMemory API) only for translation.
- Settings are used to control extension behavior.
- Cache is used to reduce repeated translation requests and improve speed.

## Data sharing

- We do not sell personal data.
- Tweet text is sent to the translation provider strictly to return translated text.

## Data retention

- Local translation cache expires automatically after 7 days.
- Users can clear extension data via Chrome extension settings.

## Permissions

- `storage`: save settings and translation cache.
- Host access to `x.com` / `twitter.com`: read tweet text and render translation UI.
- Host access to translation API domain: send translation requests.

## Security

- This MVP does not include account login or server-side user profile storage.
- Future versions may change providers and data handling; this policy should be updated accordingly.

## Contact

For support/privacy questions, provide a project contact email before store submission.
