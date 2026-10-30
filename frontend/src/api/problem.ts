import type { components } from './schema';

export type Problem = components['schemas']['Problem'];
export type FieldError = components['schemas']['FieldError'];

/** An RFC 9457 problem from the API, or a network failure (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;

  constructor(status: number, problem: Problem | null, message?: string) {
    super(message ?? problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }

  get code(): string | undefined {
    return this.problem?.code;
  }

  /**
   * Optimistic-locking conflicts of every module share HTTP 409. Accounts also answer 409
   * for a state rule (the last administrator, a taken login): those keep their own text.
   */
  get isConflict(): boolean {
    return this.status === 409 && !stateConflicts.has(this.code ?? '');
  }
}

const stateConflicts = new Set(['last_admin', 'account_conflict']);

export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === 'number' && typeof v.code === 'string' && typeof v.title === 'string';
}

export function toApiError(status: number, body: unknown): ApiError {
  return new ApiError(status, isProblem(body) ? body : null);
}

const fallback: Record<number, string> = {
  0: 'Нет связи с сервером. Проверьте подключение и повторите.',
  422: 'Проверьте значения полей.',
  401: 'Сессия завершилась. Войдите снова.',
  403: 'В этом профиле нет доступа к действию.',
  404: 'Запись не найдена или недоступна.',
  409: 'Запись изменил другой пользователь. Обновите данные и повторите.',
  413: 'Слишком большой запрос или файл.',
  429: 'Слишком много попыток. Подождите минуту и повторите.',
  503: 'Сервис временно недоступен. Повторите позже.',
};

/** Human text for any thrown error; never shows raw technical details. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? fallback[error.status] ?? 'Не удалось выполнить действие. Повторите позже.';
  }
  return 'Что-то пошло не так. Обновите страницу.';
}

/** Field messages keyed by JSON field name, for inline form errors. */
export function fieldErrors(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (error instanceof ApiError) {
    for (const item of error.problem?.errors ?? []) {
      out[item.field] ??= item.message;
    }
  }
  return out;
}
