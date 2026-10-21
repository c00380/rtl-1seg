import { expose, wrap } from '../../vendor/comlink.js';
import { recordingToMp4 } from './recording-conversion.js';

self.onmessage = ({ data }) => {
  if (data.type !== 'control-port') return;
  const events = wrap(data.events);
  expose(
    {
      async convert(blob, output) {
        let writable;
        try {
          writable = await output.createWritable();
          let lastProgress = performance.now();
          await recordingToMp4(blob, {
            writable,
            onProgress() {
              if (performance.now() - lastProgress < 1000) return;
              lastProgress = performance.now();
              void events.progress().catch(() => {});
            },
          });
          const file = await output.getFile();
          return file.slice(0, file.size, 'video/mp4');
        } catch (error) {
          await writable?.abort().catch(() => {});
          throw error;
        }
      },
    },
    data.port,
  );
};
