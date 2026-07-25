# Changelog

## Unreleased

### Added

- Opus 5 (`opus-5` / Notion `agave-flan`) в bridge API, Codex model catalog и
  model picker официального VS Code extension.
- Кроссплатформенный idempotent installer patch для версий `openai.chatgpt`,
  которые скрывают неизвестные transport model IDs.
- Responses SSE reasoning events для доступных Notion thinking deltas, а также
  немедленный progress и heartbeat каждые 10 секунд для длинных inference.

### Changed

- Переключение модели в существующей Codex conversation начинает новый Notion
  thread, чтобы фактически применялась выбранная модель.
- Codex context window увеличено до 210 000 токенов, а auto-compaction trigger
  установлен на 200 000 total tokens для всех моделей и `defaultModel`.
- Notion inference ограничен настраиваемым timeout; значение по умолчанию
  `NOTION_INFERENCE_TIMEOUT_SECONDS=180` освобождает account lease при зависании.

### Security

- Account JSON, cookies, runtime state и `.env` остаются локальными и исключены
  из public-release artifact и Git tracking.
