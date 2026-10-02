import { describe, it, expect } from 'vitest';
import { isValidMvMobile, normalizeMvNumber, parseMvMobileList } from '../src/shared/phone';

describe('Maldives numbers', () => {
  it('accepts valid', () => { expect(isValidMvMobile('9607712345')).toBe(true); expect(isValidMvMobile('+960 991-2345')).toBe(true); });
  it('normalizes bare 7-digit', () => expect(normalizeMvNumber('7712345')).toBe('9607712345'));
  it('rejects invalid', () => { expect(isValidMvMobile('9606712345')).toBe(false); expect(isValidMvMobile('96077123')).toBe(false); });
  it('normalizes and deduplicates comma-separated recipients', () => {
    expect(parseMvMobileList('7712345, +960 991-2345, 9607712345')).toEqual(['9607712345', '9609912345']);
  });
  it('rejects invalid and empty recipient entries', () => {
    expect(() => parseMvMobileList('9607712345,9606712345')).toThrow('Invalid Maldives mobile number');
    expect(() => parseMvMobileList('9607712345,')).toThrow('empty entries');
  });
});
