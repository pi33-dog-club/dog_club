import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { Alert, Button, Card, Loading, PageHeader, ProblemAlert, QueryError, SelectField, TextArea, TextField, fieldStyles, reportInvalid, toOptions, MAX_REASON } from '../../shared/ui';
import { eventsApi, useEvent, useEventDictionaries, useEventsSaved, useVenues, type Event } from './eventsApi';
import { audiences } from './labels';
import { venueAddress } from './VenuesTab';
import { commonZones, isZone, toZonedInput, zoneCaption, zonedToRFC3339 } from './zonedTime';
import styles from './events.module.css';

export function EventCreatePage() {
  return <EventForm />;
}

export function EventEditPage() {
  const event = useEvent(Number(useParams().eventID));
  if (event.isPending) return <Loading />;
  if (event.isError) return <QueryError error={event.error} onRetry={() => void event.refetch()} />;
  return <EventForm event={event.data} key={event.data.version} />;
}

const audienceOptions = (Object.keys(audiences) as Array<keyof typeof audiences>).map((value) => ({ value, label: audiences[value] }));

/** A new event is a draft; publishing needs the period, the zone and the audience. */
function EventForm({ event }: { event?: Event }) {
  const navigate = useNavigate();
  const saved = useEventsSaved();
  const dictionaries = useEventDictionaries();
  const venues = useVenues();
  const initialZone = event?.timezone ?? 'Europe/Moscow';
  const [name, setName] = useState(event?.name ?? '');
  const [typeID, setTypeID] = useState(event ? String(event.type.id) : '');
  const [venueID, setVenueID] = useState(event?.venue ? String(event.venue.id) : '');
  const [zone, setZone] = useState(initialZone);
  const [starts, setStarts] = useState(toZonedInput(event?.starts_at, initialZone));
  const [ends, setEnds] = useState(toZonedInput(event?.ends_at, initialZone));
  const [audience, setAudience] = useState<string>(event?.audience ?? 'dogs');
  const [usesClasses, setUsesClasses] = useState(event?.uses_classes ?? false);
  const [description, setDescription] = useState(event?.description ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const zones = commonZones.includes(zone) ? commonZones : [zone, ...commonZones];
  const order = starts && ends && ends < starts ? 'Окончание раньше начала.' : undefined;
  const classesError = audience === 'people' && usesClasses ? 'Классы собак не применяются, если участвуют только люди. Снимите отметку.' : errors.uses_classes;
  const ready = Boolean(name.trim() && typeID && venueID && starts && ends && !order && !(audience === 'people' && usesClasses) && isZone(zone) && (!event || reason.trim()));

  const submit = async (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    // Every missing value and broken rule is already shown under its field.
    if (!reportInvalid(submitEvent.currentTarget) || !ready) return;
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      type_id: Number(typeID),
      venue_id: Number(venueID),
      timezone: zone,
      starts_at: zonedToRFC3339(starts, zone),
      ends_at: zonedToRFC3339(ends, zone),
      audience: audience as 'dogs' | 'people' | 'mixed',
      uses_classes: usesClasses,
      description: description.trim(),
    };
    try {
      const result = event ? await eventsApi.update(event.id, { ...body, version: event.version, reason: reason.trim() }) : await eventsApi.create(body);
      await saved();
      navigate(`/events/${result.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Мероприятия" title={event ? `Исправить: ${event.name}` : 'Новое мероприятие'} />
      <Card>
        <form className={styles.form} noValidate onSubmit={submit}>
          {!event && <Alert tone="info">Мероприятие создаётся черновиком. Классы, расписание и экспертов добавите на его странице, затем откроете запись.</Alert>}
          {event?.legacy_starts_at && !event.starts_at && (
            <Alert tone="warning">В старых данных записано «{event.legacy_starts_at}» без часового пояса. Укажите точные начало и окончание по часам места проведения.</Alert>
          )}
          <TextField label="Название" required maxLength={100} value={name} onChange={(change) => setName(change.target.value)} error={errors.name} />
          <div className={fieldStyles.row}>
            <SelectField
              label="Тип"
              required
              placeholder="Выберите…"
              options={toOptions(dictionaries.data?.types ?? [])}
              value={typeID}
              onChange={(change) => setTypeID(change.target.value)}
              error={errors.type_id}
            />
            <SelectField
              label="Аудитория"
              required
              options={audienceOptions}
              value={audience}
              onChange={(change) => setAudience(change.target.value)}
              error={errors.audience}
              hint="Семинар без собак: «Люди» — медицинский допуск не нужен."
            />
          </div>
          <SelectField
            label="Площадка"
            required
            placeholder={venues.isPending ? 'Загружаем…' : 'Выберите…'}
            options={(venues.data ?? []).map((venue) => ({ value: venue.id, label: `${venue.name} — ${venueAddress(venue)}` }))}
            value={venueID}
            onChange={(change) => setVenueID(change.target.value)}
            error={errors.venue_id}
            hint={
              <>
                Новую площадку можно добавить на вкладке <Link to="/events?tab=venues">«Площадки»</Link>.
              </>
            }
          />
          <SelectField
            label="Часовой пояс"
            required
            options={zones.map((value) => ({ value, label: zoneCaption(value) }))}
            value={zone}
            onChange={(change) => setZone(change.target.value)}
            error={errors.timezone}
            hint="Время ниже вводится по часам места проведения."
          />
          <div className={fieldStyles.row}>
            <TextField label="Начало" type="datetime-local" required value={starts} onChange={(change) => setStarts(change.target.value)} error={errors.starts_at} />
            <TextField
              label="Окончание"
              type="datetime-local"
              required
              min={starts || undefined}
              value={ends}
              onChange={(change) => setEnds(change.target.value)}
              error={order ?? errors.ends_at}
            />
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={usesClasses} onChange={(change) => setUsesClasses(change.target.checked)} />
            Участие по классам
          </label>
          {classesError && (
            <p className={fieldStyles.error} role="alert">
              {classesError}
            </p>
          )}
          <TextArea label="Описание" maxLength={4000} value={description} onChange={(change) => setDescription(change.target.value)} error={errors.description} />
          {event && (
            <TextArea
              label="Причина исправления"
              required
              maxLength={MAX_REASON}
              value={reason}
              onChange={(change) => setReason(change.target.value)}
              error={errors.reason}
              hint="Сохранится в истории. После явки участников период и площадку менять нельзя."
            />
          )}
          {error ? <ProblemAlert error={error} /> : null}
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={busy}>
              {event ? 'Сохранить' : 'Создать черновик'}
            </Button>
            <Link to={event ? `/events/${event.id}` : '/events'}>Отмена</Link>
          </div>
        </form>
      </Card>
    </>
  );
}
