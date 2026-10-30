import { Link, useParams, useSearchParams } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, pluralize } from '../../shared/format';
import { Alert, ButtonLink, Fact, Facts, Loading, PageHeader, QueryError, Tabs, tabPanelProps } from '../../shared/ui';
import { useEvent, type Event } from './eventsApi';
import { audiences } from './labels';
import { OverviewTab } from './OverviewTab';
import { EventHistory, EventStatusChip } from './parts';
import { ProgramTab, editable } from './ProgramTab';
import { RegistrationsTab } from './RegistrationsTab';
import { ResultsTab } from './ResultsTab';
import { venueAddress } from './VenuesTab';
import { formatPeriod, zoneCaption } from './zonedTime';
import styles from './events.module.css';

const allTabs = [
  { value: 'overview', label: 'Обзор' },
  { value: 'program', label: 'Программа' },
  { value: 'participants', label: 'Участники' },
  { value: 'results', label: 'Результаты' },
  { value: 'history', label: 'История' },
] as const;
type Tab = (typeof allTabs)[number]['value'];

export function EventPage() {
  const event = useEvent(Number(useParams().eventID));
  if (event.isPending) return <Loading label="Загружаем мероприятие…" />;
  if (event.isError) return <QueryError error={event.error} onRetry={() => void event.refetch()} />;
  return <EventCard event={event.data} onReload={() => void event.refetch()} />;
}

function EventCard({ event, onReload }: { event: Event; onReload: () => void }) {
  const { profile } = useSession();
  // An owner sees own entries only and reads their history there, not the history of the event.
  const owner = profile.role === 'owner';
  const tabs = allTabs
    .filter((item) => item.value !== 'history' || !owner)
    .map((item) => (owner && item.value === 'participants' ? { ...item, label: 'Мои записи' } : owner && item.value === 'results' ? { ...item, label: 'Мои результаты' } : item));
  const [params, setParams] = useSearchParams();
  const tab: Tab = tabs.find((item) => item.value === params.get('tab'))?.value ?? 'overview';
  const venue = event.venue;

  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/events">{profile.role === 'expert' ? 'Мои мероприятия' : 'Мероприятия'}</Link> / {event.name}
      </nav>
      <PageHeader
        eyebrow={event.type.name}
        title={event.name}
        actions={
          <>
            <ButtonLink to={`/documents?event=${event.id}`} variant="secondary">
              Документы
            </ButtonLink>
            {profile.role === 'staff' && editable(event) && (
              <ButtonLink to={`/events/${event.id}/edit`} variant="secondary">
                Исправить
              </ButtonLink>
            )}
          </>
        }
      />
      <div className={styles.chips}>
        <EventStatusChip status={event.status} />
      </div>
      {!event.starts_at && (
        <Alert tone="warning">
          Период не задан{event.legacy_starts_at ? ` (в старых данных: ${formatDate(event.legacy_starts_at)}, без часового пояса)` : ''}. Мероприятие остаётся черновиком, пока
          сотрудник его не настроит.
        </Alert>
      )}
      <Facts>
        <Fact
          label="Период"
          value={formatPeriod(event.starts_at, event.ends_at, event.timezone)}
          note={event.starts_at ? zoneCaption(event.timezone, event.starts_at) : undefined}
        />
        <Fact label="Площадка" value={venue?.name ?? 'Не указана'} note={venue ? venueAddress(venue) : undefined} />
        <Fact label="Аудитория" value={event.audience ? audiences[event.audience] : 'Не указана'} />
        <Fact
          label="Классы"
          value={event.uses_classes ? pluralize(event.classes.filter((item) => item.enabled).length, 'класс', 'класса', 'классов') : 'Без классов'}
        />
      </Facts>
      <Tabs
        label="Разделы мероприятия"
        idPrefix="event"
        value={tab}
        options={tabs}
        onChange={(value) => setParams(value === 'overview' ? {} : { tab: value }, { replace: true })}
      />
      <section {...tabPanelProps('event', tab)} className={styles.panel}>
        {tab === 'overview' && <OverviewTab event={event} onReload={onReload} />}
        {tab === 'program' && <ProgramTab event={event} onReload={onReload} />}
        {tab === 'participants' && <RegistrationsTab event={event} onReload={onReload} />}
        {tab === 'results' && <ResultsTab event={event} onReload={onReload} />}
        {tab === 'history' && <EventHistory target={{ kind: 'event', eventID: event.id }} />}
      </section>
    </>
  );
}
