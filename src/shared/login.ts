/** Browser preview is intentionally not an authentication fallback; credentials require Electron IPC. */
export function canUseDemoLogin(_api: unknown, _username: string, _password: string): boolean {
  return false;
}
