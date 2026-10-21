import { messages } from '../messages.js';
import { audioLayout } from './labels.js';
// Select media from the shared, CRC-validated PMT/EIT sections.
export class ProgramMap {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.video = null;
    this.audio = null;
    this.caption = null;
    this.program = null;
    this.audios = [];
    this.audioModes = new Map();
    this.audioSelection = null;
    this.dualSelection = 'main';
    this.audioConfigs = new Map();
    this.options = null;
  }
  get dualAudio() {
    const track = this.selectedAudioTrack();
    if (!track) return false;
    return this.audioConfigs.get(track.pid)?.dual ?? this.audioModes.get(track.tag)?.dual ?? false;
  }
  get mainAudioChannel() {
    return this.dualAudio ? { main: 0, sub: 1, both: null }[this.dualSelection] : null;
  }
  audioOptions() {
    return (this.options ??= this.audios.map((track, index) => {
      const mode = this.audioModes.get(track.tag),
        config = this.audioConfigs.get(track.pid);
      const type = config?.type ?? mode?.type;
      return {
        ...track,
        id: String(track.pid),
        label: [
          messages.broadcast.audioTrack(index + 1),
          type == null ? '' : audioLayout(type, messages.common.audio),
        ]
          .filter(Boolean)
          .join(' · '),
        default: !!mode?.main,
      };
    }));
  }
  selectedAudioTrack() {
    const options = this.audioOptions();
    return (
      options.find((o) => o.id === this.audioSelection) ??
      options.find((o) => o.default) ??
      options[0] ??
      null
    );
  }
  refreshAudio() {
    this.options = null;
    const selected = this.selectedAudioTrack();
    this.audio = selected?.pid ?? null;
  }
  selectAudio(id) {
    if (!this.audioOptions().some((o) => o.id === id)) return false;
    const before = this.selectedAudioTrack()?.id;
    this.audioSelection = id;
    this.refreshAudio();
    return before !== this.selectedAudioTrack()?.id;
  }
  selectDualAudio(id) {
    if (!this.dualAudio || !['main', 'sub', 'both'].includes(id) || id === this.dualSelection)
      return false;
    this.dualSelection = id;
    return true;
  }
  setAudioConfig(pid, config) {
    if (!this.audios.some((track) => track.pid === pid)) return;
    const previous = this.audioConfigs.get(pid);
    if (previous?.dual === config.dual && previous?.type === config.type) return;
    this.audioConfigs.set(pid, config);
    this.options = null;
    this.onChange();
  }
  applySection(s) {
    if (!s.currentNextIndicator) return;
    const program = s.tableId === 'PMT' ? s.programNumber : s.serviceId;
    if (this.program !== null && this.program !== program) return;
    if (s.tableId === 'EIT[p/f]') {
      if (s.other || s.sectionNumber !== 0 || this.program === null) return;
      const modes = new Map(
        (s.events[0]?.descriptors ?? [])
          .filter((d) => d.tag === 'audioComponent')
          .map((d) => [
            d.componentTag,
            {
              dual: (d.componentType & 31) === 2,
              type: d.componentType & 31,
              main: d.mainComponentFlag,
            },
          ]),
      );
      if (
        modes.size === this.audioModes.size &&
        [...modes].every(([tag, mode]) => {
          const previous = this.audioModes.get(tag);
          return (
            previous &&
            previous.dual === mode.dual &&
            previous.type === mode.type &&
            previous.main === mode.main
          );
        })
      )
        return;
      this.audioModes = modes;
      this.refreshAudio();
      this.onChange();
      return;
    }
    if (s.tableId !== 'PMT') return;
    let video = null,
      caption = null;
    const audios = [];
    for (const stream of s.streams) {
      const type = stream.streamType,
        pid = stream.elementaryPID;
      const tag = stream.esInfo.find((d) => d.tag === 'streamIdentifier')?.componentTag ?? null;
      const component =
        stream.esInfo.find((d) => d.tag === 'dataComponent')?.dataComponentId ?? null;
      if (type === 0x1b && video === null) video = pid;
      if (
        type === 0x06 &&
        caption === null &&
        tag === 0x87 &&
        (component === null || component === 0x12)
      )
        caption = pid;
      if (type === 0x0f) audios.push({ pid, tag });
    }
    if (video !== null) {
      if (
        this.program === program &&
        this.pcr === s.pcrPID &&
        this.video === video &&
        this.caption === caption &&
        audios.length === this.audios.length &&
        audios.every(
          (track, index) =>
            track.pid === this.audios[index].pid && track.tag === this.audios[index].tag,
        )
      )
        return;
      this.pcr = s.pcrPID;
      this.program = program;
      this.video = video;
      this.audios = audios;
      this.caption = caption;
      this.options = null;
      for (const pid of this.audioConfigs.keys())
        if (!audios.some((track) => track.pid === pid)) this.audioConfigs.delete(pid);
      if (this.audioSelection && !this.audioOptions().some((o) => o.id === this.audioSelection))
        this.audioSelection = null;
      this.refreshAudio();
      this.onChange();
    }
  }
}
