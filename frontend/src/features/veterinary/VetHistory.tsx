import { formatDate, formatDateTime } from '../../shared/format';
import { Button, Card, EmptyState, Loading, QueryError, Timeline, tableStyles } from '../../shared/ui';
import { useVetHistory, type MedicalChange } from './vetApi';

// Russian participles agree with the gender of the record.
const entities: Record<MedicalChange['entity'], { name: string; gender: 0 | 1 | 2 }> = {
  examination: { name: 'Осмотр', gender: 0 },
  vaccination: { name: 'Прививка', gender: 1 },
  clearance: { name: 'Заключение', gender: 2 },
  vaccine_type: { name: 'Препарат', gender: 0 },
};

const actions: Record<MedicalChange['action'], [string, string, string]> = {
  created: ['внесён', 'внесена', 'внесено'],
  corrected: ['исправлен', 'исправлена', 'исправлено'],
  voided: ['отмечен ошибочным', 'отмечена ошибочной', 'отмечено ошибочным'],
};

/** What the record is about: the date of a procedure or the vaccine name. */
function subject(change: MedicalChange): string {
  const after = change.after as { date?: string; examination_date?: string; name?: string; vaccine?: { name: string } };
  if (after.vaccine && after.date) return ` «${after.vaccine.name}» от ${formatDate(after.date)}`;
  if (typeof after.date === 'string') return ` от ${formatDate(after.date)}`;
  if (typeof after.name === 'string') return ` «${after.name}»`;
  if (typeof after.examination_date === 'string') return ` по осмотру от ${formatDate(after.examination_date)}`;
  return '';
}

export function changeTitle(change: MedicalChange): string {
  const entity = entities[change.entity];
  return `${entity.name}${subject(change)} ${actions[change.action][entity.gender]}`;
}

/** Clinical history of one dog: who created, corrected or voided which record and why. */
export function VetHistory({ dogID }: { dogID: number }) {
  const history = useVetHistory(dogID);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.records);
  return (
    <Card heading="Клиническая история">
      {changes.length === 0 ? (
        <EmptyState title="Изменений пока нет" />
      ) : (
        <Timeline
          entries={changes.map((change) => ({
            id: change.id,
            title: changeTitle(change),
            meta: formatDateTime(change.changed_at),
            reason: change.reason || undefined,
          }))}
        />
      )}
      {history.hasNextPage && (
        <Button variant="secondary" className={tableStyles.more} busy={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          Показать ещё
        </Button>
      )}
    </Card>
  );
}
