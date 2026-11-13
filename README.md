# Турнир на ставках

Сервис на NestJS, PostgreSQL, RabbitMQ и Redis. Он начисляет турнирные очки по событиям ставок, строит рейтинг, фиксирует победителей и выполняет идемпотентные выплаты.

## Правила турнира

Используется один турнир. Его время окончания задается через `TOURNAMENT_END_AT`.

- До окончания обрабатываются `bet.settled` и `bet.rollback`.
- После окончания `bet.rollback` игнорируется и не меняет результат.
- `bet.settled` принимается еще 10 минут после окончания. Это окно для событий, уже идущих через инфраструктуру.
- Через 15 минут после окончания создается окончательный снимок победителей и запускаются выплаты.
- Время принятия события определяется часами PostgreSQL, а не значением `settledAt` из сообщения.
- Очки: `floor(winAmount * FX_RATES[currency])`. Денежные значения и курсы вычисляются модулем `src/money` на BigInt с фиксированной шкалой 18 знаков, без binary floating point.
- При равных очках выше игрок, раньше достигший текущего результата. Это бизнес-правило описано в `DECISIONS.md`.

Состояния: `ACTIVE -> PAYING -> PAID`. Если призовых игроков нет, турнир сразу становится `PAID`.

## Гарантии обработки

- `betId` уникален в PostgreSQL. Повторный расчет и повторная отмена не меняют результат дважды.
- Входящие события сохраняются в партиционированных `bet_events` со статусами `processed`, `duplicate`, `ignored` и причиной отклонения. Глобальный `bet_event_ids` сохраняет fingerprint для проверки повторов после удаления старого payload.
- Изменение ставки, очков, inbox и записи в outbox выполняется в одной транзакции.
- Финализация использует `FOR UPDATE`, обработчики событий используют `FOR SHARE`. Обычные события выполняются параллельно, а финализация ждет уже выполняющиеся транзакции.
- Победители, выплаты и события `payout.requested` создаются атомарно. Повторная финализация ничего не дублирует.
- RabbitMQ работает в режиме at-least-once. Итоговая идемпотентность обеспечивается PostgreSQL и idempotency key выплаты, а не обещанием exactly-once от брокера.
- Для временных ошибок событий ставок используются отложенные повторы через TTL. После `RABBITMQ_MAX_RETRIES` сообщение попадает в DLQ.
- Основные очереди имеют тип quorum. Публикации outbox используют publisher confirms.

## Рейтинг при высокой нагрузке

PostgreSQL остается источником истины. Для чтения активного турнира используется Redis Sorted Set:

- топ-100 читается за `O(log N + 100)`;
- позиция произвольного игрока читается за `O(log N)` без ранжирования всей таблицы PostgreSQL;
- обновления поступают через transactional outbox и отдельный RabbitMQ consumer;
- монотонная `scoreVersion` отбрасывает устаревшие сообщения, а `points_reached_at` определяет бизнес-порядок при равных очках;
- полный rebuild использует `REPEATABLE READ READ ONLY`, staging keys и атомарное переключение. Только успешный swap устанавливает readiness marker. При его отсутствии API использует PostgreSQL, а periodic worker перестраивает проекцию;
- фаза кэшируется в Redis с монотонной версией и обновляется через outbox. `ACTIVE` имеет TTL `LEADERBOARD_ACTIVE_PHASE_TTL_MS`, поэтому потерянное phase-событие не оставляет активный рейтинг навсегда;
- после доставки `tournament.phase.changed` чтение выполняется из неизменяемых данных PostgreSQL, поэтому отставание score-проекции не влияет на итог;
- при ошибке Redis активный рейтинг временно читается из PostgreSQL одним snapshot-запросом с отдельным распределенным ограничением нагрузки.

В нормальном режиме проекция обновляется почти в реальном времени. При потере phase-события `ACTIVE` перечитывается из PostgreSQL через `LEADERBOARD_ACTIVE_PHASE_TTL_MS`.

## Выплаты

`TOURNAMENT_PRIZES` задает призы в USD по местам. Например, `[1000,500,250]` означает выплаты за первые три места. Игроки с нулевыми очками не получают призовых мест. В `payout.requested` поле `amount` передается canonical decimal-строкой, чтобы consumer не терял точность при повторном JSON.parse.

Выплата имеет уникальный `idempotency_key` и статусы `PENDING`, `PAID`, `FAILED`. Текущий consumer моделирует успешный внешний кошелек и подтверждает выплату в PostgreSQL. Для реального провайдера его нужно заменить адаптером, сохранив тот же idempotency key и обработку неизвестного результата через сверку.

Турнир переходит в `PAID` только после всех выплат. Короткая блокировка состояния сериализует только завершение призовых операций и исключает гонку двух последних выплат.

## Запуск

Требуются Node.js 22, npm 10 и Docker Compose. Диапазоны версий зафиксированы в `engines` в `package.json`.

```bash
npm ci
cp .env.example .env
docker compose up -d
npm run start:dev
```

Миграции применяются автоматически. HTTP API доступен на `http://localhost:3000`, RabbitMQ Management на `http://localhost:15672` с логином и паролем `guest`.

PostgreSQL опубликован на `55432`, Redis на `56379`, чтобы не пересекаться с локальными установками.

## Публикация события

```bash
npm run producer -- bet.settled '{"betId":"bet-1","playerId":"player-1","currency":"EUR","stake":10,"winAmount":25.5,"settledAt":"2026-11-12T10:00:00.000Z"}'
curl -H 'X-Player-Id: player-1' http://localhost:3000/leaderboard
```

При курсе 1 EUR = 1.1 USD игрок получит 28 очков. Для отмены до окончания турнира используется тот же payload с routing key `bet.rollback`:

```bash
npm run producer -- bet.rollback '{"betId":"bet-1","playerId":"player-1","currency":"EUR","stake":10,"winAmount":25.5,"settledAt":"2026-11-12T10:00:00.000Z"}'
curl -H 'X-Player-Id: player-1' http://localhost:3000/leaderboard
```

## API

### `GET /leaderboard`

Требуется `X-Player-Id`.

```json
{
  "top": [
    { "rank": 1, "playerId": "player-2", "points": 100 },
    { "rank": 2, "playerId": "player-1", "points": 28 }
  ],
  "player": { "rank": 2, "playerId": "player-1", "points": 28 }
}
```

`player` равен `null`, если игрока нет. Пустой заголовок возвращает HTTP 400.

### `POST /admin/tournament/finalize`

Требуется `X-Admin-Token`. Запускает ту же идемпотентную финализацию, что и планировщик. До наступления `finalize_at` возвращает `{ "finalized": false, "phase": "ACTIVE" }`.

```bash
curl -X POST -H 'X-Admin-Token: local-admin-token' \
  http://localhost:3000/admin/tournament/finalize
```

## Конфигурация

Все настройки находятся в `.env.example`.

- `TOURNAMENT_SETTLEMENT_GRACE_MS`: окно приема settle, по умолчанию 600000 мс.
- `TOURNAMENT_FINALIZE_AFTER_MS`: финализация после окончания, по умолчанию 900000 мс.
- `TOURNAMENT_PRIZES`: JSON-массив призов в USD.
- `RABBITMQ_RETRY_TTL_MS`: задержка повторной обработки.
- `RABBITMQ_MAX_RETRIES`: число отложенных повторов перед DLQ.
- `MAX_WIN_AMOUNT_USD`: порог `LARGE_WIN` risk signal, не ограничение начисления очков.
- `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`: пакет и период outbox relay.
- `OUTBOX_MAX_ATTEMPTS`: максимальное число попыток публикации записи до `FAILED`.
- `LEADERBOARD_READY_WAIT_MS`: ожидание readiness проекции другим владельцем rebuild.
- `OUTBOX_RETENTION_DAYS`, `BET_EVENTS_RETENTION_DAYS`: срок хранения опубликованного outbox и партиций inbox.
- `BET_EVENT_IDS_RETENTION_DAYS`: срок хранения dedup ID в активном индексе перед перемещением в archive.
- `BET_EVENT_IDS_ARCHIVE_RETENTION_DAYS`: срок хранения dedup ID в archive перед удалением.
- `RABBITMQ_PUBLISH_CONFIRM_TIMEOUT_MS`: максимальное ожидание publisher confirm перед закрытием канала.
- `LEADERBOARD_ACTIVE_PHASE_TTL_MS`: TTL активной фазы перед повторным чтением PostgreSQL.
- `RETENTION_BATCH_SIZE`, `RETENTION_CLEANUP_INTERVAL_MS`: пакетная очистка и период retention worker.
- `RATE_LIMIT_POSTGRES_FALLBACK_MAX_REQUESTS`: предельное число fallback-запросов в окно `RATE_LIMIT_POSTGRES_FALLBACK_WINDOW_MS`.
- `LEADERBOARD_RECONCILE_INTERVAL_MS`: период сверки Redis с PostgreSQL.
- `FX_RATES`: JSON-объект USD-курсов. `{"EUR":1.1}` означает 1 EUR = 1.1 USD.

Курс применяется при первом расчете ставки. Отмена вычитает сохраненные очки, а не значение по новому курсу.

## Проверки

```bash
docker compose up -d
npm test
npm run test:e2e
npm run lint
npm run build
```

Тесты используют отдельную базу `betting_tournament_test`, отдельные Redis DB и изолированные RabbitMQ exchange и очереди. `TEST_DATABASE_URL` обязан указывать на базу с суффиксом `_test`.

Покрыты конкурентные settle и rollback, опережающая отмена, временные cutoff, гонка события с финализацией, повторная финализация, гонка завершения выплат, повторная доставка payout, ошибка outbox, retry и DLQ, устаревшие Redis-события и восстановление проекции.

## Production

Docker Compose предназначен только для разработки. Для реального контура нужны:

- несколько stateless экземпляров API и consumers с readiness/liveness probes и graceful shutdown;
- RabbitMQ-кластер минимум из трех узлов, quorum queues, мониторинг DLQ и дисков;
- PostgreSQL HA с синхронной репликой для критичных записей, PgBouncer, резервное копирование и проверенный restore;
- Redis Sentinel или Cluster с AOF. Redis является перестраиваемой проекцией, а не источником истины;
- отдельная миграционная job перед rolling deploy вместо одновременных миграций на всех pods;
- ограничение размеров пулов БД, backpressure через prefetch и алерты по lag и глубине очередей;
- мониторинг retention для партиционированного inbox и outbox, архивация и проверка восстановления;
- нагрузочный стенд с профилем реальных игроков и отдельным тестом горячего игрока.

Конкретный RPS нельзя гарантировать без измерения на целевой инфраструктуре. Горячий игрок упирается в последовательное обновление одной строки PostgreSQL, поэтому его профиль нагрузки должен проверяться отдельно.

## Локальные измерения RPS

В локальном замере `init`-версии один экземпляр приложения на Docker Desktop показал:

- **4738 RPS** publish ставок, p99 27.64 мс;
- **855 RPS** фактической обработки settle с учетом drain, все 50000 событий обработаны;
- **3710 RPS** read, p95 162 мс. На этом предельном read-прогоне было 0.74% `connection refused`, поэтому значение не является гарантированным стабильным уровнем.

Это фактические локальные замеры, а не production capacity. Команды стенда и результаты пяти экземпляров находятся в `load/README.md`, анализ hotspots в `load/PROFILING.md`.

Принятые решения и ограничения описаны в `DECISIONS.md`. Двухфазный blue-green rollout с отложенным cutover описан в `ROLLOUT.md`.

## Безопасность и защита от abuse

### Подписи событий

Внешние `bet.settled` и `bet.rollback` принимаются только с headers:

- `x-event-id`: уникальный идентификатор сообщения;
- `x-signature`: HMAC-SHA256 от домена, routing key, event ID и точного тела сообщения.

CLI-продюсер создает UUID и подпись автоматически через `EVENT_SIGNING_SECRET`. Изменение payload, повторное использование event ID с другим payload или подпись другого домена приводит к DLQ. Повтор с неизменным event ID и payload остается безопасным дубликатом.

Outbox подписывает `payout.requested` и `player.score.changed` отдельным `INTERNAL_EVENT_SIGNING_SECRET`. Поэтому издатель с доступом только к внешнему ключу не может подтвердить выплату или изменить Redis-проекцию.

HMAC является дополнительной проверкой целостности, а не заменой RabbitMQ ACL, отдельных vhosts, TLS и сетевой изоляции. Ключ внешней подписи должен быть только у доверенной betting-системы. Владелец ключа может подписать событие для любого игрока, поэтому для независимых продюсеров нужны отдельные ключи и авторизация на уровне источника.

### Конфликтные дубликаты и границы

- Одинаковый `betId` с другим `playerId`, `winAmount`, `stake`, `currency` или `settledAt` отклоняется как `Bet payload conflict`.
- Одинаковый `eventId` с другим payload отклоняется как `Event payload conflict`.
- Идентичная ставка с новым `eventId` не начисляет очки повторно.
- Конфликтный rollback откатывается транзакционно и не меняет чужие очки.
- `MAX_WIN_AMOUNT_USD` задает порог risk signal для крупного выигрыша, а не отказ в начислении очков. Такие события обрабатываются и учитываются в `bet_risk_signals_total{kind="LARGE_WIN"}`.
- Баланс игрока ограничен 2 млрд очков. Выше остатка очки не начисляются, в `bets.points` сохраняется фактический остаток для корректного rollback, а `SCORE_CAP` записывается в risk metrics.
- `MAX_EVENT_BYTES` ограничивает размер внешнего сообщения.
- `stake` и `winAmount` ограничены, ID допускают только безопасный набор символов без управляющих последовательностей.
- Validation-ошибки содержат только имя поля и нарушенное правило, но не payload.

### HTTP и секреты

Admin token сравнивается через `timingSafeEqual`. В production локальные секреты запрещены: `ADMIN_API_TOKEN`, `EVENT_SIGNING_SECRET` и `INTERNAL_EVENT_SIGNING_SECRET` обязаны быть заданы явно и иметь не менее 32 символов.

Leaderboard и admin API имеют распределенный fixed-window rate limit по IP через Redis. Превышение возвращает 429, недоступность rate limiter возвращает 503 без обхода защиты. Для работы по реальному IP за reverse proxy настройте `TRUST_PROXY` строго под свою схему балансировки. Неправильное доверие произвольным proxy позволяет подделать `X-Forwarded-For`.

Локальные значения из `.env.example` предназначены только для разработки. Доступ к DLQ и данным RabbitMQ должен быть ограничен, поскольку DLQ содержит исходные бизнес-события.

Для бесшовной ротации ключей без отклонения уже находящихся в очереди сообщений потребуется список активных ключей с `keyId`. Текущая версия поддерживает одну внешнюю и одну внутреннюю пару ключей, поэтому ротацию следует выполнять координированно после дренажа очередей.

### Deploy topology и broker credentials

RabbitMQ запрещает изменять аргументы существующей очереди. Добавление DLX, TTL или смена типа queue требует остановить издателей, дождаться обработки сообщений, перенести оставшиеся в безопасное временное хранилище и пересоздать topology. Простой rolling restart с новыми аргументами завершится `PRECONDITION_FAILED`.

Production не запускается с `guest:guest` в `RABBITMQ_URL`. Для внешнего продюсера, consumers и административного интерфейса RabbitMQ нужны разные учетные записи с минимально необходимыми правами.

## Наблюдаемость и эксплуатационные стандарты

### Metrics и health

- `GET /metrics` возвращает Prometheus-метрики процесса, ставок, fingerprints, outbox, выплат и HTTP.
- `GET /health/live` проверяет только работающий процесс.
- `GET /health/ready` проверяет PostgreSQL и Redis.
- Метрики не содержат playerId, betId и других high-cardinality labels.
- Nest и доменные логи выводятся в JSON без payload, подписей и секретов.

### Проверки кода

```bash
npm run check
npm run benchmark:fingerprint
```

`check` запускает ESLint и TypeScript no-emit. Для injectable классов используются value imports, поскольку Nest теряет runtime metadata при type-only импорте.

На текущей машине benchmark обоих fingerprints для одной ставки занял около 1.7 мкс на 100000 итераций. Это не измерение production RPS, но оно показывает, что SHA256 не является узким местом по сравнению с PostgreSQL, брокером и сетевыми вызовами. Основные затраты hot path находятся в SQL и доставке.

### Миграции и shutdown

Миграции имеют понятные имена классов и сохраняют исходные IDs в таблице TypeORM. Для production используется отдельная `npm run migration:run`, а на API pods `DATABASE_MIGRATIONS_RUN=false`. Индексы больших таблиц изменяются через `CONCURRENTLY`. Партиционирование inbox выполняется пакетным backfill с replication trigger и коротким атомарным cutover, без длительной остановки записи.

`app.enableShutdownHooks()` включен. Consumers прекращают прием сообщений, дожидаются активных handlers, outbox scheduler ждет flush перед закрытием publisher, а финализация и reconciliation завершают текущую работу перед остановкой.

### Дополнительные настройки нагрузки и shutdown

`OUTBOX_PUBLISH_CONCURRENCY` ограничивает параллельные публикации одного outbox-пакета, чтобы не создавать волну соединений и confirms. Для RabbitMQ доступна метрика `rabbitmq_publish_duration_ms` с latency и результатом публикации.

`ReconciliationLock` продлевается каждые 10 секунд через compare-and-expire по token владельца. При потере владения renewal и последующие batch-операции останавливаются. Rebuild использует уникальные staging keys, а swap Lua повторно проверяет token атомарно перед заменой live projection. Retention DDL сериализуется между экземплярами через PostgreSQL advisory lock, поэтому workers безопасны при нескольких подах.

`SHUTDOWN_GRACE_PERIOD_MS` ограничивает ожидание HTTP keep-alive соединений. После этого срока сокеты закрываются принудительно. `SHUTDOWN_CONNECTION_CHECK_INTERVAL_MS` управляет периодом проверки. Во время завершения readiness возвращает 503, чтобы orchestrator прекратил направлять трафик на pod.

### Надежность восстановления и worker lifecycle

Повторная доставка уже оплаченной записи также проверяет завершение турнира. Это закрывает сбой между `UPDATE payouts` и `UPDATE tournament_state`. Backfill fingerprints использует исходный `settledAt` из `bet_events`, поэтому timezone offset не меняет идемпотентность legacy-ставки.

`runWithConcurrency` дожидается всех задач через `allSettled` и только затем возвращает первую ошибку. Публикации outbox выполняются параллельно, а обновления БД последовательно, без concurrent queries на одном клиенте PostgreSQL.

Redis pipeline проверяет ошибку каждой команды. `last-outbox-id` не продвигается после неуспешного batch. RabbitMQ consumers и publisher обрабатывают `error` и переподключаются с задержкой `RABBITMQ_RECONNECT_DELAY_MS`. Workers используют `SHUTDOWN_WORKER_DRAIN_TIMEOUT_MS` для ограничения ожидания перед закрытием соединений.
