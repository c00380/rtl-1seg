// Retain only the current carousel so opening the panel does not require another cycle.
export class DataState {
  constructor() {
    this.reset();
  }
  reset() {
    this.messages = new Map();
    this.modules = new Map();
    this.lists = new Map();
  }
  accept(message) {
    if (message.type === 'moduleListUpdated') {
      this.lists.set(message.componentId, message);
      const versions = new Map(message.modules.map((module) => [module.id, module.version]));
      for (const [key, module] of this.modules) {
        if (module.componentId !== message.componentId) continue;
        if (
          module.dataEventId !== message.dataEventId ||
          !versions.has(module.moduleId) ||
          versions.get(module.moduleId) !== module.version
        )
          this.modules.delete(key);
      }
    } else if (message.type === 'moduleDownloaded') {
      const list = this.lists.get(message.componentId);
      if (
        !list ||
        list.dataEventId !== message.dataEventId ||
        !list.modules.some((m) => m.id === message.moduleId && m.version === message.version)
      )
        return false;
      this.modules.set(`${message.componentId}:${message.moduleId}`, message);
    } else if (message.type === 'pmt') {
      const components = new Set(
        message.components.filter((c) => c.streamType === 0x0d).map((c) => c.componentId),
      );
      for (const [key, module] of this.modules)
        if (!components.has(module.componentId)) this.modules.delete(key);
      for (const key of this.lists.keys()) if (!components.has(key)) this.lists.delete(key);
      this.messages.set(message.type, message);
    } else if (['programInfo', 'currentTime', 'pcr', 'bit'].includes(message.type))
      this.messages.set(message.type, message);
    return true;
  }
  snapshot() {
    return [...this.messages.values(), ...this.lists.values(), ...this.modules.values()];
  }
}
