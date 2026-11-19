export function packageKey(pkg: { manufacturer: string; model: string; revision: string }): string {
  return JSON.stringify([pkg.manufacturer.trim(), pkg.model.trim(), pkg.revision.trim()]);
}

/** 设备包之间只引用制造商、型号与修订三项组成的规范键。 */
export function packageIdentityFields(value: string): [string, string, string] | undefined {
  let fields: unknown;
  try { fields = JSON.parse(value); } catch { return; }
  if (Array.isArray(fields) && fields.length === 3 && fields.every(field =>
    typeof field === "string" && field.length > 0 && field.length <= 160 && field === field.trim()) &&
    JSON.stringify(fields) === value) return [fields[0], fields[1], fields[2]];
}
export const isPackageKey = (value: string) => packageIdentityFields(value) !== undefined;
