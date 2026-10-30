import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { fieldErrors, localProblem } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, pluralize, todayUTC } from '../../shared/format';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Fact,
  Facts,
  FormDialog,
  Loading,
  PageHeader,
  QueryError,
  ReasonDialog,
  SelectField,
  Table,
  TextArea,
  TextField,
  fieldStyles,
  tableStyles,
  toOptions,
  MAX_REASON,
} from '../../shared/ui';
import { DogPicker } from '../dogs/DogPicker';
import { dogsApi, useDogDictionaries } from '../dogs/dogsApi';
import { MemberPicker, type PickedMember } from '../members/MemberPicker';
import { breedingApi, useBreedingSaved, useLitter, type Litter } from './breedingApi';
import { BreedingHistory, DogName } from './parts';
import styles from './breeding.module.css';

export function LitterPage() {
  const litter = useLitter(Number(useParams().litterID));
  if (litter.isPending) return <Loading label="Загружаем помёт…" />;
  if (litter.isError) return <QueryError error={litter.error} onRetry={() => void litter.refetch()} />;
  return <LitterCard litter={litter.data} onReload={() => void litter.refetch()} />;
}

interface PuppyDraft {
  nickname: string;
  sex_id: string;
  coat_color_id: string;
  identifier_type_id: string;
  identifier_number: string;
  owners: PickedMember[];
  reason: string;
}

const emptyPuppy: PuppyDraft = { nickname: '', sex_id: '', coat_color_id: '', identifier_type_id: '', identifier_number: '', owners: [], reason: '' };

/** Puppies get ordinary dog cards; birth date, breed and parents come from the litter. */
function LitterCard({ litter, onReload }: { litter: Litter; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff';
  const saved = useBreedingSaved();
  // Only staff registers puppies; the expert may not read dog dictionaries at all.
  const dictionaries = useDogDictionaries(staff);
  const [dialog, setDialog] = useState<'correct' | 'register' | 'link' | null>(null);
  const [unlinking, setUnlinking] = useState<number | null>(null);
  const [birth, setBirth] = useState(litter.date_of_birth);
  const [total, setTotal] = useState(String(litter.total_puppies));
  const [puppy, setPuppy] = useState<PuppyDraft>(emptyPuppy);
  const [linked, setLinked] = useState<{ id: number; nickname: string } | null>(null);
  const [linkReason, setLinkReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const free = litter.total_puppies - litter.dog_ids.length;
  const activeStatus = dictionaries.data?.statuses.find((status) => status.is_active);

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
  const close = () => {
    setDialog(null);
    setUnlinking(null);
    setError(null);
  };

  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/breeding?tab=litters">Помёты</Link> / Помёт {litter.id}
      </nav>
      <PageHeader
        eyebrow={`Помёт ${litter.id}`}
        title="Помёт"
        actions={
          staff && (
            <Button
              variant="secondary"
              onClick={() => {
                setBirth(litter.date_of_birth);
                setTotal(String(litter.total_puppies));
                setDialog('correct');
              }}
            >
              Исправить
            </Button>
          )
        }
      />
      <div className={styles.pair}>
        <span className={styles.pairName}>
          <DogName id={litter.female_dog_id} />
        </span>
        <span className={styles.pairCross} aria-label="и">
          ×
        </span>
        <span className={styles.pairName}>
          <DogName id={litter.male_dog_id} />
        </span>
      </div>
      <Facts>
        <Fact label="Рождение" value={formatDate(litter.date_of_birth)} />
        <Fact label="Щенков" value={litter.total_puppies} note={`карточек: ${litter.dog_ids.length}`} />
        <Fact
          label="Прошлый помёт"
          value={litter.previous_birth_date ? formatDate(litter.previous_birth_date) : 'Неизвестен'}
          note={litter.interval_days !== null ? `интервал ${pluralize(litter.interval_days, 'день', 'дня', 'дней')}` : undefined}
        />
        <Fact label="Вязка" value={<Link to={`/breeding/matings/${litter.breeding_id}`}>Вязка {litter.breeding_id}</Link>} />
      </Facts>
      {litter.interval_violation && <Alert tone="warning">Между рождениями помётов меньше 365 дней. Помёт сохранён как факт, правило клуба нарушено.</Alert>}

      <Card
        heading={
          <span className={styles.heading}>
            Щенки
            {staff && free > 0 && (
              <span className={styles.actions}>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    setLinked(null);
                    setLinkReason('');
                    setDialog('link');
                  }}
                >
                  Связать карточку
                </Button>
                <Button
                  variant="save"
                  size="small"
                  onClick={() => {
                    setPuppy(emptyPuppy);
                    setDialog('register');
                  }}
                >
                  Зарегистрировать щенка
                </Button>
              </span>
            )}
          </span>
        }
      >
        {litter.dog_ids.length === 0 ? (
          <EmptyState title="Карточек щенков пока нет" />
        ) : (
          <Table caption="Щенки помёта">
            <thead>
              <tr>
                <th scope="col">Кличка</th>
                {staff && <th scope="col">Действия</th>}
              </tr>
            </thead>
            <tbody>
              {litter.dog_ids.map((id) => (
                <tr key={id}>
                  <td>
                    <DogName id={id} />
                  </td>
                  {staff && (
                    <td>
                      <span className={tableStyles.actions}>
                        <Button variant="danger" onClick={() => setUnlinking(id)}>
                          Снять связь
                        </Button>
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {staff && free > 0 && <p className={styles.note}>Можно добавить ещё {pluralize(free, 'карточку', 'карточки', 'карточек')}.</p>}
      </Card>
      <BreedingHistory entity="litters" id={litter.id} />

      <ReasonDialog
        open={dialog === 'correct'}
        title="Исправить помёт"
        description="Дату нельзя менять, пока к помёту привязаны щенки; число щенков — не меньше привязанных карточек."
        confirmLabel="Сохранить"
        ready={Boolean(birth && Number(total) > 0)}
        onReload={onReload}
        onClose={close}
        onConfirm={(reason) => run(() => breedingApi.correctLitter(litter.id, { version: litter.version, date_of_birth: birth, total_puppies: Number(total), reason }))}
      >
        <TextField label="Дата рождения" type="date" required max={todayUTC()} value={birth} onChange={(event) => setBirth(event.target.value)} error={errors.date_of_birth} />
        <TextField label="Число щенков" type="number" min={1} max={2147483647} step={1} inputMode="numeric" required value={total} onChange={(event) => setTotal(event.target.value)} error={errors.total_puppies} />
      </ReasonDialog>

      <FormDialog
        open={dialog === 'register'}
        title="Зарегистрировать щенка"
        description={`Порода, дата рождения (${formatDate(litter.date_of_birth)}) и родители возьмутся из помёта.`}
        confirmLabel="Зарегистрировать"
        ready={Boolean(
          puppy.nickname.trim() &&
            puppy.sex_id &&
            puppy.coat_color_id &&
            puppy.identifier_type_id &&
            puppy.identifier_number.trim() &&
            puppy.owners.length > 0 &&
            puppy.reason.trim(),
        )}
        check={() => {
          const missing = localProblem({ owner_ids: puppy.owners.length === 0 ? 'Выберите хотя бы одного владельца.' : undefined });
          setError(missing);
          return !missing;
        }}
        onReload={onReload}
        onClose={close}
        onSubmit={() =>
          run(() =>
            breedingApi.registerPuppy(litter.id, {
              version: litter.version,
              nickname: puppy.nickname,
              sex_id: Number(puppy.sex_id),
              coat_color_id: Number(puppy.coat_color_id),
              status_id: activeStatus?.id ?? 0,
              identifier: { type_id: Number(puppy.identifier_type_id), number: puppy.identifier_number },
              owner_ids: puppy.owners.map((owner) => owner.id),
              reason: puppy.reason.trim(),
            }),
          )
        }
      >
        <TextField
          label="Кличка"
          required
          maxLength={100}
          value={puppy.nickname}
          onChange={(event) => setPuppy({ ...puppy, nickname: event.target.value })}
          error={errors.nickname}
        />
        <div className={fieldStyles.row}>
          <SelectField
            label="Пол"
            required
            placeholder="Выберите…"
            options={toOptions(dictionaries.data?.sexes ?? [])}
            value={puppy.sex_id}
            onChange={(event) => setPuppy({ ...puppy, sex_id: event.target.value })}
            error={errors.sex_id}
          />
          <SelectField
            label="Окрас"
            required
            placeholder="Выберите…"
            options={toOptions(dictionaries.data?.coat_colors ?? [])}
            value={puppy.coat_color_id}
            onChange={(event) => setPuppy({ ...puppy, coat_color_id: event.target.value })}
            error={errors.coat_color_id}
          />
        </div>
        <div className={fieldStyles.row}>
          <SelectField
            label="Тип идентификатора"
            required
            placeholder="Выберите…"
            options={toOptions(dictionaries.data?.identifier_types ?? [])}
            value={puppy.identifier_type_id}
            onChange={(event) => setPuppy({ ...puppy, identifier_type_id: event.target.value })}
            error={errors['identifier.type_id']}
          />
          <TextField
            label="Номер"
            required
            maxLength={100}
            value={puppy.identifier_number}
            onChange={(event) => setPuppy({ ...puppy, identifier_number: event.target.value })}
            error={errors['identifier.number']}
          />
        </div>
        <MemberPicker label="Владельцы" value={puppy.owners} onChange={(owners) => setPuppy({ ...puppy, owners })} error={errors.owner_ids} />
        <TextArea
          label="Причина"
          required
          maxLength={MAX_REASON}
          value={puppy.reason}
          onChange={(event) => setPuppy({ ...puppy, reason: event.target.value })}
          hint="Сохранится в истории помёта."
        />
      </FormDialog>

      <FormDialog
        open={dialog === 'link'}
        title="Связать существующую карточку"
        description="Дата рождения и порода собаки должны совпасть с помётом. Пустые сведения о родителях заполнятся из помёта."
        confirmLabel="Связать"
        ready={Boolean(linked && linkReason.trim())}
        check={() => {
          const missing = localProblem({ dog_id: linked ? undefined : 'Выберите собаку.' });
          setError(missing);
          return !missing;
        }}
        onReload={onReload}
        onClose={close}
        onSubmit={async () => {
          if (!linked) return;
          // The link needs the current dog version: read the card right before linking.
          const dog = await dogsApi.get(linked.id);
          await run(() => breedingApi.linkPuppy(litter.id, { version: litter.version, dog_id: dog.id, dog_version: dog.version, reason: linkReason.trim() }));
        }}
      >
        {linked ? (
          <div className={styles.picked}>
            <b>{linked.nickname}</b>
            <Button variant="link" onClick={() => setLinked(null)}>
              Выбрать другую
            </Button>
          </div>
        ) : (
          <DogPicker label="Найти собаку" onPick={(dog) => setLinked({ id: dog.id, nickname: dog.nickname })} error={errors.dog_id} />
        )}
        <TextArea label="Причина" required maxLength={MAX_REASON} value={linkReason} onChange={(event) => setLinkReason(event.target.value)} hint="Сохранится в истории помёта." />
      </FormDialog>

      <ReasonDialog
        open={unlinking !== null}
        title="Снять связь со щенком"
        description="Карточка собаки и её родословная сохранятся; исправьте их отдельно, если нужно."
        confirmLabel="Снять связь"
        onReload={onReload}
        onClose={close}
        onConfirm={(reason) => run(() => breedingApi.unlinkPuppy(litter.id, unlinking!, litter.version, reason))}
      />
    </>
  );
}
