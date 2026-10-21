import { messages } from '../messages.js';
import { escapeHtml } from './utils.js';
const timeOptions = {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};
const time = new Intl.DateTimeFormat('ja-JP', timeOptions);
const dateTime = new Intl.DateTimeFormat('ja-JP', {
  ...timeOptions,
  month: 'numeric',
  day: 'numeric',
});
const day = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
});
export function programSchedule(event, includeDate = false) {
  if (!event) return '';
  const format = includeDate ? dateTime : time;
  const times = [event.start, event.end]
    .filter((value) => value != null)
    .map((value) => format.format(value));
  return times.join(' ～ ') + (includeDate && times.length ? messages.common.japanTime : '');
}
const escape = (value) => escapeHtml(value ?? '');
export const activeProgram = (event, now) =>
  event && (event.end == null || event.end > now) ? event : null;
export function programsAfter(info, now = Date.now()) {
  const seen = new Set([info?.current?.id, info?.next?.id].filter((id) => id != null));
  const boundary = info?.next?.end ?? info?.next?.start ?? info?.current?.end;
  return (info?.after ?? [])
    .filter(
      (event) =>
        activeProgram(event, now) &&
        Number.isFinite(event.start) &&
        (boundary == null || event.start >= boundary),
    )
    .sort((a, b) => a.start - b.start)
    .filter((event) => {
      if (event.id != null && seen.has(event.id)) return false;
      if (event.id != null) seen.add(event.id);
      return true;
    })
    .slice(0, 8);
}
function additionalProgramCard(event, label, key = '') {
  const field = (current, next) =>
    key ? ` data-program="${key === 'current' ? current : next}"` : '';
  const schedule = programSchedule(event);
  const duration =
    event.duration == null
      ? ''
      : `<span class="rx-program-duration"${field('duration', 'nextDuration')}>${escape(event.duration / 60000)}${messages.common.minutesUnit}</span>`;
  const description = event.description
    ? `<p${field('description', 'nextDescription')}>${escape(event.description)}</p>`
    : '';
  const genres = event.genres?.length
    ? `<div class="rx-program-genres"><span class="rx-program-badge"${field('genre', 'nextGenre')}>${escape(event.genres.join(' / '))}</span></div>`
    : '';
  return [
    `<article class="rx-program-card${key === 'current' ? ' is-current' : ''}">`,
    '<div class="rx-program-kicker">',
    `<span class="${key === 'current' ? 'rx-time' : 'rx-label'}"${key === 'current' ? ' data-program="currentLabel"' : ''}>${escape(label)}</span>`,
    schedule || duration
      ? `<span class="rx-program-schedule">${schedule ? `<time${field('schedule', 'nextSchedule')}>${escape(schedule)}</time>` : ''}${duration}</span>`
      : '',
    '</div>',
    event.title
      ? `<h3${key === 'current' ? ' class="rx-side-title"' : ''}${field('title', 'nextTitle')}>${escape(event.title)}</h3>`
      : '',
    description,
    genres,
    '</article>',
  ].join('');
}

// Information containers stay empty until an actual event/service arrives.
export function programSummaryMarkup(info, now = Date.now()) {
  const current = activeProgram(info?.current, now),
    next = activeProgram(info?.next, now);
  return (
    (current ? additionalProgramCard(current, messages.common.onAir, 'current') : '') +
    (next ? additionalProgramCard(next, messages.common.nextProgram, 'next') : '') +
    programAfterMarkup(info, now)
  );
}

export function receptionHeaderMarkup(program = {}) {
  const text = (tag, field, className = '') =>
    program[field]
      ? `<${tag}${className ? ` class="${className}"` : ''} data-reception="${field}">${escape(program[field])}</${tag}>`
      : '';
  const frequency = program.frequency
    ? `<small data-reception="frequency">CH ${escape(program.frequency)}</small>`
    : '';
  const logo = program.logoImage
    ? `<span class="rx-station-logo is-image" data-reception="logo"><img src="${escape(program.logoImage)}" alt="${escape(program.station || program.logo)}"></span>`
    : text('span', 'logo', 'rx-station-logo');
  const station =
    program.station || logo || frequency
      ? `<div class="rx-station rx-top-station">${logo}<div>${text('strong', 'station', 'rx-station-name')}${frequency}</div></div>`
      : '';
  const meta = text('span', 'currentLabel', 'rx-time') + text('time', 'currentSchedule');
  const current =
    meta || program.title
      ? `<div class="rx-top-program"><div class="rx-current-program">${meta ? `<div class="rx-current-meta">${meta}</div>` : ''}${program.title ? `<h1 class="rx-program-title">${text('span', 'title')}</h1>` : ''}</div></div>`
      : '';
  const next =
    program.nextLabel || program.nextTitle
      ? `<div class="rx-top-next">${text('span', 'nextLabel', 'rx-label rx-top-next-time')}${text('p', 'nextTitle', 'rx-top-next-title')}</div>`
      : '';
  return station + current + next;
}

export function programAfterMarkup(info, now = Date.now()) {
  const events = programsAfter(info, now);
  const today = events.length ? day.format(now) : '';
  return events
    .map((event) => {
      const eventDay = day.format(event.start);
      const label =
        eventDay === today
          ? messages.common.laterPrograms
          : messages.common.laterProgramsOn(eventDay);
      return additionalProgramCard(event, label);
    })
    .join('');
}

export function programTitle(info, now = Date.now()) {
  return activeProgram(info?.current, now)?.title || messages.common.appTitle;
}
