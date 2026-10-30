// Simple input rules shared with the server, so a form can say what is wrong
// before sending. The server checks the same rules again.

/** Login for a new account: as backend/internal/auth loginPattern. */
export const loginPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const loginRule = 'Логин: от 3 до 64 символов — строчные латинские буквы, цифры, точка, дефис или подчёркивание; начинается с буквы или цифры.';

/** The server's email rule in short: one address, no name or quotes. */
export function badEmail(value: string): boolean {
  return value.length > 254 || !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(value);
}

/** The server's phone rule: 7–15 digits, spaces, +, brackets, dot and hyphen, up to 50 characters. */
export function badPhone(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '').length;
  return value.length > 50 || !/^[0-9+(). -]+$/.test(value) || digits < 7 || digits > 15;
}
