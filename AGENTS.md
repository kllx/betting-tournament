# AGENTS.md

## Стек

TypeScript, Node.js 22, NestJS, TypeORM, PostgreSQL, RabbitMQ через `amqplib`, Redis через `ioredis`, Jest.

## Команды

```bash
npm ci
docker compose up -d
npm run start:dev
npm test
npm run test:e2e
npm run lint
npm run build
```

Integration-тесты требуют PostgreSQL, RabbitMQ и Redis из Docker Compose. Они используют `betting_tournament_test` либо `TEST_DATABASE_URL` с обязательным суффиксом `_test`.

## Архитектура

- `src/bets/bet-processing.service.ts` содержит транзакционные правила ставок, временные cutoff, inbox и score outbox.
- `src/bets/rabbitmq.consumer.ts` отвечает за quorum topology, отложенные retry, DLQ и ack.
- `src/tournament/tournament.service.ts` атомарно создает snapshot победителей, выплаты и payout outbox.
- `src/payouts` содержит идемпотентное подтверждение выплат и завершение турнира.
- `src/outbox` публикует committed события с confirms и `SKIP LOCKED` для конкурентных workers.
- `src/leaderboard` содержит Redis-проекцию, ее восстановление и HTTP API. PostgreSQL является источником истины.
- `src/database/migrations` является источником схемы. `synchronize` должен оставаться отключенным.

## Инварианты

- `bet.settled` принимается до `settlement_cutoff_at`, `bet.rollback` только до `ends_at`.
- Финализация и выплаты идемпотентны. Нельзя создавать денежную операцию вне транзакции с ее outbox-записью.
- События используют `FOR SHARE` на состоянии турнира, финализация использует `FOR UPDATE`. Нельзя заменять это незащищенной проверкой фазы.
- При равных очках порядок: `points_reached_at ASC`, затем `player_id DESC`. Первое правило является бизнес-требованием.
- Отмена вычитает сохраненные очки ставки, а не пересчет по текущему курсу.
- Redis не является источником истины. Более старая `scoreVersion` не должна перезаписывать новую.
- Повторная доставка выплаты не увеличивает `attempts`. Турнир завершается только после всех выплат.

## Правила изменений

- Для нового поведения сначала добавляй тест и проверяй ожидаемое падение, затем реализацию.
- Изменения схемы выполняй новой миграцией и синхронизируй сущности с ней.
- Не используй рабочую базу в тестах и не удаляй данные вне базы с суффиксом `_test`.
- Для гонок проверяй реальные конкурентные вызовы на PostgreSQL, а не только последовательные mocks.
- После изменения запускай `npm test`, `npm run test:e2e`, `npm run lint` и `npm run build`.
- Обновляй `README.md` и `DECISIONS.md`, если меняются внешний контракт, временные или бизнес-правила.

## Безопасность

- Внешние ставки принимай только с валидной HMAC-подписью домена `bet-event-v1`, внутренние payout и score события только с `internal-event-v1`.
- Не заменяй проверку подписи одной проверкой RabbitMQ credentials. Payload подписывается побайтово вместе с routing key и event ID.
- Нельзя игнорировать конфликт payload как обычный дубликат. `EventPayloadConflictError` и `BetPayloadConflictError` должны идти в DLQ без изменения исходной записи.
- Идемпотентность должна срабатывать и для нового `eventId` у того же `betId`.
- Не логируй payload, подписи, admin token или секреты. ValidationError может содержать только поле и нарушенное правило.
- Сохраняй ограничения размера сообщения и диапазона сумм. Крупный выигрыш не отклоняется, а создает risk metric. Баланс ограничивается атомарно фактически начисленным остатком, `bets.points` хранит его для корректного rollback. Порядок блокировок всегда `bets -> players`.
- Не отключай rate limit при ошибке Redis. Guard должен оставаться fail-closed.
- Production-секреты нельзя заменять локальными defaults. Для reverse proxy корректно настраивай `TRUST_PROXY`.
- Новые abuse-сценарии проверяй через реальные RabbitMQ и PostgreSQL: неподписанный settle, forged payout, конфликтный eventId, конфликтный rollback и повтор с новым eventId.

## Стандарты реализации

- Общие числовые лимиты находятся в `src/config/limits.ts`. Не дублируй их в DTO, SQL, consumers и scoring. Все env-числа читаются через strict typed readers в `configuration.ts`.
- Денежные суммы, FX-конвертация, сравнение и округление выполняй только через `src/money` на BigInt со шкалой 18. Не используй `number` или floating-point библиотеки для денежной арифметики. Decimal-строки допустимы на границах JSON и PostgreSQL.
- `src/messaging/signed-internal.consumer.ts` является общей реализацией HMAC, ack/nack, retry, DLQ и drain для внутренних consumers. Не копируй эту логику в новые consumers.
- `src/messaging/publish-mandatory.ts` обязателен для publishers. Нельзя считать сообщение доставленным только по confirm: unroutable сообщение должно завершаться ошибкой.
- `src/contracts/http.ts` содержит имена headers, `src/messaging/contracts.ts` routing keys и домены событий.
- `src/observability` содержит Prometheus metrics, JSON logger и health endpoints. Не добавляй playerId, betId или другие high-cardinality значения в labels и не логируй payload.
- `import type` для injectable классов запрещен, поскольку Nest теряет runtime metadata. Проверка выполняется через ESLint и TypeScript no-emit.
- Миграции имеют человекочитаемые имена классов. Их старые migration IDs сохранены для совместимости с уже примененными записями TypeORM.
- Для production используй `npm run migration:run` отдельной job. `DATABASE_MIGRATIONS_RUN=false` отключает миграции на API pods.
- `app.enableShutdownHooks()` обязателен. Новый async worker должен отменять прием работы, ожидать pending и только затем закрывать соединения.
- Для проверок используй `npm run check` в дополнение к тестам. Стоимость fingerprints измеряй через `npm run benchmark:fingerprint`, а не предположения.

## Дополнительные инфраструктурные правила

- Публикацию outbox выполняй через `runWithConcurrency` с `OUTBOX_PUBLISH_CONCURRENCY`, не создавая неограниченное число параллельных запросов к брокеру.
- Длительный rebuild обязан продлевать `ReconciliationLock`. Освобождение lock только по token владельца, продление останавливается перед release.
- Shutdown ограничен `SHUTDOWN_GRACE_PERIOD_MS`. Новые HTTP requests получают `Connection: close`, оставшиеся сокеты закрываются после grace period. Readiness во время shutdown возвращает 503.
- Публикации в RabbitMQ измеряются через `rabbitmq_publish_duration_ms` с результатом `SUCCESS` или `ERROR`. Не добавляй destination-specific ID в labels.

## Надежность восстановления

- Повторная выплата обязана запускать проверку завершения турнира даже если она уже `PAID`. Нельзя возвращаться из `markPaid` только по признаку дубликата.
- Backfill использует исходный `settledAt` из `bet_events`, не нормализованный `timestamptz`.
- Concurrency дожидается `allSettled`, outbox параллелит только сетевые публикации, SQL-запросы выполняются последовательно на одном query runner.
- Redis pipeline проверяет каждый `[error, result]`. Нельзя продвигать `last-outbox-id` после ошибки batch.
- RabbitMQ `error` обрабатывается, reconnect выполняется с `RABBITMQ_RECONNECT_DELAY_MS`.
- Worker drain ограничен `SHUTDOWN_WORKER_DRAIN_TIMEOUT_MS` и использует общий `waitForDrain`.

## Нагрузочные проверки

- Команды и актуальные результаты находятся в `load/README.md`.
- Не заявляй production capacity по unit/integration тестам или короткому прогону на одном Docker Desktop.
- Для `load:bet-events` используй только БД с суффиксом `_test`, скрипт полностью очищает ее.
- При анализе отделяй RPS публикации от RPS обработки, dropped iterations k6 от реальных ошибок приложения и p50 от p95/p99.
- После изменений hot path повторяй settle, read и смешанный профиль, сравнивая не только latency, но и lag outbox и остаток событий.

## Retention и партиции

- `bet_events` партиционирован по `received_at`. Активный dedup registry `bet_event_ids` перемещается в `bet_event_ids_archive` по `received_at, event_id`. Archive удаляется после `BET_EVENT_IDS_ARCHIVE_RETENTION_DAYS`. Первый SQL запрос ставки проверяет обе таблицы атомарно, поэтому архивные повторы не начисляют очки повторно.
- Все обновления и чтения `bet_events` в hot path используют `received_at` из registry для partition pruning.
- `StorageRetentionService` создает текущую и следующую дневные партиции, удаляет старые `PUBLISHED` outbox пакетами и не удаляет `NEW` или `FAILED`. DDL всех экземпляров сериализуется через `pg_advisory_xact_lock`.
- Redis reconcile продвигает `last-outbox-id` только после успешного batch и пишет Redis после commit DB-транзакции. Full rebuild использует `REPEATABLE READ READ ONLY`, staging keys с token владельца и атомарную проверку token при swap. Только swap устанавливает readiness marker. При его отсутствии API использует PostgreSQL, а periodic worker делает rebuild.
- Publisher confirm ограничен `RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS`. По таймауту канал закрывается для reconnect, повторная публикация остается идемпотентной.
- Фаза турнира кэшируется в Redis с монотонной версией. `tournament.phase.changed` записывается в той же транзакции, что и snapshot. `ACTIVE` истекает через `LEADERBOARD_ACTIVE_PHASE_TTL_MS`, `PAYING` и `PAID` сохраняются. Поздняя запись `ACTIVE` не должна откатывать финальную фазу.
- Партиционирование большой inbox-таблицы выполняется пакетным backfill с replication trigger и коротким cutover. Изменения индексов используют `CONCURRENTLY`, TypeORM настроен с `migrationsTransactionMode: "each"`.
- Любой вход в `LeaderboardProjection.apply` валидирует очки, timestamps и `scoreVersion`, включая recovery из outbox.
- PostgreSQL fallback использует один ranking statement и отдельный distributed limit. При исчерпании или недоступности limiter возвращается 503 до ranking SQL.

## Rollout

- Старые pods нельзя запускать после партиционирования `bet_events`: они используют несовместимый `ON CONFLICT (event_id)`.
- Blue-green выполняется через `BET_EVENTS_DEFER_CUTOVER=true npm run migration:run`, остановку старой версии и последующий `npm run migration:cutover`.
- Cutover разрешен только при `bet_event_migration_state.completed = true`. Процедура и rollback описаны в `ROLLOUT.md`.
