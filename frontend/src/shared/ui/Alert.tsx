import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../../api/problem';
import { Button } from './Button';
import clsx from './clsx';
import styles from './Alert.module.css';

type Tone = 'error' | 'success' | 'info' | 'warning';

interface AlertProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Alert({ tone = 'info', title, children, actions }: AlertProps) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={clsx(styles.alert, styles[tone])}>
      {title && <span className={styles.title}>{title}</span>}
      {children && <div>{children}</div>}
      {actions && <span className={styles.actions}>{actions}</span>}
    </div>
  );
}

interface ProblemProps {
  error: unknown;
  showFieldErrors?: boolean;
  /** Offered on version conflicts (HTTP 409): reload the record and retry. */
  onReload?: () => void;
}

/** RFC 9457 problem in human words; code and request_id in small print for support. */
export function ProblemAlert({ error, onReload, showFieldErrors = true }: ProblemProps) {
  const problem = error instanceof ApiError ? error.problem : null;
  const conflict = error instanceof ApiError && error.isConflict;
  return (
    <Alert
      tone="error"
      title={conflict ? (error.code === 'version_conflict' || !problem?.detail ? 'Запись изменил другой пользователь' : 'Данные или состояние записи изменились') : undefined}
      actions={
        conflict && onReload ? (
          <Button size="small" variant="save" onClick={onReload}>
            Обновить
          </Button>
        ) : undefined
      }
    >
      {errorMessage(error)}
      {showFieldErrors && problem?.errors && problem.errors.length > 0 && (
        <ul>
          {problem.errors.map((item, index) => <li key={`${item.field}-${index}`}>{item.message}</li>)}
        </ul>
      )}
      {problem?.request_id && (
        <details className={styles.meta}>
          <summary>Технические сведения</summary>
          Код: {problem.code} · Запрос: {problem.request_id}
        </details>
      )}
    </Alert>
  );
}
