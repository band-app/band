/**
 * Reads a Blob through `FileReader.readAsDataURL`, the one read React Native's Blob supports. It
 * has no `arrayBuffer()`, `bytes()` or `text()`.
 */

/** The Blob's content as base64, without the `data:` prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.readAsDataURL(blob);
  });
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return base64ToBytes(await blobToBase64(blob));
}
