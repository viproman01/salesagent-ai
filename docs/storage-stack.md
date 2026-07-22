# PostgreSQL, Redis и MinIO в Docker Compose

`docker-compose.yml` поднимает воспроизводимый локальный/одноузловой контур
хранения. Перед публичным production-развёртыванием замените значения
`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `S3_ACCESS_KEY` и `S3_SECRET_KEY`;
значения по умолчанию предназначены только для локального запуска.
Все host-порты хранилищ привязаны к `127.0.0.1`.

Нужен Docker Compose v2.17+; старый бинарный `docker-compose` v1 не
поддерживается.

## Порядок готовности

1. PostgreSQL становится healthy только после ответа `pg_isready` и проверки,
   что образ действительно содержит доступное расширение pgvector.
2. Redis требует пароль и становится healthy только после
   авторизованного `PING`.
3. Сервис `migrate` применяет миграции `migrations/NNN_*.sql` в транзакциях и
   записывает их в `_migrations`. Архивные `_old_*.sql` не исполняются.
4. MinIO становится healthy через `mc ready`; сервис `minio-init`
   идемпотентно создаёт и проверяет buckets из `S3_BUCKET_RECORDINGS` и
   `S3_BUCKET_KNOWLEDGE`.
5. Backend запускается только после успешного завершения `migrate` и
   `minio-init`, а admin — после healthcheck backend.

Такой порядок работает и с сохранёнными volumes: `migrate` запускается при
повторном `docker compose up` и применяет только ещё не зарегистрированные
файлы. Legacy-схема без `_migrations` всегда останавливает запуск. Её можно
принять только после backup и ручной проверки, явно установив
`MIGRATIONS_ADOPT_LEGACY_BASELINE=true`; даже тогда скрипт требует полный baseline 001–004.

## Запуск и проверка

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
docker compose logs migrate minio-init
```

У `postgres`, `redis`, `minio` и `app` должен быть статус `healthy`, а
одноразовые `migrate` и `minio-init` должны завершиться с кодом `0`.

Проверить расширение и buckets можно без публикации дополнительных endpoint:

```bash
docker compose exec postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT extname, extversion FROM pg_extension WHERE extname = '\''vector'\''"'

docker compose run --rm minio-init
```

Второй вызов также проверяет идемпотентность: существующие buckets не
пересоздаются и не очищаются.

## Обновление схемы

Добавляйте миграции только с монотонным трёхзначным префиксом, например
`006_add_call_indexes.sql`, затем снова выполните `docker compose up -d`.
Не изменяйте уже применённые файлы; для исправления создавайте следующую
миграцию. Файлы, которые не должны выполняться, не называйте по шаблону
`NNN_*.sql`.

## Ограничения одноузлового режима

Встроенный MinIO запускается в standalone-режиме, а PostgreSQL и Redis имеют по
одному экземпляру. Для production с требованиями высокой доступности используйте
управляемые PostgreSQL/Redis/S3 либо отдельные отказоустойчивые кластеры, сохранив
те же переменные окружения приложения.
