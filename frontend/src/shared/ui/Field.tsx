import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { formatDate } from '../format';
import clsx from './clsx';
import styles from './Field.module.css';

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
  const message = error || nativeError;
  const hintID = `${id}-hint`;
  const errorID = `${id}-error`;
  const describedBy = [hint ? hintID : '', message ? errorID : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field} onInvalidCapture={(event) => {
      const control = event.target;
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        setNativeError(validationMessage(control, label));
      }
    }} onChangeCapture={() => setNativeError(undefined)}>
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

/** Keep browser constraint errors visible next to the control, in Russian. */
function validationMessage(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, label: string): string {
  const { validity } = control;
  if (validity.valueMissing) return control instanceof HTMLSelectElement ? `Выберите значение в поле «${label}».` : `Заполните поле «${label}».`;
  if (control instanceof HTMLInputElement) {
    if (validity.typeMismatch && control.type === 'email') return 'Укажите email в формате name@example.ru.';
    const bound = validity.rangeUnderflow ? control.min : validity.rangeOverflow ? control.max : '';
    if (bound) {
      const value = control.type === 'date' ? formatDate(bound) : control.type === 'datetime-local' ? `${formatDate(bound)} ${bound.slice(11, 16)}` : bound;
      return `«${label}»: значение должно быть ${validity.rangeUnderflow ? 'не меньше' : 'не больше'} ${value}.`;
    }
    if (validity.stepMismatch) return control.step === '1' || !control.step ? 'Укажите целое число.' : `Укажите число с шагом ${control.step}.`;
    if (validity.badInput) return control.type === 'number' ? 'Укажите корректное число.' : 'Укажите существующие дату и время.';
  }
  if (validity.tooLong) return 'Сократите текст до допустимой длины.';
  if (validity.tooShort) return 'Введите текст нужной длины.';
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
  return <TextField type="password" value={value} hint={hint} {...rest} />;
}

export const fieldStyles = styles;
