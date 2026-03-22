export const PASSIVE_INDEX_DEFAULT_ENABLED = false;

export function resolvePassiveIndexEnabled(value: unknown): boolean {
  return value === true;
}

export function canObservePassiveIndex(passiveIndexEnabled: boolean, tabId: number): boolean {
  return passiveIndexEnabled && tabId >= 0;
}
