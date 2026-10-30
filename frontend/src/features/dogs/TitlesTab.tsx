import { useState, type FormEvent } from 'react';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, todayUTC } from '../../shared/format';
import { Button, Card, EmptyState, ProblemAlert, ReasonDialog, SelectField, Table, TextArea, TextField, fieldStyles, reportInvalid, tableStyles, toOptions } from '../../shared/ui';
import { dogsApi, useDogDictionaries, useDogSaved, type Dog } from './dogsApi';
import styles from './dogs.module.css';

type DogTitle = Dog['titles'][number];

/** Already awarded official titles; corrections and removals keep a reason in history. */
export function TitlesTab({ dog, onReload }: { dog: Dog; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff';
  const saved = useDogSaved();
  const [editing, setEditing] = useState<DogTitle | null>(null);
  const [removing, setRemoving] = useState<DogTitle | null>(null);
  const [awarded, setAwarded] = useState('');
  const [basis, setBasis] = useState('');

  const edit = (title: DogTitle) => {
    setAwarded(title.awarded_on ?? '');
    setBasis(title.basis);
    setEditing(title);
  };

  return (
    <>
      <Card heading="Титулы">
        {dog.titles.length === 0 ? (
          <EmptyState title="Титулов пока нет" />
        ) : (
          <Table caption="Титулы собаки">
            <thead>
              <tr>
                <th scope="col">Титул</th>
                <th scope="col">Присвоен</th>
                <th scope="col">Основание</th>
                {staff && <th scope="col">Действия</th>}
              </tr>
            </thead>
            <tbody>
              {dog.titles.map((title) => (
                <tr key={title.type.id}>
                  <td>
                    <b>{title.type.name}</b>
                  </td>
                  <td className={tableStyles.nowrap}>{formatDate(title.awarded_on)}</td>
                  <td>{title.basis || <span className={tableStyles.muted}>—</span>}</td>
                  {staff && (
                    <td>
                      <span className={tableStyles.actions}>
                        <Button variant="link" onClick={() => edit(title)}>
                          Исправить
                        </Button>
                        <Button variant="danger" onClick={() => setRemoving(title)}>
                          Отметить ошибочной
                        </Button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className={styles.note}>Здесь записывают уже присвоенные титулы: система не присваивает их сама и не снимает по сроку.</p>
      </Card>
      {staff && <AddTitle dog={dog} onReload={onReload} />}

      <ReasonDialog
        onReload={onReload}
        open={editing !== null}
        title={`Исправить запись «${editing?.type.name ?? ''}»`}
        confirmLabel="Сохранить"
        onClose={() => setEditing(null)}
        onConfirm={async (reason) => {
          if (!editing) return;
          saved(await dogsApi.updateTitle(dog.id, editing.type.id, { version: dog.version, awarded_on: awarded || null, basis: basis.trim(), reason }));
        }}
      >
        <TextField label="Дата присвоения" type="date" min={dog.date_of_birth} max={todayUTC()} value={awarded} onChange={(event) => setAwarded(event.target.value)} />
        <TextArea label="Основание" maxLength={1000} value={basis} onChange={(event) => setBasis(event.target.value)} />
      </ReasonDialog>
      <ReasonDialog
        onReload={onReload}
        open={removing !== null}
        title={`Отметить ошибочной запись «${removing?.type.name ?? ''}»`}
        description="Это исправление учёта, а не лишение официального титула. Прежняя запись останется в истории."
        confirmLabel="Отметить ошибочной"
        onClose={() => setRemoving(null)}
        onConfirm={async (reason) => {
          if (!removing) return;
          saved(await dogsApi.removeTitle(dog.id, removing.type.id, dog.version, reason));
        }}
      />
    </>
  );
}

function AddTitle({ dog, onReload }: { dog: Dog; onReload: () => void }) {
  const saved = useDogSaved();
  const dictionaries = useDogDictionaries();
  const recorded = new Set(dog.titles.map((title) => title.type.id));
  const available = (dictionaries.data?.titles ?? []).filter((title) => !recorded.has(title.id));
  const [titleID, setTitleID] = useState('');
  const [awarded, setAwarded] = useState('');
  const [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reportInvalid(event.currentTarget)) return;
    setBusy(true);
    setError(null);
    try {
      saved(await dogsApi.recordTitle(dog.id, { version: dog.version, title_id: Number(titleID), awarded_on: awarded || null, basis: basis.trim() || undefined }));
      setTitleID('');
      setAwarded('');
      setBasis('');
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (available.length === 0) return null;
  return (
    <Card heading="Записать титул">
      <form className={styles.form} noValidate onSubmit={submit}>
        <div className={fieldStyles.row}>
          <SelectField
            label="Титул"
            required
            placeholder="Выберите…"
            options={toOptions(available)}
            value={titleID}
            onChange={(event) => setTitleID(event.target.value)}
            error={errors.title_id}
          />
          <TextField
            label="Дата присвоения"
            type="date"
            min={dog.date_of_birth}
            max={todayUTC()}
            value={awarded}
            onChange={(event) => setAwarded(event.target.value)}
            error={errors.awarded_on}
            hint="Необязательно."
          />
        </div>
        <TextArea
          label="Основание"
          maxLength={1000}
          value={basis}
          onChange={(event) => setBasis(event.target.value)}
          error={errors.basis}
          hint="Например, номер диплома. Необязательно."
        />
        {error ? <ProblemAlert error={error} onReload={onReload} /> : null}
        <Button type="submit" variant="save" className={styles.start} busy={busy}>
          Записать титул
        </Button>
      </form>
    </Card>
  );
}
