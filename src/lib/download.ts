export function downloadFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name.replace(/[<>:"/\\|?*]/g, "_");
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadBlob(content: string, name: string, type: string) {
  downloadFile(new Blob([content], { type }), name);
}

export function downloadJson(value: unknown, filename: string) {
  downloadBlob(JSON.stringify(value, null, 2), filename, "application/json;charset=utf-8");
}
