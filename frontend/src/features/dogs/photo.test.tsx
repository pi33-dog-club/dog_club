import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '../../api/schema';
import { setSession } from '../../api/session';
import { dog, dogDictionaries } from '../../test/fixtures';
import { json, mockFetch, problem } from '../../test/fetchMock';
import { credentialsFor, renderApp } from '../../test/renderApp';
import { photoProblem } from './photoApi';

const meta: components['schemas']['DogPhoto'] = {
  dog_id: 7,
  media_type: 'image/jpeg',
  size_bytes: 3,
  width: 600,
  height: 900,
  version: 2,
  updated_at: '2026-10-21T10:00:00Z',
};

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  setSession(null);
  vi.unstubAllGlobals();
});

const card = {
  'GET /api/v1/dog-dictionaries': () => json(dogDictionaries),
  'GET /api/v1/dogs/7': () => json(dog()),
  'GET /api/v1/dogs/7/history': () => json({ changes: [], next_after: null }),
};

describe('dog photos', () => {
  it('checks the type and size before upload', () => {
    expect(photoProblem(new File(['x'], 'a.jpg', { type: 'image/jpeg' }))).toBeUndefined();
    expect(photoProblem(new File(['x'], 'a.gif', { type: 'image/gif' }))).toBe('Подойдёт JPEG или PNG.');
    expect(photoProblem(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))).toBe('Фото больше 5 МБ.');
  });

  it('shows the photo and lets staff replace it with the current photo version', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('staff')),
      ...card,
      'GET /api/v1/dogs/7/photo': () => json(meta),
      'GET /api/v1/dogs/7/photo/file': () => new Response(new Blob(['jpg']), { headers: { 'Content-Type': 'image/jpeg' } }),
      'PUT /api/v1/dogs/7/photo': () => json({ ...meta, version: 3 }),
    });
    renderApp('/dogs/7?tab=history');
    expect(await screen.findByRole('img', { name: 'Фото: Бублик' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Заменить фото' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.upload(within(dialog).getByLabelText('Фото'), new File(['new'], 'new.jpg', { type: 'image/jpeg' }));
    expect(within(dialog).getByText('new.jpg')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const body = await calls.find((call) => call.method === 'PUT')!.text();
    expect(body).toMatch(/name="version"\r\n\r\n2\r\n/);
    // The server judges the bytes, not the name: the part carries the type and the content.
    expect(body).toContain('Content-Type: image/jpeg\r\n\r\nnew\r\n');
  });

  it('keeps the icon without a photo and gives an owner no photo controls', async () => {
    const { calls } = mockFetch({
      'POST /api/v1/auth/refresh': () => json(credentialsFor('owner')),
      ...card,
      'GET /api/v1/dogs/7/photo': () => problem(404, 'not_found', 'Запись не найдена.'),
    });
    renderApp('/dogs/7?tab=history');
    expect(await screen.findByRole('heading', { name: 'Бублик' })).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/photo'))).toBe(true));
    expect(screen.queryByRole('img', { name: /Фото/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /фото/i })).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/photo/file'))).toBe(false);
  });
});
