import { useState } from 'react';
import { Link } from 'react-router';
import { fieldErrors, localProblem } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { pluralize } from '../../shared/format';
import { Button, Card, Loading, ProblemAlert, Table } from '../../shared/ui';
import { MemberPicker, type PickedMember } from '../members/MemberPicker';
import { MembershipChip } from '../members/MembershipChip';
import { useMembersByID } from '../members/membersApi';
import { dogsApi, useDogSaved, type Dog } from './dogsApi';
import styles from './dogs.module.css';

/** Staff and leader see the people; an owner sees only how many co-owners there are. */
export function OwnersTab({ dog, onReload }: { dog: Dog; onReload: () => void }) {
  const { profile } = useSession();
  if (profile.role === 'owner') {
    const others = dog.owner_ids.length - 1;
    return (
      <Card heading="Владельцы">
        <p>{others > 0 ? `Вы и ещё ${pluralize(others, 'совладелец', 'совладельца', 'совладельцев')}.` : 'Вы единственный владелец.'}</p>
        <p className={styles.note}>Данные других людей видят только сотрудники клуба.</p>
      </Card>
    );
  }
  return <OwnersList dog={dog} onReload={onReload} />;
}

function OwnersList({ dog, onReload }: { dog: Dog; onReload: () => void }) {
  const { profile } = useSession();
  const saved = useDogSaved();
  const owners = useMembersByID(dog.owner_ids);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PickedMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const loaded = owners.map((query, index) => ({ id: dog.owner_ids[index]!, member: query.data }));

  const start = () => {
    setDraft(loaded.map(({ id, member }) => ({ id, full_name: member?.full_name ?? `Член клуба №${id}` })));
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const missing = localProblem({ owner_ids: draft.length === 0 ? 'Оставьте хотя бы одного владельца.' : undefined });
    setError(missing);
    if (missing) return;
    setBusy(true);
    try {
      saved(
        await dogsApi.setOwners(
          dog.id,
          dog.version,
          draft.map((member) => member.id),
        ),
      );
      setEditing(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      heading={
        <span className={styles.cardHeading}>
          Владельцы
          {profile.role === 'staff' && !editing && (
            <Button variant="secondary" size="small" onClick={start}>
              Изменить владельцев
            </Button>
          )}
        </span>
      }
    >
      {editing ? (
        <>
          <MemberPicker label="Добавить владельца" value={draft} onChange={setDraft} error={fieldErrors(error).owner_ids} />
          <p className={styles.note}>Список заменяется целиком. Прежний владелец сразу теряет доступ к карточке.</p>
          {error ? <ProblemAlert error={error} onReload={onReload} /> : null}
          <div className={styles.actions}>
            <Button variant="save" busy={busy} onClick={() => void save()}>
              Сохранить владельцев
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
              Отмена
            </Button>
          </div>
        </>
      ) : owners.some((query) => query.isPending) ? (
        <Loading />
      ) : (
        <Table caption="Владельцы собаки">
          <thead>
            <tr>
              <th scope="col">ФИО</th>
              <th scope="col">Членство</th>
            </tr>
          </thead>
          <tbody>
            {loaded.map(({ id, member }) => (
              <tr key={id}>
                <td>{member ? <Link to={`/members/${id}`}>{member.full_name}</Link> : `Член клуба №${id}`}</td>
                <td>{member && <MembershipChip status={member.membership_status} />}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
