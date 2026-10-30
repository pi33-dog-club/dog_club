import { Link } from 'react-router';
import { formatDateTime } from '../../shared/format';
import { Chip, type ChipTone } from '../../shared/ui';
import { useDog } from '../dogs/dogsApi';
import { formatPeriod } from '../events/zonedTime';
import { decisions, reasons } from '../veterinary/labels';
import type { MedicalCheck, TrainingSession } from './trainingApi';
import styles from './training.module.css';

export const warnings: Record<string, string> = {
  legacy_incomplete: 'Старая запись: время без часового пояса, автор и результат неизвестны',
  medical_clearance: 'На даты занятия не было медицинского допуска к мероприятиям',
  attendance_unconfirmed: 'Явка на связанное мероприятие не подтверждена',
  event_source_changed: 'Мероприятие или запись на него изменились после внесения занятия',
};

export const historyActions: Record<string, string> = {
  created: 'Занятие внесено',
  corrected: 'Занятие исправлено',
  voided: 'Занятие отмечено ошибочным',
};

/** A dog of a session: staff, leader and the owner of a current dog read its card. */
export function DogLabel({ id, link = true }: { id: number; link?: boolean }) {
  const dog = useDog(id);
  const name = dog.data?.nickname ?? (dog.isPending ? '…' : `собака №${id}`);
  return link && dog.data ? <Link to={`/dogs/${id}`}>{name}</Link> : <>{name}</>;
}

export function sessionTime(session: TrainingSession): string {
  if (session.starts_at) return formatPeriod(session.starts_at, session.ends_at, session.timezone);
  return session.legacy_starts_at ? `${session.legacy_starts_at.replace('T', ' ').slice(0, 16)} · без пояса` : 'Время неизвестно';
}

export function MedicalChip({ check }: { check: MedicalCheck | null }) {
  if (!check) return <Chip tone="dashed">Не проверялся</Chip>;
  const item = (decisions as Record<string, { label: string; tone: ChipTone } | undefined>)[check.decision];
  return <Chip tone={item?.tone ?? 'sand'}>{item?.label ?? 'Решение требует уточнения'}</Chip>;
}

/** Decision and reason codes only: no clinical text reaches the training journal. */
export function MedicalCheckView({ title, check }: { title: string; check: MedicalCheck | null }) {
  return (
    <div className={styles.check}>
      <span className={styles.label}>{title}</span>
      <MedicalChip check={check} />
      {check && <span className={styles.note}>проверено {formatDateTime(check.checked_at)}</span>}
      {check && check.reasons.length > 0 && (
        <ul className={styles.reasons}>
          {check.reasons.map((code) => (
            <li key={code}>{(reasons as Record<string, string | undefined>)[code] ?? 'Причина медицинского решения требует уточнения у ветеринара.'}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
