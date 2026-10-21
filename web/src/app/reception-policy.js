const STORAGE_KEY = '1seg.nhk-disabled.v1';
export function isNHK(information) {
  return [information?.stationName, information?.provider].some((value) =>
    /NHK|日本放送協会/i.test(String(value ?? '').normalize('NFKC')),
  );
}
export function hasStationIdentity(information) {
  if (information?.stationIdentified !== undefined) return information.stationIdentified;
  return Boolean(information?.stationName?.trim() || information?.provider?.trim());
}
// Disabling is a one-way latch. Only clearing this site's browser data resets it.
export class ReceptionPolicy {
  constructor(storage) {
    this.storage = storage;
    this.locked = false;
    try {
      this.locked = storage?.getItem(STORAGE_KEY) === 'disabled';
    } catch {}
  }
  get enabled() {
    return !this.locked;
  }
  disable() {
    if (this.locked) return;
    this.storage.setItem(STORAGE_KEY, 'disabled');
    this.locked = true;
  }
  allows(information) {
    return this.enabled || !isNHK(information);
  }
}
