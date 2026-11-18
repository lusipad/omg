import { MODEL_LIMITS, type ModelBundle, type ModelFile } from "./import-catalog";

const meters = { m: 1, cm: 0.01, mm: 0.001 } as const;

function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function makeStaticMeshBundle(files: ModelFile[], meshPath: string, unit: keyof typeof meters): ModelBundle {
  if (!Object.hasOwn(meters, unit)) throw new Error("请指定原始网格的长度单位。");
  if (!files.some(file => file.path === meshPath) || !/\.(?:stl|obj)$/i.test(meshPath)) throw new Error("请选择包内的 STL 或 OBJ 网格。");
  const used = new Set(files.map(file => file.path.toLowerCase()));
  let entry = "geometry.xml";
  for (let n = 2; used.has(entry); n++) entry = `geometry-${n}.xml`;
  const scale = meters[unit];
  const name = meshPath.split("/").at(-1)!.replace(/\.[^.]+$/, "").slice(0, 240) || "几何模型";
  const xml = `<mujoco model="${attribute(name)}">
  <asset><mesh name="surface" file="${attribute(meshPath)}" scale="${scale} ${scale} ${scale}" inertia="shell"/></asset>
  <worldbody><body name="part"><geom type="mesh" mesh="surface" contype="0" conaffinity="0" rgba="0.25 0.65 0.58 1"/></body></worldbody>
</mujoco>`;
  const data = new TextEncoder().encode(xml);
  if (files.length + 1 > MODEL_LIMITS.maxFiles || files.reduce((total, file) => total + file.data.byteLength, data.byteLength) > MODEL_LIMITS.maxBundleBytes) {
    throw new Error("网格与装配描述合计超过单个模型包上限。");
  }
  return { entry, files: [...files, { path: entry, data }] };
}
