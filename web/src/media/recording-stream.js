// Copy TS only while recording; the original buffer remains available for AV.
export class TransportRecording {
  constructor(post) {
    this.post = post;
    this.id = null;
  }
  start(id) {
    this.id = id;
  }
  push(ts) {
    if (this.id === null || !ts.length) return;
    const buf = new Uint8Array(ts).buffer;
    this.post({ type: 'recording-data', id: this.id, buf }, [buf]);
  }
  stop(id) {
    if (this.id !== id) return;
    this.id = null;
    // Same sender as the data: every earlier chunk reaches the UI first.
    this.post({ type: 'recording-stopped', id });
  }
}
