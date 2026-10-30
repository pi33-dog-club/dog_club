import { Link } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatDateTime } from '../../shared/format';
import { Button, Card, Chip, EmptyState, Loading, QueryError, Timeline, tableStyles } from '../../shared/ui';
import { useBreedingDog, useBreedingHistory, type BreedingRequest } from './breedingApi';
import { historyActions, requestStatuses } from './labels';

/** A dog of a breeding record by ID: a link for those who may open the dog card. */
export function DogName({ id, plain }: { id: number; plain?: boolean }) {
  const { profile } = useSession();
  const dog = useBreedingDog(id);
  const name = dog.data?.nickname ?? (dog.isPending ? '…' : `собака №${id}`);
  // The expert has no dog cards; an owner opens only own dogs.
  const linked = !plain && dog.data && profile.role !== 'expert';
  return linked ? <Link to={`/dogs/${id}`}>{name}</Link> : <>{name}</>;
}

export function RequestStatus({ status }: { status: BreedingRequest['status'] }) {
  const item = requestStatuses[status];
  return <Chip tone={item.tone}>{item.label}</Chip>;
}

const entities = { 'breeding-requests': 'request', breedings: 'breeding', litters: 'litter' } as const;

/** Change history of a request, mating or litter; owners get metadata only. */
export function BreedingHistory({ entity, id }: { entity: keyof typeof entities; id: number }) {
  const history = useBreedingHistory(entity, id);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.records);
  return (
    <Card heading="История">
      {changes.length === 0 ? (
        <EmptyState title="Изменений пока нет" />
      ) : (
        <Timeline
          entries={changes.map((change) => ({
            id: change.id,
            title: historyActions[`${change.entity}:${change.action}`] ?? 'Запись изменена',
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
