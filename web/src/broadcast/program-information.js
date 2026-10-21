import { messages } from '../messages.js';
import { SectionPackets } from './transport.js';
import { readSection, decodeSIText } from '../../vendor/arib-si.js';
// SI acquisition follows the approach in web-isdb-t-viewer. Decode text with
// its same ARIB library so Japanese and broadcast symbols survive unchanged.
const PIDS = new Set([0x10, 0x11, 0x12, 0x14, 0x26, 0x27]);
const PMT_PIDS = new Set(Array.from({ length: 8 }, (_, i) => 0x1fc8 + i));
const DETAIL_PIDS = new Set([1, 0x24, ...PMT_PIDS]);
const text = (bytes) => (bytes?.length ? decodeSIText(bytes).trim() : '');
const genres = [
  messages.broadcast.genreNews,
  messages.broadcast.genreSports,
  messages.broadcast.genreInformation,
  messages.broadcast.genreDrama,
  messages.broadcast.genreMusic,
  messages.broadcast.genreVariety,
  messages.broadcast.genreMovie,
  messages.broadcast.genreAnime,
  messages.broadcast.genreDocumentary,
  messages.broadcast.genreTheater,
  messages.broadcast.genreHobby,
  messages.broadcast.genreWelfare,
];
export function duration(value) {
  if (value == null) return null;
  const b = [value >>> 16, (value >>> 8) & 255, value & 255];
  if (b.some((v) => (v & 15) > 9 || v >> 4 > 9)) return null;
  const [h, m, s] = b.map((v) => (v >> 4) * 10 + (v & 15));
  return m < 60 && s < 60 ? (h * 3600 + m * 60 + s) * 1000 : null;
}
function jstTimeEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffffff || value === 0xffffffffff)
    return null;
  const clock = duration(value % 0x1000000);
  if (clock === null || clock >= 86400000) return null;
  return (Math.floor(value / 0x1000000) - 40587) * 86400000 + clock - 32400000;
}
export function eventInfo(event) {
  if (!event) return null;
  const ds = event.descriptors;
  const short =
    ds.find((d) => d.tag === 'shortEvent' && d.iso639LanguageCode === 0x6a706e) ||
    ds.find((d) => d.tag === 'shortEvent');
  const clock = event.startTime == null ? null : duration(event.startTime % 0x1000000);
  const start =
    clock == null || clock >= 86400000
      ? null
      : (Math.floor(event.startTime / 0x1000000) - 40587) * 86400000 + clock - 32400000;
  const length = duration(event.duration);
  return {
    id: event.eventId,
    title: text(short?.eventName),
    description: text(short?.text),
    start,
    end: start != null && length != null ? start + length : null,
    duration: length,
    genres: [
      ...new Set(
        ds
          .filter((d) => d.tag === 'content')
          .flatMap((d) =>
            d.items.map(
              (i) =>
                genres[i.contentNibbleLevel1] ||
                (i.contentNibbleLevel1 === 15
                  ? messages.broadcast.other
                  : messages.broadcast.unknownGenre(i.contentNibbleLevel1)),
            ),
          ),
      ),
    ],
    scrambled: !!event.freeCAMode,
  };
}

export class ProgramInformation {
  constructor(onTime = () => {}, onSection = null, programMap = null) {
    this.sections = new SectionPackets((bytes, pid) => this.read(bytes, pid));
    this.services = new Map();
    this.onTime = onTime;
    this.onSection = onSection;
    this.programMap = programMap;
    this.lastTime = null;
  }
  service(id) {
    if (!this.services.has(id)) {
      if (this.services.size >= 64) this.services.delete(this.services.keys().next().value);
      this.services.set(id, {
        serviceId: id,
        stationName: '',
        current: null,
        next: null,
        eit: new Map(),
      });
    }
    return this.services.get(id);
  }
  read(bytes, pid) {
    try {
      if (pid === 0x14) {
        // ARIB STD-B10: both tables carry MJD + JST (not DVB's UTC).
        // Short-section syntax requires section_syntax_indicator=0,
        // reserved_future_use=1 and reserved=11.
        if ((bytes[1] & 0xf0) !== 0x70) return;
        let value;
        if (bytes[0] === 0x70 && bytes[1] === 0x70 && bytes[2] === 5 && bytes.length === 8) {
          value = 0;
          for (const b of bytes.subarray(3, 8)) value = value * 256 + b;
        } else if (
          bytes[0] === 0x73 &&
          bytes.length >= 14 &&
          (bytes[8] & 0xf0) === 0xf0 &&
          10 + ((bytes[8] & 15) << 8) + bytes[9] + 4 === bytes.length
        ) {
          const tot = readSection(bytes);
          if (tot?.tableId !== 'TOT') return;
          value = tot.jstTime;
        } else return;
        const epoch = jstTimeEpoch(value);
        // Time in one tuned transport must be monotonic. This also prevents a
        // delayed TDT from moving the UI backwards after a newer TOT arrived.
        if (epoch === null || (this.lastTime !== null && epoch <= this.lastTime)) return;
        this.lastTime = epoch;
        this.onTime(epoch);
        return;
      }
      const s = readSection(bytes); // Includes MPEG CRC validation.
      if (!s?.currentNextIndicator) return;
      try {
        this.programMap?.applySection(s);
      } catch {
        /* Media callbacks must not interrupt programme information. */
      }
      try {
        this.onSection?.(s, pid);
      } catch {
        /* Optional diagnostics must not interrupt programme information. */
      }
      if (pid === 0x11 && s.tableId === 'SDT[actual]') {
        for (const service of s.services) {
          const d = service.descriptors.find((d) => d.tag === 'service');
          if (d)
            Object.assign(this.service(service.serviceId), {
              stationName: text(d.serviceName),
              provider: text(d.serviceProviderName),
            });
          const logo = service.descriptors.find((d) => d.tag === 'logoTransmission');
          // A one-seg service uses bits 8/7 of the terrestrial service ID.
          // Only map to its full-seg counterpart if the received SDT lists it.
          const serviceType = d?.serviceType;
          const counterpart =
            serviceType === 0xc0
              ? s.services.find(
                  (entry) =>
                    entry.serviceId === (service.serviceId & ~0x180) &&
                    entry.descriptors.some((d) => d.tag === 'service' && d.serviceType === 1),
                )
              : null;
          const reference = counterpart?.descriptors.find((d) => d.tag === 'logoTransmission');
          const primary =
            reference?.logoTransmissionType === 2
              ? s.services.find((entry) =>
                  entry.descriptors.some(
                    (d) =>
                      d.tag === 'logoTransmission' &&
                      d.logoTransmissionType === 1 &&
                      d.logoId === reference.logoId,
                  ),
                )
              : null;
          Object.assign(this.service(service.serviceId), {
            originalNetworkId: s.originalNetworkId,
            logoServiceId: primary?.serviceId ?? counterpart?.serviceId ?? service.serviceId,
            logoText: logo?.logoTransmissionType === 3 ? text(logo.logoChar) : '',
          });
        }
      } else if (pid === 0x10 && s.tableId === 'NIT[actual]') {
        for (const stream of s.transportStreams) {
          const d = stream.transportDescriptors.find((d) => d.tag === 'tsInformation');
          if (d)
            for (const t of d.transmissionTypes)
              for (const id of t.serviceIdList)
                Object.assign(this.service(id), {
                  tsName: text(d.tsName),
                  remoteKey: d.remoteControlKeyId,
                });
        }
      } else if ([0x12, 0x26, 0x27].includes(pid) && s.tableId === 'EIT[p/f]' && !s.other) {
        // ARIB TR-B14 13.15: L-EIT has sections 0/1 (present/following)
        // and optional sections 2/3 containing up to eight additional events.
        const maximum = pid === 0x27 ? 3 : pid === 0x26 ? 4 : 1;
        if (
          s.sectionNumber > maximum ||
          s.sectionNumber > s.lastSectionNumber ||
          s.lastSectionNumber < 1 ||
          s.lastSectionNumber > maximum
        )
          return;
        const service = this.service(s.serviceId);
        let table = service.eit.get(pid);
        if (!table || table.version !== s.versionNumber) {
          table = { version: s.versionNumber, sections: new Map() };
          service.eit.set(pid, table);
        }
        // A shorter table must remove withdrawn programs, including when only
        // present/following remains. Replace whole sections rather than append.
        for (const number of table.sections.keys())
          if (number > s.lastSectionNumber) table.sections.delete(number);
        table.sections.set(
          s.sectionNumber,
          s.events.map(eventInfo).slice(0, s.sectionNumber < 2 ? 1 : 8),
        );
        const selected = service.eit.get(0x27) ?? service.eit.get(0x26) ?? service.eit.get(0x12);
        if (selected === table && s.sectionNumber < 2)
          service[s.sectionNumber === 0 ? 'current' : 'next'] =
            table.sections.get(s.sectionNumber)[0] ?? null;
      }
    } catch {
      /* Corrupt SI must never interrupt playback. */
    }
  }
  push(bytes, serviceId) {
    for (let i = 0; i + 188 <= bytes.length; i += 188) {
      this.pushPacket(bytes.subarray(i, i + 188));
    }
    return this.snapshot(serviceId);
  }
  pushPacket(packet) {
    if (packet.length !== 188) return;
    const pid = ((packet[1] & 31) << 8) | packet[2];
    if (
      PIDS.has(pid) ||
      (this.onSection && DETAIL_PIDS.has(pid)) ||
      (this.programMap && PMT_PIDS.has(pid))
    )
      this.sections.push(packet);
  }
  snapshot(serviceId) {
    if (serviceId == null) return null;
    const service = this.services.get(serviceId);
    const table = service?.eit.get(0x27) ?? service?.eit.get(0x26) ?? service?.eit.get(0x12);
    const seen = new Set([service?.current?.id, service?.next?.id]);
    const boundary = service?.next?.end ?? service?.next?.start ?? service?.current?.end;
    const after = [...(table?.sections ?? [])]
      .filter(([number]) => number >= 2)
      .flatMap(([, events]) => events)
      .filter((event) => event.start !== null && (boundary == null || event.start >= boundary))
      .sort((a, b) => a.start - b.start || a.id - b.id)
      .filter((event) => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      })
      .slice(0, 8);
    return {
      serviceId,
      originalNetworkId: service?.originalNetworkId ?? null,
      logoServiceId: service?.logoServiceId ?? null,
      stationName: service?.stationName || service?.tsName || '',
      provider: service?.provider || '',
      remoteKey: service?.remoteKey ?? null,
      logo: service?.logoText ? { text: service.logoText } : null,
      current: service?.current ?? null,
      next: service?.next ?? null,
      after,
    };
  }
}
