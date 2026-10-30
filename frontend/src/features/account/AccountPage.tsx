import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { roleLabels } from '../../app/navigation';
import { useAuth, useSession } from '../../auth/AuthProvider';
import { changePassword, endLocalSession } from '../../auth/authApi';
import { Button, Card, PageHeader, PasswordField, ProblemAlert, reportInvalid } from '../../shared/ui';
import type { LoginNotice } from '../auth/LoginPage';
import styles from './AccountPage.module.css';

export function AccountPage() {
  const { user, profile } = useSession();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fields = fieldErrors(error);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reportInvalid(event.currentTarget)) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, password);
      // Navigate first so the login screen, not the auth guard, receives the notice.
      const state: LoginNotice = { notice: 'Пароль изменён, все сессии завершены. Войдите с новым паролем.' };
      navigate('/login', { replace: true, state });
      endLocalSession();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow={roleLabels[profile.role]} title="Аккаунт" />
      <div className={styles.grid}>
        <Card heading="Учётная запись">
          <dl className={styles.facts}>
            <dt>Логин</dt>
            <dd>{user.login}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Активный профиль</dt>
            <dd>{roleLabels[profile.role]}</dd>
          </dl>
          <Button variant="secondary" className={styles.action} onClick={() => void logout().catch(() => undefined)}>
            Выйти
          </Button>
        </Card>
        <Card heading="Смена пароля">
          <form className={styles.form} noValidate onSubmit={submit}>
            <PasswordField label="Текущий пароль" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} error={fields.current_password} />
            <PasswordField label="Новый пароль" meter autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} error={fields.password} />
            {error ? <ProblemAlert error={error} /> : null}
            <p className={styles.note}>После смены пароля завершатся все сессии, включая эту.</p>
            <Button type="submit" variant="save" className={styles.action} busy={busy}>
              Сменить пароль
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
