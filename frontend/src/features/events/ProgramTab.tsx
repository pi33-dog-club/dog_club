import { useState } from 'react';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { Button, Card, Chip, EmptyState, ReasonDialog, SelectField, Table, TextArea, TextField, fieldStyles, tableStyles } from '../../shared/ui';
import { eventsApi, useEventsSaved, type Event, type EventClass, type EventSchedule } from './eventsApi';
import { ageRange } from './labels';
import { formatPeriod, toZonedInput, zoneCaption, zonedToRFC3339 } from './zonedTime';
import styles from './events.module.css';

/** Classes and slots stay editable until the event is completed or cancelled. */
export function editable(event: Event): boolean {
  return event.status !== 'completed' && event.status !== 'cancelled';
}

interface ClassDraft {
  name: string;
  min: string;
  max: string;
  requirements: string;
  requires_expert: boolean;
  enabled: boolean;
}

interface SlotDraft {
  name: string;
  starts: string;
  ends: string;
  class_id: string;
  enabled: boolean;
}

const months = (value: string) => (value.trim() === '' ? null : Number(value));
const badMonths = (value: string) => value.trim() !== '' && (!/^\d{1,4}$/.test(value.trim()) || Number(value) > 1200);

export function ProgramTab({ event, onReload }: { event: Event; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff' && editable(event);
  const saved = useEventsSaved();
  const zone = event.timezone || 'UTC';
  const [klass, setClass] = useState<EventClass | 'new' | null>(null);
  const [slot, setSlot] = useState<EventSchedule | 'new' | null>(null);
  const [classDraft, setClassDraft] = useState<ClassDraft>({ name: '', min: '', max: '', requirements: '', requires_expert: false, enabled: true });
  const [slotDraft, setSlotDraft] = useState<SlotDraft>({ name: '', starts: '', ends: '', class_id: '', enabled: true });
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const className = (id: number | null) => event.classes.find((item) => item.id === id)?.name ?? '—';

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
      await saved();
    } catch (failure) {
      setError(failure);
      throw failure;
    }
  };

  const openClass = (item: EventClass | 'new') => {
    setError(null);
    setClassDraft(
      item === 'new'
        ? { name: '', min: '', max: '', requirements: '', requires_expert: false, enabled: true }
        : {
            name: item.name,
            min: item.min_age_months === null ? '' : String(item.min_age_months),
            max: item.max_age_months === null ? '' : String(item.max_age_months),
            requirements: item.requirements,
            requires_expert: item.requires_expert,
            enabled: item.enabled,
          },
    );
    setClass(item);
  };
  const openSlot = (item: EventSchedule | 'new') => {
    setError(null);
    setSlotDraft(
      item === 'new'
        ? { name: '', starts: toZonedInput(event.starts_at, zone), ends: toZonedInput(event.ends_at, zone), class_id: '', enabled: true }
        : {
            name: item.name,
            starts: toZonedInput(item.starts_at, zone),
            ends: toZonedInput(item.ends_at, zone),
            class_id: item.class_id ? String(item.class_id) : '',
            enabled: item.enabled,
          },
    );
    setSlot(item);
  };

  const monthsRule = 'Укажите целое число месяцев от 0 до 1200.';
  const minError = badMonths(classDraft.min) ? monthsRule : undefined;
  const maxError = badMonths(classDraft.max) ? monthsRule : undefined;
  const ageError = minError ?? maxError;
  const ageOrder = !ageError && classDraft.min && classDraft.max && Number(classDraft.min) > Number(classDraft.max) ? 'Верхняя граница возраста не может быть меньше нижней.' : undefined;
  const expertError = classDraft.requirements.trim() && !classDraft.requires_expert ? 'Для заполненных требований включите решение эксперта по квалификации.' : undefined;
  const slotOrder = slotDraft.starts && slotDraft.ends && slotDraft.ends < slotDraft.starts ? 'Окончание раньше начала.' : undefined;

  const saveClass = (reason: string) => {
    const body = {
      name: classDraft.name.trim(),
      min_age_months: months(classDraft.min),
      max_age_months: months(classDraft.max),
      requirements: classDraft.requirements.trim(),
      requires_expert: classDraft.requires_expert,
      enabled: classDraft.enabled,
      reason,
    };
    // A new class uses the event version, a correction the version of the class.
    return run(() =>
      klass === 'new'
        ? eventsApi.addClass(event.id, { ...body, version: event.version })
        : eventsApi.updateClass(event.id, (klass as EventClass).id, { ...body, version: (klass as EventClass).version }),
    );
  };
  const saveSlot = (reason: string) => {
    const body = {
      name: slotDraft.name.trim(),
      starts_at: zonedToRFC3339(slotDraft.starts, zone),
      ends_at: zonedToRFC3339(slotDraft.ends, zone),
      class_id: slotDraft.class_id ? Number(slotDraft.class_id) : null,
      enabled: slotDraft.enabled,
      reason,
    };
    return run(() =>
      slot === 'new'
        ? eventsApi.addSlot(event.id, { ...body, version: event.version })
        : eventsApi.updateSlot(event.id, (slot as EventSchedule).id, { ...body, version: (slot as EventSchedule).version }),
    );
  };

  return (
    <>
      {(event.uses_classes || event.classes.length > 0) && (
        <Card
          heading={
            <span className={styles.heading}>
              Классы
              {staff && event.uses_classes && (
                <Button variant="save" size="small" onClick={() => openClass('new')}>
                  Добавить класс
                </Button>
              )}
            </span>
          }
        >
          {!event.uses_classes && <p className={styles.note}>Мероприятие проходит без классов: старые классы не используются.</p>}
          {event.classes.length === 0 ? (
            <EmptyState title="Классов пока нет">
              <p>Для публикации нужен хотя бы один включённый класс.</p>
            </EmptyState>
          ) : (
            <Table caption="Классы">
              <thead>
                <tr>
                  <th scope="col">Класс</th>
                  <th scope="col">Возраст</th>
                  <th scope="col">Требования</th>
                  <th scope="col">Состояние</th>
                  {staff && <th scope="col">Действия</th>}
                </tr>
              </thead>
              <tbody>
                {event.classes.map((item) => (
                  <tr key={item.id} className={item.enabled ? undefined : styles.disabled}>
                    <td>{item.name}</td>
                    <td className={tableStyles.nowrap}>{ageRange(item.min_age_months, item.max_age_months) || 'Без ограничений'}</td>
                    <td>{item.requirements || '—'}</td>
                    <td>
                      <span className={styles.chips}>
                        {item.enabled ? <Chip tone="lime">Включён</Chip> : <Chip tone="dashed">Выключен</Chip>}
                        {item.requires_expert && <Chip tone="sun">Решение эксперта</Chip>}
                      </span>
                    </td>
                    {staff && (
                      <td>
                        <Button variant="secondary" onClick={() => openClass(item)}>
                          Исправить
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className={styles.note}>Возраст — в полных календарных месяцах на местную дату начала выступления, границы включительно.</p>
        </Card>
      )}

      <Card
        heading={
          <span className={styles.heading}>
            Расписание
            {staff && (
              <Button variant="save" size="small" onClick={() => openSlot('new')} disabled={!event.starts_at}>
                Добавить выступление
              </Button>
            )}
          </span>
        }
      >
        {event.schedule.length === 0 ? (
          <EmptyState title="Отдельных выступлений нет">
            <p>Без слота участие длится весь период мероприятия.</p>
          </EmptyState>
        ) : (
          <Table caption="Расписание">
            <thead>
              <tr>
                <th scope="col">Выступление</th>
                <th scope="col">Время</th>
                {event.uses_classes && <th scope="col">Класс</th>}
                <th scope="col">Состояние</th>
                {staff && <th scope="col">Действия</th>}
              </tr>
            </thead>
            <tbody>
              {event.schedule.map((item) => (
                <tr key={item.id} className={item.enabled ? undefined : styles.disabled}>
                  <td>{item.name}</td>
                  <td className={tableStyles.nowrap}>{formatPeriod(item.starts_at, item.ends_at, event.timezone)}</td>
                  {event.uses_classes && <td>{className(item.class_id)}</td>}
                  <td>{item.enabled ? <Chip tone="lime">Включено</Chip> : <Chip tone="dashed">Выключено</Chip>}</td>
                  {staff && (
                    <td>
                      <Button variant="secondary" onClick={() => openSlot(item)}>
                        Исправить
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {event.starts_at && <p className={styles.note}>Время — {zoneCaption(event.timezone, event.starts_at)}.</p>}
        {staff && !event.starts_at && <p className={styles.note}>Сначала задайте период мероприятия.</p>}
      </Card>

      <ReasonDialog
        open={klass !== null}
        showFieldErrors
        title={klass === 'new' ? 'Новый класс' : 'Исправить класс'}
        description={klass === 'new' ? 'Укажите название группы участников. Возраст и требования необязательны. Если заданы требования, их выполнение должен подтвердить эксперт.' : 'Изменение класса сделает прежние подтверждения эксперта по нему неактуальными.'}
        confirmLabel="Сохранить"
        ready={Boolean(classDraft.name.trim() && !ageError && !ageOrder && !expertError)}
        onReload={onReload}
        onClose={() => setClass(null)}
        onConfirm={saveClass}
      >
        <TextField
          label="Название"
          required
          maxLength={100}
          value={classDraft.name}
          onChange={(change) => setClassDraft({ ...classDraft, name: change.target.value })}
          error={errors.name}
        />
        <div className={fieldStyles.row}>
          <TextField
            label="Возраст от, мес."
            inputMode="numeric"
            value={classDraft.min}
            onChange={(change) => setClassDraft({ ...classDraft, min: change.target.value })}
            error={minError ?? errors.min_age_months}
            hint="Необязательно. От 0 до 1200 месяцев."
          />
          <TextField
            label="Возраст до, мес."
            inputMode="numeric"
            value={classDraft.max}
            onChange={(change) => setClassDraft({ ...classDraft, max: change.target.value })}
            error={maxError ?? ageOrder ?? errors.max_age_months}
            hint="Необязательно. Не меньше нижней границы."
          />
        </div>
        <TextArea
          label="Требования"
          maxLength={2000}
          value={classDraft.requirements}
          onChange={(change) => setClassDraft({ ...classDraft, requirements: change.target.value })}
          hint="Необязательно. Если заполнено, нужно включить решение эксперта ниже."
          error={errors.requirements}
        />
        <label className={styles.check}>
          <input type="checkbox" checked={classDraft.requires_expert} onChange={(change) => setClassDraft({ ...classDraft, requires_expert: change.target.checked })} />
          Нужно решение эксперта по квалификации
        </label>
        {(expertError || errors.requires_expert) && <p role="alert">{expertError || errors.requires_expert}</p>}
        <label className={styles.check}>
          <input type="checkbox" checked={classDraft.enabled} onChange={(change) => setClassDraft({ ...classDraft, enabled: change.target.checked })} />
          Класс включён
        </label>
      </ReasonDialog>

      <ReasonDialog
        open={slot !== null}
        showFieldErrors
        title={slot === 'new' ? 'Новое выступление' : 'Исправить выступление'}
        description={`Время по часам места проведения: ${zoneCaption(event.timezone, event.starts_at)}. Перенос пересчитывает проверки участников.`}
        confirmLabel="Сохранить"
        ready={Boolean(slotDraft.name.trim() && slotDraft.starts && slotDraft.ends && !slotOrder)}
        onReload={onReload}
        onClose={() => setSlot(null)}
        onConfirm={saveSlot}
      >
        <TextField
          label="Название"
          required
          maxLength={150}
          value={slotDraft.name}
          onChange={(change) => setSlotDraft({ ...slotDraft, name: change.target.value })}
          error={errors.name}
        />
        <div className={fieldStyles.row}>
          <TextField
            label="Начало"
            type="datetime-local"
            required
            value={slotDraft.starts}
            onChange={(change) => setSlotDraft({ ...slotDraft, starts: change.target.value })}
            error={errors.starts_at}
          />
          <TextField
            label="Окончание"
            type="datetime-local"
            required
            min={slotDraft.starts || undefined}
            value={slotDraft.ends}
            onChange={(change) => setSlotDraft({ ...slotDraft, ends: change.target.value })}
            error={slotOrder ?? errors.ends_at}
          />
        </div>
        {event.uses_classes && (
          <SelectField
            label="Класс"
            placeholder="Для всех классов"
            options={event.classes.map((item) => ({ value: item.id, label: item.name }))}
            value={slotDraft.class_id}
            onChange={(change) => setSlotDraft({ ...slotDraft, class_id: change.target.value })}
            error={errors.class_id}
          />
        )}
        <label className={styles.check}>
          <input type="checkbox" checked={slotDraft.enabled} onChange={(change) => setSlotDraft({ ...slotDraft, enabled: change.target.checked })} />
          Выступление включено
        </label>
      </ReasonDialog>
    </>
  );
}
