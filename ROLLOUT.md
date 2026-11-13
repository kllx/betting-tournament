# Blue-green rollout партиционирования

## Правило совместимости

Старые pods используют `ON CONFLICT (event_id)` и несовместимы с партиционированной `bet_events`. После cutover их нельзя оставлять в работе. Backfill идет без остановки записи, но перед rename старая версия полностью останавливается.

## Этап 1: backfill без cutover

На операционном экземпляре:

```bash
BET_EVENTS_DEFER_CUTOVER=true npm run migration:run
```

Старые pods продолжают обслуживать трафик. Миграция создает `bet_event_ids`, целевую `bet_events_new`, replication trigger и копирует историю пакетами по 10000 событий. Новые INSERT, UPDATE и DELETE реплицируются автоматически. Score revisions используют пакетный backfill игроков и `CREATE INDEX CONCURRENTLY`, поэтому длительная остановка записи не требуется.

Проверить завершение backfill:

```sql
SELECT id, event_id, completed
FROM bet_event_migration_state
WHERE id = 1;
```

Ожидается `completed = true`. Отсутствие записи означает, что backfill еще не готов к cutover. `migration:show` при этом уже может показывать миграцию как примененную, поэтому readiness проверяется только по этой таблице.

## Этап 2: остановка старой версии

1. Убрать старые pods из балансировщика.
2. Дождаться завершения in-flight событий и outbox.
3. Установить replicas старой версии в 0.
4. Не запускать их повторно до окончания rollout.

## Этап 3: cutover

```bash
npm run migration:cutover
```

Команда откажется работать, если backfill не отмечен как завершенный. Rename старой и новой таблиц выполняется в одной транзакции с короткой `ACCESS EXCLUSIVE` блокировкой.

## Этап 4: запуск новой версии

На новых pods:

```bash
DATABASE_MIGRATIONS_RUN=false npm start
```

Проверить readiness, выполнить settle/rollback/duplicate smoke и убедиться, что `bet_events` партиционирована. Только после этого включить новые pods в балансировщик.

## Rollback

До cutover достаточно остановить rollout, удалить replication trigger и служебные таблицы после проверки отсутствия активной новой версии. Основная `bet_events` остается на месте.

После cutover rollback выполняется из резервной копии или через отдельно подготовленную обратную миграцию с учетом новых записей. Нельзя просто запустить старый код поверх партиционированной таблицы.

## Локальный запуск без blue-green

Если остановка записи допустима, отдельная команда не требуется:

```bash
npm run migration:run
```

Backfill и cutover выполняются последовательно в рамках одной миграционной job.
