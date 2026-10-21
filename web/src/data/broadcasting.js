import { decodeTS } from '../../vendor/arib-data.js';
// Separate from the media decoder: corrupt carousel sections must not interrupt AV.
export class DataBroadcasting {
  constructor(send, decoder = decodeTS) {
    this.send = send;
    this.decoder = decoder;
    this.serviceId = null;
    this.reader = null;
    this.pending = [];
    this.lastPCR = -Infinity;
    this.lastFlush = 0;
  }
  push(ts, serviceId) {
    if (serviceId == null) return;
    if (this.serviceId !== serviceId) {
      this.close();
      this.serviceId = serviceId;
      this.reader = this.decoder({
        serviceId,
        parsePES: false,
        sendCallback: (message) => this.receive(message),
      });
    }
    try {
      this.reader.push(ts);
    } catch {
      // A failed module decode cannot be retried by the upstream cache. Recreate it
      // on the next chunk, then collect the retransmitted PMT/DII/DDB again.
      this.close();
      this.receive({ type: 'dataError' });
      this.flush();
    }
    if (performance.now() - this.lastFlush >= 200) this.flush();
  }
  receive(message) {
    if (
      ![
        'pmt',
        'programInfo',
        'currentTime',
        'pcr',
        'moduleListUpdated',
        'moduleDownloaded',
        'esEventUpdated',
        'bit',
        'dataError',
      ].includes(message.type)
    )
      return;
    if (message.type === 'pcr') {
      const now = performance.now();
      if (now - this.lastPCR < 200) return;
      this.lastPCR = now;
    }
    this.pending.push(message);
    if (this.pending.length >= 32) this.flush();
  }
  flush() {
    if (this.pending.length) this.send(this.pending.splice(0));
    this.lastFlush = performance.now();
  }
  close() {
    this.reader?.close();
    this.reader = null;
    this.serviceId = null;
    this.pending.length = 0;
    this.lastPCR = -Infinity;
  }
}
