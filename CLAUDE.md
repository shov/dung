# Dung

Top-down пиксельная игра, где мир, предметы, механики и управление генерирует Claude на лету.
Сейчас идёт спайк в ветке `spike/generative-world` (одноразовый код, см. `README.md`).

## Стек и команды

- npm workspaces на TypeScript: `shared/` (zod-схемы, типы, протокол), `server/` (Node + `ws`), `client/` (Vite + PixiJS).
- `npm start` поднимает сервер (ws :8787) и клиент (:5173) и открывает браузер; `npm run dev` то же с watch; `npm test` (vitest); `npm run typecheck`.
- Claude вызывается через Claude Code CLI (`claude -p --json-schema`) по подписке пользователя, API-ключа нет.
  Команда настраивается через `CLAUDE_CMD` / `CLAUDE_USE_SHELL` в `.env`.
- Импорты между пакетами идут через `@dung/shared` (исходники TS, без сборки).

## Как работаем

- Общение с пользователем на русском; код, коммиты, комментарии в коде и тикеты на английском.
- Сначала выравниваемся по задаче, потом пишем код: для неясных или крупных задач начинай с `/grill-me` или `/grill-with-docs`, затем `/to-spec` → `/to-tickets` → `/implement`.
- Новая логика пишется через `/tdd` (red → green → refactor), баги чинятся через `/diagnosing-bugs` (сначала воспроизведение, потом фикс).
- Не знаешь, какой скилл взять, спроси `/ask-matt`: это роутер по всем скиллам.
- Коммить и пушь только по просьбе пользователя.

## Skills

Скиллы из [mattpocock/skills](https://github.com/mattpocock/skills) (v1.3.1, commit `49dd158`) скопированы в `.claude/skills/` и редактируются локально. Обновление: перекопировать нужные папки из `skills/engineering` и `skills/productivity` апстрима.

Имя `code-review` совпадает со встроенным `/code-review` Claude Code; если вызывается не тот, переименуй папку скилла (например, в `mp-code-review`).

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
