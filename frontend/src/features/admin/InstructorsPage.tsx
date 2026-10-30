import { useEffect, useState } from 'react';
import { formatDateTime } from '../../shared/format';
import { Ball, Button, Card, Chip, EmptyState, Loading, PageHeader, QueryError, ReasonDialog, SelectField, Table, TextArea, Timeline, tableStyles } from '../../shared/ui';
import { useTrainingTypes } from '../training/trainingApi';
import { adminApi, useAdminSaved, useInstructorGrants, useInstructorHistory, useUserProfiles, useUsers, type Instructor } from './adminApi';
import styles from './admin.module.css';

/** An instructor is a staff profile with a separate grant, not a role of its own. */
export function InstructorsPage() {
  const grants = useInstructorGrants();
  const types = useTrainingTypes();
  const [editing, setEditing] = useState<Instructor | 'new' | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const typeName = (id: number) => types.data?.find((type) => type.id === id)?.name ?? `вид №${id}`;

  return (
    <>
      <PageHeader eyebrow="Администратор" title="Допуски инструкторов" actions={<Button onClick={() => setEditing('new')}>Выдать допуск</Button>} />
      {grants.isPending ? (
        <Loading label="Загружаем допуски…" />
      ) : grants.isError ? (
        <QueryError error={grants.error} onRetry={() => void grants.refetch()} />
      ) : grants.data.length === 0 ? (
        <Card>
          <EmptyState title="Допусков пока нет" illustration={<Ball />}>
            <p>Без допуска сотрудник не может вносить занятия в журнал дрессировки.</p>
          </EmptyState>
        </Card>
      ) : (
        <Table caption="Допуски инструкторов">
          <thead>
            <tr>
              <th scope="col">Сотрудник</th>
              <th scope="col">Виды</th>
              <th scope="col">Основание</th>
              <th scope="col">Состояние</th>
              <th scope="col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {grants.data.map((grant) => (
              <tr key={grant.profile_id}>
                <td>{grant.name}</td>
                <td>{grant.type_ids.length > 0 ? grant.type_ids.map(typeName).join(', ') : '—'}</td>
                <td>{grant.qualification || '—'}</td>
                <td>
                  <span className={styles.chips}>
                    {grant.enabled ? <Chip tone="lime">Включён</Chip> : <Chip tone="dashed">Отключён</Chip>}
                    {grant.enabled && !grant.available && <Chip tone="sun">Профиль недоступен</Chip>}
                  </span>
                </td>
                <td>
                  <span className={tableStyles.actions}>
                    <Button variant="link" onClick={() => setHistory(history === grant.profile_id ? null : grant.profile_id)}>
                      {history === grant.profile_id ? 'Скрыть историю' : 'История'}
                    </Button>
                    <Button variant="secondary" onClick={() => setEditing(grant)}>
                      Изменить
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className={styles.note}>«Профиль недоступен» — допуск включён, но аккаунт заблокирован или профиль сотрудника отключён.</p>
      {history && <GrantHistory profileID={history} />}
      <GrantDialog grant={editing} existing={grants.data ?? []} onClose={() => setEditing(null)} />
    </>
  );
}

function GrantDialog({ grant, existing, onClose }: { grant: Instructor | 'new' | null; existing: Instructor[]; onClose: () => void }) {
  const saved = useAdminSaved();
  const types = useTrainingTypes();
  const [profileID, setProfileID] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [typeIDs, setTypeIDs] = useState<number[]>([]);
  const [qualification, setQualification] = useState('');
  const fresh = grant === 'new';

  useEffect(() => {
    if (!grant) return;
    setProfileID(fresh ? '' : grant.profile_id);
    setEnabled(fresh ? true : grant.enabled);
    setTypeIDs(fresh ? [] : grant.type_ids);
    setQualification(fresh ? '' : (grant.qualification ?? ''));
  }, [grant, fresh]);

  const ready = Boolean(profileID && qualification.trim() && (!enabled || typeIDs.length > 0));
  return (
    <ReasonDialog
      open={grant !== null}
      title={grant && grant !== 'new' ? `Допуск: ${grant.name}` : 'Выдать допуск инструктора'}
      description="Допуск разрешает вносить занятия сейчас; прошлую квалификацию он не подтверждает."
      confirmLabel="Сохранить"
      ready={ready}
      notReady={enabled && typeIDs.length === 0 ? 'Отметьте хотя бы один вид дрессировки.' : undefined}
      onClose={onClose}
      onConfirm={async (reason) => {
        await adminApi.setInstructor(profileID, {
          version: fresh ? 0 : (grant as Instructor).version,
          enabled,
          type_ids: typeIDs,
          qualification: qualification.trim(),
          reason,
        });
        await saved();
      }}
    >
      {fresh && <StaffProfilePicker value={profileID} onChange={setProfileID} taken={existing.map((item) => item.profile_id)} />}
      <label className={styles.check}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Допуск включён
      </label>
      <fieldset className={styles.checks}>
        <legend className={styles.note}>Разрешённые виды дрессировки</legend>
        {(types.data ?? []).map((type) => (
          <label key={type.id} className={styles.check}>
            <input
              type="checkbox"
              checked={typeIDs.includes(type.id)}
              onChange={(event) => setTypeIDs(event.target.checked ? [...typeIDs, type.id] : typeIDs.filter((id) => id !== type.id))}
            />
            {type.name}
          </label>
        ))}
      </fieldset>
      {enabled && typeIDs.length === 0 && <p className={styles.note}>Включённый допуск требует хотя бы один вид.</p>}
      <TextArea
        label="Основание"
        required
        maxLength={1000}
        value={qualification}
        onChange={(event) => setQualification(event.target.value)}
        hint="Видит только администратор: сотрудники его не получают."
      />
    </ReasonDialog>
  );
}

/** A staff profile of an active account; one grant per profile. */
function StaffProfilePicker({ value, onChange, taken }: { value: string; onChange: (value: string) => void; taken: string[] }) {
  const users = useUsers();
  const [userID, setUserID] = useState('');
  const profiles = useUserProfiles(userID, Boolean(userID));
  const staff = userID ? (profiles.data?.profiles ?? []).find((profile) => profile.role === 'staff' && profile.enabled) : undefined;
  useEffect(() => {
    onChange(staff && !taken.includes(staff.id) ? staff.id : '');
  }, [staff, taken, onChange]);
  return (
    <>
      <SelectField
        label="Пользователь"
        required
        placeholder={users.isPending ? 'Загружаем…' : 'Выберите…'}
        options={(users.data ?? []).filter((user) => user.status === 'active').map((user) => ({ value: user.id, label: `${user.login} (${user.email})` }))}
        value={userID}
        onChange={(event) => setUserID(event.target.value)}
      />
      {userID && profiles.isSuccess && !staff && <p className={styles.note}>У пользователя нет включённого профиля сотрудника: сначала добавьте его на странице пользователя.</p>}
      {staff && taken.includes(staff.id) && <p className={styles.note}>Допуск этого сотрудника уже есть в списке: измените его там.</p>}
      {value && <p className={styles.note}>Допуск получит профиль «Сотрудник клуба».</p>}
    </>
  );
}

function GrantHistory({ profileID }: { profileID: string }) {
  const history = useInstructorHistory(profileID);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.records);
  return (
    <Card heading="История допуска">
      {changes.length === 0 ? (
        <EmptyState title="Изменений нет" />
      ) : (
        <Timeline
          entries={changes.map((change) => ({
            id: change.id,
            title: change.before ? 'Допуск изменён' : 'Допуск выдан',
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
