import {
  Input,
  MPEG_TS,
  BlobSource,
  EncodedPacketSink,
  Output,
  StreamTarget,
  Mp4OutputFormat,
  Conversion,
} from '../../vendor/mediabunny.js';
import { messages } from '../messages.js';

// Require every AVC/AAC track to survive a packet-copy conversion; never transcode.
export async function recordingToMp4(blob, { writable, onProgress = () => {} }) {
  const input = new Input({ source: new BlobSource(blob), formats: [MPEG_TS] });
  let output, conversion;
  try {
    const starts = [];
    for (const [kind, tracks] of [
      ['video', await input.getVideoTracks()],
      ['audio', await input.getAudioTracks()],
    ]) {
      for (const track of tracks) {
        if ((await track.getCodec()) !== (kind === 'video' ? 'avc' : 'aac'))
          throw new Error(messages.recording.unsupportedTrack);
        const sink = new EncodedPacketSink(track);
        const first = await (kind === 'video'
          ? sink.getFirstKeyPacket({ verifyKeyPackets: true })
          : sink.getFirstPacket());
        if (!first) throw new Error(messages.recording.incompleteTrack);
        starts.push({ kind, sink, first });
      }
    }
    if (!starts.length) throw new Error(messages.recording.incompleteTrack);
    const videos = starts.filter((track) => track.kind === 'video');
    const origin = Math.min(
      ...(videos.length ? videos : starts).map((track) => track.first.timestamp),
    );
    // Keep one shared origin and reject an audio track entirely before the video.
    for (const { kind, sink, first } of starts) {
      if (kind !== 'audio') continue;
      let packet = (await sink.getPacket(origin)) ?? first;
      if (packet.timestamp < origin) packet = await sink.getNextPacket(packet);
      if (!packet) throw new Error(messages.recording.incompleteTrack);
    }
    output = new Output({
      target: new StreamTarget(writable, { chunked: true, chunkSize: 1048576 }),
      format: new Mp4OutputFormat({ fastStart: false }),
    });
    conversion = await Conversion.init({
      input,
      output,
      tracks: 'all',
      trim: { start: origin },
      copy: { mode: 'forced', boundaryPolicy: 'shrink', shiftTolerance: 0 },
      showWarnings: false,
    });
    if (conversion.discardedTracks.length) throw new Error(messages.recording.incompleteTrack);
    conversion.onProgress = onProgress;
    await conversion.execute();
  } catch (error) {
    if (conversion && conversion.state !== 'canceled') await conversion.cancel().catch(() => {});
    await output?.cancel().catch(() => {});
    throw error;
  } finally {
    input.dispose();
  }
}
