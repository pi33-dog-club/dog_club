import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { components } from '../../api/schema';
import { setSession } from '../../api/session';
import { dog, dogDictionaries } from '../../test/fixtures';
import { json, mockFetch, problem, staffCredentials } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';

type Schemas = components['schemas'];

afterEach(() => setSession(null));

const vaccine: Schemas['MedicalVaccineType'] = {
  id: 1,
  name: 'Комплексная вакцина',
  maker: 'Тест',
  validity: { value: 12, unit: 'months' },
  revaccination: { value: 12, unit: 'months' },
  version: 1,
};

const author = (userID: string): Schemas['MedicalAuthor'] => ({ user_id: userID, profile_id: 'p', member_id: 1 });

function vaccination(overrides: Partial<Schemas['MedicalVaccination']> = {}): Schemas['MedicalVaccination'] {
  return {
    id: 31,
    dog_id: 7,
    date: '2026-03-12',
    vaccine,
    valid_until: '2099-03-12',
    next_date: '2099-03-12',
    is_void: false,
    author: author(staffCredentials.user.id),
    version: 1,
    ...overrides,
  };
}

const status: Schemas['MedicalStatus'] = {
  dog_id: 7,
  as_of: '2026-10-20',
  events: { decision: 'allowed', valid_until: '2027-03-12', clearance_id: 5, reasons: [] },
  breeding: { decision: 'review_required', valid_until: null, clearance_id: 6, reasons: [{ code: 'vaccination_expired', vaccination_id: 31 }] },
};

const page = <T,>(records: T[]) => json({ records, next_after: null });

function examination(userID: string): Schemas['MedicalExamination'] {
  return { id: 41, dog_id: 7, date: '2026-03-12', description: '', result: 'здорова', recommendations: '', diagnoses: [], is_void: false, author: author(userID), version: 1 };
}

function clinical(vaccinations: Schemas['MedicalVaccination'][], examinations: Schemas['MedicalExamination'][] = []) {
  return {
    'GET /api/v1/dogs/7/medical-status': () => json(status),
    'GET /api/v1/dogs/7/vaccinations': () => page(vaccinations),
    'GET /api/v1/dogs/7/examinations': () => page(examinations),
    'GET /api/v1/dogs/7/clearances': () => page([]),
    'GET /api/v1/veterinary-dictionaries': () => json({ diseases: [], vaccine_types: [vaccine] }),
  };
}

const { owner_ids, pedigree, titles, registration_date, ...patient } = dog();

describe('veterinary', () => {
  it('adds a vaccination and shows the overlap error at the date', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => json({ dogs: [patient], next_after: null }),
      'POST /api/v1/dogs/7/vaccinations': () =>
        json(
          {
            type: 'about:blank',
            title: 'Ошибка',
            status: 422,
            code: 'validation_failed',
            detail: 'Проверьте поля.',
            request_id: 'r',
            errors: [{ field: 'date', message: 'Окно прежней дозы до 12.03.2099.' }],
          },
          422,
        ),
      ...clinical([vaccination()]),
    });
    renderApp('/patients/7');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить прививку' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Препарат'), 'Комплексная вакцина');
    expect(within(dialog).getByText('Следующая доза этого препарата не раньше 12.03.2099.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    const date = within(dialog).getByLabelText('Дата прививки');
    await waitFor(() => expect(date.getAttribute('aria-invalid')).toBe('true'));
    const errorID = date.getAttribute('aria-describedby')!.split(' ').at(-1)!;
    expect(document.getElementById(errorID)?.textContent).toBe('Окно прежней дозы до 12.03.2099.');
    const lookup = calls.find((call) => call.url.includes('/veterinary/dogs'))!;
    expect(new URL(lookup.url).searchParams.get('after')).toBe('6');
  });

  it('lets a veterinarian correct only their own records', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => json({ dogs: [patient], next_after: null }),
      ...clinical([vaccination(), vaccination({ id: 32, author: author('other-vet'), date: '2025-01-10' })]),
    });
    renderApp('/patients/7');
    const table = await screen.findByRole('table', { name: 'Вакцинации' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    expect(within(table).getAllByRole('button', { name: 'Отметить ошибочной' })).toHaveLength(1);
  });

  it('shows staff the admission and records without changes', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      ...clinical([vaccination()]),
    });
    renderApp('/dogs/7');
    expect(await screen.findByText('Допущена')).toBeTruthy();
    expect(screen.getByText('Требует проверки')).toBeTruthy();
    expect(await screen.findByText('Срок прививки-основания истёк. «Комплексная вакцина»')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Добавить прививку' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Новое заключение' })).toBeNull();
  });

  it('explains why a lost dog without an own examination gets no clearance', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => json({ dogs: [{ ...patient, status: { id: 2, name: 'Потеряна' } }], next_after: null }),
      ...clinical([], [examination('other-vet')]),
    });
    renderApp('/patients/7');
    expect(await screen.findByText(/новый осмотр внести нельзя/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Новое заключение' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Добавить осмотр' })).toBeNull();
  });

  it('offers a clearance on the veterinarian own examination', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => json({ dogs: [{ ...patient, status: { id: 2, name: 'Потеряна' } }], next_after: null }),
      ...clinical([], [examination(staffCredentials.user.id)]),
    });
    renderApp('/patients/7');
    expect(await screen.findByRole('button', { name: 'Новое заключение' })).toBeTruthy();
    expect(screen.queryByText(/новый осмотр внести нельзя/)).toBeNull();
  });

  it('corrects an own clearance with a reason and leaves others to their authors', async () => {
    const clearance = (id: number, userID: string): Schemas['MedicalClearance'] => ({
      id,
      dog_id: 7,
      purpose: 'events',
      decision: 'allowed',
      examination_id: 41,
      examination_date: '2026-03-12',
      valid_until: '2027-03-12',
      vaccination_ids: [31],
      comment: 'Здорова',
      is_void: false,
      author: author(userID),
      version: 2,
    });
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => json({ dogs: [patient], next_after: null }),
      ...clinical([vaccination()], [examination(staffCredentials.user.id)]),
      'GET /api/v1/dogs/7/clearances': () => page([clearance(5, staffCredentials.user.id), clearance(6, 'other-vet')]),
      'PUT /api/v1/dogs/7/clearances/5': () => json({ ...clearance(5, staffCredentials.user.id), decision: 'denied', valid_until: null, vaccination_ids: [], version: 3 }),
    });
    renderApp('/patients/7');
    const card = (await screen.findByRole('heading', { name: /Заключения о допуске/ })).closest('section')!;
    // Only the own clearance offers a correction; the other vet's one stays read only.
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(2));
    const fix = within(card).getAllByRole('button', { name: 'Исправить' });
    expect(fix).toHaveLength(1);
    await userEvent.click(fix[0]!);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Исправить заключение' })).toBeTruthy();
    expect((within(dialog).getByLabelText('Осмотр') as HTMLSelectElement).value).toBe('41');
    await userEvent.selectOptions(within(dialog).getByLabelText('Решение'), 'denied');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(within(dialog).getByText('Заполните поле «Причина исправления».')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Причина исправления'), 'Ошибка в решении');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const body = await calls.find((call) => call.method === 'PUT')!.json();
    expect(body).toEqual({
      purpose: 'events',
      examination_id: 41,
      comment: 'Здорова',
      decision: 'denied',
      valid_until: null,
      vaccination_ids: [],
      version: 2,
      reason: 'Ошибка в решении',
    });
  });

  it('reports a missing patient', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => json({ dogs: [], next_after: null }),
    });
    renderApp('/patients/99');
    expect(await screen.findByText('Пациент не найден')).toBeTruthy();
  });

  it('keeps an unexpected server failure visible', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('veterinarian')),
      'GET /api/v1/veterinary/dogs': () => problem(503, 'veterinary_unavailable', 'Сервис временно недоступен.'),
    });
    renderApp('/patients');
    expect(await screen.findByText(/Сервис временно недоступен/)).toBeTruthy();
  });
});
