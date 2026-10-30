import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { components } from '../../api/schema';
import { setSession } from '../../api/session';
import { dog } from '../../test/fixtures';
import { json, mockFetch } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';

type Schemas = components['schemas'];

afterEach(() => setSession(null));

const dictionaries: Schemas['EventDictionaries'] = {
  types: [
    { id: 1, name: 'Выставка' },
    { id: 2, name: 'Семинар' },
  ],
  classes: [],
  grades: [
    { id: 1, name: 'Отлично' },
    { id: 2, name: 'Очень хорошо' },
  ],
};

const venue: Schemas['EventVenue'] = { id: 2, name: 'Манеж «Сокол»', locality: 'Москва', street: 'Ленинградский проспект', building_number: '12', room: '', version: 1 };

const juniors: Schemas['EventClass'] = {
  id: 4,
  event_id: 8,
  name: 'Юниоры',
  min_age_months: 9,
  max_age_months: 18,
  requirements: '',
  requires_expert: true,
  enabled: true,
  version: 1,
};

function event(overrides: Partial<Schemas['Event']> = {}): Schemas['Event'] {
  return {
    id: 8,
    name: 'Осенняя выставка',
    description: '',
    type: { id: 1, name: 'Выставка' },
    venue,
    // 10:00–18:00 in Moscow.
    starts_at: '2026-10-17T07:00:00Z',
    ends_at: '2026-10-17T15:00:00Z',
    timezone: 'Europe/Moscow',
    audience: 'dogs',
    uses_classes: true,
    status: 'in_progress',
    version: 6,
    rules_version: 3,
    legacy_starts_at: null,
    legacy_ends_at: null,
    classes: [juniors],
    schedule: [],
    expert_profile_ids: ['p-expert'],
    ...overrides,
  };
}

const { owner_ids, pedigree, registration_date, ...card } = dog({ id: 7, nickname: 'Бублик' });
const animal: Schemas['EventAnimal'] = { ...card, pedigree_number: 'РКФ 1234567', pedigree_issuer: 'РКФ', pedigree_known_3_generations: true };

function check(overrides: Partial<Schemas['EventEligibility']> = {}): Schemas['EventEligibility'] {
  return {
    checked_at: '2026-10-17T07:30:00Z',
    starts_at: '2026-10-17T07:00:00Z',
    ends_at: '2026-10-17T15:00:00Z',
    local_date: '2026-10-17',
    event_version: 6,
    class: juniors,
    dog: animal,
    medical: { decision: 'allowed', clearance_id: 3, valid_until: '2026-12-31', reasons: [] },
    qualification_current: true,
    blocking_reasons: [],
    ...overrides,
  };
}

function registration(overrides: Partial<Schemas['EventRegistration']> = {}): Schemas['EventRegistration'] {
  return {
    id: 21,
    event_id: 8,
    member_id: 3,
    dog_id: 7,
    class_id: 4,
    schedule_id: null,
    participant: { id: 3, full_name: 'Мария Иванова' },
    dog: animal,
    status: 'registered',
    qualification: 'approved',
    qualifier_profile_id: 'p-expert',
    qualification_reason: '',
    attendance: null,
    eligibility: check(),
    version: 5,
    ...overrides,
  };
}

const empty = () => json({ records: [], next_after: null });

describe('events', () => {
  it('shows an owner the calendar without drafts, venues or the create button', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      'GET /api/v1/event-dictionaries': () => json(dictionaries),
      'GET /api/v1/events': () => json({ records: [event({ status: 'open' })], next_after: null }),
    });
    renderApp('/events');
    expect(await screen.findByRole('link', { name: 'Осенняя выставка' })).toBeTruthy();
    expect(screen.getByText(/17\.10\.2026, 10:00–18:00/)).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Мероприятия' })).getByText('Запись открыта')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Площадки' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Новое мероприятие/ })).toBeNull();
    const status = screen.getByLabelText('Состояние') as HTMLSelectElement;
    expect([...status.options].map((option) => option.textContent)).not.toContain('Черновик');
    expect(calls.some((call) => call.url.includes('/event-venues'))).toBe(false);
  });

  it('creates a draft with the time of the event zone', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/event-dictionaries': () => json(dictionaries),
      'GET /api/v1/event-venues': () => json({ records: [venue], next_after: null }),
      'POST /api/v1/events': () => json(event({ status: 'draft' }), 201),
      'GET /api/v1/events/8': () => json(event({ status: 'draft' })),
      'GET /api/v1/event-experts': () => json([]),
    });
    const router = renderApp('/events/new');
    await userEvent.type(await screen.findByLabelText('Название'), 'Осенняя выставка');
    await userEvent.selectOptions(screen.getByLabelText('Тип'), '1');
    await waitFor(() => expect(screen.getByRole('option', { name: /Манеж «Сокол»/ })).toBeTruthy());
    await userEvent.selectOptions(screen.getByLabelText('Площадка'), '2');
    await userEvent.selectOptions(screen.getByLabelText('Часовой пояс'), 'Asia/Vladivostok');
    await userEvent.type(screen.getByLabelText('Начало'), '2026-11-14T10:00');
    await userEvent.type(screen.getByLabelText('Окончание'), '2026-11-14T18:00');
    await userEvent.click(screen.getByRole('button', { name: 'Создать черновик' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/events/8'));
    const body = await calls.find((call) => call.method === 'POST' && call.url.endsWith('/events'))!.json();
    expect(body).toEqual({
      name: 'Осенняя выставка',
      type_id: 1,
      venue_id: 2,
      timezone: 'Asia/Vladivostok',
      starts_at: '2026-11-14T10:00:00+10:00',
      ends_at: '2026-11-14T18:00:00+10:00',
      audience: 'dogs',
      uses_classes: false,
      description: '',
    });
  });

  it('explains opening registration and shows the server reason when it fails', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/events/8': () => json(event({ status: 'draft', classes: [] })),
      'GET /api/v1/event-experts': () => json([]),
      'POST /api/v1/events/8/state': () => json({
        type: 'about:blank', title: 'Unprocessable Entity', status: 422,
        code: 'validation_failed', detail: 'Проверьте значения полей.', request_id: 'state-test',
        errors: [{ field: 'classes', code: 'invalid', message: 'Добавьте хотя бы один действующий класс.' }],
      }, 422),
    });
    renderApp('/events/8');
    await userEvent.click(await screen.findByRole('button', { name: 'Открыть запись на мероприятие' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Участники смогут записываться на это мероприятие/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'заполнить данные мероприятия' }).getAttribute('href')).toBe('/events/8/edit');
    expect(within(dialog).getByRole('link', { name: 'добавить или включить класс в программе' }).getAttribute('href')).toBe('/events/8?tab=program');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Начало приёма заявок');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Открыть запись на мероприятие' }));
    expect(await within(dialog).findByText('Добавьте хотя бы один действующий класс.')).toBeTruthy();
  });

  it('explains why class requirements need an expert and saves after correction', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/events/8': () => json(event({ status: 'draft', classes: [] })),
      'GET /api/v1/event-experts': () => json([]),
      'POST /api/v1/events/8/classes': () => json(juniors, 201),
    });
    renderApp('/events/8?tab=program');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить класс' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/Прежние подтверждения/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Юниоры');
    await userEvent.type(within(dialog).getByLabelText('Требования'), 'Базовые команды');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Настройка класса');
    expect(within(dialog).getByText('Для заполненных требований включите решение эксперта по квалификации.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dialog).getByLabelText('Нужно решение эксперта по квалификации'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/classes'))).toBe(true));
    expect(await calls.find((call) => call.method === 'POST' && call.url.endsWith('/classes'))!.json()).toMatchObject({
      name: 'Юниоры', min_age_months: null, max_age_months: null,
      requirements: 'Базовые команды', requires_expert: true, enabled: true, version: 6,
    });
  });

  it('shows class validation details returned by the server', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/events/8': () => json(event({ status: 'draft', classes: [] })),
      'POST /api/v1/events/8/classes': () => json({
        type: 'about:blank', title: 'Unprocessable Entity', status: 422,
        code: 'validation_failed', detail: 'Проверьте значения полей.', request_id: 'class-test',
        errors: [{ field: 'class', code: 'invalid', message: 'Укажите название до 100 и требования до 2000 символов.' }],
      }, 422),
    });
    renderApp('/events/8?tab=program');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить класс' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Юниоры');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Настройка класса');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await within(dialog).findByText('Укажите название до 100 и требования до 2000 символов.')).toBeTruthy();
  });

  it('keeps the attendance snapshot of an attended dog after its card changed', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('leader')),
      'GET /api/v1/events/8': () => json(event({ status: 'completed' })),
      // The dog card changed after the show: the live check now wants a new decision.
      'GET /api/v1/events/8/registrations/21': () =>
        json(registration({ status: 'attended', attendance: check(), eligibility: check({ qualification_current: false, blocking_reasons: ['qualification_required'] }) })),
      'GET /api/v1/events/8/registrations/21/history': empty,
      'GET /api/v1/events/8/results': empty,
    });
    renderApp('/events/8/registrations/21');
    expect(await screen.findByText('Проверка на момент явки')).toBeTruthy();
    expect(screen.getByText('Все проверки пройдены')).toBeTruthy();
    expect(screen.queryByText('Текущая проверка')).toBeNull();
    expect(screen.queryByText('Нужно решение эксперта по квалификации')).toBeNull();
    expect(screen.queryByText(/подтверждение устарело/)).toBeNull();
  });

  it('names the lab 3 reasons and keeps attendance closed while they last', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/events/8': () => json(event()),
      'GET /api/v1/events/8/registrations/21': () =>
        json(
          registration({
            dog: { ...animal, pedigree_known_3_generations: false },
            eligibility: check({ dog: { ...animal, pedigree_known_3_generations: false }, blocking_reasons: ['dog_inactive', 'pedigree_incomplete'] }),
          }),
        ),
      'GET /api/v1/events/8/registrations/21/history': empty,
      'GET /api/v1/events/8/results': empty,
    });
    renderApp('/events/8/registrations/21');
    const panel = (await screen.findByText('Текущая проверка')).closest('section') ?? document.body;
    expect(within(panel as HTMLElement).getByText('Собака не на учёте')).toBeTruthy();
    expect(within(panel as HTMLElement).getByText(/Родословная не известна на три поколения/)).toBeTruthy();
    expect(
      within(panel as HTMLElement)
        .getByRole('link', { name: 'Заполнить родословную' })
        .getAttribute('href'),
    ).toBe('/dogs/7?tab=pedigree');
    expect(screen.getByText('Известна не полностью')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Отметить явку' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Явку можно отметить, когда пройдены все проверки допуска.')).toBeTruthy();
  });

  it('leaves the pedigree link to staff only', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('leader')),
      'GET /api/v1/events/8': () => json(event()),
      'GET /api/v1/events/8/registrations/21': () => json(registration({ eligibility: check({ blocking_reasons: ['pedigree_incomplete'] }) })),
      'GET /api/v1/events/8/registrations/21/history': empty,
      'GET /api/v1/events/8/results': empty,
    });
    renderApp('/events/8/registrations/21');
    expect(await screen.findByText(/Родословная не известна на три поколения/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Заполнить родословную' })).toBeNull();
  });

  it('lets the assigned expert record a result of an attended dog', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('expert')),
      'GET /api/v1/events/8': () => json(event()),
      'GET /api/v1/event-dictionaries': () => json(dictionaries),
      'GET /api/v1/events/8/registrations/21': () => json(registration({ status: 'attended', attendance: check() })),
      'GET /api/v1/events/8/registrations/21/history': empty,
      'GET /api/v1/events/8/results': empty,
      'POST /api/v1/events/8/registrations/21/result': () => json({}, 201),
    });
    renderApp('/events/8/registrations/21');
    await userEvent.click(await screen.findByRole('button', { name: 'Внести результат' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Отлично' })).toBeTruthy());
    await userEvent.selectOptions(within(dialog).getByLabelText('Оценка'), '1');
    await userEvent.type(within(dialog).getByLabelText('Место'), '2');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Ринг юниоров');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/result'))).toBe(true));
    const body = await calls.find((call) => call.method === 'POST' && call.url.endsWith('/result'))!.json();
    expect(body).toEqual({ version: 5, grade_id: 1, place: 2, comment: '', reason: 'Ринг юниоров' });
    expect(screen.queryByRole('button', { name: 'Отметить явку' })).toBeNull();
  });

  it('gives the leader the event without changes', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('leader')),
      'GET /api/v1/events/8': () => json(event({ status: 'closed' })),
      'GET /api/v1/event-experts': () => json([{ profile_id: 'p-expert', display_name: 'Ольга Петрова' }]),
    });
    renderApp('/events/8');
    expect(await screen.findByText('Ольга Петрова')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Начать мероприятие' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Исправить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Назначить' })).toBeNull();
  });
});
