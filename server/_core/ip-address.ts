import { BlockList, isIP } from "net";

const PRIVATE_IPV4_BLOCK_LIST = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_IPV4_BLOCK_LIST.addSubnet(network, prefix, "ipv4");
}

const PRIVATE_IPV6_BLOCK_LIST = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  PRIVATE_IPV6_BLOCK_LIST.addSubnet(network, prefix, "ipv6");
}

function cleanIpLiteral(rawAddress: string): string {
  return String(rawAddress || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%[^%]+$/, "")
    .toLowerCase();
}

function canonicalIpv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return address;
  }
}

function mappedIpv4(address: string): string | null {
  const canonical = canonicalIpv6(address);
  const match = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

export function normalizeIpAddress(rawAddress: string): string {
  const address = cleanIpLiteral(rawAddress);
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return address;
  if (address === "::1") return "127.0.0.1";
  return mappedIpv4(address) || canonicalIpv6(address);
}

export function isPrivateIpAddress(rawAddress: string): boolean {
  const address = normalizeIpAddress(rawAddress);
  const family = isIP(address);
  if (family === 4) return PRIVATE_IPV4_BLOCK_LIST.check(address, "ipv4");
  if (family === 6) return PRIVATE_IPV6_BLOCK_LIST.check(address, "ipv6");
  return true;
}
