export function downloadBlob(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadJson(value: unknown, filename: string) {
  const safeName = filename.replace(/[<>:"/\\|?*]/g, "_");
  downloadBlob(JSON.stringify(value, null, 2), safeName, "application/json;charset=utf-8");
}
