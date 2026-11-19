export const MAX_SOURCE_DOCUMENT_BYTES = 8 * 1024 * 1024;

const officialHosts = new Set(["portal-file.inovance.com", "www.inovance.com", "www.inovance.eu"]);

export function canReadOfficialSource(url: URL) {
  return url.protocol === "https:" && officialHosts.has(url.hostname) && !url.port && !url.username && !url.password;
}
