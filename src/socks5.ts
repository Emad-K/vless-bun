import { isIPv4, isIPv6 } from "node:net";

export interface SocksEndpoint {
  hostname: string;
  port: number;
  /** SOCKS5 RFC 1929; omit for no-auth */
  username?: string;
  password?: string;
}

/**
 * Parse PROXYIP for SOCKS5:
 * - host | host:port | [ipv6]:port | socks5://...
 * - user:pass@host:port | socks5://user:pass@host:port
 * (password may contain ':' — only the first ':' splits user vs password)
 */
export function parseSocksEndpoint(raw: string): SocksEndpoint | null {
  let u = raw.trim();
  if (!u) return null;

  if (u.toLowerCase().startsWith("socks5://")) {
    u = u.slice("socks5://".length);
  }
  const slash = u.indexOf("/");
  if (slash !== -1) u = u.slice(0, slash);

  let username: string | undefined;
  let password: string | undefined;
  const at = u.lastIndexOf("@");
  if (at !== -1) {
    const cred = u.slice(0, at);
    u = u.slice(at + 1);
    const colon = cred.indexOf(":");
    if (colon === -1) {
      throw new Error(`PROXYIP: use user:password@host:port (missing ':' in credentials)`);
    }
    username = cred.slice(0, colon);
    password = cred.slice(colon + 1);
    if (!username.length) throw new Error("PROXYIP: empty SOCKS username");
  }

  if (u.startsWith("[")) {
    const end = u.indexOf("]");
    if (end === -1) throw new Error(`Invalid PROXYIP (IPv6 bracket): ${raw}`);
    const inner = u.slice(1, end);
    const rest = u.slice(end + 1);
    if (rest.startsWith(":")) {
      const port = Number.parseInt(rest.slice(1), 10);
      if (!Number.isFinite(port)) throw new Error(`Invalid PROXYIP port: ${raw}`);
      return { hostname: inner, port, username, password };
    }
    return { hostname: inner, port: 1080, username, password };
  }

  const lastColon = u.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(u.slice(lastColon + 1))) {
    const port = Number.parseInt(u.slice(lastColon + 1), 10);
    if (!Number.isFinite(port)) throw new Error(`Invalid PROXYIP port: ${raw}`);
    return { hostname: u.slice(0, lastColon), port, username, password };
  }

  return { hostname: u, port: 1080, username, password };
}

/** RFC 1929 username/password subnegotiation (after server selects method 0x02) */
export function buildSocks5UserPassAuth(username: string, password: string): Uint8Array {
  const userBytes = new TextEncoder().encode(username);
  const passBytes = new TextEncoder().encode(password);
  if (userBytes.length > 255 || passBytes.length > 255) {
    throw new Error("SOCKS5 username or password exceeds 255 bytes");
  }
  return concat(
    new Uint8Array([1, userBytes.length]),
    userBytes,
    new Uint8Array([passBytes.length]),
    passBytes
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function ipv4ToBytes(host: string): Uint8Array {
  const octets = host.split(".").map((x) => Number.parseInt(x, 10));
  if (octets.length !== 4 || octets.some((x) => x < 0 || x > 255)) {
    throw new Error("invalid IPv4");
  }
  return Uint8Array.from(octets);
}

function expandIPv6Groups(ip: string): string[] {
  const s = ip.includes("%") ? ip.split("%")[0]! : ip;
  if (!s.includes("::")) {
    const parts = s.split(":").filter((p) => p.length > 0);
    if (parts.length !== 8) throw new Error("invalid IPv6");
    return parts;
  }
  const [left, right] = s.split("::", 2);
  const leftParts = left ? left.split(":").filter((p) => p.length > 0) : [];
  const rightParts = right ? right.split(":").filter((p) => p.length > 0) : [];
  const pad = 8 - leftParts.length - rightParts.length;
  if (pad < 0) throw new Error("invalid IPv6 (::)");
  return [...leftParts, ...Array(pad).fill("0"), ...rightParts];
}

function ipv6ToBytes(ip: string): Uint8Array {
  const s = ip.includes("%") ? ip.split("%")[0]! : ip;
  const groups = expandIPv6Groups(s);
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = Number.parseInt(groups[i]!, 16);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

/** SOCKS5 REQ: VER CMD RSV ATYP DST ADDR PORT */
export function buildSocks5ConnectRequest(dstHost: string, dstPort: number): Uint8Array {
  const portHi = (dstPort >> 8) & 0xff;
  const portLo = dstPort & 0xff;

  if (isIPv4(dstHost)) {
    return concat(new Uint8Array([5, 1, 0, 1]), ipv4ToBytes(dstHost), new Uint8Array([portHi, portLo]));
  }

  if (isIPv6(dstHost)) {
    try {
      return concat(new Uint8Array([5, 1, 0, 4]), ipv6ToBytes(dstHost), new Uint8Array([portHi, portLo]));
    } catch {
      // fall through to domain
    }
  }

  const enc = new TextEncoder().encode(dstHost);
  if (enc.length > 255) throw new Error("SOCKS destination hostname too long");
  return concat(
    new Uint8Array([5, 1, 0, 3, enc.length]),
    enc,
    new Uint8Array([portHi, portLo])
  );
}

/** Full length of a SOCKS5 reply starting at buf[0], or null if incomplete */
export function socks5ConnectReplyLength(buf: Uint8Array): number | null {
  if (buf.length < 4) return null;
  const atyp = buf[3];
  let addrLen = 0;
  if (atyp === 1) addrLen = 4;
  else if (atyp === 3) {
    if (buf.length < 5) return null;
    addrLen = 1 + buf[4]!;
  } else if (atyp === 4) addrLen = 16;
  else return null;
  const total = 4 + addrLen + 2;
  return buf.length >= total ? total : null;
}
