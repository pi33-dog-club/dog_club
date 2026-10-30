import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatDateTime } from '../../shared/format';
import { Alert, Button, ButtonLink, Card, Chip, EmptyState, Fact, Facts, Loading, PageHeader, QueryError, ReasonDialog, Timeline, tableStyles } from '../../shared/ui';
import { useDog } from '../dogs/dogsApi';
import { zoneCaption } from '../events/zonedTime';
import { trainingApi, useOwnGrant, useTrainingHistory, useTrainingSaved, useTrainingSession, type TrainingSession } from './trainingApi';
import { DogLabel, MedicalCheckView, historyActions, sessionTime, warnings } from './parts';
import styles from './training.module.css';

export function SessionPage() {
  const params = useParams();
  const session = useTrainingSession(Number(params.dogID), Number(params.sessionID));
  if (session.isPending) return <Loading label="Загружаем занятие…" />;
  if (session.isError) return <QueryError error={session.error} onRetry={() => void session.refetch()} />;
  return <SessionCard session={session.data} onReload={() => void session.refetch()} />;
}

function SessionCard({ session, onReload }: { session: TrainingSession; onReload: () => void }) {
  const { profile } = useSession();
  const grant = useOwnGrant();
  const saved = useTrainingSaved();
  const [voiding, setVoiding] = useState(false);
  // Only the author corrects or voids, and only while the grant covers the type.
  const author = profile.role === 'staff' && session.instructor_profile_id === profile.id && grant.typeIDs.includes(session.type.id);
  const open = author && !session.is_void && !session.legacy;
  const event = session.event_snapshot;
  const dog = useDog(session.dog_id);

  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/training">Дрессировка</Link> / <DogLabel id={session.dog_id} link={false} /> / Занятие {session.id}
      </nav>
      <PageHeader
        eyebrow={session.type.name}
        title={dog.data?.nickname ?? `Собака №${session.dog_id}`}
        actions={
          open && (
            <ButtonLink to={`/training/${session.dog_id}/${session.id}/edit`} variant="secondary">
              Исправить
            </ButtonLink>
          )
        }
      />
      {session.is_void && (
        <Chip tone="dashed" struck>
          Отмечено ошибочным
        </Chip>
      )}
      {session.warnings.map((code) => (
        <Alert key={code} tone="warning">
          {warnings[code] ?? 'Запись занятия требует проверки сотрудником клуба.'}
        </Alert>
      ))}
      <Facts>
        <Fact label="Собака" value={<DogLabel id={session.dog_id} />} />
        <Fact label="Время" value={sessionTime(session)} note={session.starts_at ? zoneCaption(session.timezone, session.starts_at) : undefined} />
        <Fact label="Инструктор" value={session.instructor_name || 'Неизвестен'} />
        <Fact label="Вид" value={session.type.name} />
        {event && (
          <Fact
            label="Мероприятие"
            value={<Link to={`/events/${event.event_id}/registrations/${event.registration_id}`}>Запись {event.registration_id}</Link>}
            note={session.source_changed ? 'изменилось после внесения' : undefined}
          />
        )}
      </Facts>
      <Card heading="Результат">
        <p className={styles.result}>{session.result || 'Не указан.'}</p>
      </Card>
      {!session.legacy && (
        <Card heading="Медицинский допуск к мероприятиям">
          <div className={styles.checks}>
            <MedicalCheckView title="При внесении" check={session.medical_snapshot} />
            <MedicalCheckView title="Сейчас на те же даты" check={session.current_medical} />
          </div>
          <p className={styles.note}>Отсутствие допуска не мешает записать уже проведённое занятие; проверка показывает только решение и основания.</p>
        </Card>
      )}
      {author && !session.is_void && (
        <div className={styles.actions}>
          <Button variant="danger" onClick={() => setVoiding(true)}>
            Отметить ошибочным
          </Button>
        </div>
      )}
      <SessionHistory session={session} />
      <ReasonDialog
        open={voiding}
        title="Отметить занятие ошибочным"
        description="Запись останется в истории; восстановить её нельзя — при необходимости внесите правильное занятие заново."
        confirmLabel="Отметить"
        confirmVariant="danger"
        onReload={onReload}
        onClose={() => setVoiding(false)}
        onConfirm={async (reason) => {
          await trainingApi.void(session.dog_id, session.id, session.version, reason);
          await saved();
        }}
      />
    </>
  );
}

/** Owners get the metadata of changes, without their reasons and contents. */
function SessionHistory({ session }: { session: TrainingSession }) {
  const history = useTrainingHistory(session.dog_id, session.id);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.records);
  return (
    <Card heading="История">
      {changes.length === 0 ? (
        <EmptyState title="Изменений нет">{session.legacy && <p>Старая запись перенесена без истории.</p>}</EmptyState>
      ) : (
        <Timeline
          entries={changes.map((change) => ({
            id: change.id,
            title: historyActions[change.action] ?? 'Запись изменена',
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
