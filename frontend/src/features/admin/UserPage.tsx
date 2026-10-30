import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Role } from '../../api/session';
import { roleLabels } from '../../app/navigation';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, formatDateTime } from '../../shared/format';
import { Alert, Button, Card, Chip, EmptyState, Fact, Facts, FormDialog, Loading, PageHeader, QueryError, SelectField, Table, TextField, tableStyles } from '../../shared/ui';
import { adminApi, useAdminSaved, useUserInvitation, useUserProfiles, useUsers, type User } from './adminApi';
import { roleOptions, userStatuses } from './UsersPage';
import styles from './admin.module.css';

export function UserPage() {
  const id = useParams().userID ?? '';
  const users = useUsers();
  if (users.isPending) return <Loading label="Загружаем пользователя…" />;
  if (users.isError) return <QueryError error={users.error} onRetry={() => void users.refetch()} />;
  const user = users.data.find((item) => item.id === id);
  if (!user) {
    return (
      <Card>
        <EmptyState title="Пользователь не найден">
          <Link to="/admin/users">К списку пользователей</Link>
        </EmptyState>
      </Card>
    );
  }
  return <UserCard user={user} />;
}

type Confirm = { title: string; description: string; label: string; danger?: boolean; run: () => Promise<unknown> };

function UserCard({ user }: { user: User }) {
  const { user: me } = useSession();
  const saved = useAdminSaved();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [binding, setBinding] = useState(false);
  const self = user.id === me.id;

  const ask = (next: Confirm) => setConfirm(next);
  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/admin/users">Пользователи</Link> / {user.login}
      </nav>
      <PageHeader
        eyebrow="Пользователь"
        title={user.login}
        actions={
          user.status !== 'invited' && (
            <Button
              variant={user.status === 'blocked' ? 'save' : 'danger'}
              onClick={() =>
                ask(
                  user.status === 'blocked'
                    ? {
                        title: 'Разблокировать',
                        description: 'Вход снова станет возможен; прежние сессии не восстановятся.',
                        label: 'Разблокировать',
                        run: () => adminApi.setBlocked(user.id, false),
                      }
                    : {
                        title: 'Заблокировать',
                        description: 'Все сессии пользователя на всех устройствах завершатся сразу.',
                        label: 'Заблокировать',
                        danger: true,
                        run: () => adminApi.setBlocked(user.id, true),
                      },
                )
              }
            >
              {user.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
            </Button>
          )
        }
      />
      <div className={styles.chips}>
        <Chip tone={userStatuses[user.status].tone}>{userStatuses[user.status].label}</Chip>
        {self && <Chip tone="ink">Это вы</Chip>}
      </div>
      <Facts>
        <Fact label="Email" value={user.email} note={user.email_verified_at ? `подтверждён ${formatDate(user.email_verified_at)}` : 'не подтверждён'} />
        <Fact label="Создан" value={formatDate(user.created_at)} />
        <Fact
          label="Карточка члена клуба"
          value={user.club_member_id ? `№ ${user.club_member_id}` : 'Не привязана'}
          action={
            !user.club_member_id && (
              <Button variant="link" onClick={() => setBinding(true)}>
                Привязать
              </Button>
            )
          }
        />
      </Facts>
      {user.status === 'invited' && <InvitationCard user={user} ask={ask} />}
      <ProfilesCard user={user} ask={ask} />
      <Alert tone="info">Права профилей не складываются: в каждой сессии работает один выбранный профиль. Последнего администратора отключить нельзя.</Alert>

      <FormDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description}
        confirmLabel={confirm?.label ?? ''}
        confirmVariant={confirm?.danger ? 'danger' : 'save'}
        onClose={() => setConfirm(null)}
        onSubmit={async () => {
          await confirm!.run();
          await saved();
        }}
      />
      <BindDialog user={user} open={binding} onClose={() => setBinding(false)} />
    </>
  );
}

function InvitationCard({ user, ask }: { user: User; ask: (confirm: Confirm) => void }) {
  const invitation = useUserInvitation(user.id, true);
  if (invitation.isPending) return <Loading />;
  if (invitation.isError) return <QueryError error={invitation.error} onRetry={() => void invitation.refetch()} />;
  const current = invitation.data;
  const expired = current ? Date.parse(current.expires_at) < Date.now() : false;
  return (
    <Card heading="Приглашение">
      {current ? (
        <p>
          {expired ? 'Срок кода истёк' : 'Код действует до'} {formatDateTime(current.expires_at)}.{expired && ' Отправьте новый код.'}
        </p>
      ) : (
        <p>Действующего приглашения нет: оно отменено, учётная запись остаётся неактивной.</p>
      )}
      {current && (
        <div className={styles.actions}>
          <Button
            variant="save"
            onClick={() =>
              ask({
                title: 'Отправить новый код',
                description: 'Прежний код перестанет действовать; новый будет действовать 48 часов.',
                label: 'Отправить',
                run: () => adminApi.resend(current.id),
              })
            }
          >
            Отправить новый код
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              ask({
                title: 'Отменить приглашение',
                description: 'Код перестанет действовать. Учётная запись останется неактивной.',
                label: 'Отменить приглашение',
                danger: true,
                run: () => adminApi.cancelInvitation(current.id),
              })
            }
          >
            Отменить приглашение
          </Button>
        </div>
      )}
    </Card>
  );
}

function ProfilesCard({ user, ask }: { user: User; ask: (confirm: Confirm) => void }) {
  const profiles = useUserProfiles(user.id);
  const [role, setRole] = useState('');
  const [roleMissing, setRoleMissing] = useState(false);
  const taken = new Set(profiles.data?.profiles.map((profile) => profile.role));
  const free = roleOptions.filter((option) => !taken.has(option.value));
  return (
    <Card heading="Профили">
      {profiles.isPending ? (
        <Loading />
      ) : profiles.isError ? (
        <QueryError error={profiles.error} onRetry={() => void profiles.refetch()} />
      ) : (
        <>
          <Table caption="Профили пользователя">
            <thead>
              <tr>
                <th scope="col">Роль</th>
                <th scope="col">Состояние</th>
                <th scope="col">Действия</th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.profiles.map((profile) => (
                <tr key={profile.id}>
                  <td>{roleLabels[profile.role]}</td>
                  <td>{profile.enabled ? <Chip tone="lime">Включён</Chip> : <Chip tone="dashed">Отключён</Chip>}</td>
                  <td>
                    <span className={tableStyles.actions}>
                      <Button
                        variant={profile.enabled ? 'secondary' : 'save'}
                        onClick={() =>
                          ask({
                            title: profile.enabled ? 'Отключить профиль' : 'Включить профиль',
                            description: profile.enabled
                              ? `Полномочия профиля «${roleLabels[profile.role]}» прекратятся при следующем запросе.`
                              : `Профиль «${roleLabels[profile.role]}» снова можно будет выбрать при входе.`,
                            label: profile.enabled ? 'Отключить' : 'Включить',
                            danger: profile.enabled,
                            run: () => adminApi.setProfileEnabled(user.id, profile.id, !profile.enabled),
                          })
                        }
                      >
                        {profile.enabled ? 'Отключить' : 'Включить'}
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {free.length > 0 && (
            <div className={styles.addRow}>
              <SelectField
                label="Новый профиль"
                placeholder="Выберите роль…"
                options={free}
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                  setRoleMissing(false);
                }}
                error={roleMissing ? 'Выберите роль нового профиля.' : undefined}
              />
              <Button
                variant="secondary"
                onClick={() =>
                  !role ? setRoleMissing(true) : ask({
                    title: 'Добавить профиль',
                    description: `Пользователь сможет выбрать профиль «${roleLabels[role as Role]}» при входе или в меню аккаунта.`,
                    label: 'Добавить',
                    run: async () => {
                      await adminApi.addProfile(user.id, role as Role);
                      setRole('');
                    },
                  })
                }
              >
                Добавить
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** The first link between an account and a member card; re-linking to another card is refused. */
function BindDialog({ user, open, onClose }: { user: User; open: boolean; onClose: () => void }) {
  const saved = useAdminSaved();
  const [member, setMember] = useState('');
  const bad = member.trim() !== '' && !/^[1-9]\d{0,8}$/.test(member.trim());
  return (
    <FormDialog
      open={open}
      title="Привязать карточку члена клуба"
      description="Одна карточка — не больше одного аккаунта. Перепривязать к другой карточке потом нельзя."
      confirmLabel="Привязать"
      ready={Boolean(member.trim() && !bad)}
      onClose={() => {
        setMember('');
        onClose();
      }}
      onSubmit={async () => {
        await adminApi.bindMember(user.id, Number(member));
        await saved();
      }}
    >
      <TextField
        label="Номер карточки"
        inputMode="numeric"
        required
        value={member}
        onChange={(event) => setMember(event.target.value)}
        error={bad ? 'Номер карточки — целое число от 1.' : undefined}
        hint="Номер карточки подскажет сотрудник клуба."
      />
    </FormDialog>
  );
}
