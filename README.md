# SalesAgent AI

Платформа AI-продавцов для текстовых и голосовых каналов. Один агент использует базу знаний компании, ведёт историю клиента, вызывает инструменты CRM и отвечает голосом через Cartesia Sonic 3.5 или Fish Audio.

## Что работает

- регистрация организаций и JWT-аутентификация;
- модели Cerebras и OpenRouter по model ID с автоматическим fallback;
- RAG по документам PDF, CSV, TXT и Markdown;
- инструменты поиска знаний, обновления лида, встречи и WhatsApp;
- браузерный чат и голосовой тест;
- выбор микрофона и аудиовыхода; распознавание `deepgram/nova-3` через OpenRouter;
- двухконтурный голосовой ответ: Gemma 4 на Cerebras отвечает сразу, DeepSeek V4 Pro анализирует сложные вопросы в фоне;
- потоковый Cartesia Sonic 3.5 с русскими голосами, Fish Audio fallback и закреплённым voice ID для каждого агента;
- WhatsApp через Wazzup24 и Telegram Bot webhooks;
- HTTP-интеграция Voximplant для телефонных звонков;
- разговоры, лиды, записи и метрики в MySQL/MariaDB;
- светлая и тёмная тема;
- встроенный раздел «Справка и настройка».

## Документация

- [Руководство пользователя](docs/USER_GUIDE.md) — полный путь от регистрации до тестового звонка и описание каждого поля.
- [Руководство по развёртыванию](DEPLOYMENT.md) — переменные окружения, MySQL, Serverix/Pterodactyl, HTTPS и проверка.
- [.env.example](.env.example) — полный шаблон конфигурации без секретов.

Та же пользовательская документация доступна после входа в разделе «Справка и настройка». Он дополнительно показывает текущую готовность провайдеров без раскрытия ключей.

## Стек

| Область | Реализация |
|---|---|
| Backend | Node.js 20+, Express 5, TypeScript |
| Database | MySQL 8 / MariaDB |
| AI | Cerebras/OpenRouter Chat Completions, OpenRouter embeddings |
| STT | OpenRouter Audio Transcriptions, `deepgram/nova-3` с Whisper fallback |
| Voice | Cartesia Sonic 3.5 / Fish Audio TTS |
| Telephony | Voximplant HTTP scenario |
| Queues | Redis и BullMQ; режим `memory` для одиночного тестового процесса |
| Frontend | React 18, TanStack Query, Tailwind CSS, Vite |
| Storage | S3-совместимое хранилище записей |

## Быстрый локальный запуск

```bash
cp .env.example .env
npm install
npm --prefix admin install
npm run migrate:dev
npm run build
npm --prefix admin run build
npm start
```

Откройте адрес из `PUBLIC_BASE_URL` или `http://localhost:3000`. Создайте организацию через форму регистрации. Демо-паролей в репозитории нет.

Для разработки:

```bash
npm run dev
npm --prefix admin run dev
```

## Проверки

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm --prefix admin run build
npm audit
npm --prefix admin audit
```

## Основные API

Все маршруты `/api/v1/*`, кроме регистрации и входа, требуют `Authorization: Bearer <JWT>`.

| Метод | Маршрут | Назначение |
|---|---|---|
| `POST` | `/api/v1/auth/register` | Создать организацию и администратора |
| `POST` | `/api/v1/auth/login` | Получить JWT |
| `GET/POST/PUT/DELETE` | `/api/v1/agents` | Управление агентами |
| `POST` | `/api/v1/chat` | Текстовый тест выбранного агента |
| `POST` | `/api/v1/voice/respond` | Авторизованный браузерный voice turn |
| `POST` | `/api/v1/voice/sessions` | Создать голосовую тестовую сессию |
| `POST` | `/api/v1/voice/sessions/:id/utterances` | Распознать аудиореплику и получить голосовой ответ |
| `GET` | `/api/v1/voice/sessions/:id/background` | Статус фонового анализа сложного вопроса |
| `POST` | `/api/v1/voice/sessions/:id/background/:taskId/deliver` | Передать готовый глубокий вывод в голосовой диалог |
| `POST` | `/api/v1/voice/sessions/:id/background/:taskId/dismiss` | Скрыть устаревший глубокий вывод |
| `GET/POST/DELETE` | `/api/v1/knowledge` | Документы и RAG-поиск |
| `GET` | `/api/v1/conversations/:orgId` | Разговоры организации |
| `GET` | `/api/v1/recordings` | Записи звонков |
| `GET` | `/api/v1/providers/status` | Готовность интеграций без секретов |
| `GET` | `/api/v1/providers/models` | Доступные модели Cerebras и OpenRouter |
| `GET` | `/https-url` | Текущий временный HTTPS-адрес Cloudflare Tunnel |
| `POST` | `/api/voice` | Публичный HTTPS endpoint Voximplant с `X-Voice-Secret` |
| `POST` | `/api/webhooks/whatsapp/:orgId` | Wazzup24 webhook с секретом |
| `POST` | `/api/webhooks/telegram/:orgId` | Telegram webhook с secret token |

## Безопасность

- Публичный voice endpoint в production отклоняет обычный HTTP.
- Webhook-обработчики требуют отдельные секреты и дедуплицируют события.
- Организация берётся из JWT или защищённого webhook URL; автоматического выбора «первой организации» нет.
- API-ключи не возвращаются в админ-панель.
- `.env` не должен попадать в Git и должен иметь права только для владельца процесса.

## Лицензия

MIT
