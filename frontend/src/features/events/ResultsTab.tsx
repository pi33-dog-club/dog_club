import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate } from '../../shared/format';
import {
  Ball,
  Button,
  Card,
  Chip,
  EmptyState,
  Loading,
  QueryError,
  ReasonDialog,
  SelectField,
  Table,
  TextArea,
  TextField,
  fieldStyles,
  tableStyles,
  toOptions,
} from '../../shared/ui';
import { eventsApi, useEventDictionaries, useEventsSaved, useRegistrations, useResults, type Event, type EventResult, type Registration } from './eventsApi';
import { EventHistory, entryName } from './parts';
import styles from './events.module.css';

/** Results are entered and corrected by an expert assigned to the event. */
export function useAssignedExpert(event: Event): boolean {
  const { profile } = useSession();
  return profile.role === 'expert' && event.expert_profile_ids.includes(profile.id);
}

export const resultsOpen = (event: Event) => event.status === 'in_progress' || event.status === 'completed';

export function ResultsTab({ event, onReload }: { event: Event; onReload: () => void }) {
  const { profile } = useSession();
  const expert = useAssignedExpert(event) && resultsOpen(event);
  const results = useResults(event.id);
  const registrations = useRegistrations(event.id);
  const saved = useEventsSaved();
  const [correcting, setCorrecting] = useState<EventResult | null>(null);
  const [voiding, setVoiding] = useState<EventResult | null>(null);
  const [history, setHistory] = useState<number | null>(null);

  if (results.isPending) return <Loading label="Загружаем результаты…" />;
  if (results.isError) return <QueryError error={results.error} onRetry={() => void results.refetch()} />;
  const entryOf = (result: EventResult): Registration | undefined => registrations.data?.find((item) => item.id === result.registration_id) ?? result.entry_snapshot ?? undefined;
  const name = (result: EventResult) => {
    const entry = entryOf(result);
    return entry ? entryName(entry) : `собака №${result.dog_id}`;
  };

  return (
    <>
      {results.data.length === 0 ? (
        <Card>
          <EmptyState title={profile.role === 'owner' ? 'Результатов ваших собак нет' : 'Результатов пока нет'} illustration={<Ball />}>
            <p>Результат вносит назначенный эксперт после явки участника.</p>
          </EmptyState>
        </Card>
      ) : (
        <Table caption="Результаты">
          <thead>
            <tr>
              <th scope="col">Собака</th>
              <th scope="col">Оценка</th>
              <th scope="col">Место</th>
              <th scope="col">Комментарий</th>
              <th scope="col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {results.data.map((result) => (
              <tr key={result.id} className={result.is_void ? styles.disabled : undefined}>
                <td>
                  {result.registration_id ? <Link to={`/events/${event.id}/registrations/${result.registration_id}`}>{name(result)}</Link> : name(result)}
                  {result.is_void && (
                    <div>
                      <Chip tone="dashed" struck>
                        Ошибочный
                      </Chip>
                    </div>
                  )}
                  {result.legacy_judge_name && <div className={tableStyles.muted}>Судья (старые данные): {result.legacy_judge_name}</div>}
                </td>
                <td>{result.grade?.name ?? '—'}</td>
                <td>{result.place ?? '—'}</td>
                <td>
                  {result.comment || '—'}
                  {result.awarded_on && <div className={tableStyles.muted}>{formatDate(result.awarded_on)}</div>}
                </td>
                <td>
                  <span className={tableStyles.actions}>
                    <Button variant="link" onClick={() => setHistory(history === result.id ? null : result.id)}>
                      {history === result.id ? 'Скрыть историю' : 'История'}
                    </Button>
                    {expert && !result.is_void && (
                      <>
                        <Button variant="secondary" onClick={() => setCorrecting(result)}>
                          Исправить
                        </Button>
                        <Button variant="danger" onClick={() => setVoiding(result)}>
                          Ошибочный
                        </Button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className={styles.note}>Победители не вычисляются, официальный титул из оценки не присваивается: титулы вносит сотрудник в карточке собаки.</p>
      {history !== null && <EventHistory target={{ kind: 'result', eventID: event.id, id: history }} />}

      <ResultDialog
        event={event}
        open={correcting !== null}
        result={correcting ?? undefined}
        onReload={onReload}
        onClose={() => setCorrecting(null)}
        onSave={(body) => eventsApi.correctResult(event.id, correcting!.id, { ...body, version: correcting!.version })}
      />
      <ReasonDialog
        open={voiding !== null}
        title="Отметить результат ошибочным"
        description="Строка останется в истории. После этого можно внести новый результат."
        confirmLabel="Отметить"
        confirmVariant="danger"
        onReload={onReload}
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          await eventsApi.voidResult(event.id, voiding!.id, voiding!.version, reason);
          await saved();
        }}
      />
    </>
  );
}

interface ResultBody {
  grade_id: number | null;
  place: number | null;
  comment: string;
  reason: string;
}

/** Grade, place and comment: at least one of them. */
export function ResultDialog({
  event,
  open,
  result,
  onSave,
  onClose,
  onReload,
}: {
  event: Event;
  open: boolean;
  result?: EventResult;
  onSave: (body: ResultBody) => Promise<unknown>;
  onClose: () => void;
  onReload: () => void;
}) {
  const dictionaries = useEventDictionaries();
  const saved = useEventsSaved();
  const [grade, setGrade] = useState('');
  const [place, setPlace] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  // Fill the fields each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setGrade(result?.grade ? String(result.grade.id) : '');
    setPlace(result?.place ? String(result.place) : '');
    setComment(result?.comment ?? '');
    setError(null);
  }, [open, result]);
  const badPlace = place.trim() !== '' && !/^[1-9]\d{0,5}$/.test(place.trim());

  return (
    <ReasonDialog
      open={open}
      title={result ? 'Исправить результат' : 'Внести результат'}
      description={`${event.name}. Нужно хотя бы одно: оценка, место или комментарий.`}
      confirmLabel="Сохранить"
      ready={Boolean((grade || place.trim() || comment.trim()) && !badPlace)}
      notReady={badPlace ? undefined : 'Укажите оценку, место или комментарий эксперта.'}
      onReload={onReload}
      onClose={onClose}
      onConfirm={async (reason) => {
        try {
          await onSave({ grade_id: grade ? Number(grade) : null, place: place.trim() ? Number(place) : null, comment: comment.trim(), reason });
          await saved();
        } catch (failure) {
          setError(failure);
          throw failure;
        }
      }}
    >
      <div className={fieldStyles.row}>
        <SelectField
          label="Оценка"
          placeholder="Без оценки"
          options={toOptions(dictionaries.data?.grades ?? [])}
          value={grade}
          onChange={(change) => setGrade(change.target.value)}
          error={errors.grade_id}
        />
        <TextField
          label="Место"
          inputMode="numeric"
          value={place}
          onChange={(change) => setPlace(change.target.value)}
          error={badPlace ? 'Положительное целое число.' : errors.place}
        />
      </div>
      <TextArea label="Комментарий эксперта" maxLength={2000} value={comment} onChange={(change) => setComment(change.target.value)} error={errors.comment} />
    </ReasonDialog>
  );
}
