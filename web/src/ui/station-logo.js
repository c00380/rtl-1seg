import { stationLogos } from '../../logos/index.js';

export function stationLogoPath(information) {
  const network = information?.originalNetworkId;
  if (!Number.isInteger(network)) return '';
  const candidates = [information.serviceId, information.logoServiceId]
    .filter(Number.isInteger)
    .map((service) => `NID${network}-SID${service}.png`);
  // KonomiTV shares nationwide NHK artwork by station name. Also recognize
  // the names used by one-seg SDT, including full-width letters and digits.
  const station = (information.stationName ?? '')
    .normalize('NFKC')
    .replace(/\s/g, '')
    .toUpperCase();
  if (/^NHK(?:総合|携帯G)/.test(station)) candidates.push('NID32736-SID1024.png');
  else if (/^NHK(?:Eテレ|教育|携帯2)/.test(station)) candidates.push('NID32737-SID1032.png');
  const name = candidates.find((candidate) => stationLogos.has(candidate));
  return name ? new URL(`../../logos/${name}`, import.meta.url).href : '';
}
