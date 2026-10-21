import { avcInformation, aacInformation } from '../media/formats.js';
// Observe validated SI and decoded metadata; never alter tuning or playback.
export class ReceptionInformation {
  constructor() {
    this.tables = new Map();
    this.video = null;
    this.videoPid = null;
    this.spsKey = '';
    this.audios = new Map();
    this.dirty = true;
    this.selection = '';
    this.physical = null;
  }
  setPhysical(information) {
    if (JSON.stringify(information) === JSON.stringify(this.physical)) return;
    this.physical = information;
    this.dirty = true;
  }
  read(section, pid) {
    if (
      !section.currentNextIndicator ||
      !['CAT', 'PMT', 'NIT[actual]', 'SDT[actual]', 'EIT[p/f]', 'BIT'].includes(section.tableId) ||
      section.other
    )
      return;
    if (section.sectionNumber > 31) return;
    const identity = [
      pid,
      section.tableId,
      section.serviceId ??
        section.programNumber ??
        section.networkId ??
        section.originalNetworkId ??
        section.transportStreamId ??
        '',
    ].join(':');
    const key = `${identity}:${section.sectionNumber}`,
      serialized = JSON.stringify(section);
    if (this.tables.get(key)?.serialized === serialized) return;
    for (const [existing, item] of this.tables)
      if (
        item.identity === identity &&
        (item.section.versionNumber !== section.versionNumber ||
          item.section.sectionNumber > section.lastSectionNumber)
      )
        this.tables.delete(existing);
    if (this.tables.size >= 128 && !this.tables.has(key))
      this.tables.delete(this.tables.keys().next().value);
    this.tables.set(key, { identity, pid, section, serialized });
    this.dirty = true;
  }
  videoHeader(nal, pid) {
    if (nal.length > 4096) return;
    const key = Array.from(nal).join(',');
    if (pid === this.videoPid && key === this.spsKey) return;
    const info = avcInformation(nal);
    if (!info) return;
    this.videoPid = pid;
    this.spsKey = key;
    this.video = info;
    this.dirty = true;
  }
  videoOutput(frame, pid) {
    if (pid !== this.videoPid || !this.video) return;
    const decoded = {
      width: frame.displayWidth,
      height: frame.displayHeight,
      codedWidth: frame.codedWidth,
      codedHeight: frame.codedHeight,
      format: frame.format,
    };
    if (JSON.stringify(decoded) !== JSON.stringify(this.video.decoded)) {
      this.video.decoded = decoded;
      this.dirty = true;
    }
  }
  audioHeader(adts, pid) {
    const info = aacInformation(adts);
    if (!info || pid == null) return;
    const previous = this.audios.get(pid);
    if (info.dual == null && previous?.header.dual != null) info.dual = previous.header.dual;
    if (JSON.stringify(previous?.header) === JSON.stringify(info)) return;
    if (this.audios.size >= 16 && !previous) this.audios.delete(this.audios.keys().next().value);
    const unchangedCore =
      previous &&
      ['objectType', 'coreSampleRate', 'channelConfiguration'].every(
        (key) => previous.header[key] === info[key],
      );
    this.audios.set(pid, { header: info, ...(unchangedCore ? { decoded: previous.decoded } : {}) });
    this.dirty = true;
  }
  audioOutput(audio, pid) {
    const info = this.audios.get(pid);
    if (!info) return;
    const decoded = {
      sampleRate: audio.sampleRate,
      channels: audio.numberOfChannels,
      format: audio.format,
    };
    if (JSON.stringify(info.decoded) !== JSON.stringify(decoded)) {
      info.decoded = decoded;
      this.dirty = true;
    }
  }
  snapshot(program, captions) {
    const selection = JSON.stringify([
      program.program,
      program.audio,
      program.video,
      captions.management?.group,
      captions.management?.languages,
    ]);
    if (selection !== this.selection) {
      this.selection = selection;
      this.dirty = true;
    }
    if (!this.dirty) return undefined;
    this.dirty = false;
    if (program.program === null && !this.physical) return null;
    const all = [...this.tables.values()],
      sid = program.program;
    const pmt = all.find(
      (item) => item.section.tableId === 'PMT' && item.section.programNumber === sid,
    );
    const sdt = all.find(
      (item) =>
        item.section.tableId === 'SDT[actual]' &&
        item.section.services.some((service) => service.serviceId === sid),
    );
    const services = sdt
      ? [
          ...new Map(
            all
              .filter(
                (item) =>
                  item.section.tableId === 'SDT[actual]' &&
                  item.section.transportStreamId === sdt.section.transportStreamId &&
                  item.section.originalNetworkId === sdt.section.originalNetworkId &&
                  item.section.versionNumber === sdt.section.versionNumber,
              )
              .flatMap((item) => item.section.services)
              .map((service) => [service.serviceId, service]),
          ).values(),
        ]
      : [];
    const nit = all.find(
      (item) =>
        item.section.tableId === 'NIT[actual]' &&
        item.section.transportStreams.some((stream) =>
          sdt
            ? stream.transportStreamId === sdt.section.transportStreamId
            : stream.transportDescriptors.some(
                (d) => d.tag === 'partialReception' && d.serviceIdList.includes(sid),
              ),
        ),
    );
    const stream = nit?.section.transportStreams.find((stream) =>
      sdt
        ? stream.transportStreamId === sdt.section.transportStreamId
        : stream.transportDescriptors.some(
            (d) => d.tag === 'partialReception' && d.serviceIdList.includes(sid),
          ),
    );
    const eit = all.filter(
      (item) =>
        item.section.tableId === 'EIT[p/f]' &&
        item.section.serviceId === sid &&
        item.section.sectionNumber < 2,
    );
    const preferred = eit.some((item) => item.pid === 0x27)
      ? 0x27
      : eit.some((item) => item.pid === 0x26)
        ? 0x26
        : 0x12;
    return {
      physical: this.physical,
      serviceId: sid,
      selectedAudioPid: program.audio,
      pmt: pmt ? { pid: pmt.pid, ...pmt.section } : null,
      sdt: sdt ? { ...sdt.section, services } : null,
      network: nit
        ? {
            networkId: nit.section.networkId,
            versionNumber: nit.section.versionNumber,
            descriptors: nit.section.networkDescriptors,
            ...stream,
          }
        : null,
      events: eit
        .filter((item) => item.pid === preferred)
        .map((item) => ({ pid: item.pid, ...item.section })),
      broadcasters: all
        .filter(
          (item) =>
            item.section.tableId === 'BIT' &&
            item.section.originalNetworkId === sdt?.section.originalNetworkId,
        )
        .map((item) => item.section),
      conditionalAccess: all
        .filter((item) => item.section.tableId === 'CAT')
        .map((item) => item.section),
      video: program.video === this.videoPid ? this.video : null,
      audios: program.audios
        .filter((track) => this.audios.has(track.pid))
        .map((track) => ({ pid: track.pid, ...this.audios.get(track.pid) })),
      captions: captions.management
        ? {
            pid: program.caption,
            group: captions.management.group,
            languages: captions.management.languages,
          }
        : null,
    };
  }
}
