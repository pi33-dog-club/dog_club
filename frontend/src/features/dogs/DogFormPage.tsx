import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { formatDate, parseMeasure, todayUTC } from '../../shared/format';
import { Alert, Button, Card, Loading, PageHeader, ProblemAlert, QueryError, SelectField, TextField, fieldStyles, reportInvalid, toOptions } from '../../shared/ui';
import { MemberPicker, type PickedMember } from '../members/MemberPicker';
import { dogKeys, dogsApi, useDog, useDogDictionaries, useDogSaved, type Dog, type DogPatchInput } from './dogsApi';
import styles from './dogs.module.css';

interface FormValues {
  nickname: string;
  date_of_birth: string;
  sex_id: string;
  breed_id: string;
  coat_color_id: string;
  status_id: string;
  identifier_type_id: string;
  identifier_number: string;
  identifier_date: string;
  height_cm: string;
  weight_kg: string;
}

function fromDog(dog: Dog): FormValues {
  return {
    nickname: dog.nickname,
    date_of_birth: dog.date_of_birth,
    sex_id: String(dog.sex.id),
    breed_id: String(dog.breed.id),
    coat_color_id: String(dog.coat_color.id),
    status_id: String(dog.status.id),
    identifier_type_id: String(dog.identifier.type.id),
    identifier_number: dog.identifier.number,
    identifier_date: dog.identifier.date ?? '',
    height_cm: dog.height_cm === null ? '' : String(dog.height_cm).replace('.', ','),
    weight_kg: dog.weight_kg === null ? '' : String(dog.weight_kg).replace('.', ','),
  };
}

const empty: FormValues = {
  nickname: '',
  date_of_birth: '',
  sex_id: '',
  breed_id: '',
  coat_color_id: '',
  status_id: '',
  identifier_type_id: '',
  identifier_number: '',
  identifier_date: '',
  height_cm: '',
  weight_kg: '',
};

export function DogCreatePage() {
  return <DogForm />;
}

export function DogEditPage() {
  const id = Number(useParams().dogID);
  const dog = useDog(id);
  if (dog.isPending) return <Loading />;
  if (dog.isError) return <QueryError error={dog.error} onRetry={() => void dog.refetch()} />;
  return <DogForm dog={dog.data} key={dog.data.version} />;
}

/** Registration (all fields and owners) or editing of the card fields; staff only. */
function DogForm({ dog }: { dog?: Dog }) {
  const navigate = useNavigate();
  const saved = useDogSaved();
  const client = useQueryClient();
  const dictionaries = useDogDictionaries();
  const activeStatus = dictionaries.data?.statuses.find((status) => status.is_active);
  const [values, setValues] = useState<FormValues>(() => (dog ? fromDog(dog) : empty));
  const [owners, setOwners] = useState<PickedMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [unchanged, setUnchanged] = useState(false);
  const errors = { ...fieldErrors(error), ...local };
  const today = todayUTC();
  // New dogs start «На учёте» unless staff picks another status.
  const statusValue = values.status_id || (!dog && activeStatus ? String(activeStatus.id) : '');

  const set = (name: keyof FormValues) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [name]: event.target.value }));
    setUnchanged(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Browser checks report through onInvalid; the form's own checks are added on top.
    setLocal({});
    const valid = reportInvalid(event.currentTarget);
    const height = parseMeasure(values.height_cm);
    const weight = parseMeasure(values.weight_kg);
    const problems: Record<string, string> = {};
    for (const [field, value, max, unit] of [['height_cm', height, 150, 'см'], ['weight_kg', weight, 200, 'кг']] as const) {
      if (value !== null && (!Number.isFinite(value) || value < 0.01 || value > max || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)) {
        problems[field] = `Укажите число от 0,01 до ${max} ${unit}, не более двух знаков после запятой.`;
      }
    }
    if (!values.date_of_birth || values.date_of_birth < '1900-01-01' || values.date_of_birth > today) problems.date_of_birth = 'Укажите существующую дату рождения с 01.01.1900 по сегодня.';
    if (values.identifier_date && values.identifier_date < values.date_of_birth) problems['identifier.date'] = 'Дата идентификации не может быть раньше даты рождения.';
    if (!dog && owners.length === 0) problems.owner_ids = 'Выберите хотя бы одного владельца.';
    setError(null);
    setLocal((current) => ({ ...current, ...problems }));
    if (!valid || Object.keys(problems).length > 0) return;

    const identifier = { type_id: Number(values.identifier_type_id), number: values.identifier_number, date: values.identifier_date || null };
    setBusy(true);
    setError(null);
    try {
      if (!dog) {
        const created = await dogsApi.create({
          nickname: values.nickname,
          date_of_birth: values.date_of_birth,
          sex_id: Number(values.sex_id),
          breed_id: Number(values.breed_id),
          coat_color_id: Number(values.coat_color_id),
          status_id: Number(statusValue),
          identifier,
          height_cm: height,
          weight_kg: weight,
          owner_ids: owners.map((owner) => owner.id),
        });
        saved(created);
        navigate(`/dogs/${created.id}`, { replace: true });
        return;
      }
      const before = fromDog(dog);
      const patch: DogPatchInput = { version: dog.version };
      if (values.nickname !== before.nickname) patch.nickname = values.nickname;
      if (values.date_of_birth !== before.date_of_birth) patch.date_of_birth = values.date_of_birth;
      if (values.sex_id !== before.sex_id) patch.sex_id = Number(values.sex_id);
      if (values.breed_id !== before.breed_id) patch.breed_id = Number(values.breed_id);
      if (values.coat_color_id !== before.coat_color_id) patch.coat_color_id = Number(values.coat_color_id);
      if (values.status_id !== before.status_id) patch.status_id = Number(values.status_id);
      if (values.identifier_type_id !== before.identifier_type_id || values.identifier_number !== before.identifier_number || values.identifier_date !== before.identifier_date) {
        patch.identifier = identifier;
      }
      if (height !== dog.height_cm) patch.height_cm = height;
      if (weight !== dog.weight_kg) patch.weight_kg = weight;
      if (Object.keys(patch).length === 1) {
        setUnchanged(true);
        setBusy(false);
        return;
      }
      saved(await dogsApi.patch(dog.id, patch));
      navigate(`/dogs/${dog.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const options = dictionaries.data;
  return (
    <>
      <PageHeader eyebrow={dog ? `Собаки / ${dog.nickname}` : 'Собаки'} title={dog ? 'Изменить карточку' : 'Регистрация собаки'} />
      <Card>
        <form className={styles.form} noValidate onSubmit={submit}>
          <fieldset className={fieldStyles.fieldset}>
            <legend className={fieldStyles.legend}>Собака</legend>
            <div className={fieldStyles.row}>
              <TextField label="Кличка" required maxLength={100} value={values.nickname} onChange={set('nickname')} error={errors.nickname} />
              <TextField label="Дата рождения" type="date" required min="1900-01-01" max={today} onInvalid={() => setLocal((current) => ({ ...current, date_of_birth: 'Укажите существующую дату рождения с 01.01.1900 по сегодня.' }))} value={values.date_of_birth} onChange={set('date_of_birth')} error={errors.date_of_birth} />
            </div>
            <div className={fieldStyles.row}>
              <SelectField
                label="Пол"
                required
                placeholder="Выберите…"
                options={toOptions(options?.sexes ?? [])}
                value={values.sex_id}
                onChange={set('sex_id')}
                error={errors.sex_id}
              />
              <SelectField
                label="Порода"
                required
                placeholder="Выберите…"
                options={toOptions(options?.breeds ?? [])}
                value={values.breed_id}
                onChange={set('breed_id')}
                error={errors.breed_id}
              />
              <SelectField
                label="Окрас"
                required
                placeholder="Выберите…"
                options={toOptions(options?.coat_colors ?? [])}
                value={values.coat_color_id}
                onChange={set('coat_color_id')}
                error={errors.coat_color_id}
              />
            </div>
            <div className={fieldStyles.row}>
              <SelectField
                label="Статус"
                required
                placeholder="Выберите…"
                options={toOptions(options?.statuses ?? [])}
                value={statusValue}
                onChange={set('status_id')}
                error={errors.status_id}
                hint="Кроме «На учёте», статусы закрывают новые осмотры, прививки, занятия, вязки и мероприятия."
              />
              <TextField label="Рост, см" inputMode="decimal" value={values.height_cm} onChange={set('height_cm')} error={errors.height_cm} hint="Необязательно. От 0,01 до 150 см." />
              <TextField label="Вес, кг" inputMode="decimal" value={values.weight_kg} onChange={set('weight_kg')} error={errors.weight_kg} hint="Необязательно. От 0,01 до 200 кг." />
            </div>
          </fieldset>
          <fieldset className={fieldStyles.fieldset}>
            <legend className={fieldStyles.legend}>Идентификация</legend>
            <div className={fieldStyles.row}>
              <SelectField
                label="Тип"
                required
                placeholder="Выберите…"
                options={toOptions(options?.identifier_types ?? [])}
                value={values.identifier_type_id}
                onChange={set('identifier_type_id')}
                error={errors['identifier.type_id']}
              />
              <TextField
                label="Номер"
                required
                maxLength={100}
                value={values.identifier_number}
                onChange={set('identifier_number')}
                error={errors['identifier.number']}
                hint="Хранится как строка: ведущие нули сохраняются."
              />
              <TextField
                label="Дата идентификации"
                type="date"
                min={values.date_of_birth || undefined}
                max={today}
                value={values.identifier_date}
                onChange={set('identifier_date')}
                onInvalid={() => setLocal((current) => ({ ...current, 'identifier.date': 'Дата идентификации должна быть не раньше рождения и не позднее сегодняшней.' }))}
                error={errors['identifier.date']}
                hint="Необязательно."
              />
            </div>
          </fieldset>
          {!dog && (
            <fieldset className={fieldStyles.fieldset}>
              <legend className={fieldStyles.legend}>Владельцы</legend>
              <MemberPicker label="Найти члена клуба" value={owners} onChange={setOwners} error={errors.owner_ids} />
            </fieldset>
          )}
          {dog && <p className={styles.note}>Владельцы, родословная, титулы и дата регистрации ({formatDate(dog.registration_date)}) меняются на своих вкладках карточки.</p>}
          {unchanged && <Alert tone="info">Изменений нет — сохранять нечего.</Alert>}
          {error ? <ProblemAlert error={error} onReload={dog ? () => void client.invalidateQueries({ queryKey: dogKeys.card(dog.id) }) : undefined} /> : null}
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={busy}>
              {dog ? 'Сохранить' : 'Зарегистрировать'}
            </Button>
            <Link to={dog ? `/dogs/${dog.id}` : '/dogs'}>Отмена</Link>
          </div>
        </form>
      </Card>
    </>
  );
}
