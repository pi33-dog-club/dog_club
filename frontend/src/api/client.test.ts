import { afterEach, describe, expect, it } from 'vitest';
import { json, mockFetch, problem, staffCredentials } from '../test/fetchMock';
import { api, call } from './client';
import { ApiError, errorMessage, fieldErrors } from './problem';
import { refreshSession } from './refresh';
import { getSession, setSession } from './session';

afterEach(() => setSession(null));

describe('refreshSession', () => {
  it('sends one refresh for concurrent callers', async () => {
    const { calls } = mockFetch({ 'POST /api/v1/auth/refresh': () => json(staffCredentials) });
    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);
    expect(calls).toHaveLength(1);
    expect(first).toBe(second);
    expect(getSession()?.access_token).toBe('access-staff');
  });

  it('clears the session when the cookie is rejected', async () => {
    setSession({ ...staffCredentials });
    mockFetch({ 'POST /api/v1/auth/refresh': () => problem(401, 'unauthenticated', 'Войдите снова.') });
    expect(await refreshSession()).toBeNull();
    expect(getSession()).toBeNull();
  });
});

describe('authFetch', () => {
  it('adds the bearer token, refreshes once on 401 and repeats the request', async () => {
    setSession({ ...staffCredentials, access_token: 'expired' });
    let me = 0;
    const { calls } = mockFetch({
      'GET /api/v1/auth/me': (request) => {
        me += 1;
        return request.headers.get('Authorization') === 'Bearer access-staff'
          ? json({ user: staffCredentials.user, profile: staffCredentials.profile })
          : problem(401, 'unauthenticated', 'Срок действия истёк.');
      },
      'POST /api/v1/auth/refresh': () => json(staffCredentials),
    });
    const principal = await call(api.GET('/api/v1/auth/me'));
    expect(principal.user.login).toBe('ivanova.m');
    expect(me).toBe(2);
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/api/v1/auth/me', '/api/v1/auth/refresh', '/api/v1/auth/me']);
  });

  it('never retries or authorizes anonymous auth endpoints', async () => {
    setSession({ ...staffCredentials });
    const { calls } = mockFetch({ 'POST /api/v1/auth/login': () => problem(401, 'unauthenticated', 'Неверный логин или пароль.') });
    const failure = await call(api.POST('/api/v1/auth/login', { body: { login: 'x', password: 'y' } })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(errorMessage(failure)).toBe('Неверный логин или пароль.');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('Authorization')).toBeNull();
  });
});

describe('problem helpers', () => {
  it('maps conflicts, rate limits and network failures to human text', () => {
    expect(errorMessage(new ApiError(409, null))).toMatch(/другой пользователь/);
    expect(errorMessage(new ApiError(429, null))).toMatch(/Подождите/);
    expect(errorMessage(new ApiError(0, null))).toMatch(/Нет связи/);
  });

  it('does not hide a domain conflict behind the generic concurrency message', () => {
    const error = new ApiError(409, { type: 'about:blank', title: 'Conflict', status: 409, code: 'dog_conflict', detail: 'Идентификатор уже используется.', request_id: 'r' });
    expect(errorMessage(error)).toBe('Идентификатор уже используется.');
  });

  it('keeps the first message per field', () => {
    const error = new ApiError(422, {
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      code: 'validation_failed',
      request_id: 'r',
      errors: [
        { field: 'password', code: 'too_short', message: 'Не короче 15 символов.' },
        { field: 'password', code: 'other', message: 'Второе сообщение.' },
      ],
    });
    expect(fieldErrors(error)).toEqual({ password: 'Не короче 15 символов.' });
  });
});
