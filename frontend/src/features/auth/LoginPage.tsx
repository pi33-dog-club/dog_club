import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError, fieldErrors } from '../../api/problem';
import { canReturnTo, homePath } from '../../app/navigation';
import heroPhoto from '../../assets/login-hero.jpg';
import { useAuth } from '../../auth/AuthProvider';
import * as authApi from '../../auth/authApi';
import { Alert, Ball, Button, PasswordField, ProblemAlert, Stamp, Tabs, TextField, reportInvalid, tabPanelProps } from '../../shared/ui';
import clsx from '../../shared/ui/clsx';
import styles from './LoginPage.module.css';

type Mode = 'login' | 'activate' | 'forgot';

const modes = [
  { value: 'login', label: 'Вход' },
  { value: 'activate', label: 'Приглашение' },
  { value: 'forgot', label: 'Восстановить' },
] as const;

const headlines: Record<Mode, string> = {
  login: 'Где собаки становятся чемпионами',
  activate: 'Добро пожаловать в стаю',
  forgot: 'Потеряли след? Найдём',
};

/** Location state a redirect may leave for the login screen. */
export interface LoginNotice {
  notice?: string;
  from?: string;
}

export function LoginPage() {
  const { status, credentials } = useAuth();
  const location = useLocation();
  const state = (location.state ?? {}) as LoginNotice;
  const [mode, setMode] = useState<Mode>('login');
  const [notice, setNotice] = useState(state.notice ?? '');

  if (status === 'authenticated' && credentials) {
    // The return page may belong to someone else's session: keep it only if this profile can open it.
    const role = credentials.profile.role;
    return <Navigate to={state.from && canReturnTo(role, state.from) ? state.from : homePath(role)} replace />;
  }

  const done = (message: string) => {
    setNotice(message);
    setMode('login');
  };

  return (
    <div className={styles.page}>
      <section className={styles.showcase} aria-label="Витрина">
        <div className={styles.brand}>
          <Stamp size={56} />
          <span>
            Клуб
            <br />
            собаководства
          </span>
        </div>
        <div className={styles.photoWrap}>
          <div className={styles.photoFrame}>
            <img className={styles.photo} src={heroPhoto} alt="Французский бульдог на зелёном фоне" />
            <span className={styles.sticker}>Хороший мальчик</span>
          </div>
        </div>
        <p className={styles.tagline}>Учёт собак, здоровья, вязок и выставок для членов и сотрудников клуба.</p>
        <span className={styles.ball}>
          <Ball size={150} color="var(--lime-light)" />
        </span>
      </section>

      <main className={styles.formSide}>
        {/* Every headline takes the same cell: the block is as tall as the longest one, so the form never moves. */}
        <div className={styles.headlineBox}>
          {Object.values(headlines).map((text) => (
            <span key={text} className={clsx(styles.headline, styles.headlineGhost)} aria-hidden="true">
              {text}
            </span>
          ))}
          <h1 className={styles.headline}>{headlines[mode]}</h1>
        </div>
        <div className={styles.panel}>
          <Tabs label="Способ входа" idPrefix="auth" value={mode} options={modes} onChange={setMode} />
          <div {...tabPanelProps('auth', mode)}>
            {mode === 'login' && <LoginForm notice={notice} onForgot={() => setMode('forgot')} />}
            {mode === 'activate' && <ActivateForm onDone={() => done('Аккаунт активирован. Войдите с логином из письма и новым паролем.')} />}
            {mode === 'forgot' && <ForgotForm onDone={() => done('Пароль изменён, все прежние сессии завершены. Войдите с новым паролем.')} />}
          </div>
        </div>
      </main>
    </div>
  );
}

function LoginForm({ notice, onForgot }: { notice: string; onForgot: () => void }) {
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reportInvalid(event.currentTarget)) return;
    setBusy(true);
    setError(null);
    try {
      // On success the session store re-renders LoginPage, which redirects.
      await login(name.trim(), password);
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      {notice && <Alert tone="success">{notice}</Alert>}
      <TextField label="Логин" autoComplete="username" required value={name} onChange={(event) => setName(event.target.value)} placeholder="ivanova.m" />
      <PasswordField
        label="Пароль"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aside={
          <button type="button" className={styles.inlineLink} onClick={onForgot}>
            Забыли пароль?
          </button>
        }
      />
      {/* The API answers a wrong password with a generic 401 so as not to reveal accounts. */}
      {error instanceof ApiError && error.status === 401 ? <Alert tone="error">Неверный логин или пароль.</Alert> : error ? <ProblemAlert error={error} /> : null}
      <Button type="submit" size="large" block busy={busy}>
        Войти
      </Button>
      <p className={styles.note}>
        Регистрации нет — доступ выдаёт администратор клуба приглашением на email. Если у вас несколько профилей, переключайтесь между ними в меню аккаунта.
      </p>
    </form>
  );
}

function ActivateForm({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
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
      await authApi.activate(token.trim(), password);
      onDone();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      <TextField label="Код из письма-приглашения" required value={token} onChange={(event) => setToken(event.target.value)} placeholder="Вставьте код" hint="Код действует 48 часов." error={fields.token} autoComplete="one-time-code" />
      <PasswordField label="Придумайте пароль" meter autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} error={fields.password} />
      {error ? <ProblemAlert error={error} /> : null}
      <Button type="submit" size="large" block busy={busy}>
        Активировать аккаунт
      </Button>
    </form>
  );
}

function ForgotForm({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [name, setName] = useState('');
  const [sent, setSent] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fields = fieldErrors(error);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'request') {
    return (
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!reportInvalid(event.currentTarget)) return;
          void run(async () => {
            const result = await authApi.forgotPassword(name.trim());
            setSent(result.message);
          });
        }}
      >
        <p>Введите логин — на привязанную почту придёт код для нового пароля (действует 30 минут).</p>
        <TextField label="Логин" autoComplete="username" required value={name} onChange={(event) => setName(event.target.value)} />
        {error ? <ProblemAlert error={error} /> : null}
        {/* The answer is identical for any login by design: it reveals no accounts. */}
        {sent && <Alert tone="success">{sent}</Alert>}
        <Button type="submit" variant="save" size="large" block busy={busy}>
          Отправить код
        </Button>
        <button type="button" className={styles.inlineLink} onClick={() => setStep('reset')}>
          У меня уже есть код
        </button>
      </form>
    );
  }

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!reportInvalid(event.currentTarget)) return;
        void run(async () => {
          await authApi.resetPassword(token.trim(), password);
          onDone();
        });
      }}
    >
      <TextField label="Код из письма" required value={token} onChange={(event) => setToken(event.target.value)} hint="Код действует 30 минут." error={fields.token} autoComplete="one-time-code" />
      <PasswordField label="Новый пароль" meter autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} error={fields.password} />
      {error ? <ProblemAlert error={error} /> : null}
      <Button type="submit" size="large" block busy={busy}>
        Сохранить пароль
      </Button>
      <button type="button" className={styles.inlineLink} onClick={() => setStep('request')}>
        Запросить новый код
      </button>
    </form>
  );
}
