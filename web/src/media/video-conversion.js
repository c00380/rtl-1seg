import { messages } from '../messages.js';
import {
  Input,
  ALL_FORMATS,
  BlobSource,
  Output,
  StreamTarget,
  MpegTsOutputFormat,
  Conversion,
  Quality,
} from '../../vendor/mediabunny.js';
import { transportBitrate } from '../dsp/modulator.js';

const TRANSMIT_OFFSET = 0.7;

// Conversion owns decoding, frame-rate adaptation, resampling and track scheduling.
export async function convertVideo(
  file,
  writable,
  { guard = 8, signal, onProgress = () => {} } = {},
) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output, conversion;
  const abort = () => signal?.throwIfAborted();
  const cancel = () => void conversion?.cancel().catch(() => {});
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error(messages.encoding.noVideo);
    const start = Math.max(0, await video.getFirstTimestamp());
    const end = await video.computeDuration();
    const duration = end - start;
    const videoBitrate = Math.min(
      240000,
      Math.floor((transportBitrate(guard) - 150000) / 1000) * 1000,
    );
    const videoQuality = new Quality({ bitrate: videoBitrate, bitrateMode: 'constant' });
    const audioQuality = new Quality({ bitrate: 48000 });
    abort();
    output = new Output({
      format: new MpegTsOutputFormat(),
      target: new StreamTarget(writable, { chunked: true, chunkSize: 1048576 }),
    });
    const shift = (sample) => {
      abort();
      sample.setTimestamp(sample.timestamp + TRANSMIT_OFFSET);
      return sample;
    };
    const audioOptions = {
      codec: 'aac',
      quality: audioQuality,
      sampleRate: 48000,
      numberOfChannels: 2,
      process: shift,
    };
    signal?.addEventListener('abort', cancel, { once: true });
    conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      copy: false,
      composable: true,
      trim: { start, end },
      showWarnings: false,
      video: {
        codec: 'avc',
        fullCodecString: 'avc1.42e00c',
        latencyMode: 'realtime',
        quality: videoQuality,
        keyFrameInterval: 1,
        width: 320,
        height: 180,
        fit: 'contain',
        frameRate: 15,
        process: shift,
      },
      audio: audioOptions,
    });
    if (
      conversion.discardedTracks.length ||
      !conversion.utilizedTracks.includes(video) ||
      (audio && !conversion.utilizedTracks.includes(audio))
    )
      throw new Error(messages.encoding.unsupportedCodecs);
    abort();
    conversion.onProgress = onProgress;
    await output.start();
    await conversion.execute();
    abort();
    await output.finalize();
    return { duration, videoBitrate, audioBitrate: audio ? 48000 : 0 };
  } catch (error) {
    if (conversion && conversion.state !== 'canceled') await conversion.cancel().catch(() => {});
    await output?.cancel().catch(() => {});
    abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    input.dispose();
  }
}
