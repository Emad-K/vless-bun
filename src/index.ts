import type { ServerWebSocket, Socket } from "bun";
import { z } from "zod";
import { createLogger } from "./logger";

// Environment validation schema
const envSchema = z.object({
  UUID: z.string().uuid("UUID must be a valid UUID v4 format"),
  PROXYIP: z.string().optional().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),
  LOG_LEVEL: z.string().optional().default("info"),
  /** Advertised host for subscription URLs (override Host header) */
  PUBLIC_HOST: z.string().optional().default(""),
  /** Advertised port for subscription URLs (override Host / PORT) */
  PUBLIC_PORT: z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(65535).optional()
  ),
  /**
   * Generate `security=tls` / `wss` URLs for clients (use when TLS terminates on reverse proxy).
   * Default false matches plain Bun server / Docker (HTTP + WS on PORT).
   */
  TLS: z.preprocess((v) => {
    if (v === undefined || v === "") return false;
    const s = String(v).toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }, z.boolean()),
});

// Validate and parse environment variables
const env = envSchema.parse(process.env);

const log = createLogger(env.LOG_LEVEL);

// Configuration
const userID = env.UUID;
const proxyIP = env.PROXYIP;
const PORT = env.PORT;

// WebSocket data interface
interface WSData {
  earlyData: string;
  remoteSocket: { value: Socket | null };
  udpStreamWrite: ((chunk: Uint8Array) => void) | null;
  isDns: boolean;
  address: string;
  portWithRandomLog: string;
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// UUID helpers
const byteToHex: string[] = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr: Uint8Array, offset = 0): string {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    "-" +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    "-" +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    "-" +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    "-" +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr: Uint8Array, offset = 0): string {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function base64ToArrayBuffer(base64Str: string): {
  earlyData?: ArrayBuffer;
  error: Error | null;
} {
  if (!base64Str) {
    return { error: null };
  }
  try {
    // URL-safe Base64 to standard Base64
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error: error as Error };
  }
}

function safeCloseWebSocket(socket: ServerWebSocket<WSData>): void {
  try {
    if (
      socket.readyState === WS_READY_STATE_OPEN ||
      socket.readyState === WS_READY_STATE_CLOSING
    ) {
      socket.close();
    }
  } catch (error) {
    log.error("safeCloseWebSocket error", error);
  }
}

interface VlessHeader {
  hasError: boolean;
  message?: string;
  addressRemote?: string;
  addressType?: number;
  portRemote?: number;
  rawDataIndex?: number;
  vlessVersion?: Uint8Array;
  isUDP?: boolean;
}

function processVlessHeader(vless: Uint8Array, userID: string): VlessHeader {
  if (vless.byteLength < 24) {
    return { hasError: true, message: "invalid data" };
  }

  const version = vless.subarray(0, 1);
  let isValidUser = false;
  let isUDP = false;

  if (stringify(vless.subarray(1, 17)) === userID) {
    isValidUser = true;
  }

  if (!isValidUser) {
    return { hasError: true, message: "invalid user" };
  }

  const optLength = vless[17];
  const command = vless[18 + optLength];

  if (command === 1) {
    // TCP
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not supported, command 01-tcp, 02-udp, 03-mux`,
    };
  }

  const portIndex = 18 + optLength + 1;
  if (portIndex + 2 > vless.byteLength) {
    return { hasError: true, message: "truncated VLESS header (port)" };
  }
  const portRemote = new DataView(vless.buffer, vless.byteOffset + portIndex, 2).getUint16(0);

  let addressIndex = portIndex + 2;
  if (addressIndex >= vless.byteLength) {
    return { hasError: true, message: "truncated VLESS header (address type)" };
  }

  const addressType = vless[addressIndex];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";

  switch (addressType) {
    case 1: {
      // IPv4
      addressLength = 4;
      if (addressValueIndex + addressLength > vless.byteLength) {
        return { hasError: true, message: "truncated VLESS header (IPv4)" };
      }
      addressValue = Array.from(
        vless.subarray(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    }
    case 2: {
      // Domain
      if (addressValueIndex >= vless.byteLength) {
        return { hasError: true, message: "truncated VLESS header (domain len)" };
      }
      addressLength = vless[addressValueIndex];
      addressValueIndex += 1;
      if (addressValueIndex + addressLength > vless.byteLength) {
        return { hasError: true, message: "truncated VLESS header (domain)" };
      }
      addressValue = new TextDecoder().decode(
        vless.subarray(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    }
    case 3: {
      // IPv6
      addressLength = 16;
      if (addressValueIndex + addressLength > vless.byteLength) {
        return { hasError: true, message: "truncated VLESS header (IPv6)" };
      }
      const dataView = new DataView(
        vless.buffer,
        vless.byteOffset + addressValueIndex,
        addressLength
      );
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(":");
      break;
    }
    default:
      return { hasError: true, message: `invalid addressType is ${addressType}` };
  }

  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

async function handleTCPOutBound(
  ws: ServerWebSocket<WSData>,
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
): Promise<void> {
  let vlessHeader: Uint8Array | null = vlessResponseHeader;

  async function connectAndWrite(address: string, port: number): Promise<Socket> {
    log(`Connecting to ${address}:${port}`);
    
    const tcpSocket = await Bun.connect({
      hostname: address,
      port: port,
      socket: {
        data(socket, data) {
          if (ws.readyState !== WS_READY_STATE_OPEN) {
            return;
          }
          
          if (vlessHeader) {
            const combined = new Uint8Array(vlessHeader.length + data.length);
            combined.set(vlessHeader);
            combined.set(new Uint8Array(data), vlessHeader.length);
            ws.send(combined);
            vlessHeader = null;
          } else {
            ws.send(data);
          }
        },
        open(socket) {
          log(`Connected to ${address}:${port}`);
          socket.write(rawClientData);
        },
        close(socket) {
          log("TCP connection closed");
          safeCloseWebSocket(ws);
        },
        error(socket, error) {
          log("TCP connection error", String(error));
          safeCloseWebSocket(ws);
        },
        connectError(socket, error) {
          log("TCP connect error", String(error));
          // Try retry with proxyIP
          if (proxyIP && address !== proxyIP) {
            connectAndWrite(proxyIP, port).catch((err) => {
              log("Retry failed", String(err));
              safeCloseWebSocket(ws);
            });
          } else {
            safeCloseWebSocket(ws);
          }
        },
      },
    });

    ws.data.remoteSocket.value = tcpSocket;
    return tcpSocket;
  }

  await connectAndWrite(addressRemote, portRemote);
}

async function handleUDPOutBound(
  ws: ServerWebSocket<WSData>,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
): Promise<{ write: (chunk: Uint8Array) => void }> {
  let isVlessHeaderSent = false;

  return {
    write: async (chunk: Uint8Array) => {
      // Parse UDP packets from chunk
      for (let index = 0; index < chunk.byteLength; ) {
        if (index + 2 > chunk.byteLength) break;
        const udpPacketLength = (chunk[index] << 8) | chunk[index + 1];
        if (index + 2 + udpPacketLength > chunk.byteLength) break;
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;

        // DNS over HTTPS query
        try {
          const resp = await fetch("https://1.1.1.1/dns-query", {
            method: "POST",
            headers: { "content-type": "application/dns-message" },
            body: Buffer.from(udpData),
          });
          
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([
            (udpSize >> 8) & 0xff,
            udpSize & 0xff,
          ]);

          if (ws.readyState === WS_READY_STATE_OPEN) {
            log(`DoH success, DNS message length: ${udpSize}`);
            
            if (isVlessHeaderSent) {
              const combined = new Uint8Array(2 + udpSize);
              combined.set(udpSizeBuffer);
              combined.set(new Uint8Array(dnsQueryResult), 2);
              ws.send(combined);
            } else {
              const combined = new Uint8Array(
                vlessResponseHeader.length + 2 + udpSize
              );
              combined.set(vlessResponseHeader);
              combined.set(udpSizeBuffer, vlessResponseHeader.length);
              combined.set(
                new Uint8Array(dnsQueryResult),
                vlessResponseHeader.length + 2
              );
              ws.send(combined);
              isVlessHeaderSent = true;
            }
          }
        } catch (error) {
          log("DNS UDP error", String(error));
        }
      }
    },
  };
}

function splitHostPort(hostHeader: string): { host: string; port: number | undefined } {
  const raw = hostHeader.trim();
  if (!raw) return { host: "localhost", port: undefined };

  if (raw.startsWith("[")) {
    const endBracket = raw.indexOf("]");
    if (endBracket === -1) return { host: raw, port: undefined };
    const inner = raw.slice(1, endBracket);
    const rest = raw.slice(endBracket + 1);
    if (rest.startsWith(":")) {
      const p = Number.parseInt(rest.slice(1), 10);
      return { host: inner, port: Number.isFinite(p) ? p : undefined };
    }
    return { host: inner, port: undefined };
  }

  const colon = raw.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
    const p = Number.parseInt(raw.slice(colon + 1), 10);
    return { host: raw.slice(0, colon), port: Number.isFinite(p) ? p : undefined };
  }

  return { host: raw, port: undefined };
}

/** Host portion for `user@host:port` when host may be IPv6 */
function hostForUri(hostname: string): string {
  if (hostname.includes(":") && !hostname.startsWith("[")) {
    return `[${hostname}]`;
  }
  return hostname;
}

function getVLESSConfig(userID: string, hostHeader: string): string {
  const parsed = splitHostPort(hostHeader);
  const advertiseHost = env.PUBLIC_HOST.trim() || parsed.host;
  const advertisePort = env.PUBLIC_PORT ?? parsed.port ?? PORT;
  const useTls = env.TLS;

  const serverInUri = hostForUri(advertiseHost);
  const pathEnc = encodeURIComponent("/?ed=2048");
  const wsHostParam = advertiseHost;

  const vlessMain = useTls
    ? `vless://${userID}@${serverInUri}:${advertisePort}?encryption=none&security=tls&type=ws&sni=${encodeURIComponent(advertiseHost)}&fp=randomized&host=${encodeURIComponent(wsHostParam)}&path=${pathEnc}#${encodeURIComponent(advertiseHost)}`
    : `vless://${userID}@${serverInUri}:${advertisePort}?encryption=none&security=none&type=ws&host=${encodeURIComponent(wsHostParam)}&path=${pathEnc}#${encodeURIComponent(advertiseHost)}`;

  const clashTls = useTls;
  const clashSni = useTls ? `  sni: ${advertiseHost}\n  client-fingerprint: chrome\n` : "";

  return `
################################################################
v2ray / v2rayN — import as VLESS (match TLS to server: TLS=${useTls})
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
Docker / plain WS: set client transport TLS off, port ${advertisePort}.
Behind nginx/Caddy with TLS: set TLS=true in server env and use wss + TLS in client.
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${advertiseHost}
  server: ${advertiseHost}
  port: ${advertisePort}
  uuid: ${userID}
  network: ws
  tls: ${clashTls}
  udp: false
${clashSni}  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${advertiseHost}
---------------------------------------------------------------
################################################################
`;
}

async function handleWebSocketMessage(
  ws: ServerWebSocket<WSData>,
  message: Buffer | ArrayBuffer | Uint8Array
): Promise<void> {
  const data = ws.data;

  let chunk: Uint8Array;
  if (message instanceof Buffer) {
    chunk = new Uint8Array(message);
  } else if (message instanceof ArrayBuffer) {
    chunk = new Uint8Array(message);
  } else {
    chunk = message;
  }

  // Handle DNS UDP
  if (data.isDns && data.udpStreamWrite) {
    data.udpStreamWrite(chunk);
    return;
  }

  // Handle existing TCP connection
  if (data.remoteSocket.value) {
    data.remoteSocket.value.write(chunk);
    return;
  }

  // Process VLESS header for new connection (must use the same Uint8Array view as the message)
  const {
    hasError,
    message: errorMessage,
    portRemote = 443,
    addressRemote = "",
    rawDataIndex = 0,
    vlessVersion = new Uint8Array([0, 0]),
    isUDP,
  } = processVlessHeader(chunk, userID);

  data.address = addressRemote;
  data.portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? "udp" : "tcp"}`;

  const sessionLog = (msg: string, meta?: unknown) =>
    log.debug(`[${data.address}:${data.portWithRandomLog}] ${msg}`, meta);

  if (hasError) {
    sessionLog("VLESS header error", errorMessage);
    throw new Error(errorMessage);
  }

  // UDP only for DNS (port 53)
  if (isUDP) {
    if (portRemote === 53) {
      data.isDns = true;
    } else {
      throw new Error("UDP proxy only enabled for DNS (port 53)");
    }
  }

  const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
  const rawClientData = chunk.subarray(rawDataIndex);

  if (data.isDns) {
    const { write } = await handleUDPOutBound(ws, vlessResponseHeader, sessionLog);
    data.udpStreamWrite = write;
    data.udpStreamWrite(rawClientData);
    return;
  }

  await handleTCPOutBound(
    ws,
    addressRemote,
    portRemote,
    rawClientData,
    vlessResponseHeader,
    sessionLog
  );
}

// Start the server
const server = Bun.serve<WSData>({
  port: PORT,
  
  async fetch(req, server) {
    const url = new URL(req.url);
    const upgradeHeader = req.headers.get("Upgrade");

    // WebSocket upgrade
    if (upgradeHeader === "websocket") {
      const earlyData = req.headers.get("sec-websocket-protocol") || "";
      
      const success = server.upgrade(req, {
        data: {
          earlyData,
          remoteSocket: { value: null },
          udpStreamWrite: null,
          isDns: false,
          address: "",
          portWithRandomLog: "",
        },
      });

      return success
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 500 });
    }

    // HTTP routes
    switch (url.pathname) {
      case "/":
        return new Response(
          JSON.stringify({
            message: "VLESS Bun Server",
            runtime: "Bun",
            version: Bun.version,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );

      case `/${userID}`:
        const host = req.headers.get("Host") || "localhost";
        const vlessConfig = getVLESSConfig(userID, host);
        return new Response(vlessConfig, {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" },
        });

      default:
        return new Response("Not found", { status: 404 });
    }
  },

  websocket: {
    open(ws) {
      log.debug("[WS] WebSocket connection opened");

      // Handle early data (0-RTT)
      const { earlyData, error } = base64ToArrayBuffer(ws.data.earlyData);
      if (error) {
        log.warn("[WS] Early data decode error", String(error));
        ws.close();
        return;
      }
      if (earlyData) {
        handleWebSocketMessage(ws, new Uint8Array(earlyData)).catch((err) => {
          log.warn("[WS] Early data processing error", String(err));
          ws.close();
        });
      }
    },

    async message(ws, message) {
      try {
        await handleWebSocketMessage(ws, message as Buffer);
      } catch (err) {
        log.error("WebSocket message error", err);
        safeCloseWebSocket(ws);
      }
    },

    close(ws, code, reason) {
      log.debug(`[WS] Connection closed code=${code}`, reason);
      if (ws.data.remoteSocket.value) {
        ws.data.remoteSocket.value.end();
      }
    },
  },
});

log.info(`VLESS Bun server listening on port ${PORT}`);
log.info(`Config URL (replace host with your Docker/WSL IP): http://0.0.0.0:${PORT}/${userID}`);
