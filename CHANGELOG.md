# Changelog

## Unreleased

### Added

- Opus 5 (`opus-5` / Notion `agave-flan`) в bridge API, Codex model catalog и
  model picker официального VS Code extension.
- Совместимость истории Codex между `openai` и `notion-ai` providers без
  изменения или миграции сохранённых тредов.
- Восстановление JSON, Anthropic `invoke` и hybrid `antml:parameter` tool calls,
  включая ограниченную автоматическую коррекцию malformed-вызовов.
- Кроссплатформенный idempotent installer patch для версий `openai.chatgpt`,
  которые скрывают неизвестные transport model IDs.
- Responses SSE reasoning events для доступных Notion thinking deltas, а также
  немедленный progress и heartbeat каждые 10 секунд для длинных inference.

### Changed

- Linux bridge принудительно направляет все model IDs в Opus 5; legacy IDs
  сохранены только для возобновления старых Codex-тредов.
- Notion получает `modelFromUser=true` на каждом turn, чтобы continuation не
  возвращался в Auto model.
- Переключение модели в существующей Codex conversation начинает новый Notion
  thread, чтобы фактически применялась выбранная модель.
- Codex context window увеличено до 210 000 токенов, а auto-compaction trigger
  установлен на 200 000 total tokens для всех моделей и `defaultModel`.
- Notion inference ограничен настраиваемым timeout; значение по умолчанию
  `NOTION_INFERENCE_TIMEOUT_SECONDS=180` освобождает account lease при зависании.

### Security

- Account JSON, cookies, runtime state и `.env` остаются локальными и исключены
  из public-release artifact и Git tracking.
