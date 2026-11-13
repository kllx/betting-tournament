# Нагрузочные тесты

## Профили

- `scripts/load-bet-events.ts`: публикация уникальных подписанных `bet.settled` по миллиону игроков. Измеряет RPS публикации и фактической обработки, latency и остаток необработанных событий.
- `load/k6/leaderboard.js`: 5000 HTTP read RPS на `GET /leaderboard` с проверкой статуса и существования игрока.
- Смешанный профиль запускает оба сценария одновременно.

Тестовая база обязана заканчиваться на `_test`. Скрипт полностью очищает ее перед заполнением, поэтому нельзя запускать его на рабочей базе.

## Запуск приложения

```bash
npm ci
docker compose up -d
npm run build
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/betting_tournament_load_test \
REDIS_URL=redis://localhost:56379/7 \
RABBITMQ_EXCHANGE=load.test \
RABBITMQ_QUEUE=load.queue \
RABBITMQ_PREFETCH=500 \
OUTBOX_BATCH_SIZE=1000 \
OUTBOX_POLL_INTERVAL_MS=50 \
OUTBOX_PUBLISH_CONCURRENCY=50 \
RATE_LIMIT_LEADERBOARD_MAX_REQUESTS=1000000 \
EVENT_SIGNING_SECRET=test-external-event-signing-secret-32 \
TOURNAMENT_END_AT=2099-12-31T23:59:59.000Z \
node dist/src/main.js
```

В другом терминале:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/betting_tournament_load_test \
RABBITMQ_EXCHANGE=load.test \
RABBITMQ_URL=amqp://guest:guest@localhost:5672 \
EVENT_SIGNING_SECRET=test-external-event-signing-secret-32 \
npm run load:bet-events -- --rate 5000 --duration 10 --players 1000000
```

Для read-стресса:

```bash
npm run load:leaderboard
```

Для смешанного сценария запустите `load:bet-events` в фоне, а `load:leaderboard` через 2 секунды в основном терминале.

Дополнительные параметры `load:bet-events`: `--rate`, `--duration`, `--players`, `--batch-size`, `--drain-timeout`. Token bucket ограничивает реальный входной RPS и burst размером batch. Стенд завершается только при фактическом `processed === target` и отсутствии `ignored`/`duplicate`. Иначе возвращается ненулевой exit code.

## Измеренные RPS текущей версии

Все результаты получены локально на Docker Desktop и не являются production capacity.

### Один экземпляр

| Профиль | Фактический результат | Дополнительные данные |
|---|---|---|
| Publish ставок | 4738 RPS | p99 publish 27.64 мс |
| Обработка settle с учетом drain | 855 RPS | 50000/50000 обработано, остаток 0 |
| Read | 3710 RPS | p95 162 мс, 44555 запросов |

На read-прогоне было 0.74% `connection refused` и 5447 dropped iterations. Поэтому 3710 RPS является фактическим результатом предельного локального прогона с ошибками соединения, а не гарантированным стабильным уровнем.

### Пять экземпляров

| Профиль | Фактический результат | Дополнительные данные |
|---|---|---|
| Publish ставок | 2252 RPS | p99 publish 123.05 мс |
| Обработка settle с учетом drain | 1051 RPS | 50000/50000 обработано, остаток 0 |
| Read | 4459 RPS | p95 232 мс, HTTP errors 0, checks 100% |

Пять Node.js processes работали на портах 3101-3105 с общими PostgreSQL, Redis и RabbitMQ и round-robin endpoint на 3100. Во время read-прогона k6 отбросил 5304 итерации из-за latency.

Подробный разбор SQL, locks, RabbitMQ, Redis и CPU находится в `load/PROFILING.md`.

## Выводы

- Обработка ставок ограничивается PostgreSQL, блокировками и подтверждениями RabbitMQ, а не fingerprints.
- Увеличение числа экземпляров на одной машине не дает линейного роста из-за общих stateful-ресурсов.
- Для следующего анализа полезны длительный soak, горячий игрок и сравнение lock wait и IO на целевой инфраструктуре.
