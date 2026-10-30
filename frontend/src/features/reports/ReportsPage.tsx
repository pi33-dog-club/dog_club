import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, call } from '../../api/client';
import { downloadFile } from '../../api/files';
import { roleLabels } from '../../app/navigation';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, formatDateTime, todayUTC } from '../../shared/format';
import { Button, Card, Fact, Facts, Loading, PageHeader, ProblemAlert, QueryError, Table, TextField, fieldStyles, reportInvalid } from '../../shared/ui';
import styles from './reports.module.css';

export interface Period {
  from: string;
  to: string;
}

export function useReport(period: Period | null) {
  return useQuery({
    queryKey: ['reports', 'club-activity', period],
    enabled: period !== null,
    queryFn: () => call(api.GET('/api/v1/reports/club-activity', { params: { query: period! } })),
  });
}

/** Club activity for staff and leader: period counts, current totals and gaps in dates. */
export function ReportsPage() {
  const { profile } = useSession();
  const today = todayUTC();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState<Period | null>(null);
  const report = useReport(period);
  const order = from && to && to < from ? 'Конец раньше начала.' : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reportInvalid(event.currentTarget) && !order) setPeriod({ from, to });
  };

  return (
    <>
      <PageHeader eyebrow={roleLabels[profile.role]} title="Отчёт о деятельности клуба" />
      <Card>
        <form className={styles.form} noValidate onSubmit={submit}>
          <div className={fieldStyles.row}>
            <TextField label="С даты" type="date" required value={from} onChange={(change) => setFrom(change.target.value)} />
            <TextField label="По дату" type="date" required min={from || undefined} value={to} onChange={(change) => setTo(change.target.value)} error={order} />
          </div>
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={report.isFetching}>
              Сформировать
            </Button>
            <span className={styles.note}>Обе даты включительно. Считаются только уже записанные факты.</span>
          </div>
        </form>
      </Card>
      {period === null ? null : report.isPending ? (
        <Loading label="Считаем…" />
      ) : report.isError ? (
        <QueryError error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <ReportView report={report.data} period={period} />
      )}
    </>
  );
}

type Report = NonNullable<ReturnType<typeof useReport>['data']>;

function ReportView({ report, period }: { report: Report; period: Period }) {
  const { activity, current, data_quality: quality } = report;
  const gaps = quality.members_without_membership_date + quality.dogs_without_registration_date + quality.performed_matings_without_date + quality.events_without_period;
  return (
    <>
      <Card heading={`За период ${formatDate(report.period.from)} — ${formatDate(report.period.to)}`}>
        <Facts>
          <Fact label="Вступили в клуб" value={activity.members_joined} />
          <Fact label="Поставлены на учёт" value={activity.dogs_registered} note="собаки с подтверждённой датой" />
          <Fact label="Проведено мероприятий" value={activity.events_completed} />
          <Fact label="Проведено вязок" value={activity.matings_performed} />
          <Fact label="Родилось помётов" value={activity.litters_born} note={`щенков: ${activity.puppies_born}`} />
        </Facts>
        <Table caption="Мероприятия по типам">
          <thead>
            <tr>
              <th scope="col">Тип мероприятия</th>
              <th scope="col">Проведено</th>
            </tr>
          </thead>
          <tbody>
            {activity.events_by_type.map((row) => (
              <tr key={row.type_id}>
                <td>{row.type_name}</td>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card heading="Сейчас в клубе">
        <Facts>
          <Fact label="Карточек членов" value={current.member_cards} note={`активных: ${current.active_members}`} />
          <Fact label="Карточек собак" value={current.dog_cards} note={`на учёте: ${current.dogs_on_register}`} />
        </Facts>
        <p className={styles.note}>Итоги на момент формирования ({formatDateTime(report.generated_at)}), а не на конец периода.</p>
      </Card>
      <Card heading="Полнота данных">
        {gaps === 0 && <p>Пропусков дат нет.</p>}
        <Facts>
          <Fact label="Члены без даты вступления" value={quality.members_without_membership_date} />
          <Fact label="Собаки без даты регистрации" value={quality.dogs_without_registration_date} />
          <Fact label="Вязки без даты" value={quality.performed_matings_without_date} />
          <Fact label="Мероприятия без периода" value={quality.events_without_period} />
        </Facts>
        <p className={styles.note}>Записи без дат не попадают в счётчики периода. Показатели относятся ко всей текущей базе.</p>
      </Card>
      {report.methodology && (
        <Card heading="Как считается">
          <p className={styles.methodology}>{report.methodology}</p>
        </Card>
      )}
      <Export period={period} />
    </>
  );
}

function Export({ period }: { period: Period }) {
  const [busy, setBusy] = useState<'pdf' | 'csv' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (format: 'pdf' | 'csv') => {
    setBusy(format);
    setError(null);
    try {
      const query = new URLSearchParams({ from: period.from, to: period.to, format });
      await downloadFile(`/api/v1/reports/club-activity/export?${query.toString()}`, `club-activity-${period.from}-${period.to}.${format}`);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card heading="Выгрузка">
      <div className={styles.actions}>
        <Button variant="secondary" busy={busy === 'pdf'} onClick={() => void run('pdf')}>
          <Download size={16} strokeWidth={2.2} aria-hidden="true" />
          PDF
        </Button>
        <Button variant="secondary" busy={busy === 'csv'} onClick={() => void run('csv')}>
          <Download size={16} strokeWidth={2.2} aria-hidden="true" />
          CSV
        </Button>
      </div>
      {error ? <ProblemAlert error={error} /> : null}
      <p className={styles.note}>Файл скачивается и на сервере не хранится.</p>
    </Card>
  );
}
