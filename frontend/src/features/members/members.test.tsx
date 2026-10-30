import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setSession } from '../../api/session';
import { member, memberDictionaries } from '../../test/fixtures';
import { json, mockFetch, problem } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';

afterEach(() => setSession(null));

describe('members', () => {
  it('adds a contact with the current card version', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/member-dictionaries': () => json(memberDictionaries),
      'GET /api/v1/members/3': () => json(member()),
      'POST /api/v1/members/3/contacts': () => json(member({ version: 3 })),
    });
    renderApp('/members/3');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить контакт' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Тип'), 'Email');
    await userEvent.type(within(dialog).getByLabelText('Значение'), 'maria@example.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/contacts'))).toBe(true));
    const body = await calls.find((call) => call.method === 'POST' && call.url.endsWith('/contacts'))!.json();
    expect(body).toEqual({ version: 2, type_id: 2, value: 'maria@example.test' });
  });

  it('shows an owner their card read only', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      'GET /api/v1/members/me': () => json(member()),
    });
    renderApp('/me');
    expect(await screen.findByRole('heading', { name: 'Мария Иванова' })).toBeTruthy();
    expect(screen.getByText('+7 900 000-00-00')).toBeTruthy();
    expect(screen.getByText('Номер карточки')).toBeTruthy();
    expect(screen.getByText('№ 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Добавить контакт' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Изменить' })).toBeNull();
  });

  it('rejects an invalid phone locally and allows saving after correction', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/member-dictionaries': () => json(memberDictionaries),
      'GET /api/v1/members/3': () => json(member()),
      'POST /api/v1/members/3/contacts': () => json(member({ version: 3 })),
    });
    renderApp('/members/3');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить контакт' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Тип'), 'Телефон');
    const input = within(dialog).getByLabelText('Значение');
    await userEvent.type(input, '123abc4567');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    const errorID = input.getAttribute('aria-describedby')!.split(' ').at(-1)!;
    expect(document.getElementById(errorID)?.textContent).toContain('Укажите телефон: от 7 до 15 цифр');
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/contacts'))).toBe(false);
    await userEvent.clear(input);
    await userEvent.type(input, '+7 (900) 123-45-67');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/contacts'))).toBe(true));
  });

  it('checks an email contact like the server before sending', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/member-dictionaries': () => json(memberDictionaries),
      'GET /api/v1/members/3': () => json(member()),
      'POST /api/v1/members/3/contacts': () => json(member({ version: 3 })),
    });
    renderApp('/members/3');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить контакт' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Тип'), 'Email');
    const input = within(dialog).getByLabelText('Значение');
    await userEvent.type(input, 'Мария <maria@example.ru>');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(calls.some((call) => call.url.endsWith('/contacts'))).toBe(false);
    await userEvent.clear(input);
    await userEvent.type(input, 'Maria@Example.ru');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/contacts'))).toBe(true));
    const body = await calls.find((call) => call.method === 'POST' && call.url.endsWith('/contacts'))!.json();
    expect(body.value).toBe('maria@example.ru');
  });

  it('explains invalid birth and membership dates without sending changes', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/member-dictionaries': () => json(memberDictionaries),
      'GET /api/v1/members/3': () => json(member()),
    });
    renderApp('/members/3/edit');
    const birth = await screen.findByLabelText('Дата рождения');
    fireEvent.change(birth, { target: { value: '9999-01-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Дата рождения не может быть в будущем.')).toBeTruthy();
    fireEvent.change(birth, { target: { value: '1899-12-31' } });
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Укажите существующую дату рождения с 01.01.1900 по сегодня.')).toBeTruthy();
    fireEvent.change(birth, { target: { value: '1990-02-01' } });
    fireEvent.change(screen.getByLabelText('В клубе с'), { target: { value: '1989-01-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Дата вступления не может быть раньше даты рождения.')).toBeTruthy();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('explains an inactive membership instead of an empty card', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      'GET /api/v1/members/me': () => problem(403, 'forbidden', 'Нет доступа.'),
    });
    renderApp('/me');
    expect(await screen.findByText('Членство неактивно')).toBeTruthy();
  });

  it('keeps registration screens for staff only', async () => {
    mockFetch({ 'POST /api/v1/auth/refresh': () => json(credentialsFor('leader')), 'GET /api/v1/member-dictionaries': () => json(memberDictionaries) });
    renderApp('/members/new');
    expect(await screen.findByText('Профиль «Руководитель клуба» не меняет записи')).toBeTruthy();
  });
});
