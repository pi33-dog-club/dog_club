import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate } from '../../shared/format';
import { Alert, Button, Card, Chip, ProblemAlert, Tabs, TextField, fieldStyles, reportInvalid, tabPanelProps } from '../../shared/ui';
import clsx from '../../shared/ui/clsx';
import { DogPicker } from './DogPicker';
import { dogsApi, useDog, useDogDictionaries, useDogSaved, type Dog, type DogParent, type DogParentInput } from './dogsApi';
import styles from './dogs.module.css';

/** Lab 3, variant A: a pedigree document (number and issuer) makes three generations known. */
export function hasPedigreeDocument(dog: Dog): boolean {
  return dog.pedigree.number.trim() !== '' && dog.pedigree.issuer.trim() !== '';
}

export function PedigreeTab({ dog, onReload }: { dog: Dog; onReload: () => void }) {
  const { profile } = useSession();
  const [editing, setEditing] = useState(false);
  const staff = profile.role === 'staff';
  if (editing) return <PedigreeForm dog={dog} onDone={() => setEditing(false)} onReload={onReload} />;
  const documented = hasPedigreeDocument(dog);
  return (
    <Card
      heading={
        <span className={styles.cardHeading}>
          Родословная
          {staff && (
            <Button variant="secondary" size="small" onClick={() => setEditing(true)}>
              Изменить
            </Button>
          )}
        </span>
      }
    >
      <div className={styles.pedigreeDoc}>
        {documented ? <Chip tone="lime">Известна на 3 поколения</Chip> : <Chip tone="sun">Нет документа родословной</Chip>}
        <span>
          {documented ? (
            <>
              Документ <b>{dog.pedigree.number}</b>, {dog.pedigree.issuer}
            </>
          ) : (
            'Для выставок и соревнований нужны номер и организация документа родословной либо карточки клуба на родителей, дедов и известных прадедов.'
          )}
        </span>
      </div>
      <PedigreeTree dog={dog} />
      <p className={styles.note}>Сплошная рамка — собака есть в клубе, пунктир — родитель указан внешними сведениями.</p>
    </Card>
  );
}

function PedigreeTree({ dog }: { dog: Dog }) {
  const { profile } = useSession();
  // Owners read only their own dogs, so ancestors' cards open for staff and leader.
  const deep = profile.role !== 'owner';
  const father = useDog(dog.pedigree.father?.dog_id ?? 0, deep && Boolean(dog.pedigree.father?.dog_id));
  const mother = useDog(dog.pedigree.mother?.dog_id ?? 0, deep && Boolean(dog.pedigree.mother?.dog_id));
  return (
    <div className={clsx(styles.tree, deep && styles.treeDeep)}>
      <div className={styles.treeColumn}>
        <ParentNode self={dog} role={`${dog.sex.name} · ${formatDate(dog.date_of_birth)}`} />
      </div>
      <div className={styles.treeColumn}>
        <ParentNode parent={dog.pedigree.father} role="Отец" link={deep} />
        <ParentNode parent={dog.pedigree.mother} role="Мать" link={deep} />
      </div>
      {deep && (
        <div className={styles.treeColumn}>
          <ParentNode parent={father.data?.pedigree.father ?? null} role="Дед по отцу" link small />
          <ParentNode parent={father.data?.pedigree.mother ?? null} role="Бабка по отцу" link small />
          <ParentNode parent={mother.data?.pedigree.father ?? null} role="Дед по матери" link small />
          <ParentNode parent={mother.data?.pedigree.mother ?? null} role="Бабка по матери" link small />
        </div>
      )}
    </div>
  );
}

interface NodeProps {
  parent?: DogParent | null;
  self?: Dog;
  role: string;
  link?: boolean;
  small?: boolean;
}

function ParentNode({ parent, self, role, link, small }: NodeProps) {
  if (self) {
    return (
      <div className={clsx(styles.node, styles.nodeSelf)}>
        <span className={styles.nodeName}>{self.nickname}</span>
        <span className={styles.nodeRole}>{role}</span>
      </div>
    );
  }
  if (parent?.dog) {
    const name = link ? <Link to={`/dogs/${parent.dog.id}`}>{parent.dog.nickname}</Link> : parent.dog.nickname;
    return (
      <div className={clsx(styles.node, small && styles.nodeSmall)}>
        <span className={styles.nodeRole}>{role} · в клубе</span>
        <span className={styles.nodeName}>{name}</span>
        <span className={styles.nodeNote}>
          {parent.dog.breed.name} · {formatDate(parent.dog.date_of_birth)}
        </span>
      </div>
    );
  }
  if (parent?.external) {
    const { nickname, pedigree_number, issuer } = parent.external;
    return (
      <div className={clsx(styles.node, styles.nodeExternal, small && styles.nodeSmall)}>
        <span className={styles.nodeRole}>{role} · внешние сведения</span>
        <span className={styles.nodeName}>{nickname || 'Без клички'}</span>
        {(pedigree_number || issuer) && <span className={styles.nodeNote}>{[pedigree_number, issuer].filter(Boolean).join(', ')}</span>}
      </div>
    );
  }
  return (
    <div className={clsx(styles.node, styles.nodeUnknown, small && styles.nodeSmall)}>
      <span className={styles.nodeRole}>{role}</span>
      <span className={styles.nodeNote}>Нет сведений</span>
    </div>
  );
}

type Mode = 'none' | 'club' | 'external';

interface ParentDraft {
  mode: Mode;
  dog: { id: number; nickname: string; note: string; birth: string } | null;
  nickname: string;
  pedigree_number: string;
  issuer: string;
}

function draftOf(parent: DogParent | null): ParentDraft {
  const draft: ParentDraft = { mode: 'none', dog: null, nickname: '', pedigree_number: '', issuer: '' };
  if (parent?.dog)
    return { ...draft, mode: 'club', dog: { id: parent.dog.id, nickname: parent.dog.nickname, note: `${parent.dog.breed.name} · ${formatDate(parent.dog.date_of_birth)}`, birth: parent.dog.date_of_birth } };
  if (parent?.external) return { ...draft, mode: 'external', ...parent.external };
  return draft;
}

function inputOf(draft: ParentDraft): DogParentInput | null {
  if (draft.mode === 'club' && draft.dog) return { dog_id: draft.dog.id };
  if (draft.mode === 'external') {
    const external: Record<string, string> = {};
    for (const key of ['nickname', 'pedigree_number', 'issuer'] as const) {
      if (draft[key].trim()) external[key] = draft[key].trim();
    }
    return { external } as DogParentInput;
  }
  return null;
}

/** Replaces the whole pedigree: document, mother and father; staff only. */
function PedigreeForm({ dog, onDone, onReload }: { dog: Dog; onDone: () => void; onReload: () => void }) {
  const saved = useDogSaved();
  const dictionaries = useDogDictionaries();
  const sexID = (name: string) => dictionaries.data?.sexes.find((sex) => sex.name === name)?.id;
  const [number, setNumber] = useState(dog.pedigree.number);
  const [issuer, setIssuer] = useState(dog.pedigree.issuer);
  const [mother, setMother] = useState(() => draftOf(dog.pedigree.mother));
  const [father, setFather] = useState(() => draftOf(dog.pedigree.father));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...fieldErrors(error), ...local };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Browser checks report through onInvalid; the form's own checks are added on top.
    setLocal({});
    const valid = reportInvalid(event.currentTarget);
    const problems: Record<string, string> = {};
    for (const [key, draft] of [
      ['mother', mother],
      ['father', father],
    ] as const) {
      if (draft.mode === 'club' && !draft.dog) problems[key] = 'Выберите собаку клуба или другой вариант.';
      if (draft.mode === 'club' && draft.dog && draft.dog.birth >= dog.date_of_birth) {
        problems[key] = `${draft.dog.nickname} — ${key === 'mother' ? 'родилась' : 'родился'} ${formatDate(draft.dog.birth)}, не раньше этой собаки (${formatDate(dog.date_of_birth)}). Родитель должен быть старше.`;
      }
      if (draft.mode === 'external' && !draft.nickname.trim() && !draft.pedigree_number.trim()) problems[key] = 'Укажите кличку или номер родословной.';
    }
    if (Boolean(number.trim()) !== Boolean(issuer.trim())) problems[number.trim() ? 'issuer' : 'number'] = 'Номер и организация заполняются вместе.';
    setLocal((current) => ({ ...current, ...problems }));
    if (!valid || Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      saved(
        await dogsApi.setPedigree(dog.id, {
          version: dog.version,
          ...(number.trim() && { number: number.trim(), issuer: issuer.trim() }),
          mother: inputOf(mother),
          father: inputOf(father),
        }),
      );
      onDone();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <Card heading="Родословная">
      <form className={styles.form} noValidate onSubmit={submit}>
        <fieldset className={fieldStyles.fieldset}>
          <legend className={fieldStyles.legend}>Документ родословной</legend>
          <div className={fieldStyles.row}>
            <TextField
              label="Номер родословной"
              maxLength={100}
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              error={errors.number}
              hint="Нужны для допуска на выставки и соревнования."
            />
            <TextField label="Организация" maxLength={150} value={issuer} onChange={(event) => setIssuer(event.target.value)} error={errors.issuer} hint="Например, РКФ." />
          </div>
        </fieldset>
        <ParentEditor
          legend="Мать"
          idPrefix="mother"
          draft={mother}
          onChange={setMother}
          sexID={sexID('Сука')}
          excludeID={dog.id}
          bornBefore={dog.date_of_birth}
          error={errors.mother ?? errors['mother.dog_id']}
        />
        <ParentEditor
          legend="Отец"
          idPrefix="father"
          draft={father}
          onChange={setFather}
          sexID={sexID('Кобель')}
          excludeID={dog.id}
          bornBefore={dog.date_of_birth}
          error={errors.father ?? errors['father.dog_id']}
        />
        <p className={styles.note}>Сервер проверит пол и возраст родителей и отсутствие циклов в родословной.</p>
        {error ? <ProblemAlert error={error} onReload={onReload} /> : null}
        <div className={styles.actions}>
          <Button type="submit" variant="save" busy={busy}>
            Сохранить родословную
          </Button>
          <Button variant="secondary" onClick={onDone} disabled={busy}>
            Отмена
          </Button>
        </div>
      </form>
    </Card>
  );
}

const modes = [
  { value: 'none', label: 'Неизвестен' },
  { value: 'club', label: 'Собака клуба' },
  { value: 'external', label: 'Внешние сведения' },
] as const;

interface ParentEditorProps {
  legend: string;
  idPrefix: string;
  draft: ParentDraft;
  onChange: (draft: ParentDraft) => void;
  sexID?: number;
  excludeID: number;
  bornBefore: string;
  error?: string;
}

function ParentEditor({ legend, idPrefix, draft, onChange, sexID, excludeID, bornBefore, error }: ParentEditorProps) {
  const set = (patch: Partial<ParentDraft>) => onChange({ ...draft, ...patch });
  return (
    <fieldset className={fieldStyles.fieldset}>
      <legend className={fieldStyles.legend}>{legend}</legend>
      <Tabs label={`${legend}: источник сведений`} idPrefix={idPrefix} value={draft.mode} options={modes} onChange={(mode) => set({ mode })} />
      <div {...tabPanelProps(idPrefix, draft.mode)}>
        {draft.mode === 'none' && <p className={styles.note}>Родитель не указан.</p>}
        {draft.mode === 'club' &&
          (draft.dog ? (
            <div className={styles.picked}>
              <span>
                <b>{draft.dog.nickname}</b> <span className={styles.note}>{draft.dog.note}</span>
              </span>
              <Button variant="link" onClick={() => set({ dog: null })}>
                Выбрать другую
              </Button>
            </div>
          ) : (
            <DogPicker
              label={`Найти: ${legend.toLowerCase()}`}
              sexID={sexID}
              excludeID={excludeID}
              bornBefore={bornBefore}
              onPick={(dog) => set({ dog: { id: dog.id, nickname: dog.nickname, note: `${dog.breed.name} · ${formatDate(dog.date_of_birth)}`, birth: dog.date_of_birth } })}
            />
          ))}
        {draft.mode === 'external' && (
          <div className={fieldStyles.row}>
            <TextField label="Кличка" maxLength={100} value={draft.nickname} onChange={(event) => set({ nickname: event.target.value })} />
            <TextField label="Номер родословной" maxLength={100} value={draft.pedigree_number} onChange={(event) => set({ pedigree_number: event.target.value })} />
            <TextField label="Организация" maxLength={150} value={draft.issuer} onChange={(event) => set({ issuer: event.target.value })} />
          </div>
        )}
      </div>
      {error && (
        <div data-field-error>
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </fieldset>
  );
}
