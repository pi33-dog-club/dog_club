import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, ProblemAlert } from './Alert';
import { Button, type ButtonVariant } from './Button';
import { TextArea, reportInvalid } from './Field';
import styles from './Dialog.module.css';

export const MAX_REASON = 500;

interface FormDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  /** False stops saving, e.g. while a required choice is missing; the button stays enabled and explains. */
  ready?: boolean;
  /** Shown when the person saves while ready is false and the fields themselves are fine. */
  notReady?: string;
  /**
   * Checks of fields the browser cannot check, such as pickers, run together with the browser's:
   * the form shows its own messages under the fields and returns false.
   */
  check?: () => boolean;
  showFieldErrors?: boolean;
  children?: ReactNode;
  /** Offered on a version conflict: reload the record behind the dialog. */
  onReload?: () => void;
  onSubmit: () => Promise<void>;
  onClose: () => void;
}

/** Modal form: shows the API problem inline and closes only after success. */
export function FormDialog({ open, title, description, confirmLabel, confirmVariant = 'save', ready = true, notReady, check, showFieldErrors = true, children, onReload, onSubmit, onClose }: FormDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleID = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setError(null);
      setHint(null);
      dialog.showModal?.();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setHint(null);
    const valid = reportInvalid(event.currentTarget);
    const own = check ? check() : true;
    if (!valid || !own) return;
    if (!ready) {
      // Messages under the fields already say what to fix; otherwise say it here.
      const explained = event.currentTarget.querySelector('[aria-invalid="true"], [role="alert"]');
      if (notReady || !explained) setHint(notReady ?? 'Заполните обязательные поля и исправьте отмеченные ошибки.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClose} aria-labelledby={titleID}>
      {open && (
        <form className={styles.body} noValidate onSubmit={submit} onChangeCapture={() => setHint(null)}>
          <h2 id={titleID} className={styles.title}>
            {title}
          </h2>
          {description && <p>{description}</p>}
          {children}
          {hint && <Alert tone="error">{hint}</Alert>}
          {error ? (
            <ProblemAlert
              error={error}
              showFieldErrors={showFieldErrors}
              onReload={
                onReload &&
                (() => {
                  onReload();
                  onClose();
                })
              }
            />
          ) : null}
          <div className={styles.actions}>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Отмена
            </Button>
            <Button type="submit" variant={confirmVariant} busy={busy}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

interface ReasonDialogProps extends Omit<FormDialogProps, 'onSubmit'> {
  /** Corrections and voids are recorded in history together with the reason. */
  onConfirm: (reason: string) => Promise<void>;
}

export function ReasonDialog({ open, ready = true, children, onConfirm, ...rest }: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const trimmed = reason.trim();
  const tooLong = Array.from(trimmed).length > MAX_REASON;
  return (
    <FormDialog
      open={open}
      ready={ready && Boolean(trimmed) && !tooLong}
      onSubmit={() => onConfirm(trimmed)}
      {...rest}
    >
      {children}
      <TextArea
        label="Причина"
        required
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        hint="Обязательно: объясните причину действия. Сохранится в истории изменений. До 500 символов."
        error={tooLong ? 'Сократите причину до 500 символов.' : undefined}
      />
    </FormDialog>
  );
}
