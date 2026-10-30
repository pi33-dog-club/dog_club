import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { fieldErrors, localProblem } from '../../api/problem';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, todayUTC } from '../../shared/format';
import {
  Alert,
  Button,
  Card,
  Loading,
  PageHeader,
  ProblemAlert,
  QueryError,
  SearchPicker,
  SelectField,
  TextArea,
  TextField,
  fieldStyles,
  reportInvalid,
  toOptions,
  MAX_REASON,
} from '../../shared/ui';
import { useDebounced } from '../../shared/useDebounced';
import { useDecisions, useLitters, useRequests } from '../breeding/breedingApi';
import { DogPicker } from '../dogs/DogPicker';
import { useDog } from '../dogs/dogsApi';
import { useEvents, useResults } from '../events/eventsApi';
import { MemberPicker, type PickedMember } from '../members/MemberPicker';
import { useMembersByID } from '../members/membersApi';
import { usePatients } from '../veterinary/vetApi';
import { documentsApi, useDocument, useDocumentTypes, useDocumentsSaved, type Document, type Template } from './documentsApi';
import { DocDogName, DocMemberName, templateFor } from './parts';
import styles from './documents.module.css';

export function DocumentCreatePage() {
  const [params] = useSearchParams();
  const id = (name: string) => Number(params.get(name)) || null;
  return <DocumentForm initial={{ dog: id('dog'), member: id('member'), event: id('event') }} />;
}

export function DocumentEditPage() {
  const document = useDocument(Number(useParams().documentID));
  if (document.isPending) return <Loading />;
  if (document.isError) return <QueryError error={document.error} onRetry={() => void document.refetch()} />;
  const d = document.data;
  return <DocumentForm document={d} initial={{ dog: d.dog_id, member: d.member_id, event: d.event_id ?? null }} key={d.version} />;
}

type Kind = 'member' | 'dog' | 'event';

/** What a form needs as its subject; types without a form let staff choose. */
const subjectOf: Partial<Record<Template, Kind>> = {
  member_card: 'member',
  dog_card: 'dog',
  registration_certificate: 'dog',
  veterinary_conclusion: 'dog',
  breeding_conclusion: 'dog',
  litter_act: 'dog',
  event_participants: 'event',
  event_protocol: 'event',
  event_diploma: 'event',
};

const str = (value: number | null | undefined) => (value ? String(value) : '');

function DocumentForm({ document, initial }: { document?: Document; initial: { dog: number | null; member: number | null; event: number | null } }) {
  const { profile } = useSession();
  const vet = profile.role === 'veterinarian';
  const navigate = useNavigate();
  const saved = useDocumentsSaved();
  const types = useDocumentTypes();
  const [typeID, setTypeID] = useState(str(document?.type_id));
  const [chosenKind, setChosenKind] = useState<Kind>(initial.member ? 'member' : initial.event ? 'event' : 'dog');
  const [dogID, setDogID] = useState(initial.dog);
  const [member, setMember] = useState<PickedMember[]>(initial.member ? [{ id: initial.member, full_name: '' }] : []);
  const [eventID, setEventID] = useState(str(initial.event));
  const [resultID, setResultID] = useState(str(document?.event_result_id));
  const [recipient, setRecipient] = useState(str(document?.recipient_member_id));
  const [requestID, setRequestID] = useState('');
  const [decisionID, setDecisionID] = useState(str(document?.breeding_decision_id));
  const [litterID, setLitterID] = useState(str(document?.litter_id));
  const [number, setNumber] = useState(document?.number ?? '');
  const [issuer, setIssuer] = useState(document?.issuer ?? 'Клуб собаководства');
  const [issued, setIssued] = useState(document?.issue_date ?? '');
  const [expires, setExpires] = useState(document?.expires_on ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  const type = types.data?.find((item) => String(item.id) === typeID);
  const template = type ? templateFor(type.name) : undefined;
  const kind: Kind = (template && subjectOf[template]) ?? (chosenKind === 'event' ? 'dog' : chosenKind);
  const diploma = template === 'event_diploma';
  // After a file is attached the subject, recipient and type are fixed.
  const locked = Boolean(document && document.files.length > 0);
  const datesBad = issued && expires && expires < issued ? 'Окончание раньше выдачи.' : undefined;
  const subjectReady =
    kind === 'member'
      ? member.length > 0
      : kind === 'dog'
        ? Boolean(dogID) && (template !== 'breeding_conclusion' || decisionID) && (template !== 'litter_act' || litterID)
        : Boolean(eventID) && (!diploma || (resultID && dogID && recipient));
  const ready = Boolean(type && subjectReady && !datesBad && (!document || reason.trim()));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valid = reportInvalid(event.currentTarget);
    // Without a type the subject fields are not shown yet: the type's own message is enough.
    const missing = localProblem(
      !type
        ? {}
        : kind === 'member'
          ? { member_id: member.length > 0 ? undefined : 'Выберите члена клуба.' }
          : { dog_id: dogID || (kind === 'event' && !diploma) ? undefined : 'Выберите собаку.' },
    );
    setError(missing);
    if (!valid || missing || !ready || !type) return;
    setBusy(true);
    setError(null);
    const body = {
      type_id: type.id,
      number: number.trim(),
      issuer: issuer.trim(),
      issue_date: issued || null,
      expires_on: expires || null,
      member_id: kind === 'member' ? member[0]!.id : null,
      dog_id: kind === 'dog' || diploma ? dogID : null,
      recipient_member_id: kind === 'member' ? member[0]!.id : recipient ? Number(recipient) : null,
      event_id: kind === 'event' ? Number(eventID) : null,
      event_result_id: diploma && resultID ? Number(resultID) : null,
      breeding_decision_id: template === 'breeding_conclusion' && decisionID ? Number(decisionID) : null,
      litter_id: template === 'litter_act' && litterID ? Number(litterID) : null,
    };
    try {
      const out = document ? await documentsApi.update(document.id, { ...body, version: document.version, reason: reason.trim() }) : await documentsApi.create(body);
      await saved();
      navigate(`/documents/${out.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow={vet ? 'Медицинские документы' : 'Документы'} title={document ? `Исправить: ${document.type_name}` : 'Новый документ'} />
      <Card>
        <form className={styles.form} noValidate onSubmit={submit}>
          {!document && <Alert tone="info">Сначала сохраняется запись реестра. PDF-форму или скан копии добавите в карточке документа.</Alert>}
          {locked && <Alert tone="info">К документу уже приложен файл: тип, предмет и получателя менять нельзя.</Alert>}
          <SelectField
            label="Тип документа"
            required
            disabled={locked}
            placeholder="Выберите…"
            // Medical records belong to the veterinarian; staff keeps the rest.
            options={toOptions((types.data ?? []).filter((item) => vet || item.category !== 'medical'))}
            value={typeID}
            onChange={(change) => setTypeID(change.target.value)}
            error={errors.type_id}
            hint={template ? 'Для этого типа есть PDF-форма.' : type ? 'Для этого типа можно приложить скан или фото.' : undefined}
          />
          {type && !template && !vet && (
            <SelectField
              label="Предмет"
              disabled={locked}
              options={[
                { value: 'dog', label: 'Собака' },
                { value: 'member', label: 'Член клуба' },
              ]}
              value={kind}
              onChange={(change) => setChosenKind(change.target.value as Kind)}
            />
          )}

          {type &&
            kind === 'member' &&
            (member[0] ? (
              <div className={styles.picked}>
                <span>
                  Член клуба: <b>{<DocMemberName id={member[0].id} />}</b>
                </span>
                {!locked && (
                  <Button variant="link" onClick={() => setMember([])}>
                    Выбрать другого
                  </Button>
                )}
              </div>
            ) : (
              <MemberPicker
                label="Член клуба"
                value={member}
                onChange={(value) => setMember(value.slice(-1))}
                error={errors.member_id}
                hint="ФИО члена клуба; он же получатель документа."
              />
            ))}

          {type && kind === 'dog' && (
            <>
              <DogField
                dogID={dogID}
                locked={locked}
                vet={vet}
                onChange={(id) => {
                  setDogID(id);
                  setRecipient('');
                  setDecisionID('');
                  setLitterID('');
                }}
                error={errors.dog_id}
              />
              {dogID && !vet && <RecipientField dogID={dogID} value={recipient} onChange={setRecipient} locked={locked} error={errors.recipient_member_id} />}
              {dogID && template === 'breeding_conclusion' && (
                <DecisionField
                  dogID={dogID}
                  requestID={requestID}
                  decisionID={decisionID}
                  onRequest={setRequestID}
                  onDecision={setDecisionID}
                  error={errors.breeding_decision_id}
                />
              )}
              {dogID && template === 'litter_act' && <LitterField dogID={dogID} value={litterID} onChange={setLitterID} error={errors.litter_id} />}
            </>
          )}

          {type && kind === 'event' && (
            <EventFields
              eventID={eventID}
              resultID={resultID}
              diploma={diploma}
              locked={locked}
              onEvent={(id) => {
                setEventID(id);
                setResultID('');
                setDogID(null);
                setRecipient('');
              }}
              onResult={(id, dog) => {
                setResultID(id);
                setDogID(dog);
                setRecipient('');
              }}
              errors={errors}
            />
          )}
          {type && diploma && dogID && <RecipientField dogID={dogID} value={recipient} onChange={setRecipient} locked={locked} required error={errors.recipient_member_id} />}

          <div className={fieldStyles.row}>
            <TextField
              label="Номер"
              maxLength={50}
              value={number}
              onChange={(change) => setNumber(change.target.value)}
              error={errors.number}
              hint="Пустой номер печатается как неизвестный."
            />
            <TextField label="Дата выдачи" type="date" max={todayUTC()} value={issued} onChange={(change) => setIssued(change.target.value)} error={errors.issue_date} />
          </div>
          <div className={fieldStyles.row}>
            <TextField label="Кем выдан" maxLength={2000} value={issuer} onChange={(change) => setIssuer(change.target.value)} error={errors.issuer} />
            <TextField
              label="Действует до"
              type="date"
              min={issued || undefined}
              value={expires}
              onChange={(change) => setExpires(change.target.value)}
              error={datesBad ?? errors.expires_on}
            />
          </div>
          {document && (
            <TextArea
              label="Причина исправления"
              required
              maxLength={MAX_REASON}
              value={reason}
              onChange={(change) => setReason(change.target.value)}
              error={errors.reason}
              hint="Сохранится в истории документа."
            />
          )}
          {error ? <ProblemAlert error={error} /> : null}
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={busy}>
              {document ? 'Сохранить' : 'Создать запись'}
            </Button>
            <Link to={document ? `/documents/${document.id}` : '/documents'}>Отмена</Link>
          </div>
        </form>
      </Card>
    </>
  );
}

/** Staff searches the catalogue; the vet searches patients, the only dogs it may read. */
function DogField({ dogID, locked, vet, onChange, error }: { dogID: number | null; locked: boolean; vet: boolean; onChange: (id: number | null) => void; error?: string }) {
  if (dogID) {
    return (
      <div className={styles.picked}>
        <span>
          Собака: <b>{<DocDogName id={dogID} />}</b>
        </span>
        {!locked && (
          <Button variant="link" onClick={() => onChange(null)}>
            Выбрать другую
          </Button>
        )}
      </div>
    );
  }
  return vet ? <PatientPicker onPick={onChange} error={error} /> : <DogPicker label="Собака" onPick={(dog) => onChange(dog.id)} error={error} />;
}

function PatientPicker({ onPick, error }: { onPick: (id: number) => void; error?: string }) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const patients = usePatients(q);
  const found = q ? patients.data?.pages.flatMap((page) => page.dogs) : undefined;
  return (
    <SearchPicker
      label="Пациент"
      query={query}
      onQuery={setQuery}
      loading={patients.isFetching || q !== query.trim()}
      error={error}
      hint="Кличка или номер идентификатора."
      items={found?.map((dog) => ({ id: dog.id, title: dog.nickname, note: `${dog.breed.name} · род. ${formatDate(dog.date_of_birth)}` }))}
      onPick={(id) => {
        onPick(id);
        setQuery('');
      }}
    />
  );
}

/** A personal copy goes to a current owner; without one only professionals see it. */
function RecipientField({
  dogID,
  value,
  onChange,
  locked,
  required,
  error,
}: {
  dogID: number;
  value: string;
  onChange: (value: string) => void;
  locked: boolean;
  required?: boolean;
  error?: string;
}) {
  const dog = useDog(dogID);
  const owners = useMembersByID(dog.data?.owner_ids ?? []);
  if (dog.isPending) return <Loading label="Загружаем владельцев…" />;
  if (dog.isError) return <QueryError error={dog.error} onRetry={() => void dog.refetch()} />;
  return (
    <SelectField
      label="Получатель"
      required={required}
      disabled={locked}
      placeholder={required ? 'Выберите владельца…' : 'Только клубный экземпляр'}
      options={dog.data.owner_ids.map((id, index) => ({ value: id, label: owners[index]?.data?.full_name ?? `член клуба №${id}` }))}
      value={value}
      onChange={(change) => onChange(change.target.value)}
      error={error}
      hint="Текущий владелец собаки; он сможет скачать документ."
    />
  );
}

function DecisionField({
  dogID,
  requestID,
  decisionID,
  onRequest,
  onDecision,
  error,
}: {
  dogID: number;
  requestID: string;
  decisionID: string;
  onRequest: (value: string) => void;
  onDecision: (value: string) => void;
  error?: string;
}) {
  const requests = useRequests(dogID);
  const decisions = useDecisions(Number(requestID) || 0, Boolean(requestID));
  return (
    <div className={fieldStyles.row}>
      <SelectField
        label="Заявка на вязку"
        required
        placeholder={requests.isPending ? 'Загружаем…' : 'Выберите…'}
        options={(requests.data ?? []).map((request) => ({ value: request.id, label: `Заявка ${request.id} от ${formatDate(request.planned_date)}` }))}
        value={requestID}
        onChange={(change) => {
          onRequest(change.target.value);
          onDecision('');
        }}
      />
      <SelectField
        label="Решение эксперта"
        required
        placeholder={!requestID ? (decisionID ? `Решение №${decisionID}` : 'Сначала заявка') : 'Выберите…'}
        options={
          requestID
            ? (decisions.data ?? []).map((decision) => ({
                value: decision.id,
                label: `${decision.decision === 'approved' ? 'Одобрена' : 'Отклонена'}, ${formatDate(decision.decided_at)}`,
              }))
            : []
        }
        value={requestID ? decisionID : ''}
        onChange={(change) => onDecision(change.target.value)}
        error={error}
      />
    </div>
  );
}

function LitterField({ dogID, value, onChange, error }: { dogID: number; value: string; onChange: (value: string) => void; error?: string }) {
  const litters = useLitters(dogID);
  return (
    <SelectField
      label="Помёт"
      required
      placeholder={litters.isPending ? 'Загружаем…' : 'Выберите…'}
      options={(litters.data ?? []).map((litter) => ({ value: litter.id, label: `Помёт ${litter.id}, рождён ${formatDate(litter.date_of_birth)}` }))}
      value={value}
      onChange={(change) => onChange(change.target.value)}
      error={error}
    />
  );
}

/** A diploma rests on one result with a grade or a place; a comment alone is not enough. */
function EventFields({
  eventID,
  resultID,
  diploma,
  locked,
  onEvent,
  onResult,
  errors,
}: {
  eventID: string;
  resultID: string;
  diploma: boolean;
  locked: boolean;
  onEvent: (id: string) => void;
  onResult: (id: string, dogID: number | null) => void;
  errors: Record<string, string>;
}) {
  const events = useEvents({});
  const results = useResults(Number(eventID) || 0, Boolean(eventID));
  const rows = (events.data?.pages.flatMap((page) => page.records) ?? []).filter((event) => event.status !== 'draft');
  const scored = (results.data ?? []).filter((result) => !result.is_void && (result.grade || result.place));
  return (
    <>
      <SelectField
        label="Мероприятие"
        required
        disabled={locked}
        placeholder={events.isPending ? 'Загружаем…' : 'Выберите…'}
        options={rows.map((event) => ({ value: event.id, label: event.name }))}
        value={eventID}
        onChange={(change) => onEvent(change.target.value)}
        error={errors.event_id}
        hint={diploma ? 'Диплом выпускается по завершённому мероприятию.' : 'Список участников — после публикации, протокол — после завершения.'}
      />
      {diploma && eventID && (
        <SelectField
          label="Результат"
          required
          disabled={locked}
          placeholder={results.isPending ? 'Загружаем…' : scored.length === 0 ? 'Нет результатов с оценкой или местом' : 'Выберите…'}
          options={scored.map((result) => ({
            value: result.id,
            label: `${result.entry_snapshot?.dog?.nickname ?? `собака №${result.dog_id}`}: ${[result.grade?.name, result.place ? `${result.place} место` : ''].filter(Boolean).join(', ')}`,
          }))}
          value={resultID}
          onChange={(change) => onResult(change.target.value, scored.find((result) => String(result.id) === change.target.value)?.dog_id ?? null)}
          error={errors.event_result_id}
        />
      )}
    </>
  );
}
