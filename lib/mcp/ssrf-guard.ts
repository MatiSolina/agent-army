import { lookup } from "node:dns/promises"
import net from "node:net"

// note: deny-list of address ranges, not an allow-list of approved hosts. A
// catalog allow-list would be tighter; this blocks the internal-network SSRF
// vector (loopback/RFC1918/link-local/ULA) which is what matters for OAuth
// MCP connect. Upgrade to a host allow-list if the threat model needs it.
function isPrivateIp(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7) // IPv4-mapped IPv6
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast / reserved
    )
  }
  if (net.isIPv6(ip)) {
    const lc = ip.toLowerCase()
    return (
      lc === "::1" ||
      lc === "::" ||
      lc.startsWith("fc") ||
      lc.startsWith("fd") || // unique-local
      lc.startsWith("fe80") || // link-local
      lc.startsWith("ff") // multicast
    )
  }
  return true // unknown family → reject
}

function checkProtocolAndHost(u: URL, allowHttpInDev: boolean): string {
  const isDev = process.env.NODE_ENV !== "production"
  if (u.protocol !== "https:" && !(allowHttpInDev && isDev && u.protocol === "http:")) {
    throw new Error(`URL must be HTTPS: ${u.href}`)
  }
  // URL.hostname keeps brackets on IPv6 literals ("[::1]") and a trailing dot on
  // FQDNs — strip both so net.isIP / the suffix checks see a bare host.
  const host = u.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(`URL host is not allowed: ${host}`)
  }
  return host
}

/**
 * Reject URLs that could drive server-side requests to internal hosts.
 * Requires https (http only in dev), resolves the hostname, and blocks any
 * private/loopback/link-local address — covers literal-IP and DNS-rebinding
 * at check time. Use before any server-side fetch of an operator-supplied URL.
 */
export async function assertPublicHttpUrl(raw: string | URL): Promise<URL> {
  const u = new URL(raw)
  // The operator-supplied connection URL may be http://localhost in local dev.
  const host = checkProtocolAndHost(u, true)
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`URL points at a private address: ${host}`)
    }
    return u
  }
  const addrs = await lookup(host, { all: true })
  if (addrs.length === 0) throw new Error(`URL host does not resolve: ${host}`)
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error(`URL host resolves to a private address: ${host} → ${address}`)
    }
  }
  return u
}

/**
 * Synchronous, structural-only variant for call sites that cannot await (the
 * AI SDK's `validateAuthorizationServerURL` hook is sync). Checks protocol,
 * obvious internal hostnames, and literal private IPs. note: no DNS lookup, so
 * a public hostname resolving to an internal IP is NOT caught here — the async
 * check at connect time guards the primary (operator-supplied) URL.
 */
export function assertPublicHttpUrlSync(raw: string | URL): URL {
  const u = new URL(raw)
  // Discovered OAuth authorization servers must always be HTTPS (no dev http).
  const host = checkProtocolAndHost(u, false)
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error(`URL points at a private address: ${host}`)
  }
  return u
}
