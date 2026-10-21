import { ProgramMap } from './program-map.js';
import { ProgramInformation } from './program-information.js';
// CRC-validated PAT/PMT/NIT/SDT identify a service without waiting for pictures.
export class ServiceProbe {
  constructor() {
    this.map = new ProgramMap();
    this.information = new ProgramInformation(undefined, null, this.map);
  }
  push(ts) {
    for (let i = 0; i + 188 <= ts.length; i += 188)
      this.information.pushPacket(ts.subarray(i, i + 188));
    const information = this.information.snapshot(this.map.program);
    return information
      ? {
          ...information,
          stationIdentified: Boolean(
            this.information.services.get(this.map.program)?.stationName?.trim(),
          ),
        }
      : null;
  }
}
