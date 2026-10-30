import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fieldErrors, localProblem } from '../../api/problem';
import type { Role } from '../../api/session';
import { roleLabels } from '../../app/navigation';
import { formatDate } from '../../shared/format';
import { badEmail, loginPattern, loginRule } from '../../shared/rules';
import {
  Ball,
  Button,
  Card,
  Chip,
  EmptyState,
  FormDialog,
  Loading,
  PageHeader,
  QueryError,
  SelectField,
  Table,
  TextField,
  Toolbar,
  fieldStyles,
  tableStyles,
  type ChipTone,
} from '../../shared/ui';
import { adminApi, useAdminSaved, useUsers, type User } from './adminApi';

export const userStatuses: Record<User['status'], { label: string; tone: ChipTone }> = {
  invited: { label: 'Приглашён', tone: 'sun' },
  active: { label: 'Активен', tone: 'lime' },
  blocked: { label: 'Заблокирован', tone: 'pink' },
};

export const roleOptions = (Object.keys(roleLabels) as Role[]).map((value) => ({ value, label: roleLabels[value] }));

/** Accounts of the club: there is no self-registration, access starts with an invitation. */
export function UsersPage() {
  const users = useUsers();
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const q = query.trim().toLowerCase();
  const rows = (users.data ?? []).filter((user) => !q || user.login.toLowerCase().includes(q) || user.email.toLowerCase().includes(q));

  return (
    <>
      <PageHeader
        eyebrow="Администратор"
        title="Пользователи"
        actions={
          <Button onClick={() => setInviting(true)}>
            <UserPlus size={18} strokeWidth={2.4} aria-hidden="true" />
            Пригласить
          </Button>
        }
      />
      <Toolbar>
        <TextField label="Поиск" type="search" placeholder="Логин или email" value={query} onChange={(event) => setQuery(event.target.value)} />
      </Toolbar>
      {users.isPending ? (
        <Loading label="Загружаем пользователей…" />
      ) : users.isError ? (
        <QueryError error={users.error} onRetry={() => void users.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title={q ? 'Никого не нашли' : 'Пользователей пока нет'} illustration={<Ball />} />
        </Card>
      ) : (
        <Table caption="Пользователи">
          <thead>
            <tr>
              <th scope="col">Логин</th>
              <th scope="col">Email</th>
              <th scope="col">Статус</th>
              <th scope="col">Карточка</th>
              <th scope="col">Создан</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => (
              <tr key={user.id}>
                <td>
                  <Link to={`/admin/users/${user.id}`}>{user.login}</Link>
                </td>
                <td>{user.email}</td>
                <td>
                  <Chip tone={userStatuses[user.status].tone}>{userStatuses[user.status].label}</Chip>
                </td>
                <td>{user.club_member_id ? `№ ${user.club_member_id}` : '—'}</td>
                <td className={tableStyles.nowrap}>{formatDate(user.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const saved = useAdminSaved();
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('owner');
  const [member, setMember] = useState('');
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const badMember = member.trim() !== '' && !/^[1-9]\d{0,8}$/.test(member.trim());
  const close = () => {
    setLogin('');
    setEmail('');
    setRole('owner');
    setMember('');
    setError(null);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      title="Пригласить пользователя"
      description="На email уйдёт одноразовый код, он действует 48 часов. Пароль пользователь придумает сам."
      confirmLabel="Пригласить"
      ready={!badMember}
      check={() => {
        const name = login.trim().toLowerCase();
        const address = email.trim().toLowerCase();
        const problem = localProblem({
          login: name && !loginPattern.test(name) ? loginRule : undefined,
          email: address && badEmail(address) ? 'Укажите email в виде name@example.ru, не больше 254 символов.' : undefined,
        });
        setError(problem);
        return !problem;
      }}
      onClose={close}
      onSubmit={async () => {
        try {
          const name = login.trim().toLowerCase();
          const address = email.trim().toLowerCase();
          const invitation = await adminApi.invite({ login: name, email: address, role, club_member_id: member.trim() ? Number(member) : undefined });
          await saved();
          navigate(`/admin/users/${invitation.user_id}`);
        } catch (failure) {
          setError(failure);
          throw failure;
        }
      }}
    >
      <div className={fieldStyles.row}>
        <TextField label="Логин" required maxLength={64} autoComplete="off" value={login} onChange={(event) => setLogin(event.target.value)} error={errors.login} hint="Латиница в нижнем регистре, цифры, точка, дефис, подчёркивание; от 3 символов." />
        <TextField label="Email" type="email" required maxLength={254} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} error={errors.email} />
      </div>
      <SelectField
        label="Первый профиль"
        options={roleOptions}
        value={role}
        onChange={(event) => setRole(event.target.value as Role)}
        error={errors.role}
        hint="Остальные профили можно добавить позже."
      />
      <TextField
        label="Карточка члена клуба"
        inputMode="numeric"
        value={member}
        onChange={(event) => setMember(event.target.value)}
        error={badMember ? 'Номер карточки — целое число от 1.' : errors.club_member_id}
        hint="Необязательно. Номер карточки подскажет сотрудник клуба."
      />
    </FormDialog>
  );
}
