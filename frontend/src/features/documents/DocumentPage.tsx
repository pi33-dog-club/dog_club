import { Download } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useSession } from '../../auth/AuthProvider';
import { formatDate, formatDateTime } from '../../shared/format';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  Chip,
  EmptyState,
  Fact,
  Facts,
  Loading,
  PageHeader,
  ProblemAlert,
  QueryError,
  ReasonDialog,
  SelectField,
  Table,
  TextField,
  Timeline,
  tableStyles,
} from '../../shared/ui';
import { isMine } from '../veterinary/labels';
import { useClearances, useExaminations } from '../veterinary/vetApi';
import { MAX_UPLOAD, documentsApi, uploadTypes, useDocument, useDocumentHistory, useDocumentsSaved, type Document, type DocumentFile } from './documentsApi';
import { Subject } from './DocumentsPage';
import { DocMemberName, DocumentStatus, categories, formatSize, historyActions, templateFor, templates } from './parts';
import styles from './documents.module.css';

export function DocumentPage() {
  const document = useDocument(Number(useParams().documentID));
  if (document.isPending) return <Loading label="Загружаем документ…" />;
  if (document.isError) return <QueryError error={document.error} onRetry={() => void document.refetch()} />;
  return <DocumentCard document={document.data} onReload={() => void document.refetch()} />;
}

/** Staff keeps general and breeding records, the veterinarian medical ones. */
function useWriter(document: Document): boolean {
  const { profile } = useSession();
  if (document.status === 'void') return false;
  if (profile.role === 'staff') return document.category !== 'medical';
  if (profile.role === 'veterinarian') return document.category === 'medical';
  return false;
}

function DocumentCard({ document, onReload }: { document: Document; onReload: () => void }) {
  const writer = useWriter(document);
  const saved = useDocumentsSaved();
  const [dialog, setDialog] = useState<'upload' | 'generate' | 'void' | null>(null);
  const template = templateFor(document.type_name);

  return (
    <>
      <nav aria-label="Навигационная цепочка" className={styles.crumbs}>
        <Link to="/documents">Документы</Link> / {document.type_name}
      </nav>
      <PageHeader
        eyebrow={document.category ? categories[document.category] : 'Документ'}
        title={document.type_name}
        actions={
          writer && (
            <ButtonLink to={`/documents/${document.id}/edit`} variant="secondary">
              Исправить
            </ButtonLink>
          )
        }
      />
      <div className={styles.chips}>
        <DocumentStatus document={document} />
      </div>
      {document.status === 'legacy' && <Alert tone="warning">Перенесён из старых данных: реквизиты нужно уточнить исправлением.</Alert>}
      <Facts>
        <Fact label="Номер" value={document.number || 'Не указан'} note={document.issuer || undefined} />
        <Fact label="Выдан" value={formatDate(document.issue_date)} note={document.expires_on ? `до ${formatDate(document.expires_on)}` : 'бессрочно'} />
        <Fact label="Предмет" value={<Subject document={document} />} />
        <Fact
          label="Получатель"
          value={document.recipient_member_id ? <DocMemberName id={document.recipient_member_id} /> : 'Клубный экземпляр'}
          note={`Версия ${document.version}`}
        />
      </Facts>

      <Card
        heading={
          <span className={styles.heading}>
            Файлы
            {writer && (
              <span className={styles.actions}>
                {template && (
                  <Button variant="save" size="small" onClick={() => setDialog('generate')}>
                    Сформировать PDF
                  </Button>
                )}
                <Button variant="secondary" size="small" onClick={() => setDialog('upload')}>
                  Загрузить копию
                </Button>
              </span>
            )}
          </span>
        }
      >
        {document.files.length === 0 ? (
          <EmptyState title="Файлов пока нет">{writer && <p>Сформируйте PDF по форме или загрузите скан.</p>}</EmptyState>
        ) : (
          <FilesTable files={document.files} />
        )}
        <p className={styles.note}>Файлы не перезаписываются: каждая загрузка или выпуск формы добавляет новую версию. Скачивание идёт как вложение.</p>
      </Card>

      {writer && (
        <div className={styles.actions}>
          <Button variant="danger" onClick={() => setDialog('void')}>
            Отменить документ
          </Button>
        </div>
      )}
      <DocumentHistory id={document.id} />

      <UploadDialog document={document} open={dialog === 'upload'} onClose={() => setDialog(null)} onReload={onReload} />
      {template && <GenerateDialog document={document} open={dialog === 'generate'} onClose={() => setDialog(null)} onReload={onReload} />}
      <ReasonDialog
        open={dialog === 'void'}
        title="Отменить документ"
        description="Отмена окончательна: запись и файлы останутся в истории, вместо восстановления создают новую запись."
        confirmLabel="Отменить документ"
        confirmVariant="danger"
        onReload={onReload}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await documentsApi.void(document.id, document.version, reason);
          await saved();
        }}
      />
    </>
  );
}

function FilesTable({ files }: { files: DocumentFile[] }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const download = async (file: DocumentFile) => {
    setBusy(file.id);
    setError(null);
    try {
      await documentsApi.download(file);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Table caption="Файлы документа">
        <thead>
          <tr>
            <th scope="col">Файл</th>
            <th scope="col">Источник</th>
            <th scope="col">Добавлен</th>
            <th scope="col">Действия</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <td>
                {file.name}
                <div className={tableStyles.muted}>
                  {uploadTypes[file.media_type]?.toUpperCase()} · {formatSize(file.size_bytes)}
                </div>
              </td>
              <td>
                {file.template ? templates[file.template] : 'Загруженная копия'}
                {file.source_changed && (
                  <div>
                    <Chip tone="sun">Сведения изменились</Chip>
                  </div>
                )}
              </td>
              <td className={tableStyles.nowrap}>{formatDateTime(file.created_at)}</td>
              <td>
                <Button variant="secondary" busy={busy === file.id} onClick={() => void download(file)}>
                  <Download size={16} strokeWidth={2.2} aria-hidden="true" />
                  Скачать
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {error ? <ProblemAlert error={error} /> : null}
      {files.some((file) => file.source_changed) && (
        <p className={styles.note}>После выпуска формы исходные сведения изменились. Прежний PDF не меняется; для актуальной версии сформируйте новый.</p>
      )}
    </>
  );
}

/** The type and size are checked here first; the server checks the signature again. */
export function uploadProblem(file: File | null): string | undefined {
  if (!file) return undefined;
  if (!uploadTypes[file.type]) return 'Подойдёт PDF, JPEG или PNG.';
  if (file.size > MAX_UPLOAD) return 'Файл больше 10 МиБ.';
  if (file.size === 0) return 'Файл пустой.';
  return undefined;
}

function UploadDialog({ document, open, onClose, onReload }: { document: Document; open: boolean; onClose: () => void; onReload: () => void }) {
  const saved = useDocumentsSaved();
  const [file, setFile] = useState<File | null>(null);
  const problem = uploadProblem(file);
  return (
    <ReasonDialog
      open={open}
      title="Загрузить копию"
      description="Скан или фото документа: PDF, JPEG или PNG до 10 МиБ."
      confirmLabel="Загрузить"
      ready={Boolean(file && !problem)}
      onReload={onReload}
      onClose={() => {
        setFile(null);
        onClose();
      }}
      onConfirm={async (reason) => {
        await documentsApi.upload(document.id, file!, document.version, reason);
        await saved();
        setFile(null);
      }}
    >
      <TextField
        label="Файл"
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        required
        onChange={(change) => setFile(change.target.files?.[0] ?? null)}
        error={problem}
      />
    </ReasonDialog>
  );
}

/** A form of the document's type; the veterinary one rests on the vet's own examination. */
function GenerateDialog({ document, open, onClose, onReload }: { document: Document; open: boolean; onClose: () => void; onReload: () => void }) {
  const saved = useDocumentsSaved();
  const template = templateFor(document.type_name)!;
  const medical = template === 'veterinary_conclusion';
  const [examination, setExamination] = useState('');
  const [clearance, setClearance] = useState('');
  return (
    <ReasonDialog
      open={open}
      title="Сформировать PDF"
      description={`Форма «${templates[template]}». Сохранится снимок сведений на момент выпуска.`}
      confirmLabel="Сформировать"
      ready={!medical || Boolean(examination)}
      onReload={onReload}
      onClose={onClose}
      onConfirm={async (reason) => {
        await documentsApi.generate(document.id, {
          version: document.version,
          reason,
          template,
          examination_id: medical ? Number(examination) : undefined,
          clearance_id: medical && clearance ? Number(clearance) : undefined,
        });
        await saved();
      }}
    >
      {medical && document.dog_id && (
        <MedicalBasis dogID={document.dog_id} examination={examination} clearance={clearance} onExamination={setExamination} onClearance={setClearance} />
      )}
    </ReasonDialog>
  );
}

function MedicalBasis({
  dogID,
  examination,
  clearance,
  onExamination,
  onClearance,
}: {
  dogID: number;
  examination: string;
  clearance: string;
  onExamination: (value: string) => void;
  onClearance: (value: string) => void;
}) {
  const { user } = useSession();
  const examinations = useExaminations(dogID);
  const clearances = useClearances(dogID);
  const own = (examinations.data ?? []).filter((item) => !item.is_void && isMine(item.author, user.id));
  const linked = (clearances.data ?? []).filter((item) => !item.is_void && String(item.examination_id) === examination);
  return (
    <>
      <SelectField
        label="Осмотр"
        required
        placeholder={examinations.isPending ? 'Загружаем…' : own.length === 0 ? 'Нет ваших действующих осмотров' : 'Выберите…'}
        options={own.map((item) => ({ value: item.id, label: `Осмотр от ${formatDate(item.date)}` }))}
        value={examination}
        onChange={(change) => {
          onExamination(change.target.value);
          onClearance('');
        }}
        hint="Справку выпускают только по своему неотменённому осмотру."
      />
      {examination && (
        <SelectField
          label="Заключение о допуске"
          placeholder="Без заключения"
          options={linked.map((item) => ({
            value: item.id,
            label: `${item.purpose === 'events' ? 'Мероприятия' : 'Вязка'}, ${item.valid_until ? `до ${formatDate(item.valid_until)}` : 'без срока'}`,
          }))}
          value={clearance}
          onChange={(change) => onClearance(change.target.value)}
          hint="Без выбранного заключения справка не означает допуск."
        />
      )}
    </>
  );
}

/** Owners get the metadata of changes only. */
function DocumentHistory({ id }: { id: number }) {
  const history = useDocumentHistory(id);
  if (history.isPending) return <Loading />;
  if (history.isError) return <QueryError error={history.error} onRetry={() => void history.refetch()} />;
  const changes = history.data.pages.flatMap((page) => page.records);
  return (
    <Card heading="История">
      {changes.length === 0 ? (
        <EmptyState title="Изменений пока нет" />
      ) : (
        <Timeline
          entries={changes.map((change) => ({
            id: change.id,
            title: historyActions[change.action] ?? 'Запись изменена',
            meta: `${formatDateTime(change.changed_at)} · версия ${change.version}`,
            reason: change.reason || undefined,
          }))}
        />
      )}
      {history.hasNextPage && (
        <Button variant="secondary" className={tableStyles.more} busy={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          Показать ещё
        </Button>
      )}
    </Card>
  );
}
