import { useState } from 'react';
import { Link } from 'react-router';
import { fieldErrors, localProblem } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, pluralize } from '../../shared/format';
import { Ball, Button, Card, Chip, EmptyState, FormDialog, Loading, QueryError, SearchPicker, SelectField, Table, Tabs, tableStyles } from '../../shared/ui';
import { useDebounced } from '../../shared/useDebounced';
import { useDog } from '../dogs/dogsApi';
import { MemberPicker, type PickedMember } from '../members/MemberPicker';
import { useMembersByID } from '../members/membersApi';
import { eventsApi, useEventDogs, useEventsSaved, useRegistrations, type Event, type Registration } from './eventsApi';
import { qualifications, registrationStatuses } from './labels';
import { entryName } from './parts';
import { formatPeriod } from './zonedTime';
import styles from './events.module.css';

/** Staff enters people and dogs only while registration is open. */
export function RegistrationsTab({ event, onReload }: { event: Event; onReload: () => void }) {
  const { profile } = useSession();
  const registrations = useRegistrations(event.id);
  const [adding, setAdding] = useState(false);
  const staff = profile.role === 'staff';
  const owner = profile.role === 'owner';

  return (
    <>
      {staff && (
        <div className={styles.actions}>
          <Button variant="save" disabled={event.status !== 'open'} onClick={() => setAdding(true)}>
            Записать участника
          </Button>
          {event.status !== 'open' && <span className={styles.note}>Запись возможна, только пока она открыта.</span>}
        </div>
      )}
      {registrations.isPending ? (
        <Loading label="Загружаем участников…" />
      ) : registrations.isError ? (
        <QueryError error={registrations.error} onRetry={() => void registrations.refetch()} />
      ) : registrations.data.length === 0 ? (
        <Card>
          <EmptyState title={owner ? 'Ваших записей нет' : 'Участников пока нет'} illustration={<Ball />}>
            {owner && <p>Записывает сотрудник клуба: обратитесь к нему, чтобы участвовать.</p>}
          </EmptyState>
        </Card>
      ) : (
        <Table caption={owner ? 'Мои записи' : 'Участники'}>
          <thead>
            <tr>
              <th scope="col">Участник</th>
              {event.uses_classes && <th scope="col">Класс</th>}
              <th scope="col">Время</th>
              <th scope="col">Статус</th>
              <th scope="col">Допуск</th>
            </tr>
          </thead>
          <tbody>
            {registrations.data.map((registration) => (
              <tr key={registration.id}>
                <td>
                  <Link to={`/events/${event.id}/registrations/${registration.id}`}>{entryName(registration)}</Link>
                  {registration.dog && registration.participant && <div className={tableStyles.muted}>{registration.participant.full_name}</div>}
                </td>
                {event.uses_classes && <td>{event.classes.find((item) => item.id === registration.class_id)?.name ?? '—'}</td>}
                <td className={tableStyles.nowrap}>{slotText(event, registration)}</td>
                <td>
                  <Chip tone={registrationStatuses[registration.status].tone}>{registrationStatuses[registration.status].label}</Chip>
                </td>
                <td>
                  <Admission registration={registration} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {staff && <NewRegistrationDialog event={event} open={adding} onClose={() => setAdding(false)} onReload={onReload} />}
    </>
  );
}

export function slotText(event: Event, registration: Pick<Registration, 'schedule_id'>): string {
  const slot = event.schedule.find((item) => item.id === registration.schedule_id);
  return slot ? `${slot.name}, ${formatPeriod(slot.starts_at, slot.ends_at, event.timezone)}` : 'Весь период';
}

/** Attended entries keep the snapshot taken at attendance; others show the live check. */
function Admission({ registration }: { registration: Registration }) {
  if (registration.status === 'cancelled') return <>—</>;
  const check = registration.status === 'attended' ? registration.attendance : registration.eligibility;
  if (!check) return <>—</>;
  const count = check.blocking_reasons.length;
  const waiting = registration.qualification === 'pending' && check.blocking_reasons.includes('qualification_required');
  return (
    <span className={styles.chips}>
      {count === 0 ? (
        <Chip tone="lime">{registration.status === 'attended' ? 'Был допущен' : 'Допущен'}</Chip>
      ) : (
        <Chip tone="pink">{pluralize(count, 'причина', 'причины', 'причин')}</Chip>
      )}
      {waiting && <Chip tone={qualifications.pending.tone}>{qualifications.pending.label}</Chip>}
    </span>
  );
}

/** A dog searched among cards staff may enter. */
function EventDogPicker({ onPick, error }: { onPick: (dog: { id: number; nickname: string }) => void; error?: string }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const dogs = useEventDogs(q);
  return (
    <SearchPicker
      label="Найти собаку"
      error={error}
      query={query}
      onQuery={setQuery}
      loading={dogs.isFetching || q !== query.trim()}
      hint="Кличка, номер идентификатора или родословной."
      items={dogs.data?.dogs.map((dog) => ({
        id: dog.id,
        title: dog.nickname,
        note: `${dog.breed.name} · ${dog.sex.name} · род. ${formatDate(dog.date_of_birth)} · ${dog.identifier.number || 'нет идентификатора'}`,
      }))}
      onPick={(id) => {
        const dog = dogs.data?.dogs.find((item) => item.id === id);
        if (dog) {
          onPick(dog);
          setQuery('');
        }
      }}
    />
  );
}

/** The representative is one of the dog's current owners. */
export function RepresentativeField({ dogID, value, onChange, error }: { dogID: number; value: string; onChange: (value: string) => void; error?: string }) {
  const card = useDog(dogID);
  const owners = useMembersByID(card.data?.owner_ids ?? []);
  if (card.isPending) return <Loading label="Загружаем владельцев…" />;
  if (card.isError) return <QueryError error={card.error} onRetry={() => void card.refetch()} />;
  return (
    <SelectField
      label="Представитель"
      required
      placeholder="Выберите владельца…"
      options={card.data.owner_ids.map((id, index) => ({ value: id, label: owners[index]?.data?.full_name ?? `член клуба №${id}` }))}
      value={value}
      onChange={(change) => onChange(change.target.value)}
      error={error}
      hint={card.data.owner_ids.length === 0 ? 'У собаки нет владельцев: укажите их в карточке собаки.' : 'Один из текущих владельцев собаки.'}
    />
  );
}

/** Class and slot of an entry; slots of another class are not offered. */
export function ClassSlotFields({
  event,
  classID,
  scheduleID,
  onChange,
  errors,
}: {
  event: Event;
  classID: string;
  scheduleID: string;
  onChange: (next: { classID: string; scheduleID: string }) => void;
  errors: Record<string, string | undefined>;
}) {
  const slots = event.schedule.filter((slot) => slot.enabled && (!slot.class_id || String(slot.class_id) === classID));
  return (
    <>
      {event.uses_classes && (
        <SelectField
          label="Класс"
          required
          placeholder="Выберите…"
          options={event.classes.filter((item) => item.enabled).map((item) => ({ value: item.id, label: item.name }))}
          value={classID}
          onChange={(change) => onChange({ classID: change.target.value, scheduleID: '' })}
          error={errors.class_id}
        />
      )}
      {event.schedule.length > 0 && (
        <SelectField
          label="Время выступления"
          placeholder="Весь период мероприятия"
          options={slots.map((slot) => ({ value: slot.id, label: `${slot.name}, ${formatPeriod(slot.starts_at, slot.ends_at, event.timezone)}` }))}
          value={scheduleID}
          onChange={(change) => onChange({ classID, scheduleID: change.target.value })}
          error={errors.schedule_id}
        />
      )}
    </>
  );
}

type Kind = 'dog' | 'person';

function NewRegistrationDialog({ event, open, onClose, onReload }: { event: Event; open: boolean; onClose: () => void; onReload: () => void }) {
  const saved = useEventsSaved();
  const kinds: Kind[] = event.audience === 'people' ? ['person'] : event.audience === 'mixed' ? ['dog', 'person'] : ['dog'];
  const [kind, setKind] = useState<Kind>(kinds[0]!);
  const [dog, setDog] = useState<{ id: number; nickname: string } | null>(null);
  const [representative, setRepresentative] = useState('');
  const [person, setPerson] = useState<PickedMember[]>([]);
  const [entry, setEntry] = useState({ classID: '', scheduleID: '' });
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const memberID = kind === 'dog' ? Number(representative) : person[0]?.id;

  const close = () => {
    setDog(null);
    setRepresentative('');
    setPerson([]);
    setEntry({ classID: '', scheduleID: '' });
    setError(null);
    onClose();
  };

  return (
    <FormDialog
      open={open}
      title="Записать участника"
      description="Запись не означает допуск: проверки покажут причины, их можно устранить до явки."
      confirmLabel="Записать"
      onReload={onReload}
      onClose={close}
      check={() => {
        const missing = localProblem({
          dog_id: kind === 'dog' && !dog ? 'Выберите собаку.' : undefined,
          member_id: kind === 'person' && !memberID ? 'Выберите участника.' : undefined,
        });
        setError(missing);
        return !missing;
      }}
      onSubmit={async () => {
        try {
          await eventsApi.register(event.id, {
            member_id: memberID!,
            dog_id: kind === 'dog' ? dog!.id : null,
            class_id: kind === 'dog' && entry.classID ? Number(entry.classID) : null,
            schedule_id: entry.scheduleID ? Number(entry.scheduleID) : null,
          });
          await saved();
        } catch (failure) {
          setError(failure);
          throw failure;
        }
      }}
    >
      {kinds.length > 1 && (
        <Tabs
          label="Кого записать"
          idPrefix="entry"
          value={kind}
          options={[
            { value: 'dog', label: 'Собаку' },
            { value: 'person', label: 'Человека' },
          ]}
          onChange={setKind}
        />
      )}
      {kind === 'dog' ? (
        <>
          {dog ? (
            <div className={styles.picked}>
              <b>{dog.nickname}</b>
              <Button
                variant="link"
                onClick={() => {
                  setDog(null);
                  setRepresentative('');
                }}
              >
                Выбрать другую
              </Button>
            </div>
          ) : (
            <EventDogPicker onPick={setDog} error={errors.dog_id} />
          )}
          {dog && errors.dog_id && <p className={styles.note}>{errors.dog_id}</p>}
          {dog && <RepresentativeField dogID={dog.id} value={representative} onChange={setRepresentative} error={errors.member_id} />}
          <ClassSlotFields event={event} classID={entry.classID} scheduleID={entry.scheduleID} onChange={setEntry} errors={errors} />
        </>
      ) : (
        <>
          <MemberPicker label="Участник" value={person} onChange={(value) => setPerson(value.slice(-1))} error={errors.member_id} hint="ФИО члена клуба." />
          <p className={styles.note}>Человек записывается один раз, без собаки, класса и медицинских проверок.</p>
          <ClassSlotFields event={{ ...event, uses_classes: false }} classID="" scheduleID={entry.scheduleID} onChange={setEntry} errors={errors} />
        </>
      )}
    </FormDialog>
  );
}
