import { SO101_REVISION } from "@contracts/so101";

const miloRevision = "2aaa0c55e6bc176e42592bdb27051e428413f516";
const docsRepository = "MillenniumMachines/millenniummachines.github.io";
const miloDocsRoot = `https://github.com/${docsRepository}/blob/${miloRevision}/docs/milo_1.5`;
const so101Repo = "TheRobotStudio/SO-ARM100";

export const miloBomSource = {
  revision: miloRevision, docsRoot: miloDocsRoot, localPath: "machines/milo-v1-5/bom-facts.md",
  documentUrl: `${miloDocsRoot}/bom/sourcing_guide.md`,
  rawUrl: `https://raw.githubusercontent.com/${docsRepository}/${miloRevision}/docs/milo_1.5/bom/sourcing_guide.md`,
  guideUrl: "https://millenniummachines.github.io/docs/milo_1.5/bom/sourcing_guide/",
};
export const so101BomSource = {
  revision: SO101_REVISION, localPath: "models/so101/follower-bom.md",
  documentUrl: `https://github.com/${so101Repo}/blob/${SO101_REVISION}/README.md#parts-for-one-follower-arm`,
  rawUrl: `https://raw.githubusercontent.com/${so101Repo}/${SO101_REVISION}/README.md`,
};

export function downloadableSource(url: URL): URL {
  const page = url.origin + url.pathname.replace(/\/$/, "");
  if (page === miloBomSource.guideUrl.replace(/\/$/, "")) return new URL(miloBomSource.rawUrl);
  if (page.toLowerCase() === `https://github.com/${so101Repo}`.toLowerCase() && url.hash === "#parts-for-one-follower-arm") {
    return new URL(so101BomSource.rawUrl);
  }
  const blob = url.hostname === "github.com" && /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  return blob ? new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`) : url;
}
