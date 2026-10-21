import { wrap, expose, releaseProxy } from '../../vendor/comlink.js';

// Control and notifications use separate ports so both can be closed on failure.
export function workerRpc(worker, events, failureMessage) {
  const control = new MessageChannel();
  const notifications = events ? new MessageChannel() : null;
  const remote = wrap(control.port1);
  let rejectFailure,
    closed = false;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => {});
  const dispose = (error = new DOMException('Worker closed', 'AbortError')) => {
    if (closed) return;
    closed = true;
    rejectFailure(error);
    try {
      remote[releaseProxy]();
    } catch {}
    control.port1.close();
    notifications?.port1.close();
    control.port2.close();
    notifications?.port2.close();
    worker.terminate();
    worker.onerror = worker.onmessageerror = null;
  };
  if (notifications)
    expose(
      Object.fromEntries(
        Object.entries(events).map(([name, handler]) => [
          name,
          (...args) => {
            if (!closed) return handler(...args);
          },
        ]),
      ),
      notifications.port1,
    );
  worker.onerror = (event) => {
    event.preventDefault?.();
    dispose(new Error(event.message || failureMessage));
  };
  worker.onmessageerror = () => dispose(new Error(failureMessage));
  control.port1.onmessageerror = worker.onmessageerror;
  if (notifications) notifications.port1.onmessageerror = worker.onmessageerror;
  try {
    const message = { type: 'control-port', port: control.port2 };
    const transfers = [control.port2];
    if (notifications) {
      message.events = notifications.port2;
      transfers.push(notifications.port2);
    }
    worker.postMessage(message, transfers);
  } catch (error) {
    dispose(error);
    throw error;
  }
  return {
    failure,
    call(method, ...args) {
      if (closed) return failure;
      return Promise.race([Promise.resolve().then(() => remote[method](...args)), failure]);
    },
    dispose,
  };
}
