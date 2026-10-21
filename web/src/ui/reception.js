import { messages } from '../messages.js';
import { concatBytes } from '../broadcast/transport.js';
import { eventInfo } from '../broadcast/program-information.js';
import { decodeSIText } from '../../vendor/arib-si.js';
import { escapeHtml } from './utils.js';
import { receptionCode as code, receptionValue } from './reception-values.js';
const escape = (value) => escapeHtml(value ?? '');
const yes = (value) => (value == null ? null : value ? messages.details.yes : messages.details.no);
const row = (name, value) =>
  value == null || value === ''
    ? ''
    : `<div class="rx-reception-row"><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`;
const rows = (values) => values.map(([name, value]) => row(name, value)).join('');
const group = (title, source, body) =>
  body
    ? `<section class="rx-reception-section"><h3>${escape(title)}</h3><p class="rx-reception-source">${escape(source)}</p>${body}</section>`
    : '';
const list = (values) => {
  const content = rows(values);
  return content ? `<dl>${content}</dl>` : '';
};
const tags = {
  digitalCopyControl: messages.details.copyControl,
  contentAvailability: messages.details.contentAvailability,
  terrestrialDeliverySystem: messages.details.terrestrialTransmission,
  partialReception: messages.details.partialService,
  tsInformation: messages.details.transportInformation,
  extendedBroadcaster: messages.details.broadcasterIdentity,
  logoTransmission: messages.details.logoTransmission,
  streamIdentifier: messages.details.componentIdentity,
  dataComponent: messages.details.dataEncoding,
  conditionalAccess: messages.details.conditionalAccess,
  audioComponent: messages.details.audioComponent,
  component: messages.details.videoComponent,
  emergencyInformation: messages.details.emergency,
  shortEvent: messages.details.programDescription,
  extendedEvent: messages.details.extendedDescription,
  content: messages.details.genre,
  series: messages.details.series,
  service: messages.details.serviceNames,
  networkName: messages.details.networkName,
  broadcasterName: messages.details.broadcasterName,
  systemManagement: messages.details.systemManagement,
  serviceList: messages.details.serviceList,
  siParameter: messages.details.siParameter,
  accessControl: messages.details.accessControl,
  caService: messages.details.caService,
};
const textFields = new Set([
  'eventName',
  'text',
  'itemDescription',
  'item',
  'seriesName',
  'serviceProviderName',
  'serviceName',
  'name',
  'tsName',
  'logoChar',
]);
function binary(value) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16)
    lines.push(
      Array.from(bytes.subarray(offset, offset + 16), (byte) =>
        byte.toString(16).toUpperCase().padStart(2, '0'),
      ).join(' '),
    );
  return messages.details.binaryValue(bytes.length, lines.join('\n'));
}
// Decode defined SI text fields; show opaque or undecodable data as hex bytes.
// Nested descriptor fields retain their field names.
function fields(value, prefix = '', context = value?.tag) {
  const result = [];
  for (const [key, item] of Object.entries(value ?? {})) {
    if (key === 'tag' || item == null) continue;
    const field =
      context === 'digitalCopyControl' && key === 'apsControlData' && value.copyControlType !== 1
        ? 'reserved_copy_control_bits'
        : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const name = prefix ? `${prefix}.${field}` : field;
    if (ArrayBuffer.isView(item)) {
      const text = textFields.has(key) ? decodeSIText(item) : null;
      result.push([
        name,
        textFields.has(key) && item.byteLength === 0
          ? messages.details.emptyText
          : text || binary(item),
      ]);
    } else if (Array.isArray(item)) {
      if (item.every((entry) => typeof entry === 'number'))
        result.push([name, item.map((entry) => code(entry)).join(' / ')]);
      else
        item.forEach((entry, index) => {
          if (typeof entry === 'object')
            result.push(...fields(entry, `${name}[${index}]`, context));
        });
    } else if (typeof item === 'object') result.push(...fields(item, name, context));
    else if (typeof item === 'number')
      result.push([name, receptionValue(key, item, value, context)]);
    else if (typeof item === 'boolean') result.push([name, item ? '1（true）' : '0（false）']);
    else if (typeof item === 'string')
      result.push([name, receptionValue(key, item, value, context)]);
  }
  return result;
}
// Extended descriptions can split one text item across descriptor boundaries.
// Join bytes before decoding so character and escape sequences remain intact.
function descriptionDescriptors(values) {
  const result = [],
    extended = new Map();
  for (const descriptor of values ?? []) {
    if (descriptor.tag !== 'extendedEvent') {
      result.push(descriptor);
      continue;
    }
    const language = descriptor.iso639LanguageCode;
    if (!extended.has(language)) extended.set(language, []);
    extended.get(language).push(descriptor);
  }
  for (const parts of extended.values()) {
    parts.sort((a, b) => a.descriptorNumber - b.descriptorNumber);
    const combined = { ...parts[0], items: [], text: new Uint8Array() };
    let previousNumber = null;
    for (const part of parts) {
      for (const entry of part.items) {
        const previous = combined.items.at(-1);
        if (
          previous &&
          !entry.itemDescription.length &&
          (previousNumber === part.descriptorNumber || previousNumber + 1 === part.descriptorNumber)
        )
          previous.item = concatBytes([previous.item, entry.item]);
        else combined.items.push({ ...entry });
        previousNumber = part.descriptorNumber;
      }
      combined.text = concatBytes([combined.text, part.text]);
    }
    result.push(combined);
  }
  return result;
}
function descriptors(values) {
  return descriptionDescriptors(values)
    .map((d) => {
      const content = rows([
        ...(d.tag === 'content'
          ? [[messages.details.genre, eventInfo({ descriptors: [d] }).genres.join(' / ')]]
          : []),
        ...fields(d),
      ]);
      return content
        ? `<div class="rx-reception-descriptor"><h4>${escape(tags[d.tag] ?? d.tag)}${tags[d.tag] ? ` <span>${escape(d.tag)}</span>` : ''}</h4><dl>${content}</dl></div>`
        : '';
    })
    .join('');
}
const streamType = (type) =>
  ({
    0x1b: 'H.264 / AVC',
    0x0f: 'AAC（ADTS）',
    0x11: 'AAC（LATM / LOAS）',
    0x06: 'PES private data',
    0x0d: 'DSM-CC sections',
  })[type] ?? messages.details.unclassified;
function physicalMarkup(physical) {
  const tmcc = physical?.tmcc,
    ac = physical?.ac;
  const layerMarkup = (layer, index) => {
    const unused =
      layer.modulation === 7 && layer.rate === 7 && layer.interleave === 7 && layer.segments === 15;
    const body = unused
      ? list([[messages.details.state, messages.details.unusedOrUnset]])
      : list([
          [
            messages.details.modulation,
            ['DQPSK', 'QPSK', '16QAM', '64QAM'][layer.modulation] ??
              messages.details.reservedValue(layer.modulation),
          ],
          [
            messages.details.codeRate,
            ['1/2', '2/3', '3/4', '5/6', '7/8'][layer.rate] ??
              messages.details.unusedOrReserved(layer.rate),
          ],
          [
            messages.details.timeInterleave,
            { 0: 'I = 0', 1: 'I = 1', 2: 'I = 2', 3: 'I = 4' }[layer.interleave] ??
              messages.details.unusedOrReserved(layer.interleave),
          ],
          [
            messages.details.segmentCount,
            layer.segments === 15
              ? messages.details.unused
              : layer.segments === 0 || layer.segments === 14
                ? messages.details.reservedValue(layer.segments)
                : layer.segments,
          ],
        ]);
    return `<div class="rx-reception-descriptor"><h4>Layer ${'ABC'[index]}</h4>${body}</div>`;
  };
  const tmccBody = tmcc
    ? list([
        [messages.details.validation, messages.details.parityVerified],
        [
          messages.details.system,
          { 0: messages.details.television, 1: messages.details.soundBroadcast }[tmcc.system] ??
            messages.details.reservedValue(tmcc.system),
        ],
        [
          messages.details.centralModulation,
          { 0: messages.details.synchronous, 7: messages.details.differential }[tmcc.segmentType] ??
            messages.details.reservedValue(tmcc.segmentType),
        ],
        [messages.details.partialReception, yes(tmcc.partial)],
        [
          messages.details.transmissionSwitch,
          tmcc.switchCountdown === 15
            ? messages.details.noSwitch
            : messages.details.switchFrames(tmcc.switchCountdown + 1),
        ],
        [
          messages.details.emergencyStartup,
          tmcc.ews ? messages.details.startupRequested : messages.details.startupNotRequested,
        ],
        [
          messages.details.phaseCorrection,
          tmcc.connectedPhase === 7
            ? messages.details.phaseCorrectionUnused
            : code(tmcc.connectedPhase, 1),
        ],
        [
          messages.details.reservedBits,
          `0x${tmcc.reserved.toString(16).toUpperCase().padStart(3, '0')}`,
        ],
      ]) +
      `<h4>${messages.details.currentTransmission}</h4>${tmcc.current.map(layerMarkup).join('')}` +
      `<h4>${messages.details.nextTransmission}</h4>${list([[messages.details.nextPartialReception, yes(tmcc.nextPartial)]])}${tmcc.next.map(layerMarkup).join('')}`
    : '';
  let acBody;
  if (ac?.status === 'idle')
    acBody = list([[messages.details.state, messages.details.noAuxiliaryInformation]]);
  else if (ac?.status === 'unverified')
    acBody = list([
      [messages.details.state, messages.details.invalidWarning],
      [messages.details.configuration, code(ac.configuration, 1)],
    ]);
  else if (ac?.status === 'validated')
    acBody = list([
      [messages.details.validation, messages.details.verifiedWarning],
      [
        messages.details.details,
        { 0: messages.details.warningAvailable, 3: messages.details.no }[ac.startEnd] ??
          messages.details.reservedValue(ac.startEnd),
      ],
      [messages.details.update, ac.update],
      [
        messages.details.signalIdentity,
        {
          0: messages.details.earthquakeWithArea,
          1: messages.details.earthquakeWithoutArea,
          2: messages.details.testWithArea,
          3: messages.details.testWithoutArea,
          7: messages.details.noWarningDetails,
        }[ac.identification] ?? messages.details.extensionValue(ac.identification),
      ],
      [messages.details.auxiliaryBroadcaster, code(ac.broadcasterId, 3)],
      [messages.details.timeCode, ac.currentTimeCode],
      [
        messages.details.pageType,
        ac.page == null
          ? null
          : ac.page === 0
            ? messages.details.targetArea
            : messages.details.hypocenter,
      ],
      [
        messages.details.targetArea,
        ac.targetAreas?.join(' / ') || (ac.targetAreas ? messages.details.noTargetBits : null),
      ],
      [messages.details.earthquakeCount, ac.earthquakeCount],
      [messages.details.earthquakeIndex, ac.earthquakeIndex],
      [messages.details.warningIdentity, code(ac.warningId, 3)],
      [
        messages.details.state,
        ac.cancelled == null
          ? null
          : ac.cancelled
            ? messages.details.cancel
            : messages.details.announced,
      ],
      [messages.details.latitude, ac.latitude == null ? null : `${ac.latitude.toFixed(1)}°`],
      [messages.details.longitude, ac.longitude == null ? null : `${ac.longitude.toFixed(1)}°`],
      [messages.details.depth, ac.depthKm == null ? null : `${ac.depthKm} km`],
      [messages.details.occurrenceTimeCode, ac.occurrenceTimeCode],
    ]);
  else acBody = '';
  return (
    group(messages.details.tmcc, messages.details.tmccSource, tmccBody) +
    group(messages.details.auxiliary, messages.details.auxiliarySource, acBody)
  );
}
export function receptionMarkup(info, context = {}) {
  if (!info) return '';
  const sections = [];
  const video = info.video;
  if (video) {
    const profile =
      video.profile === 66 && video.constraints & 0x40
        ? 'Constrained Baseline'
        : ({
            66: 'Baseline',
            77: 'Main',
            88: 'Extended',
            100: 'High',
            110: 'High 10',
            122: 'High 4:2:2',
            244: 'High 4:4:4',
          }[video.profile] ?? messages.details.unclassified);
    sections.push(
      group(
        messages.details.videoEncoding,
        messages.details.videoEncodingSource,
        list([
          [messages.details.videoFormat, 'H.264 / AVC'],
          ['codec', video.codec],
          [messages.details.resolution, `${video.width} × ${video.height}`],
          [messages.details.codedSize, `${video.codedWidth} × ${video.codedHeight}`],
          [
            messages.details.scanType,
            video.progressive ? messages.details.progressive : messages.details.fieldCoding,
          ],
          [messages.details.profile, `${profile}（profile_idc=${video.profile}）`],
          ['level_idc', `${video.level}（Level ${(video.level / 10).toFixed(1)}）`],
          ['constraint flags', code(video.constraints, 2)],
          [
            messages.details.chroma,
            { 0: messages.details.monochrome, 1: '4:2:0', 2: '4:2:2', 3: '4:4:4' }[video.chroma],
          ],
          [
            messages.details.bitDepth,
            messages.details.bitDepthValue(video.lumaDepth, video.chromaDepth),
          ],
          [messages.details.aspectRatio, video.sar?.join(':')],
          [
            messages.details.timing,
            video.timingRate == null
              ? null
              : messages.details.frameRateValue(video.timingRate.toFixed(3)),
          ],
          [messages.details.fullRange, yes(video.fullRange)],
          ['colour_primaries', receptionValue('colourPrimaries', video.colourPrimaries)],
          [
            'transfer_characteristics',
            receptionValue('transferCharacteristics', video.transferCharacteristics),
          ],
          ['matrix_coefficients', receptionValue('matrixCoefficients', video.matrixCoefficients)],
          [
            messages.details.decodedDisplaySize,
            video.decoded ? `${video.decoded.width} × ${video.decoded.height}` : null,
          ],
          [
            messages.details.decodedCodedSize,
            video.decoded?.codedWidth
              ? `${video.decoded.codedWidth} × ${video.decoded.codedHeight}`
              : null,
          ],
          [messages.details.decodedPixelFormat, video.decoded?.format],
        ]),
      ),
    );
  }
  for (const audio of info.audios ?? []) {
    const a = audio.header,
      output = audio.decoded;
    sections.push(
      group(
        messages.details.audioEncoding(
          code(audio.pid),
          audio.pid === info.selectedAudioPid ? messages.details.selected : '',
        ),
        messages.details.audioEncodingSource,
        list([
          [messages.details.audioFormat, `MPEG-${a.mpegVersion} AAC（ADTS）`],
          [
            messages.details.audioObjectType,
            `${a.objectType}${a.objectType === 2 ? '（AAC-LC）' : ''}`,
          ],
          [messages.details.audioSampleRate, `${a.coreSampleRate.toLocaleString('ja-JP')} Hz`],
          ['sampling_frequency_index', a.frequencyIndex],
          [
            'channel_configuration',
            `${a.channelConfiguration}${a.channelConfiguration === 0 ? messages.details.pceSpecified : ''}`,
          ],
          [messages.details.adtsCrcPresence, yes(a.crcPresent)],
          ['raw_data_blocks', a.rawDataBlocks],
          [messages.details.pceDual, yes(a.dual)],
          [
            messages.details.decodedSampleRate,
            output ? `${output.sampleRate.toLocaleString('ja-JP')} Hz` : null,
          ],
          [messages.details.decodedChannels, output?.channels],
          [messages.details.decodedPcmFormat, output?.format],
        ]),
      ),
    );
  }
  const service = info.sdt?.services.find((service) => service.serviceId === info.serviceId),
    network = info.network;
  sections.push(
    group(
      messages.details.serviceIdentity,
      'SDT / NIT / PMT',
      list([
        ['service_id', code(info.serviceId)],
        ['network_id', code(network?.networkId)],
        ['transport_stream_id', code(info.sdt?.transportStreamId ?? network?.transportStreamId)],
        ['original_network_id', code(info.sdt?.originalNetworkId ?? network?.originalNetworkId)],
        [
          'service_type',
          receptionValue(
            'serviceType',
            service?.descriptors.find((d) => d.tag === 'service')?.serviceType,
          ),
        ],
        ['PMT PID', code(info.pmt?.pid)],
        ['PCR PID', code(info.pmt?.pcrPID)],
        ['PMT version', info.pmt?.versionNumber],
        ['SDT version', info.sdt?.versionNumber],
        ['NIT version', network?.versionNumber],
        ['service free_CA_mode', yes(service?.freeCAMode)],
        [messages.details.lEit, yes(service?.lEITFlag)],
        [messages.details.hEit, yes(service?.hEITFlag)],
        [messages.details.mEit, yes(service?.mEITFlag)],
        [
          messages.details.physicalChannel,
          context.channel == null ? null : `CH ${context.channel}`,
        ],
        [
          messages.details.tunerFrequency,
          context.frequency == null ? null : `${(context.frequency / 1e6).toFixed(6)} MHz`,
        ],
      ]) + descriptors(network?.descriptors),
    ),
  );
  const terrestrial = network?.transportDescriptors.find(
    (d) => d.tag === 'terrestrialDeliverySystem',
  );
  sections.push(
    group(
      messages.details.broadcastTransmission,
      messages.details.broadcastTransmissionSource,
      list([
        ['area_code', code(terrestrial?.areaCode)],
        [
          messages.details.transmissionMode,
          terrestrial
            ? ['Mode 1', 'Mode 2', 'Mode 3', messages.details.reserved][
                terrestrial.transmissionMode
              ]
            : null,
        ],
        [
          messages.details.guardInterval,
          terrestrial ? ['1/32', '1/16', '1/8', '1/4'][terrestrial.guardInterval] : null,
        ],
        [
          messages.details.frequencies,
          terrestrial?.frequencies
            .map((frequency) =>
              messages.details.frequencyValue((frequency / 7).toFixed(6), frequency),
            )
            .join(' / '),
        ],
      ]) +
        descriptors(
          network?.transportDescriptors.filter((d) => d.tag !== 'terrestrialDeliverySystem'),
        ),
    ),
  );
  sections.push(physicalMarkup(info.physical));
  if (info.pmt)
    sections.push(
      group(
        messages.details.streamStructure,
        'PMT',
        descriptors(info.pmt.programInfo) +
          info.pmt.streams
            .map(
              (stream) =>
                `<div class="rx-reception-stream"><h4>${escape(streamType(stream.streamType))} · PID ${escape(code(stream.elementaryPID))}</h4>${list([['stream_type', code(stream.streamType, 2)]])}${descriptors(stream.esInfo)}</div>`,
            )
            .join(''),
      ),
    );
  for (const section of [...(info.events ?? [])].sort(
    (a, b) => a.sectionNumber - b.sectionNumber,
  )) {
    const event = section.events[0];
    if (!event) continue;
    sections.push(
      group(
        section.sectionNumber === 0 ? messages.details.currentEvent : messages.details.nextEvent,
        'EIT p/f',
        list([
          ['event_id', code(event.eventId)],
          ['EIT PID', code(section.pid)],
          ['version_number', section.versionNumber],
          ['section_number', section.sectionNumber],
          ['last_section_number', section.lastSectionNumber],
          ['running_status', receptionValue('runningStatus', event.runningStatus)],
          ['free_CA_mode', yes(event.freeCAMode)],
        ]) + descriptors(event.descriptors),
      ),
    );
  }
  if (service)
    sections.push(
      group(
        messages.details.serviceControl,
        messages.details.selectedSdt,
        descriptors(service.descriptors),
      ),
    );
  if (info.captions)
    sections.push(
      group(
        messages.details.captionEncoding,
        messages.details.captionManagement,
        list([
          [messages.details.captionPid, code(info.captions.pid)],
          [messages.details.dataGroup, info.captions.group === 0 ? 'A' : 'B'],
        ]) +
          info.captions.languages
            .map(
              (language) =>
                `<div class="rx-reception-descriptor"><h4>${messages.details.captionTrackPrefix}${language.lang + 1}</h4>${list(fields(language, '', 'caption'))}</div>`,
            )
            .join(''),
      ),
    );
  for (const bit of info.broadcasters ?? [])
    sections.push(
      group(
        messages.details.broadcasterInformation,
        'BIT',
        list([
          ['original_network_id', code(bit.originalNetworkId)],
          ['version_number', bit.versionNumber],
        ]) +
          descriptors(bit.firstDescriptors) +
          bit.broadcasters
            .map(
              (b) =>
                `<div class="rx-reception-descriptor"><h4>broadcaster_id ${escape(code(b.broadcasterId, 2))}</h4>${descriptors(b.broadcasterDescriptors)}</div>`,
            )
            .join(''),
      ),
    );
  for (const cat of info.conditionalAccess ?? [])
    sections.push(
      group(messages.details.conditionalAccessInformation, 'CAT', descriptors(cat.descriptors)),
    );
  if (info.sdt)
    sections.push(
      group(
        messages.details.sharedServices,
        'SDT',
        info.sdt.services
          .map(
            (s) =>
              `<div class="rx-reception-descriptor"><h4>service_id ${escape(code(s.serviceId))}${s.serviceId === info.serviceId ? messages.details.selected : ''}</h4>${descriptors(s.descriptors.filter((d) => d.tag === 'service' || d.tag === 'logoTransmission'))}</div>`,
          )
          .join(''),
      ),
    );
  return sections.join('');
}
