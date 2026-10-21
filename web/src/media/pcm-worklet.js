// Timestamped PCM queue. Report the audio sample clock back to the video worker.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset(0);
    this.report = 0;
    this.audioPort = null;
    this.port.onmessage = ({ data: m }) => {
      if (m.type === 'connect') {
        this.audioPort?.close();
        this.audioPort = m.port;
        this.audioPort.onmessage = ({ data }) => this.receive(data);
      }
    };
  }
  receive(m) {
    if (m.type === 'reset') {
      this.reset(m.generation);
      return;
    }
    if (m.generation !== this.generation) return;
    if (m.type === 'end') {
      this.ended = true;
      return;
    }
    if (this.ended || !m.chs?.[0]?.length) return;
    // A real PTS discontinuity must not play stale audio from the old timeline.
    if (this.end !== null && Math.abs(m.pts - this.end) > 250000) this.reset(m.generation);
    this.end = m.pts + (m.chs[0].length * 1e6) / sampleRate;
    this.q.push(m);
    this.buffered += m.chs[0].length;
    while (this.buffered > sampleRate && this.q.length > 1) {
      const old = this.q.shift();
      this.buffered -= old.chs[0].length;
    }
  }
  reset(generation) {
    this.generation = generation;
    this.q = [];
    this.cur = null;
    this.pos = 0;
    this.buffered = 0;
    this.started = false;
    this.end = null;
    this.pts = null;
    this.ended = false;
    this.endReported = false;
  }
  process(_inputs, outputs) {
    const out = outputs[0],
      n = out[0].length;
    if (!this.started && (this.buffered >= sampleRate * 0.35 || (this.ended && this.buffered > 0)))
      this.started = true;
    let played = false;
    if (this.started)
      for (let i = 0; i < n; i++) {
        if (!this.cur || this.pos >= this.cur.chs[0].length) {
          this.cur = this.q.shift() || null;
          this.pos = 0;
        }
        if (!this.cur) {
          this.started = false;
          break;
        }
        for (let c = 0; c < out.length; c++)
          out[c][i] = (this.cur.chs[c] || this.cur.chs[0])[this.pos];
        this.pos++;
        this.buffered--;
        played = true;
        this.pts = this.cur.pts + (this.pos * 1e6) / sampleRate;
      }
    this.report += n;
    if (this.ended && !this.buffered && !this.endReported) {
      this.endReported = true;
      this.audioPort?.postMessage({
        type: 'audio-ended',
        generation: this.generation,
        contextTime: currentTime + n / sampleRate,
      });
    }
    if (this.report >= sampleRate * 0.025) {
      this.report = 0;
      this.audioPort?.postMessage({
        type: 'audio-clock',
        contextTime: currentTime + n / sampleRate,
        generation: this.generation,
        pts: this.pts,
        playing: played && this.started,
      });
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
