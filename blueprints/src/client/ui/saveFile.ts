// Handing a file made in the app (a downloaded PDF) to the device.
//
// A computer saves it like any download. An iPad or iPhone opened from the
// home screen often can't "download" a file the page made, so there it goes
// through the share sheet (Save to Files, Mail, AirDrop, Print). Both need a
// tap of their own: the browser only allows them right after one.

/** Save `blob` as `name` (a download). */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the download has its own copy by the time this runs
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The file for the share sheet, or null where this device can't share files. */
export function shareableFile(blob: Blob, name: string): File | null {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return null;
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  try {
    return navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

/** Open the share sheet; false when it failed (closing the sheet isn't a failure). */
export async function shareFile(file: File): Promise<boolean> {
  try {
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch (err) {
    return err instanceof DOMException && err.name === "AbortError";
  }
}
