import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { fieldErrors, localProblem } from '../../api/problem';
import { formatDate } from '../../shared/format';
import { Alert, Button, Card, Loading, PageHeader, ProblemAlert, QueryError, TextArea, TextField, fieldStyles, reportInvalid, MAX_REASON } from '../../shared/ui';
import { DogPicker } from '../dogs/DogPicker';
import { useDogDictionaries } from '../dogs/dogsApi';
import { breedingApi, useBreedingSaved, useRequest, type BreedingRequest } from './breedingApi';
import { DogName } from './parts';
import styles from './breeding.module.css';

export function RequestCreatePage() {
  const [params] = useSearchParams();
  const id = (name: string) => Number(params.get(name)) || null;
  return <RequestForm female={id('female')} male={id('male')} />;
}

export function RequestEditPage() {
  const request = useRequest(Number(useParams().requestID));
  if (request.isPending) return <Loading />;
  if (request.isError) return <QueryError error={request.error} onRetry={() => void request.refetch()} />;
  return <RequestForm request={request.data} female={request.data.female_dog_id} male={request.data.male_dog_id} key={request.data.version} />;
}

/** Staff may file a request before the pair's problems are fixed: the check shows them. */
function RequestForm({ request, female: initialFemale, male: initialMale }: { request?: BreedingRequest; female: number | null; male: number | null }) {
  const navigate = useNavigate();
  const saved = useBreedingSaved();
  const dictionaries = useDogDictionaries();
  const sexID = (name: string) => dictionaries.data?.sexes.find((sex) => sex.name === name)?.id;
  const [female, setFemale] = useState(initialFemale);
  const [male, setMale] = useState(initialMale);
  const [planned, setPlanned] = useState(request?.planned_date ?? '');
  const [expected, setExpected] = useState(request?.expected_birth_date ?? '');
  const [comment, setComment] = useState(request?.comment ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const ready = Boolean(female && male && planned && (!request || reason.trim()));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valid = reportInvalid(event.currentTarget);
    const missing = localProblem({ female_dog_id: female ? undefined : 'Выберите суку.', male_dog_id: male ? undefined : 'Выберите кобеля.' });
    setError(missing);
    if (!valid || missing || !ready || !female || !male) return;
    setBusy(true);
    setError(null);
    const body = { female_dog_id: female, male_dog_id: male, planned_date: planned, expected_birth_date: expected || null, comment: comment.trim() };
    try {
      const result = request ? await breedingApi.updateRequest(request.id, { ...body, version: request.version, reason: reason.trim() }) : await breedingApi.createRequest(body);
      await saved();
      navigate(`/breeding/requests/${result.id}`, { replace: true });
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  };

  const parent = (label: string, value: number | null, set: (id: number | null) => void, sex: string, error?: string) => (
    <fieldset className={fieldStyles.fieldset}>
      <legend className={fieldStyles.legend}>{label}</legend>
      {value ? (
        <div className={styles.picked}>
          <b>
            <DogName id={value} plain />
          </b>
          <Button variant="link" onClick={() => set(null)}>
            Выбрать другую
          </Button>
        </div>
      ) : (
        <DogPicker label={`Найти: ${label.toLowerCase()}`} sexID={sexID(sex)} onPick={(dog) => set(dog.id)} error={error} />
      )}
      {value && error && <Alert tone="error">{error}</Alert>}
    </fieldset>
  );

  return (
    <>
      <PageHeader eyebrow="Племенная работа" title={request ? `Исправить заявку ${request.id}` : 'Новая заявка'} />
      <Card>
        <form className={styles.form} noValidate onSubmit={submit}>
          {request && <Alert tone="info">После исправления заявка вернётся к эксперту: прежние решения останутся в истории.</Alert>}
          {parent('Сука', female, setFemale, 'Сука', errors.female_dog_id)}
          {parent('Кобель', male, setMale, 'Кобель', errors.male_dog_id)}
          <div className={fieldStyles.row}>
            <TextField label="Планируемая дата вязки" type="date" required value={planned} onChange={(event) => setPlanned(event.target.value)} error={errors.planned_date} />
            <TextField
              label="Ожидаемые роды"
              type="date"
              min={planned || undefined}
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
              error={errors.expected_birth_date}
              hint="Обязательны для одобрения, если у суки уже был помёт."
            />
          </div>
          <TextArea label="Комментарий" maxLength={2000} value={comment} onChange={(event) => setComment(event.target.value)} error={errors.comment} />
          {request && (
            <TextArea
              label="Причина исправления"
              required
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              error={errors.reason}
              hint={`Сохранится в истории. Сейчас заявка от ${formatDate(request.planned_date)}.`}
            />
          )}
          <p className={styles.note}>Совместимость пары проверяется после сохранения: родство, допуск, порода, интервал между помётами.</p>
          {error ? <ProblemAlert error={error} /> : null}
          <div className={styles.actions}>
            <Button type="submit" variant="save" busy={busy}>
              {request ? 'Сохранить' : 'Подать заявку'}
            </Button>
            <Link to={request ? `/breeding/requests/${request.id}` : '/breeding'}>Отмена</Link>
          </div>
        </form>
      </Card>
    </>
  );
}
