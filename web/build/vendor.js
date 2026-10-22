import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildViterbi } from './viterbi.js';
import { buildReedSolomon } from './ezpwd.js';
import { buildAssets } from './assets.js';
import { collectLicenses, buildLicenses } from './licenses.js';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const rtlSdrCorrections = {
  name: 'rtl-sdr-v4-initialization',
  setup(builder) {
    builder.onLoad(
      { filter: /webrtlsdr[\\/]dist[\\/]rtlsdr[\\/]rtlcom\.js$/ },
      async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        const before = 'return new ArrayBuffer(length);';
        if (contents.split(before).length !== 2)
          throw new Error('webrtlsdr changed: review USB stall handling');
        contents = contents.replace(
          before,
          'throw new RadioError("USB endpoint stalled; IQ continuity was lost", RadioErrorType.UsbTransferError);',
        );
        contents = contents.replace(
          'return result.data.buffer;',
          'return result.data.byteOffset === 0 && result.data.byteLength === result.data.buffer.byteLength ? result.data.buffer : result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength);',
        );
        return { contents, loader: 'js' };
      },
    );
    builder.onLoad({ filter: /webrtlsdr[\\/]dist[\\/]rtlsdr[\\/]r828d\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const replacements = [
        ['let found = R8xx.check(com, 0x74);', 'let found = await R8xx.check(com, 0x74);'],
        // Unknown initial band: force UHF input registers and GPIO5 on first tune.
        ['this.input = 0;', 'this.input = -1;'],
      ];
      for (const [before, after] of replacements) {
        if (contents.split(before).length !== 2) {
          throw new Error('webrtlsdr changed: review R828D initialization corrections');
        }
        contents = contents.replace(before, after);
      }
      return { contents, loader: 'js' };
    });
  },
};

const boundedCarousel = {
  name: 'bounded-carousel',
  setup(build) {
    build.onLoad({ filter: /web-bml[\\/]dist[\\/]server[\\/]decode_ts\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const replace = (from, to) => {
        if (!contents.includes(from))
          throw new Error('web-bml decoder changed: review carousel limits');
        contents = contents.replace(from, to);
      };
      replace(
        'const modules = new Map();',
        `if (!(section.blockSize > 0 && section.blockSize <= 4066) || section.modules.length > 64 ||
        section.modules.some(m => m.moduleSize > 262144 || m.moduleInfoDescriptors.some(d => d.tag === "compressionType" && d.originalSize > 262144))) return;
      const modules = new Map();`,
      );
      replace(
        'moduleData = (0, fflate_1.unzlibSync)(moduleData);',
        `if (!(moduleInfo.originalSize > 0 && moduleInfo.originalSize <= 262144)) return;
      moduleData = (0, fflate_1.unzlibSync)(moduleData, {out: new Uint8Array(moduleInfo.originalSize)});`,
      );
      replace(
        '[...componentToPid.keys()].some((x) => !ctp.has(x))',
        '[...componentToPid.keys()].some((x) => JSON.stringify(componentToPid.get(x)) !== JSON.stringify(ctp.get(x)))',
      );
      replace(
        'const cachedComponent = cachedComponents.get(componentId);',
        `const cachedComponent = cachedComponents.get(componentId);
      if (cachedComponent != null) for (const id of cachedComponent.modules.keys()) if (!modules.has(id)) cachedComponent.modules.delete(id);`,
      );
      return { contents, loader: 'js' };
    });
  },
};

const corrections = {
  name: 'one-seg-aac-pce',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]conversion\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const encoderOptions = `                codec: encodableCodec,
                quality,`;
      if (contents.split(encoderOptions).length !== 2)
        throw new Error('Review Mediabunny Conversion encoder options after update');
      contents = contents.replace(
        encoderOptions,
        `                codec: encodableCodec,
                fullCodecString: trackOptions.fullCodecString,
                latencyMode: trackOptions.latencyMode,
                quality,`,
      );
      await mkdir('licenses/mediabunny', { recursive: true });
      await writeFile('licenses/mediabunny/conversion.js', contents);
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /adts[\\/]adts-reader\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const before = `    if (channelConfiguration === 0) {
        throw new Error('ADTS frames with channel configuration 0 are not supported.');
    }`;
      if (contents.split(before).length !== 2)
        throw new Error('Review Mediabunny ADTS PCE header parsing after update');
      contents = contents.replace(
        before,
        '    // Configuration 0 carries its layout in a PCE; the receiver waits for that PCE before decoding.',
      );
      await mkdir('licenses/mediabunny', { recursive: true });
      await writeFile('licenses/mediabunny/adts-reader.js', contents);
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /mpeg-ts[\\/]mpeg-ts-demuxer\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const before = 'aacChannelMap[header.channelConfiguration]';
      if (contents.split(before).length !== 2)
        throw new Error('Review Mediabunny PCE channel configuration after update');
      contents = contents.replace(
        before,
        '(header.channelConfiguration === 0 ? 2 : aacChannelMap[header.channelConfiguration])',
      );
      // One-seg can carry multiple pictures per PES. The upstream demuxer
      // applies that PES's PTS to every picture; interpolate within the PES
      // using SPS timing and apply each new PES anchor once.
      const timing = 'const spsInfo = parseAvcSps(spsUnit);';
      const slice = 'slicePts = this.getPesPacketAt(chunkStartPos + nalHeaderStart).pts;';
      const override = 'if (timestampOverride !== null) {';
      const supply = 'const currentPesPacket = this.getCurrentPesPacket();\n        let pts;';
      for (const before of [timing, slice, override, supply])
        if (contents.split(before).length !== 2)
          throw new Error('Review Mediabunny video PTS correction after update');
      contents = contents.replace(
        timing,
        timing +
          '\n elementaryStream.info.frameDuration = (spsInfo.timingFrameDuration ?? (1 / 15)) * TIMESCALE;',
      );
      contents = contents.replace(slice, 'slicePts = this.getPesPacketAt(packetStartPos).pts;');
      contents = contents.replace(
        override,
        "if (timestampOverride !== null && !(this.elementaryStream.info.type === 'video' && this.lastSuppliedPesPacket === currentPesPacket)) {",
      );
      contents = contents.replace(
        supply,
        "const currentPesPacket = this.getCurrentPesPacket();\n if (this.elementaryStream.info.type === 'video') intrinsicDuration = this.elementaryStream.info.frameDuration ?? (TIMESCALE / 15);\n        let pts;",
      );
      await mkdir('licenses/mediabunny', { recursive: true });
      await writeFile('licenses/mediabunny/mpeg-ts-demuxer.js', contents);
      return { contents, loader: 'js' };
    });
    builder.onLoad({ filter: /[\\/]src[\\/]codec-data\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const before =
        /bitstream\.skipBits\(32\); \/\/ num_units_in_tick\s+bitstream\.skipBits\(32\); \/\/ time_scale/;
      const result = /(\n\s+)vuiParametersFlagBitOffset,(\r?\n)/;
      const complete = 'assert(maxDecFrameBuffering !== null);';
      if (!before.test(contents) || !result.test(contents) || contents.split(complete).length !== 2)
        throw new Error('Review Mediabunny SPS timing extraction after update');
      contents = contents.replace(
        before,
        `var timingFrameDuration;
        const timingUnits = bitstream.readBits(32), timingScale = bitstream.readBits(32);
        if (timingUnits > 0 && timingScale > 0) timingFrameDuration = 2 * timingUnits / timingScale;`,
      );
      contents = contents.replace(result, '$1vuiParametersFlagBitOffset, timingFrameDuration,$2');
      // Bitstream zero-fills reads beyond EOF; a truncated SPS must not invent
      // dimensions or defaults for either playback or the reception details.
      contents = contents.replace(
        complete,
        'if (bitstream.getBitsLeft() < 0) return null;\n' + complete,
      );
      await mkdir('licenses/mediabunny', { recursive: true });
      await writeFile('licenses/mediabunny/codec-data.js', contents);
      return { contents, loader: 'js' };
    });
  },
};
const zagCorrections = {
  name: 'zag-ui-corrections',
  setup(builder) {
    builder.onLoad(
      { filter: /@zag-js[\\/]tooltip[\\/]dist[\\/]tooltip\.machine\.mjs$/ },
      async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        const before = `          ...prop("positioning"),
          onComplete(data) {`;
        if (contents.split(before).length !== 2)
          throw new Error('Review Zag tooltip reposition listener cleanup after update');
        // The state effect owns positioning listeners. This immediate action's
        // return value is not retained, so it must only update the position once.
        contents = contents.replace(
          before,
          `          ...prop("positioning"),
          listeners: false,
          onComplete(data) {`,
        );
        await mkdir('licenses/zag-js', { recursive: true });
        await writeFile('licenses/zag-js/tooltip-machine.mjs', contents);
        return { contents, loader: 'js' };
      },
    );
    builder.onLoad(
      { filter: /@zag-js[\\/]vanilla[\\/]dist[\\/]machine\.mjs$/ },
      async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        const before = `    const prevSource = this.userPropsRef.current;
    this.userPropsRef.current = () => {
      const prev = runIfFn(prevSource);
      const next = runIfFn(newProps);
      return mergeMachineProps(prev, next);
    };`;
        if (!contents.includes(before))
          throw new Error('Review Zag vanilla prop snapshots after update');
        // Receiver updates are plain snapshots. Avoid retaining a recursive chain
        // of all previous snapshots during a long-lived receiver session.
        contents = contents.replace(
          before,
          `    const prev = runIfFn(this.userPropsRef.current);
    this.userPropsRef.current = mergeMachineProps(prev, runIfFn(newProps));`,
        );
        await mkdir('licenses/zag-js', { recursive: true });
        await writeFile('licenses/zag-js/vanilla-machine.mjs', contents);
        return { contents, loader: 'js' };
      },
    );
  },
};
const targets = {
  select: {
    source:
      "export { machine, connect, collection } from '@zag-js/select';\nexport { machine as tooltipMachine, connect as connectTooltip } from '@zag-js/tooltip';\nexport { VanillaMachine, normalizeProps, spreadProps } from '@zag-js/vanilla';\n",
    output: 'select',
    plugin: 'zagCorrections',
  },
  viterbi: {},
  ezpwd: {},
  signals: {
    source:
      "export { FFT } from '@jtarrio/signals/dsp/fft.js';\nexport { getIqResampler } from '@jtarrio/signals/dsp/resamplers.js';\nexport { makeLowPassKernel } from '@jtarrio/signals/dsp/coefficients.js';\n",
    output: 'signals',
  },
  sdr: {
    source: "export { RTL2832U_Provider, RTL2832U } from '@jtarrio/webrtlsdr/rtlsdr.js';\n",
    output: 'webrtlsdr',
    plugin: 'rtlSdrCorrections',
  },
  si: {
    source:
      "export { readSection } from 'arib-mmt-tlv-ts/ts/si.js';\nexport { decodeSIText } from 'arib-mmt-tlv-ts/ts/si-text-decoder.js';\nexport { PESReader } from 'arib-mmt-tlv-ts/ts/pes-reader.js';\nexport { calculateCRC32 } from 'arib-mmt-tlv-ts/crc-32.js';\n// 2.0.2 does not export SectionReader as a package subpath. Pin this build-only\n// import; receiver adapters supply TDT/CAT dispatch as well as ordinary SI.\nexport { SectionReader } from './node_modules/arib-mmt-tlv-ts/dist/ts/section-reader.js';\n",
    output: 'arib-si',
  },
  'si-text': {
    source: "export { siKanji } from './build/si-text.js';\n",
    output: 'arib-si-text',
  },
  caption: {
    source:
      "export {\n  ARIBB24JapaneseJIS8Tokenizer,\n  ARIBB24Parser,\n  ARIBB24JapaneseInitialParserState,\n  demuxDatagroup,\n  canvasRenderingStrategy,\n  CanvasRenderingOption,\n} from 'aribb24.js';\nexport { default as additionalSymbolGlyphs } from 'aribb24.js/glyph';\n// Build-only reference to the pinned CRC16 implementation (initial value 0).\nexport { default as captionCRC } from './node_modules/aribb24.js/dist/esm/util/crc16-ccitt.mjs';\n",
    output: 'arib-caption',
  },
  comlink: {
    source: "export { wrap, expose, transfer, releaseProxy } from 'comlink';\n",
    output: 'comlink',
  },
  media: {
    source:
      "export { Input, MPEG_TS, ALL_FORMATS, BlobSource, ReadableStreamSource, EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, VideoSampleSink, AudioSampleSink, Output, StreamTarget, BufferTarget, MpegTsOutputFormat, WebMOutputFormat, Mp4OutputFormat, VideoSampleSource, AudioSampleSource, CanvasSource, MediaStreamAudioTrackSource, AudioSample, Quality, canEncodeVideo, canEncodeAudio, Conversion } from 'mediabunny';\n// Build-only reference to the pinned internal SPS parser, shared with the demuxer.\nexport { parseAvcSps } from './node_modules/mediabunny/dist/modules/src/codec-data.js';\nexport { registerAacEncoder } from '@mediabunny/aac-encoder';\n",
    output: 'mediabunny',
    plugin: 'corrections',
  },
  data: {
    source: "export { decodeTS } from 'web-bml/ts';\n",
    output: 'arib-data',
    plugin: 'boundedCarousel',
  },
  bml: {
    source: "export { BMLBrowser, keyCodeToAribKey, OverlayInputApplication } from 'web-bml';\n",
    output: 'bml-browser',
  },
};
const patches = { rtlSdrCorrections, boundedCarousel, corrections, zagCorrections };
const requested = process.argv[2];
const licensesOnly = requested === 'licenses';
const names =
  requested && !licensesOnly
    ? requested === 'data'
      ? ['data', 'bml']
      : [requested]
    : Object.keys(targets);
for (const name of names) {
  if (name === 'ezpwd') {
    if (!licensesOnly) await buildReedSolomon();
    continue;
  }
  if (name === 'viterbi') {
    if (!licensesOnly) await buildViterbi();
    continue;
  }
  const target = targets[name];
  if (!target) throw new Error('Unknown vendor target: ' + name);
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: target.source, resolveDir: root, sourcefile: name + '-entry.js' },
    tsconfigRaw: {},
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    outfile: 'vendor/' + target.output + '.js',
    metafile: true,
    write: !licensesOnly,
    plugins: target.plugin ? [patches[target.plugin]] : [],
  });
  await collectLicenses(result);
  if (requested && !licensesOnly && name === 'signals') {
    await copyFile('node_modules/@jtarrio/signals/LICENSE', 'licenses/signals-LICENSE');
  }
  if (requested && !licensesOnly && name === 'select') {
    await mkdir('licenses/zag-js', { recursive: true });
    await copyFile('node_modules/proxy-compare/LICENSE', 'licenses/proxy-compare-LICENSE');
    for (const name of await readdir('node_modules/@zag-js')) {
      const packagePath = 'node_modules/@zag-js/' + name;
      await copyFile(packagePath + '/LICENSE', 'licenses/zag-js/' + name + '-LICENSE');
    }
  }
  if (requested && !licensesOnly && name === 'media') {
    await copyFile('node_modules/mediabunny/LICENSE', 'licenses/mediabunny-LICENSE');
  }
  console.log('Built ' + name);
}
if (!requested || licensesOnly) {
  const server = await build({
    absWorkingDir: root,
    entryPoints: ['../server.js'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
  });
  await collectLicenses(server, 'server');
  await buildLicenses();
}
if (!requested) await buildAssets();
