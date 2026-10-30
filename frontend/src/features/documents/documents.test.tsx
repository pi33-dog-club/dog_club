import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { components } from '../../api/schema';
import { attachmentName } from '../../api/files';
import { setSession } from '../../api/session';
import { dog, member } from '../../test/fixtures';
import { json, mockFetch } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';
import { uploadProblem } from './DocumentPage';

type Schemas = components['schemas'];

afterEach(() => {
  setSession(null);
  vi.unstubAllGlobals();
});

const file: Schemas['DocumentFile'] = {
  id: 9,
  document_id: 5,
  document_version: 2,
  name: 'dog-card-5.pdf',
  media_type: 'application/pdf',
  size_bytes: 48_213,
  sha256: 'a'.repeat(64),
  template: 'dog_card',
  source_changed: true,
  created_at: '2026-10-20T10:00:00Z',
};

function document(overrides: Partial<Schemas['Document']> = {}): Schemas['Document'] {
  return {
    id: 5,
    type_id: 9,
    type_name: 'Карточка собаки',
    category: 'general',
    number: 'КС-5',
    issuer: 'Клуб собаководства',
    issue_date: '2026-10-20',
    expires_on: null,
    expired: false,
    status: 'active',
    dog_id: 7,
    member_id: null,
    recipient_member_id: 3,
    legacy_member_id: null,
    event_id: null,
    files: [file],
    version: 2,
    ...overrides,
  };
}

const { owner_ids, pedigree, titles, registration_date, ...summary } = dog();
const breedingDog = (request: Request) => {
  const after = Number(new URL(request.url).searchParams.get('after'));
  return json({ dogs: after === 6 ? [summary] : [], next_after: null });
};
const empty = () => json({ records: [], next_after: null });

describe('documents', () => {
  it('reads the attachment name in both header forms', () => {
    expect(attachmentName(`attachment; filename="card.pdf"; filename*=UTF-8''%D0%BA%D0%B0%D1%80%D1%82%D0%B0.pdf`, 'x.pdf')).toBe('карта.pdf');
    expect(attachmentName('attachment; filename="card.pdf"', 'x.pdf')).toBe('card.pdf');
    expect(attachmentName('attachment; filename=dog_card.pdf', 'x.pdf')).toBe('dog_card.pdf');
    expect(attachmentName(null, 'x.pdf')).toBe('x.pdf');
  });

  it('accepts only PDF, JPEG and PNG up to 10 MiB before upload', () => {
    expect(uploadProblem(new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }))).toBeUndefined();
    expect(uploadProblem(new File(['x'], 'a.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))).toBe('Подойдёт PDF, JPEG или PNG.');
    expect(uploadProblem(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))).toBe('Файл больше 10 МБ.');
  });

  it('downloads a file with the session token as an attachment', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      'GET /api/v1/documents/5': () => json(document()),
      'GET /api/v1/documents/5/history': empty,
      'GET /api/v1/dogs/7': () => json(dog()),
      'GET /api/v1/members/me': () => json(member()),
      'GET /api/v1/documents/5/files/9': () =>
        new Response(new Blob(['%PDF-1.4']), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="dog-card-5.pdf"' } }),
    });
    const createObjectURL = vi.fn(() => 'blob:card');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderApp('/documents/5');
    expect(await screen.findByText('Сведения изменились')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Загрузить копию' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Отменить документ' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const request = calls.find((call) => call.url.endsWith('/files/9'))!;
    expect(request.headers.get('Authorization')).toBe('Bearer access-staff');
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('dog-card-5.pdf');
    expect(await screen.findByText('Мария Иванова')).toBeTruthy();
    click.mockRestore();
  });

  it('lets the vet issue a certificate only on an own examination', async () => {
    const medical = document({ type_id: 4, type_name: 'Ветеринарная справка', category: 'medical', files: [], recipient_member_id: null });
    const exam = (id: number, userID: string) => ({
      id,
      dog_id: 7,
      date: '2026-10-01',
      author: { user_id: userID, profile_id: 'p', member_id: null },
      description: '',
      result: '',
      recommendations: '',
      diagnoses: [],
      is_void: false,
      version: 1,
    });
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/documents/5': () => json(medical),
      'GET /api/v1/documents/5/history': empty,
      'GET /api/v1/veterinary/dogs': breedingDog,
      'GET /api/v1/dogs/7/examinations': () => json({ records: [exam(11, 'u1'), exam(12, 'someone-else')], next_after: null }),
      'GET /api/v1/dogs/7/clearances': empty,
      'POST /api/v1/documents/5/generate': () => json({ ...medical, files: [{ ...file, template: 'veterinary_conclusion', source_changed: null }] }),
    });
    renderApp('/documents/5');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать PDF' }));
    const dialog = screen.getByRole('dialog');
    const exams = within(dialog).getByLabelText('Осмотр') as HTMLSelectElement;
    await waitFor(() => expect(exams.options.length).toBe(2));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сформировать' }));
    expect(within(dialog).getByText('Выберите значение в поле «Осмотр».')).toBeTruthy();
    await userEvent.selectOptions(exams, '11');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Выдача справки');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сформировать' }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/generate'))).toBe(true));
    const body = await calls.find((call) => call.url.endsWith('/generate'))!.json();
    expect(body).toEqual({ version: 2, reason: 'Выдача справки', template: 'veterinary_conclusion', examination_id: 11 });
  });
});
