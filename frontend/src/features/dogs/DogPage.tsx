import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatAge, formatDate, pluralize, todayUTC } from '../../shared/format';
import { Alert, Button, ButtonLink, Chip, Fact, Facts, Loading, QueryError, ReasonDialog, Tabs, TextField, tabPanelProps } from '../../shared/ui';
import { DogBreedingTab } from '../breeding/DogBreedingTab';
import { DogTrainingTab } from '../training/DogTrainingTab';
import { HealthTab } from '../veterinary/HealthTab';
import { DogHistoryTab } from './DogHistoryTab';
import { dogsApi, isActiveStatus, useDog, useDogDictionaries, useDogSaved, type Dog } from './dogsApi';
import { OwnersTab } from './OwnersTab';
import { DogPhoto } from './DogPhoto';
import { PhotoControls } from './PhotoControls';
import { PedigreeTab } from './PedigreeTab';
import { TitlesTab } from './TitlesTab';
import styles from './dogs.module.css';

const tabs = [
  { value: 'health', label: 'Здоровье' },
  { value: 'pedigree', label: 'Родословная' },
  { value: 'titles', label: 'Титулы' },
  { value: 'owners', label: 'Владельцы' },
  { value: 'breeding', label: 'Вязки' },
  { value: 'training', label: 'Дрессировка' },
  { value: 'history', label: 'История' },
] as const;
type Tab = (typeof tabs)[number]['value'];

export function DogPage() {
  const id = Number(useParams().dogID);
  const dog = useDog(id);
  if (dog.isPending) return <Loading label="Загружаем карточку…" />;
  if (dog.isError) return <QueryError error={dog.error} onRetry={() => void dog.refetch()} />;
  return <DogCard dog={dog.data} onReload={() => void dog.refetch()} />;
}

function DogCard({ dog, onReload }: { dog: Dog; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff';
  const dictionaries = useDogDictionaries();
  const active = isActiveStatus(dictionaries.data, dog.status.id);
  const [params, setParams] = useSearchParams();
  const tab: Tab = tabs.find((item) => item.value === params.get('tab'))?.value ?? 'health';
  const [registration, setRegistration] = useState(false);
  const age = formatAge(dog.date_of_birth);

  return (
    <>
      <header className={styles.hero}>
        <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
          <Link to="/dogs">{profile.role === 'owner' ? 'Мои собаки' : 'Собаки'}</Link> / {dog.nickname}
        </nav>
        <div className={styles.heroBody}>
          <DogPhoto dogID={dog.id} nickname={dog.nickname} iconSize={88} className={styles.portrait} />
          <div className={styles.heroText}>
            <div className={styles.heroChips}>{active ? <span className={styles.heroStatus}>{dog.status.name}</span> : <Chip struck>{dog.status.name}</Chip>}</div>
            <h1 className={styles.nickname}>{dog.nickname}</h1>
            <p className={styles.heroMeta}>
              <span>{dog.breed.name}</span>
              <span>{dog.sex.name}</span>
              <span>{dog.coat_color.name}</span>
              <span>
                Род. {formatDate(dog.date_of_birth)}
                {age && ` · ${age}`}
              </span>
              <span>
                {dog.identifier.type.name} <b>{dog.identifier.number}</b>
              </span>
              {dog.height_cm !== null && <span>{String(dog.height_cm).replace('.', ',')} см</span>}
              {dog.weight_kg !== null && <span>{String(dog.weight_kg).replace('.', ',')} кг</span>}
            </p>
          </div>
          {staff && (
            <div className={styles.heroActions}>
              <ButtonLink to={`/dogs/${dog.id}/edit`} variant="secondary" className={styles.onForest}>
                Изменить
              </ButtonLink>
              <PhotoControls dogID={dog.id} />
            </div>
          )}
        </div>
      </header>

      {!active && (
        <Alert tone="info" title="Собака не на учёте: новые записи недоступны">
          Осмотры, прививки, занятия, вязки и запись на мероприятия закрыты, пока статус не вернут на «На учёте».
        </Alert>
      )}

      <Facts>
        <Fact label="Владельцы" value={pluralize(dog.owner_ids.length, 'владелец', 'владельца', 'владельцев')} note={<Link to="?tab=owners">Подробнее</Link>} />
        <Fact
          label="Регистрация в клубе"
          value={dog.registration_date ? `от ${formatDate(dog.registration_date)}` : 'Дата не подтверждена'}
          action={
            staff && (
              <Button variant="link" onClick={() => setRegistration(true)}>
                {dog.registration_date ? 'Исправить дату' : 'Подтвердить дату'}
              </Button>
            )
          }
        />
        <Fact label="Титулы" value={dog.titles[0]?.type.name ?? 'Нет'} note={dog.titles.length > 0 ? pluralize(dog.titles.length, 'запись', 'записи', 'записей') : undefined} />
        <Fact label="Документы" value={<Link to={`/documents?dog=${dog.id}`}>Открыть</Link>} />
      </Facts>

      <Tabs label="Разделы карточки" idPrefix="dog" value={tab} options={tabs} onChange={(value) => setParams(value === 'health' ? {} : { tab: value }, { replace: true })} />
      <section {...tabPanelProps('dog', tab)} className={styles.panel}>
        {tab === 'health' && <HealthTab dogID={dog.id} birth={dog.date_of_birth} active={active} />}
        {tab === 'pedigree' && <PedigreeTab dog={dog} onReload={onReload} />}
        {tab === 'titles' && <TitlesTab dog={dog} onReload={onReload} />}
        {tab === 'owners' && <OwnersTab dog={dog} onReload={onReload} />}
        {tab === 'breeding' && <DogBreedingTab dogID={dog.id} active={active} />}
        {tab === 'training' && <DogTrainingTab dogID={dog.id} active={active} />}
        {tab === 'history' && <DogHistoryTab dogID={dog.id} />}
      </section>

      {staff && <RegistrationDialog dog={dog} open={registration} onReload={onReload} onClose={() => setRegistration(false)} />}
    </>
  );
}

/** Confirming, correcting or withdrawing the club registration date needs a reason. */
function RegistrationDialog({ dog, open, onReload, onClose }: { dog: Dog; open: boolean; onReload: () => void; onClose: () => void }) {
  const saved = useDogSaved();
  const [date, setDate] = useState(dog.registration_date ?? '');
  useEffect(() => {
    if (open) setDate(dog.registration_date ?? '');
  }, [open, dog.registration_date]);
  return (
    <ReasonDialog
      open={open}
      title="Дата регистрации в клубе"
      description="Подтверждённая дата постановки на учёт: попадает в отчёты и документы. Пустое поле снимает подтверждение."
      confirmLabel="Сохранить"
      ready={date !== (dog.registration_date ?? '')}
      notReady="Дата не изменилась. Укажите другую дату или очистите поле, чтобы снять подтверждение."
      onReload={onReload}
      onClose={onClose}
      onConfirm={async (reason) => {
        saved(await dogsApi.setRegistration(dog.id, dog.version, date || null, reason));
      }}
    >
      <TextField label="Дата регистрации" type="date" min={dog.date_of_birth} max={todayUTC()} value={date} onChange={(event) => setDate(event.target.value)} />
    </ReasonDialog>
  );
}
