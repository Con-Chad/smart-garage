import { isIP } from "node:net";
import { promises as dns } from "node:dns";

/**
 * SSRF guard for push endpoints. The server POSTs to whatever URL a device
 * registers, so the URL must point at a public push service and nothing
 * else: `https:` only, default port, no credentials, and a host that does
 * not resolve to loopback, private, link-local, CGNAT, multicast or
 * cloud-metadata ranges. ntfy.sh, Mozilla autopush and any public
 * UnifiedPush distributor pass; `http://ntfy.lan:8080` and `https://10.0.0.5`
 * do not.
 *
 * Self-hosters whose distributor lives on the LAN can set
 * `UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS=true` (D-022), which keeps the
 * `https:` requirement but allows private addresses and other ports.
 */

export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

export type EndpointCheck = { ok: true; url: URL } | { ok: false; reason: string };

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export function privateEndpointsAllowed(): boolean {
  return process.env.UNIFIEDPUSH_ALLOW_PRIVATE_ENDPOINTS === "true";
}

/** Hostnames that never belong to a public push service. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".localdomain"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 address into its eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  let value = address.toLowerCase();
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);

  // Embedded IPv4 tail, e.g. ::ffff:10.0.0.1
  const v4Match = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (v4Match) {
    const octets = parseIpv4(v4Match[2]!);
    if (!octets) return null;
    value = `${v4Match[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail].map((group) => parseInt(group, 16));
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const isZero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (isZero(0, 8)) return true; // ::
  if (isZero(0, 7) && g7 === 1) return true; // ::1
  if (isZero(0, 5) && g5 === 0xffff) {
    // IPv4-mapped ::ffff:a.b.c.d
    return isPrivateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // NAT64 64:ff9b::/96 — judge the embedded IPv4
    return isPrivateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2002) return isPrivateIpv4(`${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`); // 6to4
  void g3;
  void g4;
  return false;
}

/** True for loopback, private, link-local, CGNAT, multicast and metadata addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

/** The synchronous part of the check: scheme, port, credentials, literal host. */
export function checkPushEndpointSyntax(value: string): EndpointCheck {
  if (typeof value !== "string" || value.length === 0) return { ok: false, reason: "endpoint is required" };
  if (value.length > MAX_PUSH_ENDPOINT_LENGTH) return { ok: false, reason: "endpoint is too long" };
  if (/[\s\u0000-\u001f]/.test(value)) return { ok: false, reason: "endpoint contains whitespace or control characters" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "endpoint is not a valid URL" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "endpoint must use https" };
  if (url.username || url.password) return { ok: false, reason: "endpoint must not contain credentials" };
  if (url.hash) return { ok: false, reason: "endpoint must not contain a fragment" };

  const allowPrivate = privateEndpointsAllowed();
  if (url.port && url.port !== "443" && !allowPrivate) {
    return { ok: false, reason: "endpoint must use the default https port" };
  }

  const hostname = url.hostname.toLowerCase();
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (!allowPrivate) {
    if (BLOCKED_HOSTS.has(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return { ok: false, reason: "endpoint host is not a public push service" };
    }
    if (isIP(literal) && isPrivateAddress(literal)) {
      return { ok: false, reason: "endpoint resolves to a private address" };
    }
    if (!hostname.includes(".") && !isIP(literal)) {
      return { ok: false, reason: "endpoint host is not a public push service" };
    }
  }

  return { ok: true, url };
}

/**
 * Full check: syntax plus a DNS lookup of the host so `https://evil.example`
 * can't point at 127.0.0.1 or the cloud metadata service. Every address the
 * name resolves to must be public.
 */
export async function validatePushEndpoint(
  value: string,
  resolve: Resolver = defaultResolver,
): Promise<EndpointCheck> {
  const syntax = checkPushEndpointSyntax(value);
  if (!syntax.ok) return syntax;
  if (privateEndpointsAllowed()) return syntax;

  const hostname = syntax.url.hostname;
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(literal)) return syntax;

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, reason: "endpoint host could not be resolved" };
  }
  if (addresses.length === 0) return { ok: false, reason: "endpoint host could not be resolved" };
  if (addresses.some((address) => isPrivateAddress(address))) {
    return { ok: false, reason: "endpoint resolves to a private address" };
  }
  return syntax;
}
