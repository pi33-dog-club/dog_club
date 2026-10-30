import { useSession } from '../../auth/AuthProvider';
import { formatDate } from '../../shared/format';
import { Alert, Card, Chip, Loading, QueryError } from '../../shared/ui';
import { ClearancesCard } from './ClearancesCard';
import { ExaminationsCard } from './ExaminationsCard';
import { decisions, purposes, reasons } from './labels';
import { VaccinationsCard } from './VaccinationsCard';
import { useMedicalStatus, useVaccinations, type Admission } from './vetApi';
import styles from './vet.module.css';

export interface HealthProps {
  dogID: number;
  birth: string;
  /** Inactive dogs (lab 3) get no new or corrected examinations and vaccinations. */
  active: boolean;
}

/** Admission, vaccinations, examinations and clearances; only the veterinarian writes. */
export function HealthTab({ dogID, birth, active }: HealthProps) {
  const { profile } = useSession();
  const vet = profile.role === 'veterinarian';
  return (
    <>
      <AdmissionPanel dogID={dogID} />
      {!vet && <p className={styles.note}>Вносит ветеринар, здесь только просмотр.</p>}
      <VaccinationsCard dogID={dogID} birth={birth} active={active} />
      <ExaminationsCard dogID={dogID} birth={birth} active={active} />
      <ClearancesCard dogID={dogID} active={active} />
    </>
  );
}

function AdmissionPanel({ dogID }: { dogID: number }) {
  const status = useMedicalStatus(dogID);
  const vaccinations = useVaccinations(dogID);
  if (status.isPending) return <Loading label="Проверяем допуск…" />;
  if (status.isError) return <QueryError error={status.error} onRetry={() => void status.refetch()} />;
  const vaccineName = (id: number | null) => vaccinations.data?.find((item) => item.id === id)?.vaccine.name;
  return (
    <div className={styles.admissions}>
      {(['events', 'breeding'] as const).map((purpose) => (
        <AdmissionCard key={purpose} title={`Допуск · ${purposes[purpose].toLowerCase()}`} admission={status.data[purpose]} vaccineName={vaccineName} />
      ))}
    </div>
  );
}

function AdmissionCard({ title, admission, vaccineName }: { title: string; admission: Admission; vaccineName: (id: number | null) => string | undefined }) {
  const decision = decisions[admission.decision];
  return (
    <Card className={styles.admission}>
      <span className={styles.label}>{title}</span>
      <span>
        <Chip tone={decision.tone}>{decision.label}</Chip>
      </span>
      {admission.valid_until && <span className={styles.note}>до {formatDate(admission.valid_until)}</span>}
      {admission.reasons.length > 0 && (
        <ul className={styles.reasons}>
          {admission.reasons.map((reason, index) => {
            const vaccine = vaccineName(reason.vaccination_id);
            return (
              <li key={`${reason.code}-${reason.vaccination_id ?? index}`}>
                {reasons[reason.code] ?? 'Причина медицинского решения требует уточнения у ветеринара.'}
                {vaccine && ` «${vaccine}»`}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function InactiveNote() {
  return <Alert tone="info">Собака не на учёте: новые осмотры и прививки недоступны. Ошибочные записи можно отметить.</Alert>;
}
