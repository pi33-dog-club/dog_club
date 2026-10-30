import { CircleCheck } from 'lucide-react';
import { Link } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, formatDateTime } from '../../shared/format';
import { Button, Card, Chip, EmptyState, Fact, Facts, Loading, QueryError, Timeline, tableStyles } from '../../shared/ui';
import { decisions, reasons as medicalReasons } from '../veterinary/labels';
import { useEventHistory, type Eligibility, type Event, type HistoryTarget, type Registration } from './eventsApi';
import { blockingReasons, historyActions, statuses } from './labels';
import { formatPeriod, zoneCaption } from './zonedTime';
import styles from './events.module.css';

export function EventStatusChip({ status }: { status: Event['status'] }) {
  const item = statuses[status];
  return <Chip tone={item.tone}>{item.label}</Chip>;
}

/** A dog entry is named by the dog; a person entry by the person. */
export function entryName(registration: Registration): string {
  if (registration.dog) return registration.dog.nickname;
  if (registration.dog_id) return `собака №${registration.dog_id}`;
  return registration.participant?.full_name ?? `участник №${registration.member_id}`;
}

/**
 * The current check or the snapshot saved at attendance: reasons, age date, medicine.
 * On the current check staff gets a way to the dog card where a reason can be fixed.
 */
export function EligibilityPanel({ check, event, heading, note, live }: { check: Eligibility; event: Event; heading: string; note?: string; live?: boolean }) {
  const { profile } = useSession();
  const passed = check.blocking_reasons.length === 0;
  const fixable = live && profile.role === 'staff' && check.dog;
  const medical = check.medical;
  return (
    <Card heading={heading}>
      {note && <p className={styles.note}>{note}</p>}
      {passed ? (
        <p className={styles.passed}>
          <CircleCheck size={20} strokeWidth={2.2} aria-hidden="true" /> Все проверки пройдены
        </p>
      ) : (
        <ul className={styles.reasons} aria-label="Причины">
          {check.blocking_reasons.map((code) => (
            <li key={code}>
              {blockingReasons[code]}
              {fixable && code === 'pedigree_incomplete' && (
                <>
                  {' · '}
                  <Link to={`/dogs/${check.dog!.id}?tab=pedigree`}>Заполнить родословную</Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Facts>
        <Fact label="Участие" value={formatPeriod(check.starts_at, check.ends_at, event.timezone)} note={zoneCaption(event.timezone, check.starts_at)} />
        {check.dog && <Fact label="Возраст считается на" value={formatDate(check.local_date)} note="местная дата начала выступления" />}
        {check.dog && check.dog.pedigree_known_3_generations !== undefined && (
          <Fact label="Родословная" value={check.dog.pedigree_known_3_generations ? 'Известна на 3 поколения' : 'Известна не полностью'} />
        )}
        {medical && (
          <Fact
            label="Медицинский допуск"
            value={<Chip tone={decisions[medical.decision].tone}>{decisions[medical.decision].label}</Chip>}
            note={medical.valid_until ? `до ${formatDate(medical.valid_until)}` : undefined}
          />
        )}
        <Fact label="Проверено" value={formatDateTime(check.checked_at)} note={`версия мероприятия ${check.event_version}`} />
      </Facts>
      {medical && medical.reasons.length > 0 && (
        <ul className={styles.reasons} aria-label="Основания медицинского решения">
          {medical.reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`}>{medicalReasons[reason.code]}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Change history; owners get metadata of their own entries only. */
export function EventHistory({ target }: { target: HistoryTarget }) {
  const history = useEventHistory(target);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.records);
  return (
    <Card heading="История">
      {changes.length === 0 ? (
        <EmptyState title="Изменений пока нет" />
      ) : (
        <Timeline
          entries={changes.map((change) => ({
            id: change.id,
            title: historyActions[`${change.entity}:${change.action}`] ?? 'Запись изменена',
            meta: formatDateTime(change.changed_at),
            reason: change.reason || undefined,
          }))}
        />
      )}
      {history.hasNextPage && (
        <Button variant="secondary" className={tableStyles.more} busy={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          Показать ещё
        </Button>
      )}
    </Card>
  );
}
