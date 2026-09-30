/** Maldives mobile numbers: country code 960 + 7 digits starting with 7 or 9. */
const MV_MOBILE = /^960[79]\d{6}$/;

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
