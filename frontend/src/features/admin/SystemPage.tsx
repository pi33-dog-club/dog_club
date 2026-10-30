import { formatDateTime } from '../../shared/format';
import { Card, Chip, Fact, Facts, Loading, PageHeader, QueryError, Table, tableStyles } from '../../shared/ui';
import { useMetrics } from './adminApi';
import styles from './admin.module.css';

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days} д ${hours} ч` : hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

const ms = (seconds: number) => `${Math.round(seconds * 1000)} мс`;

/** Aggregated process metrics; refreshed every 30 seconds while the page is open. */
export function SystemPage() {
  const metrics = useMetrics();
  if (metrics.isPending) return <Loading label="Загружаем метрики…" />;
  if (metrics.isError) return <QueryError error={metrics.error} onRetry={() => void metrics.refetch()} />;
  const { database: db, notifications: mail, http } = metrics.data;
  const routes = [...http].sort((a, b) => b.requests - a.requests);
  const lastCycle = mail.last_successful_cycle_unix > 0 ? formatDateTime(new Date(mail.last_successful_cycle_unix * 1000).toISOString()) : 'ещё не было';

  return (
    <>
      <PageHeader eyebrow="Администратор" title="Состояние системы" />
      <Facts>
        <Fact label="Работает" value={uptime(metrics.data.uptime_seconds)} note={`обновлено ${formatDateTime(new Date(metrics.dataUpdatedAt).toISOString())}`} />
        <Fact label="Соединения БД" value={`${db.acquired_connections} из ${db.max_connections}`} note={`свободно ${db.idle_connections}, всего ${db.total_connections}`} />
        <Fact
          label="Ожидание соединения"
          value={db.acquire_count > 0 ? ms(db.acquire_duration_seconds / db.acquire_count) : '—'}
          note={`отменено ожиданий: ${db.canceled_acquire_count}`}
        />
        <Fact
          label="Письма"
          value={metrics.data.notifications_enabled ? <Chip tone="lime">Включены</Chip> : <Chip tone="dashed">Выключены</Chip>}
          note={`в очереди ${mail.pending}, отправляется ${mail.sending}`}
        />
      </Facts>
      <Card heading="Очередь писем">
        <div className={styles.metrics}>
          <Facts>
            <Fact label="Отправлено" value={mail.sent} />
            <Fact label="Подавлено" value={mail.suppressed} note="получатель больше не подходит" />
            <Fact label="Последний цикл" value={lastCycle} />
          </Facts>
        </div>
      </Card>
      <Card heading="Запросы к серверу">
        <Table caption="Запросы по маршрутам">
          <thead>
            <tr>
              <th scope="col">Маршрут</th>
              <th scope="col">Запросов</th>
              <th scope="col">Отклонено</th>
              <th scope="col">Сбоев сервера</th>
              <th scope="col">Среднее</th>
              <th scope="col">Максимум</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={`${route.method} ${route.route}`}>
                <td className={tableStyles.nowrap}>
                  <code>
                    {route.method} {route.route}
                  </code>
                </td>
                <td>{route.requests}</td>
                <td>{route.client_errors}</td>
                <td>{route.server_errors > 0 ? <Chip tone="pink">{route.server_errors}</Chip> : 0}</td>
                <td className={tableStyles.nowrap}>{route.requests > 0 ? ms(route.duration_seconds / route.requests) : '—'}</td>
                <td className={tableStyles.nowrap}>{ms(route.max_duration_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className={styles.note}>Счётчики накоплены с запуска сервера; персональных данных и параметров запросов в метриках нет.</p>
      </Card>
    </>
  );
}
