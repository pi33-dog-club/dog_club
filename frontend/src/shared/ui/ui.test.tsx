import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/problem';
import { ProblemAlert } from './Alert';
import { TextField, passwordLength } from './Field';
import { SelectField } from './Select';
import { FormDialog, ReasonDialog } from './ReasonDialog';

describe('passwordLength', () => {
  it('counts Unicode code points like the server', () => {
    expect(passwordLength('пароль')).toBe(6);
    expect(passwordLength('🐶🐶')).toBe(2);
  });
});

describe('ReasonDialog', () => {
  it('requires a trimmed reason and passes it on', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<ReasonDialog open title="Отметить ошибочной" confirmLabel="Отметить" onConfirm={onConfirm} onClose={onClose} />);
    const confirm = screen.getByRole('button', { name: 'Отметить' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Причина'), '   ');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Причина'), 'Ошибочная запись ');
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Ошибочная запись');
    expect(onClose).toHaveBeenCalled();
  });
});


describe('form error visibility', () => {
  it('shows grouped server errors in a dialog without an inline field mapping', async () => {
    const error = new ApiError(422, {
      type: 'about:blank', title: 'Unprocessable Entity', status: 422,
      code: 'validation_failed', detail: 'Проверьте значения полей.', request_id: 'support-id',
      errors: [{ field: 'fields', code: 'invalid', message: 'Укажите название площадки и населённый пункт.' }],
    });
    render(<FormDialog open title="Площадка" confirmLabel="Сохранить" onClose={() => undefined} onSubmit={async () => { throw error; }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Укажите название площадки и населённый пункт.')).toBeTruthy();
    const details = screen.getByText('Технические сведения').closest('details')!;
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText('Технические сведения'));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('support-id');
  });

  it('preserves the actual conflict reason and offers reload', () => {
    const error = new ApiError(409, { type: 'about:blank', title: 'Conflict', status: 409, code: 'member_conflict', detail: 'Адрес используется мероприятием.', request_id: 'r' });
    render(<ProblemAlert error={error} onReload={() => undefined} />);
    expect(screen.getByText('Адрес используется мероприятием.')).toBeTruthy();
    expect(screen.queryByText('Запись изменил другой пользователь')).toBeNull();
    expect(screen.getByRole('button', { name: 'Обновить' })).toBeTruthy();
  });

  it('shows a Russian required error at the input, then clears it after correction', async () => {
    const submitted = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={submitted}><TextField label="Название" required /><button type="submit">Сохранить</button></form>);
    const input = screen.getByLabelText('Название');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(screen.getByText('Заполните поле «Название».')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(submitted).not.toHaveBeenCalled();
    await userEvent.type(input, 'Выставка');
    expect(screen.queryByText('Заполните поле «Название».')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(submitted).toHaveBeenCalledOnce();
  });

  it.each([
    ['date', '1899-12-31', '1900-01-01', undefined, '«Значение»: значение должно быть не меньше 01.01.1900.'],
    ['number', '1.5', '0', undefined, 'Укажите целое число.'],
    ['number', '201', undefined, '200', '«Значение»: значение должно быть не больше 200.'],
    ['email', 'wrong', undefined, undefined, 'Укажите email в формате name@example.ru.'],
  ])('explains native %s constraints inline', async (type, value, min, max, message) => {
    render(<form><TextField label="Значение" type={type} min={min} max={max} step={1} defaultValue={value} /><button type="submit">Сохранить</button></form>);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(screen.getByText(message!)).toBeTruthy();
  });

  it('shows missing required selection next to the dropdown', async () => {
    render(<form><SelectField label="Тип" required placeholder="Выберите…" defaultValue="" options={[{ value: 1, label: 'Выставка' }]} /><button type="submit">Сохранить</button></form>);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(screen.getByText('Выберите значение в поле «Тип».')).toBeTruthy();
  });
});
