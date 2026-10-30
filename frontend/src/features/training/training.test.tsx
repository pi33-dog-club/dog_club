import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { components } from '../../api/schema';
import { setSession } from '../../api/session';
import { dog, dogDictionaries } from '../../test/fixtures';
import { json, mockFetch } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';

type Schemas = components['schemas'];

afterEach(() => {
  setSession(null);
  vi.useRealTimers();
});

const types: Schemas['TrainingType'][] = [
  { id: 1, name: 'Послушание' },
  { id: 2, name: 'Аджилити' },
];

const grant: Schemas['TrainingInstructor'] = { profile_id: 'p-staff', member_id: 3, name: 'Мария Иванова', enabled: true, available: true, type_ids: [1], version: 2 };

function session(overrides: Partial<Schemas['TrainingSession']> = {}): Schemas['TrainingSession'] {
  return {
    id: 4,
    dog_id: 7,
    type: types[0]!,
    starts_at: '2026-10-16T03:00:00Z',
    ends_at: '2026-10-16T04:00:00Z',
    timezone: 'Asia/Barnaul',
    result: 'Отработаны команды послушания',
    instructor_profile_id: 'p-staff',
    instructor_member_id: 3,
    instructor_name: 'Мария Иванова',
    instructor_grant_version: 2,
    event_id: null,
    registration_id: null,
    event_snapshot: null,
    medical_snapshot: { decision: 'allowed', reasons: [], checked_at: '2026-10-16T05:00:00Z' },
    current_medical: { decision: 'denied', reasons: ['clearance_voided'], checked_at: '2026-10-20T05:00:00Z' },
    source_changed: null,
    is_void: false,
    legacy: false,
    legacy_starts_at: null,
    legacy_ends_at: null,
    warnings: ['medical_clearance'],
    version: 1,
    ...overrides,
  };
}

const empty = () => json({ records: [], next_after: null });

describe('training', () => {
  it('tells staff without an instructor grant why sessions cannot be added', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/training-types': () => json(types),
      'GET /api/v1/training-instructors': () => json({ records: [], next_after: null }),
      'GET /api/v1/training-sessions': empty,
    });
    renderApp('/training');
    expect(await screen.findByText(/допуском инструктора/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Внести занятие/ })).toBeNull();
  });

  it('records a session in the zone of the place, with the types of the grant only', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T12:00:00Z') });
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/training-types': () => json(types),
      'GET /api/v1/training-instructors': () => json({ records: [grant], next_after: null }),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      'POST /api/v1/dogs/7/training-sessions': () => json(session(), 201),
      'GET /api/v1/dogs/7/training-sessions/4': () => json(session()),
      'GET /api/v1/dogs/7/training-sessions/4/history': empty,
    });
    const router = renderApp('/training/new?dog=7');
    const type = (await screen.findByLabelText('Вид дрессировки')) as HTMLSelectElement;
    expect([...type.options].map((option) => option.textContent)).toEqual(['Выберите…', 'Послушание']);
    await userEvent.selectOptions(type, '1');
    await userEvent.selectOptions(screen.getByLabelText('Часовой пояс'), 'Asia/Barnaul');
    await userEvent.type(screen.getByLabelText('Начало'), '2026-10-16T10:00');
    await userEvent.type(screen.getByLabelText('Окончание'), '2026-10-16T11:00');
    expect((screen.getByRole('button', { name: 'Внести занятие' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Результат') as HTMLTextAreaElement).required).toBe(true);
    await userEvent.type(screen.getByLabelText('Результат'), 'Отработаны команды послушания');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Внести занятие' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'Внести занятие' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/training/7/4'));
    const body = await calls.find((call) => call.method === 'POST' && call.url.endsWith('/training-sessions'))!.json();
    expect(body).toEqual({
      type_id: 1,
      timezone: 'Asia/Barnaul',
      starts_at: '2026-10-16T10:00:00+07:00',
      ends_at: '2026-10-16T11:00:00+07:00',
      result: 'Отработаны команды послушания',
      event_id: null,
      registration_id: null,
    });
  });

  it('closes new sessions for a dog that is not on the register', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/training-types': () => json(types),
      'GET /api/v1/training-instructors': () => json({ records: [grant], next_after: null }),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog({ status: { id: 2, name: 'Потеряна' } })),
    });
    renderApp('/training/new?dog=7');
    expect(await screen.findByText(/Собака не на учёте/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Внести занятие' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an owner the medical check then and now, without corrections', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      'GET /api/v1/dogs/7': () => json(dog()),
      'GET /api/v1/dogs/7/training-sessions/4': () => json(session()),
      'GET /api/v1/dogs/7/training-sessions/4/history': empty,
    });
    renderApp('/training/7/4');
    expect(await screen.findByText('При внесении')).toBeTruthy();
    expect(screen.getByText('Допущена')).toBeTruthy();
    expect(screen.getByText('Не допущена')).toBeTruthy();
    expect(screen.getByText('Последнее заключение отмечено ошибочным.')).toBeTruthy();
    expect(screen.getByText('На даты занятия не было медицинского допуска к мероприятиям')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Исправить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Отметить ошибочным' })).toBeNull();
  });
});
