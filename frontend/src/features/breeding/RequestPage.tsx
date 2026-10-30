import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, formatDateTime, todayUTC } from '../../shared/format';
import { Alert, Button, ButtonLink, Card, Chip, EmptyState, Fact, Facts, Loading, PageHeader, QueryError, ReasonDialog, TextField } from '../../shared/ui';
import { decisions as admissionDecisions } from '../veterinary/labels';
import { breedingApi, useBreedingSaved, useDecisions, useMatings, usePairCheck, useRequest, type Animal, type Assessment, type BreedingRequest } from './breedingApi';
import { blockingReasons, warnings } from './labels';
import { BreedingHistory, DogName, RequestStatus } from './parts';
import styles from './breeding.module.css';

export function RequestPage() {
  const id = Number(useParams().requestID);
  const request = useRequest(id);
  if (request.isPending) return <Loading label="Загружаем заявку…" />;
  if (request.isError) return <QueryError error={request.error} onRetry={() => void request.refetch()} />;
  return <RequestCard request={request.data} onReload={() => void request.refetch()} />;
}

function RequestCard({ request, onReload }: { request: BreedingRequest; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff';
  const expert = profile.role === 'expert';
  // Owners get no pair assessment from the server.
  const check = usePairCheck(request.id, profile.role !== 'owner');
  const matings = useMatings(request.female_dog_id);
  const mating = matings.data?.find((item) => item.request_id === request.id);
  const saved = useBreedingSaved();
  const [dialog, setDialog] = useState<'cancel' | 'perform' | 'approve' | 'reject' | null>(null);
  const [date, setDate] = useState(request.planned_date);
  const [expected, setExpected] = useState(request.expected_birth_date ?? '');
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const blocked = (check.data?.blocking_reasons.length ?? 0) > 0;
  const open = !mating && request.status !== 'cancelled';
  const today = todayUTC();

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
    setError(null);
  };

  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/breeding">Племенная работа</Link> / Заявка {request.id}
      </nav>
      <PageHeader
        eyebrow={`Заявка ${request.id}`}
        title="Пара"
        actions={
          <>
            {staff && open && (
              <ButtonLink to={`/breeding/requests/${request.id}/edit`} variant="secondary">
                Исправить
              </ButtonLink>
            )}
            {staff && open && request.status === 'approved' && (
              <Button
                variant="save"
                onClick={() => {
                  setDate(request.planned_date);
                  setDialog('perform');
                }}
              >
                Провести вязку
              </Button>
            )}
            {expert && request.status === 'pending' && (
              <>
                <Button variant="secondary" onClick={() => setDialog('reject')}>
                  Отклонить
                </Button>
                <Button
                  variant="save"
                  disabled={!check.isSuccess || blocked}
                  onClick={() => {
                    setExpected(request.expected_birth_date ?? '');
                    setDialog('approve');
                  }}
                >
                  Одобрить
                </Button>
              </>
            )}
          </>
        }
      />
      <div className={styles.pair}>
        <span className={styles.pairName}>
          <DogName id={request.female_dog_id} />
        </span>
        <span className={styles.pairCross} aria-label="и">
          ×
        </span>
        <span className={styles.pairName}>
          <DogName id={request.male_dog_id} />
        </span>
      </div>
      {/* The expert has no dog cards, so the pair offers mate candidates right here. */}
      <p className={styles.note}>
        Подобрать пару:{' '}
        <Link to={`/breeding/candidates/${request.female_dog_id}`}>
          для <DogName id={request.female_dog_id} plain />
        </Link>
        {' · '}
        <Link to={`/breeding/candidates/${request.male_dog_id}`}>
          для <DogName id={request.male_dog_id} plain />
        </Link>
      </p>
      <Facts>
        <Fact label="Статус" value={<RequestStatus status={request.status} />} />
        <Fact label="Планируемая дата" value={formatDate(request.planned_date)} />
        <Fact label="Ожидаемые роды" value={formatDate(request.expected_birth_date)} />
        <Fact
          label="Вязка"
          value={mating ? <Link to={`/breeding/matings/${mating.id}`}>Проведена {formatDate(mating.date)}</Link> : 'Не проведена'}
        />
      </Facts>
      {request.comment && <Alert tone="info">{request.comment}</Alert>}
      {expert && request.status === 'pending' && blocked && <Alert tone="warning">Одобрение недоступно, пока есть блокирующие причины.</Alert>}
      {staff && request.status === 'approved' && open && request.planned_date > today && (
        <p className={styles.note}>Провести вязку можно в одобренную дату {formatDate(request.planned_date)}: фактическая дата не бывает в будущем.</p>
      )}

      {profile.role !== 'owner' &&
        (check.isPending ? (
          <Loading label="Проверяем пару…" />
        ) : check.isError ? (
          <QueryError error={check.error} />
        ) : (
          <PairCheck assessment={check.data} title="Проверка пары сейчас" />
        ))}
      <Decisions requestID={request.id} />
      <BreedingHistory entity="breeding-requests" id={request.id} />

      <ReasonDialog
        open={dialog === 'reject'}
        title="Отклонить заявку"
        confirmLabel="Отклонить"
        onReload={onReload}
        onClose={close}
        onConfirm={(reason) => run(() => breedingApi.decide(request.id, { decision: 'rejected', reason, version: request.version }))}
      />
      <ReasonDialog
        open={dialog === 'approve'}
        title="Одобрить заявку"
        description="Решение сохранится вместе со снимком проверки пары."
        confirmLabel="Одобрить"
        onReload={onReload}
        onClose={close}
        onConfirm={(reason) => run(() => breedingApi.decide(request.id, { decision: 'approved', reason, version: request.version, expected_birth_date: expected || null }))}
      >
        <TextField
          label="Ожидаемые роды"
          type="date"
          min={request.planned_date}
          value={expected}
          onChange={(event) => setExpected(event.target.value)}
          error={errors.expected_birth_date}
          hint={check.data?.earliest_birth_date ? `Не раньше ${formatDate(check.data.earliest_birth_date)} (365 дней после прошлого помёта).` : 'Можно уточнить при решении.'}
        />
      </ReasonDialog>
      <ReasonDialog
        open={dialog === 'cancel'}
        title="Отменить заявку"
        description="Отменённую заявку нельзя вернуть: при необходимости подайте новую."
        confirmLabel="Отменить заявку"
        onReload={onReload}
        onClose={close}
        onConfirm={(reason) => run(() => breedingApi.cancel(request.id, request.version, reason))}
      />
      <ReasonDialog
        open={dialog === 'perform'}
        title="Провести вязку"
        description="Перед записью сервер повторит проверку пары на эту дату."
        confirmLabel="Записать вязку"
        ready={Boolean(date)}
        onReload={onReload}
        onClose={close}
        onConfirm={(reason) => run(() => breedingApi.perform(request.id, request.version, date, reason))}
      >
        <TextField
          label="Фактическая дата"
          type="date"
          required
          max={today}
          value={date}
          onChange={(event) => setDate(event.target.value)}
          error={errors.date}
          hint="Должна совпадать с одобренной."
        />
      </ReasonDialog>
      {staff && open && (
        <p>
          <Button variant="danger" onClick={() => setDialog('cancel')}>
            Отменить заявку
          </Button>
        </p>
      )}
    </>
  );
}

/** Blocking reasons in pink, warnings in sun, then each dog of the pair. */
export function PairCheck({ assessment, title }: { assessment: Assessment; title: string }) {
  return (
    <Card heading={title}>
      <p className={styles.note}>На {formatDate(assessment.as_of)}</p>
      {assessment.blocking_reasons.length === 0 ? (
        <Chip tone="lime">Блокирующих причин нет</Chip>
      ) : (
        <div className={styles.chips}>
          {assessment.blocking_reasons.map((code) => (
            <Chip key={code} tone="pink">
              {blockingReasons[code] ?? 'Причина недопуска пары требует уточнения у эксперта.'}
            </Chip>
          ))}
        </div>
      )}
      {assessment.warnings.length > 0 && (
        <div className={styles.chips}>
          {assessment.warnings.map((code) => (
            <Chip key={code} tone="sun">
              {warnings[code] ?? 'Условия вязки требуют уточнения у эксперта.'}
            </Chip>
          ))}
        </div>
      )}
      {assessment.common_ancestor_ids.length > 0 && (
        <p>
          Общие предки:{' '}
          {assessment.common_ancestor_ids.map((id, index) => (
            <span key={id}>
              {index > 0 && ', '}
              <DogName id={id} plain />
            </span>
          ))}
        </p>
      )}
      {assessment.earliest_birth_date && <p>Ближайшие допустимые роды: {formatDate(assessment.earliest_birth_date)}.</p>}
      <div className={styles.animals}>
        <AnimalCheck label="Сука" animal={assessment.female} health={assessment.female_health} />
        <AnimalCheck label="Кобель" animal={assessment.male} health={assessment.male_health} />
      </div>
    </Card>
  );
}

function AnimalCheck({ label, animal, health }: { label: string; animal: Animal; health: Assessment['female_health'] }) {
  const admission = admissionDecisions[health.admission.decision];
  return (
    <div className={styles.animal}>
      <span className={styles.label}>{label}</span>
      <b>{animal.nickname}</b>
      <span className={styles.note}>
        {animal.breed.name} · род. {formatDate(animal.date_of_birth)} · {animal.status.name}
      </span>
      <span className={styles.chips}>
        <Chip tone={admission.tone}>Вязка: {admission.label.toLowerCase()}</Chip>
        {animal.pedigree_known_3_generations === true && <Chip tone="lime">Родословная на 3 поколения</Chip>}
        {animal.pedigree_known_3_generations === false && <Chip tone="sun">Родословная не на 3 поколения</Chip>}
      </span>
      {health.findings.length > 0 && (
        <ul className={styles.findings}>
          {health.findings.map((finding) => (
            <li key={`${finding.examination_id}-${finding.disease_id}`}>
              {finding.disease_name} ({finding.is_hereditary ? 'наследственное' : 'наследственность не установлена'}), осмотр {formatDate(finding.date)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Decisions({ requestID }: { requestID: number }) {
  const decisions = useDecisions(requestID);
  if (decisions.isPending) return <Loading />;
  if (decisions.isError) return <QueryError error={decisions.error} />;
  return (
    <Card heading="Решения эксперта">
      {decisions.data.length === 0 ? (
        <EmptyState title="Решений пока нет" />
      ) : (
        <ul className={styles.records}>
          {decisions.data.map((decision) => (
            <li key={decision.id} className={styles.record}>
              <span className={styles.recordHead}>
                <Chip tone={decision.decision === 'approved' ? 'lime' : 'pink'}>{decision.decision === 'approved' ? 'Одобрена' : 'Отклонена'}</Chip>
                <span className={styles.note}>
                  {formatDateTime(decision.decided_at)} · по версии заявки {decision.request_version}
                </span>
              </span>
              <span>«{decision.reason}»</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
