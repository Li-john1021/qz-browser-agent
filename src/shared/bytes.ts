/** Binary/base64 wire conversion shared by documents and packaged Skill resources. */
export function bytesToBase64(bytes: Uint8Array | ArrayBuffer | ArrayLike<number> | null | undefined) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = "";
  for (let offset = 0; offset < input.length; offset += 0x8000) {
    out += String.fromCharCode(...input.subarray(offset, offset + 0x8000));
  }
  return btoa(out);
}

export function base64ToBytes(value: unknown) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
