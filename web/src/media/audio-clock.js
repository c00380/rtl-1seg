// Only the window can read the AudioContext's device-output timestamp. Send an
// anchor occasionally; the worker extrapolates it without relaying PCM or clocks.
export function audioOutputTiming(audio, now = performance.now()) {
  const output = audio.getOutputTimestamp?.();
  const valid =
    Number.isFinite(output?.contextTime) &&
    Number.isFinite(output?.performanceTime) &&
    output.performanceTime > 0;
  return {
    contextTime: valid ? output.contextTime : audio.currentTime,
    sentAt: performance.timeOrigin + (valid ? output.performanceTime : now),
    latency: valid ? 0 : (audio.baseLatency || 0) + (audio.outputLatency || 0),
    running: audio.state === undefined || audio.state === 'running',
  };
}

export function receiveAudioClock(message, now = performance.now(), timing = null) {
  if (!message.playing || !Number.isFinite(message.pts)) return null;
  if (timing) {
    if (!timing.running) return null;
    let pts = message.pts - timing.latency * 1e6;
    if (Number.isFinite(message.contextTime) && Number.isFinite(timing.contextTime)) {
      pts += (timing.contextTime - message.contextTime) * 1e6;
      pts += Math.max(0, performance.timeOrigin + now - timing.sentAt) * 1000;
    }
    return { pts, at: now };
  }
  // Window and worker performance.now() have different origins.
  const elapsed = Number.isFinite(message.sentAt)
    ? Math.max(0, performance.timeOrigin + now - message.sentAt)
    : 0;
  return { pts: message.pts + elapsed * 1000, at: now };
}
