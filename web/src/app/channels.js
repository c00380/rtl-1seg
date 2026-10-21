// UHF center frequencies, denpa-data.com/denpadata/digital_frequency.htm
export const CHANNELS = Array.from({ length: 40 }, (_, i) => ({
  channel: i + 13,
  hz: 473142857 + i * 6000000,
}));
export const GAINS = [
  0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28, 29.7, 32.8,
  33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6,
];
