import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { Alert, Button, Card, Loading, PageHeader, ProblemAlert, QueryError, SelectField, TextArea, TextField, fieldStyles, MAX_REASON } from '../../shared/ui';
import { DogPicker } from '../dogs/DogPicker';
import { isActiveStatus, useDog, useDogDictionaries } from '../dogs/dogsApi';
import { useEventDictionaries, useEvents, useRegistrations } from '../events/eventsApi';
import { commonZones, formatPeriod, isZone, toZonedInput, zoneCaption, zonedToRFC3339 } from '../events/zonedTime';
import { trainingApi, useOwnGrant, useTrainingSaved, useTrainingSession, useTrainingTypes, type TrainingSession } from './trainingApi';
import { DogLabel } from './parts';
import styles from './training.module.css';

export function SessionCreatePage() {
  const [params] = useSearchParams();
  return <SessionForm initialDog={Number(params.get('dog')) || null} />;
}

export function SessionEditPage() {
  const params = useParams();
  const session = useTrainingSession(Number(params.dogID), Number(params.sessionID));
  if (session.isPending) return <Loading />;
  if (session.isError) return <QueryError error={session.error} onRetry={() => void session.refetch()} />;
  return <SessionForm session={session.data} initialDog={session.data.dog_id} key={session.data.version} />;
}

/** Only an instructor records a session, and only of the types the grant allows. */
function SessionForm({ session, initialDog }: { session?: TrainingSession; initialDog: number | null }) {
  const navigate = useNavigate();
  const saved = useTrainingSaved();
  const grant = useOwnGrant();
  const types = useTrainingTypes();
  const initialZone = session?.timezone ?? 'Europe/Moscow';
  const [dogID, setDogID] = useState(initialDog);
  const [typeID, setTypeID] = useState(session ? String(session.type.id) : '');
  const [zone, setZone] = useState(initialZone);
  const [starts, setStarts] = useState(toZonedInput(session?.starts_at, initialZone));
  const [ends, setEnds] = useState(toZonedInput(session?.ends_at, initialZone));
  const [result, setResult] = useState(session?.result ?? '');
  const [linked, setLinked] = useState(Boolean(session?.event_id));
  const [eventID, setEventID] = useState(session?.event_id ? String(session.event_id) : '');
  const [registrationID, setRegistrationID] = useState(session?.registration_id ? String(session.registration_id) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const dog = useDog(dogID ?? 0, Boolean(dogID));
  const dictionaries = useDogDictionaries();
  const inactive = dog.data ? !isActiveStatus(dictionaries.data, dog.data.status.id) : false;
  const zones = commonZones.includes(zone) ? commonZones : [zone, ...commonZones];
  const now = toZonedInput(new Date().toISOString(), zone);
  const timeError = starts && ends && ends < starts ? 'Окончание раньше начала.' : ends && ends > now ? 'Занятие ещё не закончилось: журнал хранит только проведённые.' : undefined;
  const ready = Boolean(dogID && typeID && result.trim() && starts && ends && !timeError && isZone(zone) && !inactive && (!linked || registrationID) && (!session || reason.trim()));

  if (grant.pending) return <Loading />;
  if (grant.typeIDs.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Дрессировка" title="Нет допуска инструктора" />
        <Alert tone="info">
          Вносить и исправлять занятия может сотрудник с допуском инструктора к нужному виду. Допуск выдаёт администратор клуба. <Link to="/training">К журналу</Link>
        </Alert>
      </>
    );
  }

  const submit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    if (!dogID) return;
    setBusy(true);
    setError(null);
    const body = {
      type_id: Number(typeID),
      timezone: zone,
      starts_at: zonedToRFC3339(starts, zone),
      ends_at: zonedToRFC3339(ends, zone),
      result: result.trim(),
      event_id: linked && eventID ? Number(eventID) : null,
      registration_id: linked && registrationID ? Number(registrationID) : null,
    };
    try {
      const out = session ? await trainingApi.update(dogID, session.id, { ...body, version: session.version, reason: reason.trim() }) : await trainingApi.create(dogID, body);
      await saved();
      navigate(`/training/${dogID}/${out.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Дрессировка" title={session ? 'Исправить занятие' : 'Новое занятие'} />
      <Card>
        <form className={styles.form} onSubmit={submit}>
          {dogID ? (
            <div className={styles.picked}>
              <b>
                <DogLabel id={dogID} link={false} />
              </b>
              {!session && (
                <Button variant="link" onClick={() => setDogID(null)}>
                  Выбрать другую
                </Button>
              )}
            </div>
          ) : (
            <DogPicker label="Собака" onPick={(picked) => setDogID(picked.id)} error={errors.dog_id} />
          )}
          {inactive && <Alert tone="error">Собака не на учёте: новые занятия и их исправление недоступны. Ошибочное занятие можно только отменить.</Alert>}
          {dogID && errors.dog_id && <Alert tone="error">{errors.dog_id}</Alert>}
          <SelectField
            label="Вид дрессировки"
            required
            placeholder="Выберите…"
            options={(types.data ?? []).filter((type) => grant.typeIDs.includes(type.id)).map((type) => ({ value: type.id, label: type.name }))}
            value={typeID}
            onChange={(change) => setTypeID(change.target.value)}
            error={errors.type_id}
            hint="Только виды, разрешённые вашим допуском."
          />
          <SelectField
            label="Часовой пояс"
            required
            options={zones.map((value) => ({ value, label: zoneCaption(value) }))}
            value={zone}
            onChange={(change) => setZone(change.target.value)}
            error={errors.timezone}
            hint="Время вводится по часам места занятия."
          />
          <div className={fieldStyles.row}>
            <TextField label="Начало" type="datetime-local" required max={now} value={starts} onChange={(change) => setStarts(change.target.value)} error={errors.starts_at} />
            <TextField
              label="Окончание"
              type="datetime-local"
              required
              min={starts || undefined}
              max={now}
              value={ends}
              onChange={(change) => setEnds(change.target.value)}
              error={timeError ?? errors.ends_at}
            />
          </div>
          <TextArea
            label="Результат"
            required
            maxLength={2000}
            value={result}
            onChange={(change) => setResult(change.target.value)}
            error={errors.result}
            hint="Опишите результат проведённого занятия. Виден владельцу собаки."
          />
          <label className={styles.toggle}>
            <input type="checkbox" checked={linked} onChange={(change) => setLinked(change.target.checked)} />
            Занятие проходило на мероприятии клуба
          </label>
          {linked && dogID && <EventLink dogID={dogID} eventID={eventID} registrationID={registrationID} onEvent={setEventID} onRegistration={setRegistrationID} errors={errors} />}
          {session && (
            <TextArea
              label="Причина исправления"
              required
              maxLength={MAX_REASON}
              value={reason}
              onChange={(change) => setReason(change.target.value)}
              error={errors.reason}
              hint="Сохранится в истории занятия."
            />
          )}
          <p className={styles.note}>Медицинский допуск к мероприятиям проверится на даты занятия; без него занятие сохранится с предупреждением.</p>
          {error ? <ProblemAlert error={error} /> : null}
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={busy} disabled={!ready}>
              {session ? 'Сохранить' : 'Внести занятие'}
            </Button>
            <Link to={session ? `/training/${session.dog_id}/${session.id}` : '/training'}>Отмена</Link>
          </div>
        </form>
      </Card>
    </>
  );
}

/** A session may rest on the dog's entry in an event of type «Занятие». */
function EventLink({
  dogID,
  eventID,
  registrationID,
  onEvent,
  onRegistration,
  errors,
}: {
  dogID: number;
  eventID: string;
  registrationID: string;
  onEvent: (value: string) => void;
  onRegistration: (value: string) => void;
  errors: Record<string, string>;
}) {
  const dictionaries = useEventDictionaries();
  const lesson = dictionaries.data?.types.find((type) => type.name === 'Занятие');
  const events = useEvents({ type_id: lesson?.id });
  const registrations = useRegistrations(Number(eventID), Boolean(eventID));
  const rows = (events.data?.pages.flatMap((page) => page.records) ?? []).filter((event) => event.status !== 'draft' && event.status !== 'cancelled');
  const entries = eventID ? (registrations.data ?? []).filter((entry) => entry.dog_id === dogID && entry.status !== 'cancelled') : [];
  return (
    <div className={fieldStyles.row}>
      <SelectField
        label="Мероприятие «Занятие»"
        required
        placeholder={events.isPending ? 'Загружаем…' : 'Выберите…'}
        options={rows.map((event) => ({ value: event.id, label: `${event.name}, ${formatPeriod(event.starts_at, event.ends_at, event.timezone)}` }))}
        value={eventID}
        onChange={(change) => {
          onEvent(change.target.value);
          onRegistration('');
        }}
        error={errors.event_id}
      />
      <SelectField
        label="Запись собаки"
        required
        placeholder={!eventID ? 'Сначала мероприятие' : registrations.isPending ? 'Загружаем…' : entries.length === 0 ? 'Собака не записана' : 'Выберите…'}
        options={entries.map((entry) => ({ value: entry.id, label: `Запись ${entry.id}${entry.status === 'attended' ? ', явка отмечена' : ''}` }))}
        value={registrationID}
        onChange={(change) => onRegistration(change.target.value)}
        error={errors.registration_id}
      />
    </div>
  );
}
