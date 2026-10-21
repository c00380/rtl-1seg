const WORKER_RESPONSE_TIMEOUT = 20000;

// Control/acknowledgement deadlines; long-running streams are not timed out.
export function withTimeout(
  operation,
  message,
  { timeout = WORKER_RESPONSE_TIMEOUT, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimer(() => {
      const error = new Error(message);
      error.name = 'TimeoutError';
      reject(error);
    }, timeout);
  });
  return Promise.race([Promise.resolve().then(operation), expired]).finally(() =>
    clearTimer(timer),
  );
}
