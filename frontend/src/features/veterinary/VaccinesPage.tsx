import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { fieldErrors } from '../../api/problem';
import { roleLabels } from '../../app/navigation';
import { useSession } from '../../auth/AuthProvider';
import { formatDateTime } from '../../shared/format';
import {
  Button,
  Card,
  EmptyState,
  FormDialog,
  Loading,
  PageHeader,
  QueryError,
  ReasonDialog,
  SelectField,
  Table,
  TextField,
  Timeline,
  fieldStyles,
  tableStyles,
} from '../../shared/ui';
import { changeTitle } from './VetHistory';
import { formatPeriod, useVaccineHistory, useVetDictionaries, vetApi, vetKeys, type Period, type VaccineType } from './vetApi';
import styles from './vet.module.css';

interface Draft {
  name: string;
  maker: string;
  validity: { value: string; unit: Period['unit'] };
  revaccination: { value: string; unit: Period['unit'] };
}

const units = [
  { value: 'days', label: 'дней' },
  { value: 'months', label: 'месяцев' },
];

function draftOf(vaccine?: VaccineType): Draft {
  const period = (value: Period | null) => ({ value: value ? String(value.value) : '', unit: value?.unit ?? 'months' });
  return { name: vaccine?.name ?? '', maker: vaccine?.maker ?? '', validity: period(vaccine?.validity ?? null), revaccination: period(vaccine?.revaccination ?? null) };
}

function bodyOf(draft: Draft) {
  return {
    name: draft.name.trim(),
    maker: draft.maker.trim() || undefined,
    validity: { value: Number(draft.validity.value), unit: draft.validity.unit },
    revaccination: { value: Number(draft.revaccination.value), unit: draft.revaccination.unit },
  };
}

const positive = (value: string) => /^\d+$/.test(value) && Number(value) > 0;

/** Shared vaccine dictionary: periods are set from confirmed data on the product. */
export function VaccinesPage() {
  const { profile } = useSession();
  const client = useQueryClient();
  const dictionaries = useVetDictionaries();
  const [adding, setAdding] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<{ vaccine: VaccineType; draft: Draft } | null>(null);
  const [history, setHistory] = useState<VaccineType | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => client.invalidateQueries({ queryKey: vetKeys.dictionaries });

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
      await refresh();
    } catch (failure) {
      setError(failure);
      throw failure;
    }
  };
  const close = () => {
    setAdding(null);
    setEditing(null);
    setError(null);
  };
  const ready = (draft: Draft | undefined) => Boolean(draft?.name.trim() && positive(draft.validity.value) && positive(draft.revaccination.value));

  return (
    <>
      <PageHeader
        eyebrow={roleLabels[profile.role]}
        title="Препараты"
        actions={
          <Button onClick={() => setAdding(draftOf())}>
            <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
            Добавить препарат
          </Button>
        }
      />
      <p className={styles.note}>
        Срок действия задаёт «Действует до» прививки, интервал ревакцинации — дату следующей дозы. Исправление препарата не меняет уже внесённые прививки.
      </p>
      {dictionaries.isPending ? (
        <Loading />
      ) : dictionaries.isError ? (
        <QueryError error={dictionaries.error} onRetry={() => void dictionaries.refetch()} />
      ) : dictionaries.data.vaccine_types.length === 0 ? (
        <Card>
          <EmptyState title="Препаратов пока нет" />
        </Card>
      ) : (
        <Table caption="Препараты">
          <thead>
            <tr>
              <th scope="col">Препарат</th>
              <th scope="col">Производитель</th>
              <th scope="col">Действует</th>
              <th scope="col">Ревакцинация через</th>
              <th scope="col">Действия</th>
            </tr>
          </thead>
          <tbody>
            {dictionaries.data.vaccine_types.map((vaccine) => (
              <tr key={vaccine.id}>
                <td>
                  <b>{vaccine.name}</b>
                </td>
                <td>{vaccine.maker || <span className={tableStyles.muted}>—</span>}</td>
                <td className={tableStyles.nowrap}>{formatPeriod(vaccine.validity)}</td>
                <td className={tableStyles.nowrap}>{formatPeriod(vaccine.revaccination)}</td>
                <td>
                  <span className={tableStyles.actions}>
                    <Button variant="link" onClick={() => setEditing({ vaccine, draft: draftOf(vaccine) })}>
                      Исправить
                    </Button>
                    <Button variant="link" onClick={() => setHistory(vaccine)}>
                      История
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {history && <VaccineHistory vaccine={history} onClose={() => setHistory(null)} />}

      <FormDialog
        open={adding !== null}
        title="Новый препарат"
        confirmLabel="Сохранить"
        ready={ready(adding ?? undefined)}
        onClose={close}
        onSubmit={() => run(() => vetApi.addVaccineType(bodyOf(adding!)))}
      >
        {adding && <VaccineFields draft={adding} onChange={setAdding} error={error} />}
      </FormDialog>
      <ReasonDialog
        open={editing !== null}
        title={`Исправить «${editing?.vaccine.name ?? ''}»`}
        confirmLabel="Сохранить"
        ready={ready(editing?.draft)}
        onReload={() => void refresh()}
        onClose={close}
        onConfirm={(reason) => run(() => vetApi.updateVaccineType(editing!.vaccine.id, { ...bodyOf(editing!.draft), version: editing!.vaccine.version, reason }))}
      >
        {editing && <VaccineFields draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} error={error} />}
      </ReasonDialog>
    </>
  );
}

function VaccineFields({ draft, onChange, error }: { draft: Draft; onChange: (draft: Draft) => void; error: unknown }) {
  const errors = fieldErrors(error);
  const period = (key: 'validity' | 'revaccination', label: string) => (
    <div className={fieldStyles.row}>
      <TextField
        label={label}
        inputMode="numeric"
        type="number"
        min={1}
        max={2147483647}
        step={1}
        required
        value={draft[key].value}
        onChange={(event) => onChange({ ...draft, [key]: { ...draft[key], value: event.target.value } })}
        error={draft[key].value && (!positive(draft[key].value) || Number(draft[key].value) > 2147483647) ? 'Укажите целое число от 1 до 2147483647.' : errors[`${key}.value`] ?? errors[key]}
      />
      <SelectField
        label="Единица"
        options={units}
        value={draft[key].unit}
        onChange={(event) => onChange({ ...draft, [key]: { ...draft[key], unit: event.target.value as Period['unit'] } })}
        error={errors[`${key}.unit`]}
      />
    </div>
  );
  return (
    <>
      <TextField label="Название" required maxLength={100} value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} error={errors.name} />
      <TextField
        label="Производитель"
        maxLength={100}
        value={draft.maker}
        onChange={(event) => onChange({ ...draft, maker: event.target.value })}
        error={errors.maker}
        hint="Необязательно."
      />
      {period('validity', 'Срок действия')}
      {period('revaccination', 'Ревакцинация через')}
    </>
  );
}

function VaccineHistory({ vaccine, onClose }: { vaccine: VaccineType; onClose: () => void }) {
  const history = useVaccineHistory(vaccine.id, true);
  return (
    <Card
      heading={
        <span className={styles.heading}>
          История «{vaccine.name}»
          <Button variant="secondary" size="small" onClick={onClose}>
            Закрыть
          </Button>
        </span>
      }
    >
      {history.isPending ? (
        <Loading />
      ) : history.isError ? (
        <QueryError error={history.error} />
      ) : (
        <Timeline
          entries={history.data.pages
            .flatMap((page) => page.records)
            .map((change) => ({ id: change.id, title: changeTitle(change), meta: formatDateTime(change.changed_at), reason: change.reason || undefined }))}
        />
      )}
    </Card>
  );
}
