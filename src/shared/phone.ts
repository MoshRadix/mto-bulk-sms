/** Maldives mobile: country code 960, prefixes 71-79 or 91-99, then five subscriber digits. */
const MV_MOBILE = /^960(?:7[1-9]|9[1-9])\d{5}$/;

/** Strip spaces, dashes, "+" and a leading "00"; add 960 to bare 7-digit numbers. */
export function normalizeMvNumber(input: string): string {
  let n = input.replace(/[\s\-()+]/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (/^[79]\d{6}$/.test(n)) n = '960' + n;
  return n;
}

export function isValidMvMobile(input: string): boolean {
  return MV_MOBILE.test(normalizeMvNumber(input));
}

export function parseMvMobileList(input: string): string[] {
  const cleanInput = input.trim();
  if (!cleanInput) return [];

  const entries = cleanInput.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) {
    throw new Error('Remove empty entries from the recipient list.');
  }

  // Validate the entire list before returning anything, then deduplicate normalized numbers.
  const normalizedNumbers = entries.map(normalizeMvNumber);
  const invalidNumbers = [...new Set(normalizedNumbers.filter((number) => !isValidMvMobile(number)))];
  if (invalidNumbers.length) {
    throw new Error(`Invalid Maldives mobile number${invalidNumbers.length === 1 ? '' : 's'}: ${invalidNumbers.join(', ')}`);
  }

  return [...new Set(normalizedNumbers)];
}

/** Render Maldives numbers without the country code while preserving comma-separated recipient lists. */
export function formatMvNumberForDisplay(input: string): string {
  return input
    .split(',')
    .map((entry) => {
      const value = entry.trim();
      const normalized = normalizeMvNumber(value);
      return normalized.startsWith('960') && normalized.length === 10 ? normalized.slice(3) : value;
    })
    .filter(Boolean)
    .join(', ');
}
