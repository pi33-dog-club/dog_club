import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { Alert, Button, Card, Chip, Fact, Facts, Loading, PageHeader, QueryError, ReasonDialog } from '../../shared/ui';
import { eventsApi, useEvent, useEventsSaved, useRegistration, useResults, type Event, type Registration } from './eventsApi';
import { qualifications, registrationStatuses } from './labels';
import { EligibilityPanel, EventHistory, entryName } from './parts';
import { editable } from './ProgramTab';
import { ClassSlotFields, RepresentativeField, slotText } from './RegistrationsTab';
import { ResultDialog, resultsOpen, useAssignedExpert } from './ResultsTab';
import styles from './events.module.css';

export function RegistrationPage() {
  const params = useParams();
  const eventID = Number(params.eventID);
  const event = useEvent(eventID);
  const registration = useRegistration(eventID, Number(params.registrationID));
  if (event.isPending || registration.isPending) return <Loading label="Загружаем запись…" />;
  if (event.isError) return <QueryError error={event.error} onRetry={() => void event.refetch()} />;
  if (registration.isError) return <QueryError error={registration.error} onRetry={() => void registration.refetch()} />;
  const reload = () => {
    void event.refetch();
    void registration.refetch();
  };
  return <RegistrationCard event={event.data} registration={registration.data} onReload={reload} />;
}

function RegistrationCard({ event, registration, onReload }: { event: Event; registration: Registration; onReload: () => void }) {
  const { profile } = useSession();
  const klass = event.classes.find((item) => item.id === registration.class_id);
  const attended = registration.status === 'attended';
  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/events">{profile.role === 'expert' ? 'Мои мероприятия' : 'Мероприятия'}</Link> / <Link to={`/events/${event.id}?tab=participants`}>{event.name}</Link> / Запись{' '}
        {registration.id}
      </nav>
      <PageHeader eyebrow={`Запись ${registration.id}`} title={entryName(registration)} />
      <div className={styles.chips}>
        <Chip tone={registrationStatuses[registration.status].tone}>{registrationStatuses[registration.status].label}</Chip>
        {klass?.requires_expert && <Chip tone={qualifications[registration.qualification].tone}>{qualifications[registration.qualification].label}</Chip>}
      </div>
      <Facts>
        <Fact label={registration.dog ? 'Представитель' : 'Участник'} value={registration.participant?.full_name ?? '—'} />
        {registration.dog && <Fact label="Собака" value={registration.dog.nickname} note={`${registration.dog.breed.name} · ${registration.dog.sex.name}`} />}
        {event.uses_classes && <Fact label="Класс" value={klass?.name ?? '—'} note={klass?.requirements || undefined} />}
        <Fact label="Время" value={slotText(event, registration)} />
      </Facts>
      {attended && registration.attendance ? (
        <EligibilityPanel
          check={registration.attendance}
          event={event}
          heading="Проверка на момент явки"
          note="Снимок сохранён при отметке явки. Последующие правки карточки собаки, медицины или правил его не меняют."
        />
      ) : registration.eligibility && registration.status !== 'cancelled' ? (
        <EligibilityPanel
          check={registration.eligibility}
          event={event}
          heading="Текущая проверка"
          note="Пересчитывается при каждом открытии; запись сама по себе не означает допуск."
          live
        />
      ) : null}
      {klass?.requires_expert && <QualificationCard event={event} registration={registration} onReload={onReload} />}
      <ResultCard event={event} registration={registration} onReload={onReload} />
      <StaffActions event={event} registration={registration} onReload={onReload} />
      <EventHistory target={{ kind: 'registration', eventID: event.id, id: registration.id }} />
    </>
  );
}

/** The assigned expert confirms documents and qualification once automatic checks pass. */
function QualificationCard({ event, registration, onReload }: { event: Event; registration: Registration; onReload: () => void }) {
  const expert = useAssignedExpert(event);
  const saved = useEventsSaved();
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  // After attendance the decision is judged by the snapshot: later edits do not make it stale.
  const check = registration.status === 'attended' ? registration.attendance : registration.eligibility;
  const other = check?.blocking_reasons.filter((code) => code !== 'qualification_required') ?? [];
  const open = registration.status === 'registered' && editable(event);
  return (
    <Card heading="Квалификация">
      <p>
        <Chip tone={qualifications[registration.qualification].tone}>{qualifications[registration.qualification].label}</Chip>
        {registration.qualification === 'approved' && check && !check.qualification_current && ' — подтверждение устарело после изменений, нужно новое решение.'}
      </p>
      {registration.qualification_reason && <p className={styles.description}>{registration.qualification_reason}</p>}
      {expert && open && (
        <>
          <div className={styles.actions}>
            {!(registration.qualification === 'approved' && check?.qualification_current) && (
              <Button variant="save" disabled={other.length > 0} onClick={() => setDecision('approved')}>
                Подтвердить
              </Button>
            )}
            {registration.qualification !== 'rejected' && (
              <Button variant="danger" onClick={() => setDecision('rejected')}>
                Отклонить
              </Button>
            )}
          </div>
          {other.length > 0 && registration.qualification !== 'approved' && <p className={styles.note}>Подтверждение доступно, когда пройдены автоматические проверки.</p>}
        </>
      )}
      <ReasonDialog
        open={decision !== null}
        title={decision === 'approved' ? 'Подтвердить квалификацию' : 'Отклонить квалификацию'}
        description="Решение действует, пока не изменятся собака, класс, время или правила мероприятия."
        confirmLabel={decision === 'approved' ? 'Подтвердить' : 'Отклонить'}
        confirmVariant={decision === 'rejected' ? 'danger' : 'save'}
        onReload={onReload}
        onClose={() => setDecision(null)}
        onConfirm={async (reason) => {
          await eventsApi.qualify(event.id, registration.id, { version: registration.version, decision: decision!, reason });
          await saved();
        }}
      />
    </Card>
  );
}

function ResultCard({ event, registration, onReload }: { event: Event; registration: Registration; onReload: () => void }) {
  const expert = useAssignedExpert(event) && resultsOpen(event);
  const results = useResults(event.id);
  const [adding, setAdding] = useState(false);
  if (!registration.dog_id) return null;
  const active = results.data?.find((item) => item.registration_id === registration.id && !item.is_void);
  const canAdd = expert && registration.status === 'attended' && results.isSuccess && !active;
  if (!active && !canAdd) return null;
  return (
    <Card heading="Результат">
      {active ? (
        <Facts>
          <Fact label="Оценка" value={active.grade?.name ?? '—'} />
          <Fact label="Место" value={active.place ?? '—'} />
          <Fact label="Комментарий" value={active.comment || '—'} note={<Link to={`/events/${event.id}?tab=results`}>Все результаты</Link>} />
        </Facts>
      ) : (
        <div className={styles.actions}>
          <Button variant="save" onClick={() => setAdding(true)}>
            Внести результат
          </Button>
        </div>
      )}
      <ResultDialog
        event={event}
        open={adding}
        onReload={onReload}
        onClose={() => setAdding(false)}
        onSave={(body) => eventsApi.recordResult(event.id, registration.id, { ...body, version: registration.version })}
      />
    </Card>
  );
}

/** Staff fixes attendance, corrects or cancels the entry; a cancelled one is restored by a correction. */
function StaffActions({ event, registration, onReload }: { event: Event; registration: Registration; onReload: () => void }) {
  const { profile } = useSession();
  const saved = useEventsSaved();
  const [dialog, setDialog] = useState<'attend' | 'cancel' | 'edit' | null>(null);
  const [member, setMember] = useState(String(registration.member_id));
  const [entry, setEntry] = useState({
    classID: registration.class_id ? String(registration.class_id) : '',
    scheduleID: registration.schedule_id ? String(registration.schedule_id) : '',
  });
  const [error, setError] = useState<unknown>(null);
  const results = useResults(event.id);
  const errors = fieldErrors(error);
  if (profile.role !== 'staff') return null;

  const check = registration.eligibility;
  const blocked = (check?.blocking_reasons.length ?? 0) > 0;
  const started = check ? Date.parse(check.starts_at) <= Date.now() : false;
  const canAttend = registration.status === 'registered' && event.status === 'in_progress';
  const canEdit = registration.status !== 'attended' && ['open', 'closed', 'in_progress'].includes(event.status);
  const canCancel = registration.status !== 'cancelled' && event.status !== 'cancelled';
  if (!canAttend && !canEdit && !canCancel) return null;
  const cancelled = registration.status === 'cancelled';
  const scored = results.data?.some((item) => item.registration_id === registration.id && !item.is_void) ?? false;

  const openEdit = () => {
    setMember(String(registration.member_id));
    setEntry({ classID: registration.class_id ? String(registration.class_id) : '', scheduleID: registration.schedule_id ? String(registration.schedule_id) : '' });
    setError(null);
    setDialog('edit');
  };

  return (
    <Card heading="Действия сотрудника">
      <div className={styles.actions}>
        {canAttend && (
          <Button variant="save" disabled={blocked || !started} onClick={() => setDialog('attend')}>
            Отметить явку
          </Button>
        )}
        {canEdit && (
          <Button variant="secondary" onClick={openEdit}>
            {cancelled ? 'Восстановить запись' : 'Исправить запись'}
          </Button>
        )}
        {canCancel && (
          <Button variant="danger" disabled={registration.status === 'attended' && scored} onClick={() => setDialog('cancel')}>
            {registration.status === 'attended' ? 'Отменить ошибочную явку' : 'Отменить запись'}
          </Button>
        )}
      </div>
      {canAttend && blocked && <p className={styles.note}>Явку можно отметить, когда пройдены все проверки допуска.</p>}
      {canAttend && !blocked && !started && <p className={styles.note}>Явка отмечается после начала выступления.</p>}
      {event.status !== 'in_progress' && registration.status === 'registered' && <p className={styles.note}>Явка отмечается, пока мероприятие идёт.</p>}
      {registration.status === 'attended' && scored && <p className={styles.note}>Ошибочную явку можно отменить после того, как эксперт отметит результат ошибочным.</p>}

      <ReasonDialog
        open={dialog === 'attend'}
        title="Отметить явку"
        description="Проверки пересчитаются ещё раз; результат проверки сохранится снимком в записи."
        confirmLabel="Отметить явку"
        onReload={onReload}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await eventsApi.attend(event.id, registration.id, registration.version, reason);
          await saved();
        }}
      />
      <ReasonDialog
        open={dialog === 'cancel'}
        title={registration.status === 'attended' ? 'Отменить ошибочную явку' : 'Отменить запись'}
        description="Запись останется в истории; отменённую запись можно восстановить исправлением."
        confirmLabel="Отменить"
        confirmVariant="danger"
        onReload={onReload}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await eventsApi.cancel(event.id, registration.id, registration.version, reason);
          await saved();
        }}
      />
      <ReasonDialog
        open={dialog === 'edit'}
        title={cancelled ? 'Восстановить запись' : 'Исправить запись'}
        description="Исправление сбрасывает решение эксперта по квалификации: его нужно получить заново."
        confirmLabel="Сохранить"
        ready={Boolean(member && (!registration.dog_id || !event.uses_classes || entry.classID))}
        onReload={onReload}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          try {
            await eventsApi.updateRegistration(event.id, registration.id, {
              version: registration.version,
              reason,
              member_id: Number(member),
              dog_id: registration.dog_id,
              class_id: registration.dog_id && entry.classID ? Number(entry.classID) : null,
              schedule_id: entry.scheduleID ? Number(entry.scheduleID) : null,
            });
            await saved();
          } catch (failure) {
            setError(failure);
            throw failure;
          }
        }}
      >
        {registration.dog_id ? <RepresentativeField dogID={registration.dog_id} value={member} onChange={setMember} error={errors.member_id} /> : null}
        {cancelled && <Alert tone="info">Запись вернётся в состояние «Записан» с новой проверкой допуска.</Alert>}
        <ClassSlotFields
          event={registration.dog_id ? event : { ...event, uses_classes: false }}
          classID={entry.classID}
          scheduleID={entry.scheduleID}
          onChange={setEntry}
          errors={errors}
        />
      </ReasonDialog>
    </Card>
  );
}
