import { Link, useParams, useSearchParams } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, formatDateTime } from '../../shared/format';
import { Button, ButtonLink, Card, EmptyState, Fact, Facts, Loading, PageHeader, QueryError, Table, Tabs, Timeline, tabPanelProps, tableStyles } from '../../shared/ui';
import { DogStatusChip } from '../dogs/DogStatusChip';
import { actorLabel } from '../dogs/DogHistoryTab';
import { useDogs } from '../dogs/dogsApi';
import { ContactsTab } from './ContactsTab';
import { MembershipChip } from './MembershipChip';
import { useMember, useMemberHistory, useOwnMember, type Member, type MemberChange } from './membersApi';
import styles from './members.module.css';

const tabs = [
  { value: 'contacts', label: 'Контакты и адреса' },
  { value: 'dogs', label: 'Собаки' },
  { value: 'history', label: 'История' },
] as const;
type Tab = (typeof tabs)[number]['value'];

export function MemberPage() {
  const id = Number(useParams().memberID);
  const member = useMember(id);
  if (member.isPending) return <Loading label="Загружаем карточку…" />;
  if (member.isError) return <QueryError error={member.error} onRetry={() => void member.refetch()} />;
  return <MemberCard member={member.data} onReload={() => void member.refetch()} />;
}

/** «Моя карточка» of an owner: the same card, read only. */
export function OwnCardPage() {
  const member = useOwnMember();
  if (member.isPending) return <Loading label="Загружаем карточку…" />;
  if (member.isError) return <QueryError error={member.error} onRetry={() => void member.refetch()} />;
  return <MemberCard member={member.data} own onReload={() => void member.refetch()} />;
}

function MemberCard({ member, own, onReload }: { member: Member; own?: boolean; onReload: () => void }) {
  const { profile } = useSession();
  const staff = profile.role === 'staff';
  const [params, setParams] = useSearchParams();
  const tab: Tab = tabs.find((item) => item.value === params.get('tab'))?.value ?? 'contacts';
  return (
    <>
      {!own && (
        <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
          <Link to="/members">Члены клуба</Link> / {member.full_name}
        </nav>
      )}
      <PageHeader
        eyebrow={own ? 'Моя карточка' : 'Члены клуба'}
        title={member.full_name}
        actions={
          staff && (
            <ButtonLink to={`/members/${member.id}/edit`} variant="secondary">
              Изменить
            </ButtonLink>
          )
        }
      />
      <Facts>
        <Fact label="Номер карточки" value={`№ ${member.id}`} />
        <Fact label="Членство" value={<MembershipChip status={member.membership_status} />} />
        <Fact label="В клубе с" value={formatDate(member.membership_date)} />
        <Fact label="Дата рождения" value={formatDate(member.date_of_birth)} />
        <Fact label="Документы" value={<Link to={own ? '/documents' : `/documents?member=${member.id}`}>Открыть</Link>} />
      </Facts>
      {own && <p className={styles.note}>Изменить данные карточки может сотрудник клуба.</p>}
      <Tabs label="Разделы карточки" idPrefix="member" value={tab} options={tabs} onChange={(value) => setParams(value === 'contacts' ? {} : { tab: value }, { replace: true })} />
      <section {...tabPanelProps('member', tab)} className={styles.panel}>
        {tab === 'contacts' && <ContactsTab member={member} editable={staff} onReload={onReload} />}
        {tab === 'dogs' && <MemberDogs member={member} own={own} />}
        {tab === 'history' && <MemberHistory memberID={member.id} />}
      </section>
    </>
  );
}

function MemberDogs({ member, own }: { member: Member; own?: boolean }) {
  // The owner's list is limited to their own dogs by the server anyway.
  const dogs = useDogs(own ? {} : { owner_id: member.id });
  if (dogs.isPending) return <Loading />;
  if (dogs.isError) return <QueryError error={dogs.error} onRetry={() => void dogs.refetch()} />;
  const rows = dogs.data.pages.flatMap((page) => page.dogs);
  return (
    <Card heading="Собаки">
      {rows.length === 0 ? (
        <EmptyState title="Собак не записано" />
      ) : (
        <Table caption="Собаки члена клуба">
          <thead>
            <tr>
              <th scope="col">Кличка</th>
              <th scope="col">Порода</th>
              <th scope="col">Рождение</th>
              <th scope="col">Статус</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((dog) => (
              <tr key={dog.id}>
                <td>
                  <Link to={`/dogs/${dog.id}`}>{dog.nickname}</Link>
                </td>
                <td>{dog.breed.name}</td>
                <td className={tableStyles.nowrap}>{formatDate(dog.date_of_birth)}</td>
                <td>
                  <DogStatusChip status={dog.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {dogs.hasNextPage && (
        <Button variant="secondary" className={tableStyles.more} busy={dogs.isFetchingNextPage} onClick={() => void dogs.fetchNextPage()}>
          Следующие 50
        </Button>
      )}
    </Card>
  );
}

const actions: Record<MemberChange['action'], string> = {
  member_created: 'Карточка создана',
  member_updated: 'Изменена карточка',
  contact_saved: 'Сохранён контакт',
  contact_deleted: 'Удалён контакт',
  address_saved: 'Сохранён адрес',
  address_deleted: 'Удалён адрес',
};

const fields: Array<[keyof Member, string]> = [
  ['full_name', 'ФИО'],
  ['date_of_birth', 'дата рождения'],
  ['membership_date', 'дата вступления'],
  ['membership_status', 'членство'],
];

function MemberHistory({ memberID }: { memberID: number }) {
  const history = useMemberHistory(memberID);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.changes);
  return (
    <Card heading="История изменений">
      {changes.length === 0 ? (
        <EmptyState title="Изменений пока нет" />
      ) : (
        <Timeline
          entries={changes.map((change) => {
            const before = change.before;
            const changed = before ? fields.filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(change.after[key])).map(([, label]) => label) : [];
            return {
              id: change.id,
              title: actions[change.action] ?? 'Запись изменена',
              details: change.action === 'member_updated' && changed.length > 0 ? `Изменено: ${changed.join(', ')}` : undefined,
              meta: `${actorLabel(change.actor_role)} · ${formatDateTime(change.changed_at)}`,
            };
          })}
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
