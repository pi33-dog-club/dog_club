import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/problem';
import { ProblemAlert } from './Alert';
import { FileField, TextField, passwordLength } from './Field';
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
    await userEvent.click(confirm);
    expect(screen.getByText('Заполните поле «Причина».')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Причина'), '   ');
    await userEvent.click(confirm);
    expect(screen.getByText('Заполните поле «Причина»: одних пробелов недостаточно.')).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Причина'), 'Ошибочная запись ');
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('Ошибочная запись');
    expect(onClose).toHaveBeenCalled();
  });
});


describe('form error visibility', () => {
  it('lists server field errors in a dialog and shows no technical details', async () => {
    const error = new ApiError(422, {
      type: 'about:blank', title: 'Unprocessable Entity', status: 422,
      code: 'validation_failed', detail: 'Исправьте ошибки в форме.', request_id: 'support-id',
      errors: [{ field: 'checks', code: 'invalid', message: 'Сначала устраните автоматические причины недопуска.' }],
    });
    render(<FormDialog open title="Решение" confirmLabel="Сохранить" onClose={() => undefined} onSubmit={async () => { throw error; }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Исправьте ошибки в форме.');
    expect(alert.textContent).toContain('Сначала устраните автоматические причины недопуска.');
    for (const technical of ['support-id', 'validation_failed', 'Технические сведения']) expect(alert.textContent).not.toContain(technical);
  });

  it('replaces the browser popup with a message under the field and focuses the first error', async () => {
    const popups: boolean[] = [];
    render(
      <form onSubmit={(event) => event.preventDefault()}>
        <TextField label="Кличка" required />
        <TextField label="Число щенков" type="number" min={1} max={2147483647} defaultValue="3000000000" />
        <button type="submit">Сохранить</button>
      </form>,
    );
    for (const input of screen.getAllByRole('textbox').concat(screen.getAllByRole('spinbutton'))) {
      input.addEventListener('invalid', (event) => popups.push(!event.defaultPrevented));
    }
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(popups.length).toBeGreaterThan(0);
    expect(popups.every((shown) => !shown)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText(/Кличка/));
    expect(screen.getByText('Заполните поле «Кличка».')).toBeTruthy();
    expect(screen.getByText('Слишком большое число.')).toBeTruthy();
  });

  it('picks a file with a Russian button and shows its name', async () => {
    function Picker() {
      const [file, setFile] = useState<File | null>(null);
      return <FileField label="Фото" file={file} onChange={(event) => setFile(event.target.files?.[0] ?? null)} />;
    }
    render(<Picker />);
    expect(screen.getByText('Выбрать файл')).toBeTruthy();
    expect(screen.getByText('Файл не выбран')).toBeTruthy();
    await userEvent.upload(screen.getByLabelText('Фото'), new File(['x'], 'rex.png', { type: 'image/png' }));
    expect(screen.getByText('rex.png')).toBeTruthy();
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
    ['date', '1899-12-31', '1900-01-01', undefined, 'Дата не может быть раньше 01.01.1900.'],
    ['number', '1.5', '0', undefined, 'Укажите целое число.'],
    ['number', '201', undefined, '200', 'Укажите число не больше 200.'],
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
