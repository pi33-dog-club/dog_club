import { ChevronDown } from 'lucide-react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import clsx from './clsx';
import { Field } from './Field';
import styles from './Field.module.css';

export interface Option {
  value: string | number;
  label: string;
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  label: string;
  options: ReadonlyArray<Option>;
  /** First empty option, e.g. «Все породы» in filters or «Выберите…» in forms. */
  placeholder?: string;
  hint?: ReactNode;
  error?: string;
};

export function SelectField({ label, options, placeholder, hint, error, className, ...rest }: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} required={rest.required}>
      {({ id, describedBy, invalid }) => (
        <span className={styles.selectWrap}>
          <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={clsx(styles.control, styles.select, className)} {...rest}>
            {placeholder !== undefined && <option value="">{placeholder}</option>}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown size={18} strokeWidth={2} className={styles.chevron} aria-hidden="true" />
        </span>
      )}
    </Field>
  );
}

/** Dictionary rows from the API as select options. */
export function toOptions(items: ReadonlyArray<{ id: number; name: string }>): Option[] {
  return items.map((item) => ({ value: item.id, label: item.name }));
}
