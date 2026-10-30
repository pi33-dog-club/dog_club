import { useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { pluralize } from '../../shared/format';
import { Alert, Button, Card, Chip, EmptyState, ReasonDialog } from '../../shared/ui';
import { eventsApi, useEventExperts, useEventsSaved, type Event } from './eventsApi';
import { transitionLabels, transitions, type Target } from './labels';
import { EventStatusChip } from './parts';
import { formatZoned } from './zonedTime';
import styles from './events.module.css';

export function OverviewTab({ event, onReload }: { event: Event; onReload: () => void }) {
  return (
    <>
      {event.description && (
        <Card heading="Описание">
          <p className={styles.description}>{event.description}</p>
        </Card>
      )}
      <StateCard event={event} onReload={onReload} />
      <ExpertsCard event={event} onReload={onReload} />
    </>
  );
}

/** Staff moves the event along draft → open → closed → in progress → completed. */
function StateCard({ event, onReload }: { event: Event; onReload: () => void }) {
  const { profile } = useSession();
  const saved = useEventsSaved();
  const [target, setTarget] = useState<Target | null>(null);
  const staff = profile.role === 'staff';
  const next = transitions[event.status];
  const early = Boolean(event.starts_at && Date.parse(event.starts_at) > Date.now());
  if (!staff) return null;
  return (
    <Card heading="Состояние">
      <p>
        Сейчас: <EventStatusChip status={event.status} />
      </p>
      {next.length === 0 ? (
        <p className={styles.note}>Мероприятие {event.status === 'completed' ? 'завершено' : 'отменено'}: состояние больше не меняется.</p>
      ) : (
        <div className={styles.actions}>
          {next.map((status) => (
            <Button
              key={status}
              variant={status === 'cancelled' ? 'danger' : status === 'open' && event.status === 'closed' ? 'secondary' : 'save'}
              disabled={status === 'in_progress' && early}
              onClick={() => setTarget(status)}
            >
              {transitionLabels[status]}
            </Button>
          ))}
        </div>
      )}
      {event.status === 'draft' && (
        <p className={styles.note}>Для открытия записи нужны даты, часовой пояс, аудитория, площадка и — при участии по классам — хотя бы один включённый класс.</p>
      )}
      {next.includes('in_progress') && early && <p className={styles.note}>Начать можно с {formatZoned(event.starts_at, event.timezone)} по местному времени.</p>}
      <ReasonDialog
        open={target !== null}
        showFieldErrors
        title={target ? transitionLabels[target] : ''}
        description={
          target === 'open'
            ? 'Участники смогут записываться на это мероприятие. Укажите причину открытия записи, например «Начало приёма заявок»: она сохранится в истории.'
            : target === 'cancelled'
              ? 'Отмену нельзя вернуть. Записи и результаты сохранятся в истории.'
              : target === 'closed'
                ? 'Приём новых участников будет закрыт. Уже поданные заявки сохранятся.'
                : target === 'in_progress'
                  ? 'Мероприятие перейдёт в состояние «Идёт». Можно будет отмечать явку участников.'
                  : 'Мероприятие будет завершено. Изменение его данных станет недоступно.'
        }
        confirmLabel={target ? transitionLabels[target] : ''}
        confirmVariant={target === 'cancelled' ? 'danger' : 'save'}
        onReload={onReload}
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          await eventsApi.setState(event.id, { version: event.version, status: target!, reason });
          await saved();
        }}
      >
        {target === 'open' && (
          <p>
            Если мероприятие ещё не настроено: <Link to={`/events/${event.id}/edit`}>заполнить данные мероприятия</Link>
            {event.uses_classes && <> или <Link to={`/events/${event.id}?tab=program`}>добавить или включить класс в программе</Link></>}.
          </p>
        )}
      </ReasonDialog>
    </Card>
  );
}

/** Experts are profiles assigned by staff; only staff and leader see their names. */
function ExpertsCard({ event, onReload }: { event: Event; onReload: () => void }) {
  const { profile } = useSession();
  const office = profile.role === 'staff' || profile.role === 'leader';
  const staff = profile.role === 'staff' && event.status !== 'completed' && event.status !== 'cancelled';
  const experts = useEventExperts(office);
  const saved = useEventsSaved();
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const assigned = event.expert_profile_ids;
  const nameOf = (id: string) => experts.data?.find((item) => item.profile_id === id)?.display_name ?? 'Эксперт с отключённым профилем';

  if (profile.role === 'owner') return null;
  return (
    <Card
      heading={
        <span className={styles.heading}>
          Эксперты
          {staff && (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setChosen(assigned);
                setEditing(true);
              }}
            >
              Назначить
            </Button>
          )}
        </span>
      }
    >
      {profile.role === 'expert' ? (
        <p>{assigned.includes(profile.id) ? 'Вы назначены экспертом этого мероприятия.' : 'Вы не назначены на это мероприятие.'}</p>
      ) : assigned.length === 0 ? (
        <EmptyState title="Эксперты не назначены">
          <p>Без эксперта некому подтвердить квалификацию и внести результаты.</p>
        </EmptyState>
      ) : (
        <ul className={styles.chips} aria-label="Назначенные эксперты">
          {assigned.map((id) => (
            <li key={id}>
              <Chip tone="lime">{experts.isPending ? '…' : nameOf(id)}</Chip>
            </li>
          ))}
        </ul>
      )}
      <ReasonDialog
        open={editing}
        title="Эксперты мероприятия"
        description="Список включённых профилей экспертов-кинологов. Снятый эксперт теряет доступ, его подтверждения перестают действовать."
        confirmLabel="Сохранить"
        onReload={onReload}
        onClose={() => setEditing(false)}
        onConfirm={async (reason) => {
          await eventsApi.setExperts(event.id, { version: event.version, profile_ids: chosen, reason });
          await saved();
        }}
      >
        {experts.isError ? (
          <Alert tone="error">Не удалось загрузить экспертов.</Alert>
        ) : experts.data?.length === 0 ? (
          <p>Включённых экспертов нет: профиль назначает администратор.</p>
        ) : (
          <ul className={styles.checks}>
            {(experts.data ?? []).map((item) => (
              <li key={item.profile_id}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(item.profile_id)}
                    onChange={(change) => setChosen(change.target.checked ? [...chosen, item.profile_id] : chosen.filter((id) => id !== item.profile_id))}
                  />
                  {item.display_name}
                </label>
              </li>
            ))}
          </ul>
        )}
        {chosen.length > 0 && <p className={styles.note}>Выбрано: {pluralize(chosen.length, 'эксперт', 'эксперта', 'экспертов')}.</p>}
      </ReasonDialog>
    </Card>
  );
}
