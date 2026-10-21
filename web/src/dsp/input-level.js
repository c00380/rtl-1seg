// Uncalibrated ADC power excluding DC; dBFS, not antenna dBm.
export function inputLevel(iq, offset = 0, divisor = 1) {
  let real = 0,
    imag = 0,
    power = 0,
    count = 0;
  for (let i = 0; i + 1 < iq.length; i += 2) {
    const x = (iq[i] - offset) / divisor,
      y = (iq[i + 1] - offset) / divisor;
    real += x;
    imag += y;
    power += x * x + y * y;
    count++;
  }
  return count
    ? 10 *
        Math.log10(Math.max(1e-12, (power / count - (real / count) ** 2 - (imag / count) ** 2) / 2))
    : null;
}
