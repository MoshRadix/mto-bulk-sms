export const SMS_MESSAGE_LIMIT = 1530;
export const SMS_LOG_EXCERPT_LIMIT = 60;

export function countSmsCharacters(message: string): number {
  return Array.from(message).length;
}

export function truncateSmsMessage(message: string, limit = SMS_MESSAGE_LIMIT): string {
  return Array.from(message).slice(0, Math.max(0, limit)).join('');
}

export function createSmsExcerpt(message: string, limit = SMS_LOG_EXCERPT_LIMIT): string {
  if (countSmsCharacters(message) <= limit) return message;
  return `${truncateSmsMessage(message, limit).trimEnd()}...`;
}