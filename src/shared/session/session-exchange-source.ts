/** Exported chat pages may import only from a local file or an explicit loopback origin. */
export function isAllowedSessionExchangeLocation(location: { protocol: string; hostname: string }): boolean {
  if (location.protocol === "file:") return true;
  if (location.protocol !== "http:" && location.protocol !== "https:") return false;
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(location.hostname.toLowerCase());
}
