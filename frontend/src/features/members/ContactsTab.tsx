import { Plus } from 'lucide-react';
import { useState } from 'react';
import { ApiError, fieldErrors } from '../../api/problem';
import { Button, Card, EmptyState, FormDialog, SelectField, Table, TextField, fieldStyles, tableStyles, toOptions } from '../../shared/ui';
import { formatAddress, membersApi, useMemberDictionaries, useMemberSaved, type Member, type MemberAddress, type MemberContact } from './membersApi';
import styles from './members.module.css';

interface TabProps {
  member: Member;
  editable: boolean;
  onReload: () => void;
}

export function ContactsTab({ member, editable, onReload }: TabProps) {
  return (
    <>
      <Contacts member={member} editable={editable} onReload={onReload} />
      <Addresses member={member} editable={editable} onReload={onReload} />
    </>
  );
}

type ContactDraft = { id?: number; type_id: string; value: string };

function Contacts({ member, editable, onReload }: TabProps) {
  const saved = useMemberSaved();
  const dictionaries = useMemberDictionaries();
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  const [removing, setRemoving] = useState<MemberContact | null>(null);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);
  const isPhone = dictionaries.data?.contact_types.find((type) => String(type.id) === draft?.type_id)?.name === 'Телефон';

  const save = async () => {
    if (!draft) return;
    const body = { version: member.version, type_id: Number(draft.type_id), value: draft.value };
    try {
      const phone = draft.value.trim();
      const digits = phone.replace(/[^0-9]/g, '');
      if (isPhone && (!/^[0-9+(). \-]+$/.test(phone) || digits.length < 7 || digits.length > 15 || phone.length > 50)) {
        throw new ApiError(422, {
          type: 'about:blank', title: 'Ошибка заполнения', status: 422, code: 'validation_failed', request_id: '',
          detail: 'Проверьте номер телефона.',
          errors: [{ field: 'value', code: 'invalid', message: 'Укажите телефон с 7–15 цифрами; допустимы пробелы, +, скобки, точка и дефис.' }],
        });
      }
      saved(draft.id ? await membersApi.replaceContact(member.id, draft.id, body) : await membersApi.addContact(member.id, body));
      setError(null);
    } catch (failure) {
      setError(failure);
      throw failure;
    }
  };

  return (
    <Card
      heading={
        <span className={styles.cardHeading}>
          Контакты
          {editable && (
            <Button variant="secondary" size="small" onClick={() => setDraft({ type_id: '', value: '' })}>
              <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
              Добавить контакт
            </Button>
          )}
        </span>
      }
    >
      {member.contacts.length === 0 ? (
        <EmptyState title="Контактов нет" />
      ) : (
        <Table caption="Контакты">
          <thead>
            <tr>
              <th scope="col">Тип</th>
              <th scope="col">Значение</th>
              {editable && <th scope="col">Действия</th>}
            </tr>
          </thead>
          <tbody>
            {member.contacts.map((contact) => (
              <tr key={contact.id}>
                <td className={tableStyles.muted}>{contact.type.name}</td>
                <td>{contact.value}</td>
                {editable && (
                  <td>
                    <span className={tableStyles.actions}>
                      <Button variant="link" onClick={() => setDraft({ id: contact.id, type_id: String(contact.type.id), value: contact.value })}>
                        Изменить
                      </Button>
                      <Button variant="danger" onClick={() => setRemoving(contact)}>
                        Удалить
                      </Button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <FormDialog
        onReload={onReload}
        open={draft !== null}
        title={draft?.id ? 'Изменить контакт' : 'Новый контакт'}
        confirmLabel="Сохранить"
        ready={Boolean(draft?.type_id && draft.value.trim())}
        onClose={() => {
          setDraft(null);
          setError(null);
        }}
        onSubmit={save}
      >
        {draft && (
          <>
            <SelectField
              label="Тип"
              required
              placeholder="Выберите…"
              options={toOptions(dictionaries.data?.contact_types ?? [])}
              value={draft.type_id}
              onChange={(event) => setDraft({ ...draft, type_id: event.target.value })}
              error={errors.type_id}
            />
            <TextField label="Значение" type={isPhone ? 'tel' : 'text'} hint={isPhone ? 'От 7 до 15 цифр, например +7 (900) 123-45-67.' : undefined} required value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} error={errors.value} />
          </>
        )}
      </FormDialog>
      <FormDialog
        onReload={onReload}
        open={removing !== null}
        title="Удалить контакт?"
        description={removing ? `${removing.type.name}: ${removing.value}. Удаление сохранится в истории карточки.` : undefined}
        confirmLabel="Удалить"
        confirmVariant="primary"
        onClose={() => setRemoving(null)}
        onSubmit={async () => {
          if (removing) saved(await membersApi.deleteContact(member.id, removing.id, member.version));
        }}
      />
    </Card>
  );
}

type AddressDraft = { id?: number; type_id: string; locality: string; street: string; building_number: string; apartment_number: string };

const emptyAddress: AddressDraft = { type_id: '', locality: '', street: '', building_number: '', apartment_number: '' };

function Addresses({ member, editable, onReload }: TabProps) {
  const saved = useMemberSaved();
  const dictionaries = useMemberDictionaries();
  const [draft, setDraft] = useState<AddressDraft | null>(null);
  const [removing, setRemoving] = useState<MemberAddress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const errors = fieldErrors(error);

  const edit = (address: MemberAddress) =>
    setDraft({
      id: address.id,
      type_id: String(address.type.id),
      locality: address.locality,
      street: address.street,
      building_number: address.building_number,
      apartment_number: address.apartment_number,
    });

  const save = async () => {
    if (!draft) return;
    const body = {
      version: member.version,
      type_id: Number(draft.type_id),
      locality: draft.locality,
      street: draft.street.trim() || undefined,
      building_number: draft.building_number.trim() || undefined,
      apartment_number: draft.apartment_number.trim() || undefined,
    };
    try {
      saved(draft.id ? await membersApi.replaceAddress(member.id, draft.id, body) : await membersApi.addAddress(member.id, body));
      setError(null);
    } catch (failure) {
      setError(failure);
      throw failure;
    }
  };

  const field = (name: keyof Omit<AddressDraft, 'id'>) => ({
    value: draft?.[name] ?? '',
    onChange: (event: { target: { value: string } }) => draft && setDraft({ ...draft, [name]: event.target.value }),
    error: errors[name],
  });

  return (
    <Card
      heading={
        <span className={styles.cardHeading}>
          Адреса
          {editable && (
            <Button variant="secondary" size="small" onClick={() => setDraft(emptyAddress)}>
              <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
              Добавить адрес
            </Button>
          )}
        </span>
      }
    >
      {member.addresses.length === 0 ? (
        <EmptyState title="Адресов нет" />
      ) : (
        <Table caption="Адреса">
          <thead>
            <tr>
              <th scope="col">Тип</th>
              <th scope="col">Адрес</th>
              {editable && <th scope="col">Действия</th>}
            </tr>
          </thead>
          <tbody>
            {member.addresses.map((address) => (
              <tr key={address.id}>
                <td className={tableStyles.muted}>{address.type.name}</td>
                <td>{formatAddress(address)}</td>
                {editable && (
                  <td>
                    <span className={tableStyles.actions}>
                      <Button variant="link" onClick={() => edit(address)}>
                        Изменить
                      </Button>
                      <Button variant="danger" onClick={() => setRemoving(address)}>
                        Удалить
                      </Button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <FormDialog
        onReload={onReload}
        open={draft !== null}
        title={draft?.id ? 'Изменить адрес' : 'Новый адрес'}
        confirmLabel="Сохранить"
        ready={Boolean(draft?.type_id && draft.locality.trim())}
        onClose={() => {
          setDraft(null);
          setError(null);
        }}
        onSubmit={save}
      >
        {draft && (
          <>
            <SelectField label="Тип" required placeholder="Выберите…" options={toOptions(dictionaries.data?.address_types ?? [])} {...field('type_id')} />
            <TextField label="Населённый пункт" required {...field('locality')} />
            <TextField label="Улица" {...field('street')} />
            <div className={fieldStyles.row}>
              <TextField label="Дом" {...field('building_number')} />
              <TextField label="Квартира" {...field('apartment_number')} />
            </div>
          </>
        )}
      </FormDialog>
      <FormDialog
        onReload={onReload}
        open={removing !== null}
        title="Удалить адрес?"
        description={removing ? `${removing.type.name}: ${formatAddress(removing)}. Удаление сохранится в истории карточки.` : undefined}
        confirmLabel="Удалить"
        confirmVariant="primary"
        onClose={() => setRemoving(null)}
        onSubmit={async () => {
          if (removing) saved(await membersApi.deleteAddress(member.id, removing.id, member.version));
        }}
      />
    </Card>
  );
}
