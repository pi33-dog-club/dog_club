import { useState } from 'react';
import { Button, FileField, FormDialog, ReasonDialog } from '../../shared/ui';
import { photoApi, photoProblem, usePhotoSaved, useDogPhoto } from './photoApi';
import styles from './dogs.module.css';

/** Staff uploads, replaces or removes the photo; a photo never changes the card version. */
export function PhotoControls({ dogID }: { dogID: number }) {
  const photo = useDogPhoto(dogID);
  const saved = usePhotoSaved();
  const [dialog, setDialog] = useState<'upload' | 'remove' | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tried, setTried] = useState(false);
  const problem = photoProblem(file);
  const current = photo.data?.meta;
  if (photo.isPending) return null;

  return (
    <>
      <Button variant="secondary" className={styles.onForest} onClick={() => setDialog('upload')}>
        {current ? 'Заменить фото' : 'Загрузить фото'}
      </Button>
      {current && (
        <Button variant="link" className={styles.onForestLink} onClick={() => setDialog('remove')}>
          Убрать фото
        </Button>
      )}
      <FormDialog
        open={dialog === 'upload'}
        title={current ? 'Заменить фото' : 'Загрузить фото'}
        description="JPEG или PNG до 5 МБ. Фото увидят сотрудники, руководитель, ветеринар, эксперт и владельцы собаки."
        confirmLabel="Сохранить"
        check={() => {
          setTried(true);
          return Boolean(file && !problem);
        }}
        onReload={() => void saved(dogID)}
        onClose={() => {
          setFile(null);
          setTried(false);
          setDialog(null);
        }}
        onSubmit={async () => {
          await photoApi.set(dogID, file!, current?.version ?? 0);
          await saved(dogID);
        }}
      >
        <FileField label="Фото" file={file} accept=".jpg,.jpeg,.png,image/jpeg,image/png" required onChange={(event) => setFile(event.target.files?.[0] ?? null)} error={problem ?? (tried && !file ? 'Выберите файл фото.' : undefined)} />
      </FormDialog>
      <ReasonDialog
        open={dialog === 'remove'}
        title="Убрать фото"
        description="Карточка снова покажет значок вместо фото. Действие останется в истории собаки."
        confirmLabel="Убрать"
        confirmVariant="danger"
        onReload={() => void saved(dogID)}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await photoApi.remove(dogID, current!.version, reason);
          await saved(dogID);
        }}
      />
    </>
  );
}
