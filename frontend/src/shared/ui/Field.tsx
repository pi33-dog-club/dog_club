import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { formatDate } from '../format';
import { buttonStyles } from './Button';
import clsx from './clsx';
import styles from './Field.module.css';

/** Sent to every control before a form check, so each field drops its old message. */
const RECHECK = 'dogclub:recheck';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  aside?: ReactNode;
  required?: boolean;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

/** Label, control, hint and inline error with correct aria wiring. */
export function Field({ label, hint, error, aside, required, children }: FieldProps) {
  const id = useId();
  const [nativeError, setNativeError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  // Every save checks all fields again: a message whose cause went away disappears.
  useEffect(() => {
    const node = root.current;
    const clear = () => setNativeError(undefined);
    node?.addEventListener(RECHECK, clear);
    return () => node?.removeEventListener(RECHECK, clear);
  }, []);
  const message = error || nativeError;
  const hintID = `${id}-hint`;
  const errorID = `${id}-error`;
  const describedBy = [hint ? hintID : '', message ? errorID : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div
      ref={root}
      className={styles.field}
      onInvalidCapture={(event) => {
        const control = event.target;
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
          // The message goes under the field in Russian; the browser's own popup
          // would repeat it in the browser's language.
          event.preventDefault();
          setNativeError(validationMessage(control, label));
          const first = Array.from(control.form?.elements ?? []).find(
            (element) => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && !element.validity.valid,
          );
          if (first === control) control.focus();
        }
      }}
      onChangeCapture={(event) => {
        setNativeError(undefined);
        const control = event.target;
        if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && control.validity.customError) control.setCustomValidity('');
      }}
    >
      <div className={styles.labelRow}>
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
        {required && <span className={styles.hint}>Обязательно</span>}
        {aside}
      </div>
      {children({ id, describedBy, invalid: Boolean(message) })}
      {hint && (
        <span id={hintID} className={styles.hint}>
          {hint}
        </span>
      )}
      {message && (
        <span id={errorID} className={styles.error} role="alert">
          {message}
        </span>
      )}
    </div>
  );
}

/**
 * Shows every problem the browser finds under its field at once and focuses the
 * first one; true when there is none. Forms use it with noValidate so their own
 * checks can report in the same pass.
 */
export function reportInvalid(form: HTMLFormElement): boolean {
  // The server trims text, so a required field of spaces only is empty too.
  for (const element of Array.from(form.elements)) {
    element.dispatchEvent(new Event(RECHECK, { bubbles: true }));
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.required && element.type !== 'file') {
      element.setCustomValidity(element.value !== '' && element.value.trim() === '' ? 'blank' : '');
    }
  }
  return form.checkValidity();
}

/** Keep browser constraint errors visible next to the control, in Russian. */
function validationMessage(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, label: string): string {
  const { validity } = control;
  if (validity.valueMissing) return control instanceof HTMLSelectElement ? `Выберите значение в поле «${label}».` : `Заполните поле «${label}».`;
  if (validity.customError) return `Заполните поле «${label}»: одних пробелов недостаточно.`;
  if (control instanceof HTMLInputElement) {
    if (validity.typeMismatch && control.type === 'email') return 'Укажите email в формате name@example.ru.';
    const bound = validity.rangeUnderflow ? control.min : validity.rangeOverflow ? control.max : '';
    // Limits like 2147483647 come from storage, not from the club's rules.
    if (bound && Number(bound) >= 1e6) return 'Слишком большое число.';
    if (bound) {
      const under = validity.rangeUnderflow;
      if (control.type === 'date') return `Дата не может быть ${under ? 'раньше' : 'позже'} ${formatDate(bound)}.`;
      if (control.type === 'datetime-local') return `Время не может быть ${under ? 'раньше' : 'позже'} ${formatDate(bound)} ${bound.slice(11, 16)}.`;
      return `Укажите число ${under ? 'не меньше' : 'не больше'} ${bound}.`;
    }
    if (validity.stepMismatch) return control.step === '1' || !control.step ? 'Укажите целое число.' : `Укажите число с шагом ${control.step}.`;
    if (validity.badInput) return control.type === 'number' ? 'Укажите корректное число.' : 'Укажите существующие дату и время.';
  }
  if (validity.tooLong) return 'Сократите текст до допустимой длины.';
  if (validity.tooShort) return `Не короче ${control instanceof HTMLSelectElement ? '' : control.minLength} символов.`;
  return `Проверьте формат поля «${label}».`;
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string; aside?: ReactNode };

export const TextField = forwardRef<HTMLInputElement, InputProps>(function TextField({ label, hint, error, aside, className, ...rest }, ref) {
  return (
    <Field label={label} hint={hint} error={error} aside={aside} required={rest.required}>
      {({ id, describedBy, invalid }) => (
        <input ref={ref} id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={clsx(styles.control, className)} {...rest} />
      )}
    </Field>
  );
});

type AreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode; error?: string };

export function TextArea({ label, hint, error, className, ...rest }: AreaProps) {
  return (
    <Field label={label} hint={hint} error={error} required={rest.required}>
      {({ id, describedBy, invalid }) => (
        <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={clsx(styles.control, className)} {...rest} />
      )}
    </Field>
  );
}

type FileProps = Omit<InputProps, 'type' | 'value'> & { file: File | null };

/**
 * File picker with a Russian button and the chosen name; the native control is only visually hidden.
 * required only marks the field: the dialog checks the chosen file itself, with its own message.
 */
export function FileField({ label, hint, error, file, className, required, ...rest }: FileProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {({ id, describedBy, invalid }) => (
        <span className={clsx(styles.file, className)}>
          <input id={id} type="file" aria-describedby={describedBy} aria-invalid={invalid || undefined} className={styles.fileInput} {...rest} />
          <label htmlFor={id} className={clsx(buttonStyles.button, buttonStyles.secondary, buttonStyles.small)}>
            Выбрать файл
          </label>
          <span className={styles.fileName}>{file ? file.name : 'Файл не выбран'}</span>
        </span>
      )}
    </Field>
  );
}

export const MIN_PASSWORD = 15;

/** Counts Unicode code points, as the server does; no composition rules. */
export function passwordLength(value: string): number {
  return Array.from(value).length;
}

type PasswordProps = Omit<InputProps, 'type' | 'hint'> & { value: string; meter?: boolean };

export function PasswordField({ value, meter, ...rest }: PasswordProps) {
  const count = passwordLength(value);
  const done = count >= MIN_PASSWORD;
  const hint = meter ? (
    <>
      <span className={styles.meter}>
        <span className={styles.track} aria-hidden="true">
          <span className={clsx(styles.fill, done && styles.fillDone)} style={{ width: `${Math.min(100, (count / MIN_PASSWORD) * 100)}%` }} />
        </span>
        <span className={styles.count}>
          {Math.min(count, 999)} / {MIN_PASSWORD} символов
        </span>
      </span>
      <span>Не короче {MIN_PASSWORD} символов. Удобно — фраза из нескольких слов.</span>
    </>
  ) : undefined;
  // A new password is checked for length on save, like on the server.
  return <TextField type="password" value={value} hint={hint} minLength={meter ? MIN_PASSWORD : undefined} {...rest} />;
}

export const fieldStyles = styles;
