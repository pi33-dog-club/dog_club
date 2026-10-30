import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { fieldErrors } from '../../api/problem';
import { todayUTC } from '../../shared/format';
import { Alert, Button, Card, Loading, PageHeader, ProblemAlert, QueryError, SelectField, TextField, fieldStyles, toOptions } from '../../shared/ui';
import { memberKeys, membersApi, useMember, useMemberDictionaries, useMemberSaved, type Member, type MemberPatchInput } from './membersApi';
import styles from './members.module.css';

export function MemberCreatePage() {
  return <MemberForm />;
}

export function MemberEditPage() {
  const id = Number(useParams().memberID);
  const member = useMember(id);
  if (member.isPending) return <Loading />;
  if (member.isError) return <QueryError error={member.error} onRetry={() => void member.refetch()} />;
  return <MemberForm member={member.data} key={member.data.version} />;
}

/** Card fields only; contacts and addresses are edited on the card itself. */
function MemberForm({ member }: { member?: Member }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const saved = useMemberSaved();
  const dictionaries = useMemberDictionaries();
  const [fullName, setFullName] = useState(member?.full_name ?? '');
  const [birth, setBirth] = useState(member?.date_of_birth ?? '');
  const [since, setSince] = useState(member?.membership_date ?? '');
  const [status, setStatus] = useState(member ? String(member.membership_status.id) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [unchanged, setUnchanged] = useState(false);
  const errors = { ...fieldErrors(error), ...local };
  const today = todayUTC();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (birth && (birth < '1900-01-01' || birth > today)) problems.date_of_birth = 'Укажите дату рождения с 01.01.1900 по сегодня.';
    if (since && birth && since < birth) problems.membership_date = 'Дата вступления не может быть раньше даты рождения.';
    setLocal(problems);
    setError(null);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setUnchanged(false);
    try {
      if (!member) {
        const created = await membersApi.create({ full_name: fullName, date_of_birth: birth || null, membership_date: since || null, membership_status_id: Number(status) });
        saved(created);
        navigate(`/members/${created.id}`, { replace: true });
        return;
      }
      const patch: MemberPatchInput = { version: member.version };
      if (fullName !== member.full_name) patch.full_name = fullName;
      if ((birth || null) !== member.date_of_birth) patch.date_of_birth = birth || null;
      if ((since || null) !== member.membership_date) patch.membership_date = since || null;
      if (status !== String(member.membership_status.id)) patch.membership_status_id = Number(status);
      if (Object.keys(patch).length === 1) {
        setUnchanged(true);
        setBusy(false);
        return;
      }
      saved(await membersApi.patch(member.id, patch));
      navigate(`/members/${member.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow={member ? `Члены клуба / ${member.full_name}` : 'Члены клуба'} title={member ? 'Изменить карточку' : 'Новый член клуба'} />
      <Card>
        <form className={styles.form} onSubmit={submit}>
          <TextField label="ФИО" required maxLength={150} autoComplete="off" value={fullName} onChange={(event) => setFullName(event.target.value)} error={errors.full_name} />
          <div className={fieldStyles.row}>
            <TextField
              label="Дата рождения"
              type="date"
              min="1900-01-01"
              max={today}
              onInvalid={(event) => {
                const message = event.currentTarget.validity.rangeOverflow ? 'Дата рождения не может быть в будущем.' : 'Укажите существующую дату рождения с 01.01.1900 по сегодня.';
                setLocal((current) => ({ ...current, date_of_birth: message }));
              }}
              value={birth}
              onChange={(event) => setBirth(event.target.value)}
              error={errors.date_of_birth}
              hint="Необязательно."
            />
            <TextField
              label="В клубе с"
              type="date"
              max={today}
              min={birth || undefined}
              value={since}
              onChange={(event) => setSince(event.target.value)}
              onInvalid={(event) => {
                const message = event.currentTarget.validity.rangeUnderflow ? 'Дата вступления не может быть раньше даты рождения.' : 'Укажите существующую дату вступления не позднее сегодняшней.';
                setLocal((current) => ({ ...current, membership_date: message }));
              }}
              error={errors.membership_date}
              hint="Дата вступления. Необязательно."
            />
            <SelectField
              label="Членство"
              required
              placeholder="Выберите…"
              options={toOptions(dictionaries.data?.membership_statuses ?? [])}
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              error={errors.membership_status_id}
              hint="Раздел владельца открыт только при статусе «Активный»."
            />
          </div>
          {unchanged && <Alert tone="info">Изменений нет — сохранять нечего.</Alert>}
          {error ? <ProblemAlert error={error} onReload={member ? () => void client.invalidateQueries({ queryKey: memberKeys.card(member.id) }) : undefined} /> : null}
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={busy}>
              {member ? 'Сохранить' : 'Создать карточку'}
            </Button>
            <Link to={member ? `/members/${member.id}` : '/members'}>Отмена</Link>
          </div>
        </form>
      </Card>
    </>
  );
}
