import { describe, expect, it } from 'vitest';
import { countSmsCharacters, createSmsExcerpt, SMS_LOG_EXCERPT_LIMIT, SMS_MESSAGE_LIMIT, truncateSmsMessage } from '../src/shared/sms';

// These cases protect the API's Unicode-aware 1,530-character limit and readable log excerpts.
describe('SMS message length', () => {
  it('counts whitespace and invisible Unicode characters', () => {
    expect(countSmsCharacters('A \n\t\u200B')).toBe(5);
  });

  it('counts a supplementary Unicode character as one character', () => {
    expect(countSmsCharacters('💬')).toBe(1);
  });

  it('truncates by Unicode character without splitting surrogate pairs', () => {
    expect(truncateSmsMessage(`A💬${'B'.repeat(SMS_MESSAGE_LIMIT)}`, 2)).toBe('A💬');
  });

  it('shows a short message fully and truncates longer log excerpts', () => {
    expect(createSmsExcerpt('Short message')).toBe('Short message');
    expect(createSmsExcerpt('x'.repeat(SMS_LOG_EXCERPT_LIMIT + 1))).toBe(`${'x'.repeat(SMS_LOG_EXCERPT_LIMIT)}...`);
  });
});