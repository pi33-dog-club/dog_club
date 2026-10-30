import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, todayUTC } from '../../shared/format';
import { Alert, Button, Chip, Fact, Facts, Loading, PageHeader, QueryError, ReasonDialog, SelectField, TextField } from '../../shared/ui';
import { breedingApi, useBreedingSaved, useLitters, useMating, type Mating } from './breedingApi';
import { outcomes } from './labels';
import { BreedingHistory, DogName } from './parts';
import { PairCheck } from './RequestPage';
import styles from './breeding.module.css';

export function MatingPage() {
  const mating = useMating(Number(useParams().matingID));
  if (mating.isPending) return <Loading label="Загружаем вязку…" />;
  if (mating.isError) return <QueryError error={mating.error} onRetry={() => void mating.refetch()} />;
  return <MatingCard mating={mating.data} onReload={() => void mating.refetch()} />;
}

/** A performed mating: its outcome is clarified later, a litter is registered separately. */
function MatingCard({ mating, onReload }: { mating: Mating; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff';
  const navigate = useNavigate();
  const saved = useBreedingSaved();
  const litters = useLitters(mating.female_dog_id);
  const litter = litters.data?.find((item) => item.breeding_id === mating.id);
  const [dialog, setDialog] = useState<'outcome' | 'litter' | null>(null);
  const [outcome, setOutcome] = useState<Mating['outcome']>(mating.outcome);
  const [birth, setBirth] = useState('');
  const [total, setTotal] = useState('');
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const outcomeItem = outcomes[mating.outcome];

  const run = async <T,>(action: () => Promise<T>) => {
    try {
      const result = await action();
      setError(null);
      await saved();
      return result;
    } catch (failure) {
      setError(failure);
      throw failure;
    }
  };
  const close = () => {
    setDialog(null);
    setError(null);
  };

  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/breeding?tab=matings">Вязки</Link> / Вязка {mating.id}
      </nav>
      <PageHeader
        eyebrow={`Вязка ${mating.id}`}
        title="Вязка"
        actions={
          staff &&
          !litter && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setOutcome(mating.outcome === 'litter' ? 'unknown' : mating.outcome);
                  setDialog('outcome');
                }}
              >
                Уточнить исход
              </Button>
              <Button
                variant="save"
                onClick={() => {
                  setBirth('');
                  setTotal('');
                  setDialog('litter');
                }}
              >
                Зарегистрировать помёт
              </Button>
            </>
          )
        }
      />
      <div className={styles.pair}>
        <span className={styles.pairName}>
          <DogName id={mating.female_dog_id} />
        </span>
        <span className={styles.pairCross} aria-label="и">
          ×
        </span>
        <span className={styles.pairName}>
          <DogName id={mating.male_dog_id} />
        </span>
      </div>
      <Facts>
        <Fact label="Дата" value={formatDate(mating.date)} />
        <Fact label="Исход" value={<Chip tone={outcomeItem.tone}>{outcomeItem.label}</Chip>} />
        <Fact label="Заявка" value={mating.request_id ? <Link to={`/breeding/requests/${mating.request_id}`}>Заявка {mating.request_id}</Link> : 'Без заявки'} />
        <Fact label="Помёт" value={litter ? <Link to={`/breeding/litters/${litter.id}`}>Помёт {litter.id}</Link> : 'Не зарегистрирован'} note={`Версия ${mating.version}`} />
      </Facts>
      {mating.legacy_puppy_count !== null && <Alert tone="info">Старая запись: в прежнем учёте указано щенков — {mating.legacy_puppy_count}.</Alert>}
      {mating.outcome === 'unknown' && <p className={styles.note}>Пока исход неизвестен, следующую вязку этой суки одобрить нельзя.</p>}
      {mating.assessment && <PairCheck assessment={mating.assessment} title="Проверка пары при проведении" />}
      <BreedingHistory entity="breedings" id={mating.id} />

      <ReasonDialog
        open={dialog === 'outcome'}
        title="Уточнить исход"
        description="Исход «Помёт» ставится сам при регистрации помёта."
        confirmLabel="Сохранить"
        ready={outcome !== mating.outcome}
        onReload={onReload}
        onClose={close}
        onConfirm={async (reason) => {
          await run(() => breedingApi.correctMating(mating.id, { version: mating.version, date: mating.date ?? '', outcome, reason }));
        }}
      >
        <SelectField
          label="Исход"
          options={[
            { value: 'unknown', label: outcomes.unknown.label },
            { value: 'no_litter', label: outcomes.no_litter.label },
          ]}
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as Mating['outcome'])}
          error={errors.outcome}
        />
      </ReasonDialog>
      <ReasonDialog
        open={dialog === 'litter'}
        title="Зарегистрировать помёт"
        description="Дата рождения позже вязки; щенков больше нуля. Интервал с прошлым помётом сервер посчитает сам."
        confirmLabel="Зарегистрировать"
        ready={Boolean(birth && Number(total) > 0)}
        onReload={onReload}
        onClose={close}
        onConfirm={async (reason) => {
          const created = await run(() =>
            breedingApi.createLitter({ breeding_id: mating.id, version: mating.version, date_of_birth: birth, total_puppies: Number(total), reason }),
          );
          navigate(`/breeding/litters/${created.id}`);
        }}
      >
        <TextField
          label="Дата рождения"
          type="date"
          required
          min={mating.date ?? undefined}
          max={todayUTC()}
          value={birth}
          onChange={(event) => setBirth(event.target.value)}
          error={errors.date_of_birth}
        />
        <TextField label="Число щенков" type="number" min={1} max={2147483647} step={1} inputMode="numeric" required value={total} onChange={(event) => setTotal(event.target.value)} error={errors.total_puppies} />
      </ReasonDialog>
    </>
  );
}
