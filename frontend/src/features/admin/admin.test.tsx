import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { components } from '../../api/schema';
import { setSession } from '../../api/session';
import { json, mockFetch, problem } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';

type Schemas = components['schemas'];

afterEach(() => setSession(null));

const boris: Schemas['User'] = { id: 'u-boris', login: 'boris', email: 'boris@dogclub.test', status: 'invited', created_at: '2026-10-20T10:00:00Z' };
const olga: Schemas['User'] = { id: 'u-olga', login: 'petrova.o', email: 'olga@dogclub.test', status: 'active', created_at: '2026-10-01T10:00:00Z', club_member_id: 4 };
const users = () => json({ users: [boris, olga] });

describe('administration', () => {
  it('finds a pending invitation and the profiles of an account after a reload', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('admin')),
      'GET /api/v1/users': users,
      'GET /api/v1/users/u-boris/profiles': () =>
        json({
          profiles: [
            { id: 'p-owner', role: 'owner', enabled: true },
            { id: 'p-vet', role: 'veterinarian', enabled: false },
          ],
        }),
      'GET /api/v1/users/u-boris/invitation': () => json({ id: 'i-1', user_id: 'u-boris', expires_at: '2099-01-01T00:00:00Z' }),
      'POST /api/v1/invitations/i-1/resend': () => json({ id: 'i-2', user_id: 'u-boris', expires_at: '2099-01-03T00:00:00Z' }),
    });
    renderApp('/admin/users/u-boris');
    expect(await screen.findByText(/Код действует до/)).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Профили пользователя' });
    expect(within(table).getByText('Ветеринар')).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Включить' })).toBeTruthy();
    // The account is not active yet: there is nothing to block.
    expect(screen.queryByRole('button', { name: 'Заблокировать' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Отправить новый код' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/invitations/i-1/resend'))).toBe(true));
  });

  it('invites with the first profile and opens the new account', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('admin')),
      'GET /api/v1/users': users,
      'POST /api/v1/invitations': () => json({ id: 'i-1', user_id: 'u-boris', expires_at: '2099-01-01T00:00:00Z' }, 201),
      'GET /api/v1/users/u-boris/profiles': () => json({ profiles: [{ id: 'p-staff', role: 'staff', enabled: true }] }),
      'GET /api/v1/users/u-boris/invitation': () => json({ id: 'i-1', user_id: 'u-boris', expires_at: '2099-01-01T00:00:00Z' }),
    });
    const router = renderApp('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: /Пригласить/ }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Логин'), 'boris');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'boris@dogclub.test');
    await userEvent.selectOptions(within(dialog).getByLabelText('Первый профиль'), 'staff');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Пригласить' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users/u-boris'));
    const body = await calls.find((call) => call.method === 'POST' && call.url.endsWith('/invitations'))!.json();
    expect(body).toEqual({ login: 'boris', email: 'boris@dogclub.test', role: 'staff' });
  });

  it('explains the login rule under the field before inviting', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('admin')),
      'GET /api/v1/users': users,
    });
    renderApp('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: /Пригласить/ }));
    const dialog = screen.getByRole('dialog');
    const login = within(dialog).getByLabelText('Логин');
    await userEvent.type(login, 'Борис');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'boris@dogclub.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Пригласить' }));
    await waitFor(() => expect(login.getAttribute('aria-invalid')).toBe('true'));
    const errorID = login.getAttribute('aria-describedby')!.split(' ').at(-1)!;
    expect(document.getElementById(errorID)?.textContent).toContain('строчные латинские буквы');
    expect(calls.some((call) => call.url.endsWith('/invitations'))).toBe(false);
  });

  it('explains that the last administrator cannot be blocked', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('admin')),
      'GET /api/v1/users': users,
      'GET /api/v1/users/u-olga/profiles': () => json({ profiles: [{ id: 'p-admin', role: 'admin', enabled: true }] }),
      'PATCH /api/v1/users/u-olga': () => problem(409, 'last_admin', 'Нельзя заблокировать последнего администратора.'),
    });
    renderApp('/admin/users/u-olga');
    await userEvent.click(await screen.findByRole('button', { name: 'Заблокировать' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Заблокировать' }));
    expect(await within(screen.getByRole('dialog')).findByText('Нельзя заблокировать последнего администратора.')).toBeTruthy();
    expect(screen.queryByText('Запись изменил другой пользователь')).toBeNull();
  });

  it('grants an instructor with the types and a private basis', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('admin')),
      'GET /api/v1/training-instructors': () => json({ records: [], next_after: null }),
      'GET /api/v1/training-types': () =>
        json([
          { id: 1, name: 'Послушание' },
          { id: 2, name: 'Аджилити' },
        ]),
      'GET /api/v1/users': users,
      'GET /api/v1/users/u-olga/profiles': () => json({ profiles: [{ id: 'p-staff', role: 'staff', enabled: true }] }),
      'PUT /api/v1/training-instructors/p-staff': () =>
        json({ profile_id: 'p-staff', member_id: 4, name: 'Ольга Петрова', enabled: true, available: true, type_ids: [2], version: 1 }),
    });
    renderApp('/admin/instructors');
    await userEvent.click(await screen.findByRole('button', { name: 'Выдать допуск' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('option', { name: /petrova\.o/ })).toBeTruthy());
    await userEvent.selectOptions(within(dialog).getByLabelText('Пользователь'), 'u-olga');
    expect(await within(dialog).findByText('Допуск получит профиль «Сотрудник клуба».')).toBeTruthy();
    await userEvent.click(within(dialog).getByLabelText('Аджилити'));
    await userEvent.type(within(dialog).getByLabelText('Основание'), 'Сертификат инструктора');
    await userEvent.type(within(dialog).getByLabelText('Причина'), 'Назначение инструктора');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const body = await calls.find((call) => call.method === 'PUT')!.json();
    expect(body).toEqual({ version: 0, enabled: true, type_ids: [2], qualification: 'Сертификат инструктора', reason: 'Назначение инструктора' });
  });

  it('keeps the administration away from staff', async () => {
    mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      'GET /api/v1/reports/club-activity': () => json({}),
      'GET /api/v1/breeding-requests': () => json({ records: [], next_after: null }),
      'GET /api/v1/events': () => json({ records: [], next_after: null }),
    });
    renderApp('/admin/users');
    expect(await screen.findByText('Нет доступа')).toBeTruthy();
  });
});
