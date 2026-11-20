export const MAX_SOURCE_DOCUMENT_BYTES = 8 * 1024 * 1024;

export const OFFICIAL_SOURCE_HOSTS = [
  "portal-file.inovance.com",
  "www.inovance.com",
  "www.inovance.eu",
  "www.deltaww.com",
  "filecenter.deltaww.com",
  "industry.panasonic.com",
  "tech.thk.com",
  "www.hiwin.tw",
  "www.yaskawa.com",
  "www.omron.com",
  "www.festo.com",
  "www.boschrexroth.com",
] as const;

const officialHosts = new Set<string>(OFFICIAL_SOURCE_HOSTS);

export function canReadOfficialSource(url: URL) {
  return url.protocol === "https:" && officialHosts.has(url.hostname) && !url.port && !url.username && !url.password;
}
