import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setSession } from '../../api/session';
import { dog, dogDictionaries, member } from '../../test/fixtures';
import { json, mockFetch, problem } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';

afterEach(() => setSession(null));

/** A list row: the card without owners, pedigree, titles and registration. */
const summary = (overrides = {}) => {
  const { owner_ids, pedigree, titles, registration_date, ...rest } = dog(overrides);
  return rest;
};

describe('dogs catalogue', () => {
  it('lists dogs, sends filters to the server and offers registration to staff', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs': () => json({ dogs: [summary(), summary({ id: 8, nickname: 'Ласка', status: { id: 2, name: 'Потеряна' } })], next_after: null }),
    });
    renderApp('/dogs');
    expect(await screen.findByRole('link', { name: 'Бублик' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Зарегистрировать собаку' })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Пол'), 'Сука');
    await waitFor(() => expect(calls.some((call) => new URL(call.url).searchParams.get('sex_id') === '2')).toBe(true));
  });

  it('hides changes from the leader', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('leader')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      'GET /api/v1/dogs/5': () => json(dog({ id: 5, nickname: 'Граф', pedigree: { number: '', issuer: '', father: null, mother: null } })),
    });
    renderApp('/dogs/7?tab=pedigree');
    expect(await screen.findByRole('heading', { name: 'Бублик' })).toBeTruthy();
    expect(screen.getByText('Известна на 3 поколения')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Граф' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Изменить' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull();
  });
});

describe('dog card', () => {
  it('shows an owner co-owners without reading other people', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog({ status: { id: 2, name: 'Потеряна' } })),
    });
    renderApp('/dogs/7?tab=owners');
    expect(await screen.findByText('Вы и ещё 1 совладелец.')).toBeTruthy();
    expect(await screen.findByText('Собака не на учёте: новые записи недоступны')).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/members'))).toBe(false);
  });

  it('translates registration and litter actions returned in the dog history', async () => {
    const actions = ['registration_date_confirmed', 'puppy_registered', 'litter_parents_set'];
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      'GET /api/v1/dogs/7/photo': () => problem(404, 'not_found', 'Фото нет.'),
      'GET /api/v1/dogs/7/history': () => json({ changes: actions.map((action, index) => ({
        id: index + 1, action, actor_user_id: 'u1', actor_profile_id: 'p-staff', actor_role: 'staff',
        reason: '', before: dog(), after: dog({ version: 5 }), request_id: 'r', changed_at: '2026-10-20T10:00:00Z',
      })), next_after: null }),
    });
    renderApp('/dogs/7?tab=history');
    expect(await screen.findByText('Уточнена дата регистрации')).toBeTruthy();
    expect(screen.getByText('Щенок зарегистрирован')).toBeTruthy();
    expect(screen.getByText('Указаны родители по помёту')).toBeTruthy();
    for (const action of actions) expect(screen.queryByText(action)).toBeNull();
    expect(document.body.textContent).not.toMatch(/[Вв]ерси[яи]/);
  });

  it('offers a reload when another user changed the card', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      'DELETE /api/v1/dogs/7/titles/1': () => problem(409, 'version_conflict', 'Версия устарела.'),
    });
    renderApp('/dogs/7?tab=titles');
    await userEvent.click(await screen.findByRole('button', { name: 'Отметить ошибочной' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Титул другой собаки');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отметить ошибочной' }));
    expect(await within(dialog).findByText('Запись изменил другой пользователь')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Обновить' })).toBeTruthy();
  });

  it('replaces the pedigree with a mother found among females', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      'GET /api/v1/dogs/5': () => json(dog({ id: 5, nickname: 'Граф' })),
      'GET /api/v1/dogs': () => json({ dogs: [summary({ id: 9, nickname: 'Альма', sex: { id: 2, name: 'Сука' }, date_of_birth: '2019-03-01' }), summary({ id: 10, nickname: 'Белка', sex: { id: 2, name: 'Сука' }, date_of_birth: '2024-01-01' })], next_after: null }),
      'PUT /api/v1/dogs/7/pedigree': () => json(dog({ version: 5 })),
      'GET /api/v1/members/3': () => json(member()),
    });
    renderApp('/dogs/7?tab=pedigree');
    await userEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    const mother = screen.getByRole('group', { name: 'Мать' });
    await userEvent.click(within(mother).getByRole('tab', { name: 'Собака клуба' }));
    await userEvent.type(within(mother).getByLabelText('Найти: мать'), 'Аль');
    await within(mother).findByRole('button', { name: /Альма/ });
    // A dog born after the puppy is not offered as its parent.
    expect(within(mother).queryByRole('button', { name: /Белка/ })).toBeNull();
    await userEvent.click(within(mother).getByRole('button', { name: /Альма/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить родословную' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const search = calls.find((call) => call.method === 'GET' && new URL(call.url).pathname === '/api/v1/dogs')!;
    expect(new URL(search.url).searchParams.get('sex_id')).toBe('2');
    const body = await calls.find((call) => call.method === 'PUT')!.json();
    expect(body).toEqual({
      version: 4,
      number: 'РКФ 1234567',
      issuer: 'РКФ',
      mother: { dog_id: 9 },
      father: { dog_id: 5 },
    });
  });
});


describe('dog form validation', () => {
  it.each(['0', '-1', '201', '100000', '1,234', 'abc', '9'.repeat(310)])('rejects invalid measurements: %s', async (value) => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
    });
    renderApp('/dogs/7/edit');
    fireEvent.change(await screen.findByLabelText('Рост, см'), { target: { value } });
    fireEvent.change(screen.getByLabelText('Вес, кг'), { target: { value } });
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Укажите число от 0,01 до 150 см, не более двух знаков после запятой.')).toBeTruthy();
    expect(screen.getByText('Укажите число от 0,01 до 200 кг, не более двух знаков после запятой.')).toBeTruthy();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('saves valid decimal measurements', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
      'PATCH /api/v1/dogs/7': () => json(dog({ height_cm: 55.5, weight_kg: 14.25, version: 5 })),
    });
    renderApp('/dogs/7/edit');
    fireEvent.change(await screen.findByLabelText('Рост, см'), { target: { value: '55,5' } });
    fireEvent.change(screen.getByLabelText('Вес, кг'), { target: { value: '14.25' } });
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(await calls.find((call) => call.method === 'PATCH')!.json()).toEqual({ version: 4, height_cm: 55.5, weight_kg: 14.25 });
  });

  it.each(['1899-12-31', '9999-01-01'])('rejects birth date outside the allowed interval: %s', async (birth) => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
      'GET /api/v1/dogs/7': () => json(dog()),
    });
    renderApp('/dogs/7/edit');
    fireEvent.change(await screen.findByLabelText('Дата рождения'), { target: { value: birth } });
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Укажите существующую дату рождения с 01.01.1900 по сегодня.')).toBeTruthy();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});
