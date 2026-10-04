import { describe, it, expect } from 'vitest';
import { formatMvNumberForDisplay, isValidMvMobile, normalizeMvNumber, parseMvMobileList } from '../src/shared/phone';

// Phone validation is shared by contact entry, imports, and direct-recipient SMS composition.
describe('Maldives numbers', () => {
  it('accepts valid', () => { expect(isValidMvMobile('9607712345')).toBe(true); expect(isValidMvMobile('+960 991-2345')).toBe(true); });
  it('accepts all Dhiraagu prefixes from 71 through 79 and 91 through 99', () => {
    const prefixes = ['71', '72', '73', '74', '75', '76', '77', '78', '79', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
    for (const prefix of prefixes) expect(isValidMvMobile(`960${prefix}12345`)).toBe(true);
  });
  it('normalizes bare 7-digit', () => expect(normalizeMvNumber('7712345')).toBe('9607712345'));
  it('rejects invalid prefixes and lengths', () => {
    expect(isValidMvMobile('9607012345')).toBe(false);
    expect(isValidMvMobile('9609012345')).toBe(false);
    expect(isValidMvMobile('9606712345')).toBe(false);
    expect(isValidMvMobile('96077123')).toBe(false);
  });
  it('normalizes and deduplicates comma-separated recipients', () => {
    expect(parseMvMobileList('7712345, +960 991-2345, 9607712345')).toEqual(['9607712345', '9609912345']);
  });
  it('formats numbers without the country code for display', () => {
    expect(formatMvNumberForDisplay('9607712345')).toBe('7712345');
    expect(formatMvNumberForDisplay('9607712345,9609912345')).toBe('7712345, 9912345');
  });
  it('rejects invalid and empty recipient entries', () => {
    expect(() => parseMvMobileList('9607712345,9606712345')).toThrow('Invalid Maldives mobile number');
    expect(() => parseMvMobileList('9607712345,')).toThrow('empty entries');
  });
});
