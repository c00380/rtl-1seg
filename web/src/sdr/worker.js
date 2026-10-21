import { messages } from '../messages.js';
import { expose } from '../../vendor/comlink.js';
import { RTL2832U_Provider } from '../../vendor/webrtlsdr.js';
import { RtlSdrDevice } from './device.js';
let receiver = null,
  port = null,
  pendingBytes = 0,
  gap = false,
  lastLevel = 0;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
let opening = null;
const control = {
  open(selection, settings) {
    opening = (async () => {
      const devices = await navigator.usb.getDevices();
      const selected = devices.find(
        (device) =>
          device.vendorId === selection.vendorId &&
          device.productId === selection.productId &&
          device.serialNumber === selection.serialNumber,
      );
      if (!selected) throw new Error(messages.usb.deviceMissing);
      const provider = new RTL2832U_Provider({ webusb: navigator.usb });
      provider.device = selected;
      receiver = new RtlSdrDevice(provider);
      await receiver.open(settings);
    })().finally(() => {
      opening = null;
    });
    return opening;
  },
  connectDecoder(decoderPort) {
    port?.close();
    port = decoderPort;
    pendingBytes = 0;
    gap = false;
    port.onmessage = ({ data }) => {
      if (data.type === 'ack') pendingBytes = Math.max(0, pendingBytes - data.bytes);
    };
  },
  read() {
    if (!receiver) throw new Error(messages.usb.disconnected);
    receiver
      .readSamples((iq) => {
        // Acquisition replays stored symbols through FEC before acknowledging
        // input. Allow that one-off burst without manufacturing a sample gap.
        if ((gap && pendingBytes > 0) || pendingBytes + iq.length > MAX_PENDING_BYTES) {
          gap = true;
          return;
        }
        if (performance.now() - lastLevel >= 1000 / 30) {
          lastLevel = performance.now();
          const level = iq.slice(0, 4096).buffer;
          self.postMessage({ type: 'level', buf: level }, [level]);
        }
        const buf =
          iq.byteOffset === 0 && iq.byteLength === iq.buffer.byteLength
            ? iq.buffer
            : iq.slice().buffer;
        pendingBytes += buf.byteLength;
        port.postMessage({ type: 'iq', buf, gap }, [buf]);
        gap = false;
      })
      .then(
        () => {
          self.postMessage({ type: 'ended' });
        },
        (error) => {
          self.postMessage({ type: 'ended', error: error.message });
        },
      );
  },
  async close() {
    await opening?.catch(() => {});
    try {
      await receiver?.close();
    } finally {
      port?.close();
      port = null;
      receiver = null;
    }
  },
};
self.onmessage = ({ data: message }) => {
  if (message.type === 'control-port') expose(control, message.port);
};
