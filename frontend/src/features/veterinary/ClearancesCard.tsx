import { Plus } from 'lucide-react';
import { useState } from 'react';
import { fieldErrors, localProblem } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate } from '../../shared/format';
import { Button, Card, Chip, EmptyState, FormDialog, Loading, QueryError, ReasonDialog, SelectField, TextArea, TextField, fieldStyles, MAX_REASON } from '../../shared/ui';
import clsx from '../../shared/ui/clsx';
import { decisions, isMine, purposes } from './labels';
import { useClearances, useClinicalSaved, useExaminations, useVaccinations, vetApi, type Clearance } from './vetApi';
import styles from './vet.module.css';

interface Draft {
  purpose: Clearance['purpose'] | '';
  examination_id: string;
  decision: Clearance['decision'] | '';
  valid_until: string;
  vaccination_ids: number[];
  comment: string;
}

const emptyDraft: Draft = { purpose: '', examination_id: '', decision: '', valid_until: '', vaccination_ids: [], comment: '' };

/**
 * Clearances are not limited by the dog status, but each rests on the veterinarian's own
 * examination. The author corrects one with a reason or voids it and issues a new one.
 */
export function ClearancesCard({ dogID, active }: { dogID: number; active: boolean }) {
  const { profile, user } = useSession();
  const vet = profile.role === 'veterinarian';
  const clearances = useClearances(dogID);
  const examinations = useExaminations(dogID);
  const vaccinations = useVaccinations(dogID);
  const saved = useClinicalSaved(dogID);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<Clearance | null>(null);
  const [reason, setReason] = useState('');
  const [voiding, setVoiding] = useState<Clearance | null>(null);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  const ownExams = (examinations.data ?? []).filter((exam) => !exam.is_void && isMine(exam.author, user.id));
  const vaccineLabel = (id: number) => {
    const item = vaccinations.data?.find((vaccination) => vaccination.id === id);
    return item ? `${item.vaccine.name} от ${formatDate(item.date)}` : `прививка №${id}`;
  };

  const open = (item: Clearance | null) => {
    setEditing(item);
    setReason('');
    setError(null);
    setDraft(
      item
        ? {
            purpose: item.purpose,
            examination_id: String(item.examination_id),
            decision: item.decision,
            valid_until: item.valid_until ?? '',
            vaccination_ids: item.vaccination_ids,
            comment: item.comment,
          }
        : emptyDraft,
    );
  };

  const submit = async () => {
    if (!draft) return;
    const allowed = draft.decision === 'allowed';
    const base = { purpose: draft.purpose as Clearance['purpose'], examination_id: Number(draft.examination_id), comment: draft.comment.trim() || undefined };
    try {
      if (editing) {
        // A correction states every field: a decision other than «allowed» clears the term and the bases.
        await vetApi.correctClearance(
          dogID,
          editing.id,
          allowed
            ? {
                ...base,
                comment: draft.comment.trim(),
                decision: 'allowed',
                valid_until: draft.valid_until,
                vaccination_ids: draft.vaccination_ids,
                version: editing.version,
                reason: reason.trim(),
              }
            : {
                ...base,
                comment: draft.comment.trim(),
                decision: draft.decision as 'denied' | 'not_assessed',
                valid_until: null,
                vaccination_ids: [],
                version: editing.version,
                reason: reason.trim(),
              },
        );
      } else {
        await vetApi.addClearance(
          dogID,
          allowed
            ? { ...base, decision: 'allowed', valid_until: draft.valid_until, vaccination_ids: draft.vaccination_ids }
            : { ...base, decision: draft.decision as 'denied' | 'not_assessed' },
        );
      }
      setError(null);
      await saved();
    } catch (failure) {
      setError(failure);
      throw failure;
    }
  };

  const ready = Boolean(
    draft?.purpose &&
      draft.examination_id &&
      draft.decision &&
      (draft.decision !== 'allowed' || (draft.valid_until && draft.vaccination_ids.length > 0)) &&
      (!editing || reason.trim()),
  );
  const exam = ownExams.find((item) => String(item.id) === draft?.examination_id);
  // A correction keeps its examination selectable even if it is no longer among the own valid ones.
  const examOptions = ownExams.map((item) => ({ value: item.id, label: `${formatDate(item.date)}${item.result ? ` · ${item.result}` : ''}` }));
  if (editing && !ownExams.some((item) => item.id === editing.examination_id)) {
    examOptions.push({ value: editing.examination_id, label: `${formatDate(editing.examination_date)} · осмотр недоступен` });
  }
  // Without an own examination the form would be a dead end, e.g. for a lost dog.
  const canIssue = vet && ownExams.length > 0;
  const needsExam = vet && examinations.isSuccess && ownExams.length === 0;

  return (
    <Card
      heading={
        <span className={styles.heading}>
          Заключения о допуске
          {canIssue && (
            <Button variant="secondary" size="small" onClick={() => open(null)}>
              <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
              Новое заключение
            </Button>
          )}
        </span>
      }
    >
      {needsExam && (
        <p className={styles.note}>
          {active
            ? 'Чтобы выдать заключение, сначала внесите свой осмотр.'
            : 'Собака не на учёте: новый осмотр внести нельзя. Заключение можно выдать только по уже внесённому вами осмотру.'}
        </p>
      )}
      {clearances.isPending ? (
        <Loading />
      ) : clearances.isError ? (
        <QueryError error={clearances.error} onRetry={() => void clearances.refetch()} />
      ) : clearances.data.length === 0 ? (
        <EmptyState title="Заключений пока нет" />
      ) : (
        <ul className={styles.records}>
          {clearances.data.map((item) => (
            <li key={item.id} className={clsx(styles.record, item.is_void && styles.void)}>
              <div className={styles.recordHead}>
                <b>{purposes[item.purpose]}</b>
                {item.is_void ? <Chip struck>Ошибочная запись</Chip> : <Chip tone={decisions[item.decision].tone}>{decisions[item.decision].label}</Chip>}
                {item.valid_until && <span>до {formatDate(item.valid_until)}</span>}
              </div>
              <p className={styles.sub}>
                По осмотру от {formatDate(item.examination_date)}
                {item.vaccination_ids.length > 0 && ` · основания: ${item.vaccination_ids.map(vaccineLabel).join(', ')}`}
              </p>
              {item.comment && <p>{item.comment}</p>}
              {vet && isMine(item.author, user.id) && !item.is_void && (
                <span className={styles.recordActions}>
                  <Button variant="secondary" onClick={() => open(item)}>
                    Исправить
                  </Button>
                  <Button variant="danger" onClick={() => setVoiding(item)}>
                    Отметить ошибочным
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <FormDialog
        open={draft !== null}
        title={editing ? 'Исправить заключение' : 'Новое заключение'}
        description="Заключение строится на вашем осмотре. Для «Допущена» выберите срок и прививки-основания, действовавшие на дату осмотра."
        confirmLabel="Сохранить"
        ready={ready}
        check={() => {
          const missing = localProblem({
            vaccination_ids: draft?.decision === 'allowed' && draft.vaccination_ids.length === 0 ? 'Отметьте прививки, на которых основано разрешение.' : undefined,
          });
          setError(missing);
          return !missing;
        }}
        onReload={() => void saved()}
        onClose={() => {
          setDraft(null);
          setEditing(null);
          setError(null);
        }}
        onSubmit={submit}
      >
        {draft && (
          <>
            <div className={fieldStyles.row}>
              <SelectField
                label="Назначение"
                required
                placeholder="Выберите…"
                options={[
                  { value: 'events', label: purposes.events },
                  { value: 'breeding', label: purposes.breeding },
                ]}
                value={draft.purpose}
                onChange={(event) => setDraft({ ...draft, purpose: event.target.value as Draft['purpose'] })}
                error={errors.purpose}
              />
              <SelectField
                label="Решение"
                required
                placeholder="Выберите…"
                options={(['allowed', 'denied', 'not_assessed'] as const).map((value) => ({ value, label: decisions[value].label }))}
                value={draft.decision}
                onChange={(event) => setDraft({ ...draft, decision: event.target.value as Draft['decision'] })}
                error={errors.decision}
              />
            </div>
            <SelectField
              label="Осмотр"
              required
              placeholder="Выберите…"
              options={examOptions}
              value={draft.examination_id}
              onChange={(event) => setDraft({ ...draft, examination_id: event.target.value })}
              error={errors.examination_id}
            />
            {draft.decision === 'allowed' && (
              <>
                <TextField
                  label="Действует до"
                  type="date"
                  required
                  min={exam?.date}
                  value={draft.valid_until}
                  onChange={(event) => setDraft({ ...draft, valid_until: event.target.value })}
                  error={errors.valid_until}
                />
                <fieldset className={fieldStyles.fieldset}>
                  <legend className={fieldStyles.legend}>Прививки-основания</legend>
                  <ul className={styles.diagnoses}>
                    {(vaccinations.data ?? [])
                      .filter((item) => !item.is_void)
                      .map((item) => (
                        <li key={item.id}>
                          <label className={styles.check}>
                            <input
                              type="checkbox"
                              checked={draft.vaccination_ids.includes(item.id)}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  vaccination_ids: event.target.checked ? [...draft.vaccination_ids, item.id] : draft.vaccination_ids.filter((id) => id !== item.id),
                                })
                              }
                            />
                            {item.vaccine.name} от {formatDate(item.date)}, до {formatDate(item.valid_until)}
                          </label>
                        </li>
                      ))}
                  </ul>
                  {errors.vaccination_ids && <span className={styles.error} role="alert">{errors.vaccination_ids}</span>}
                </fieldset>
              </>
            )}
            <TextArea label="Комментарий" maxLength={4000} value={draft.comment} onChange={(event) => setDraft({ ...draft, comment: event.target.value })} error={errors.comment} />
            {editing && (
              <TextArea
                label="Причина исправления"
                required
                maxLength={MAX_REASON}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                error={errors.reason}
                hint="Сохранится в ветеринарной истории."
              />
            )}
          </>
        )}
      </FormDialog>
      <ReasonDialog
        open={voiding !== null}
        title="Отметить заключение ошибочным"
        description="Прежнее разрешение не вернётся: при необходимости выдайте новое заключение."
        confirmLabel="Отметить ошибочным"
        onReload={() => void saved()}
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await vetApi.voidClearance(dogID, voiding!.id, voiding!.version, reason);
          await saved();
        }}
      />
    </Card>
  );
}
