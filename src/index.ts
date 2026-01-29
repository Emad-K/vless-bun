import type { ServerWebSocket, Socket } from "bun";
import { z } from "zod";

// Environment validation schema
const envSchema = z.object({
  UUID: z.string().uuid("UUID must be a valid UUID v4 format"),
  PROXYIP: z.string().optional().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),
});

// Validate and parse environment variables
const env = envSchema.parse(process.env);

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
    console.error("safeCloseWebSocket error", error);
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

function processVlessHeader(vlessBuffer: ArrayBuffer, userID: string): VlessHeader {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: "invalid data" };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;

  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
    isValidUser = true;
  }

  if (!isValidUser) {
    return { hasError: true, message: "invalid user" };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(
    vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
  )[0];

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
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(
    vlessBuffer.slice(addressIndex, addressIndex + 1)
  );

  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    case 2: // Domain
      addressLength = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3: // IPv6
      addressLength = 16;
      const dataView = new DataView(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(":");
      break;
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
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer.buffer).getUint16(0);
        const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
        index = index + 2 + udpPacketLength;

        // DNS over HTTPS query
        try {
          const resp = await fetch("https://1.1.1.1/dns-query", {
            method: "POST",
            headers: { "content-type": "application/dns-message" },
            body: udpData,
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

function getVLESSConfig(userID: string, hostName: string): string {
  const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
  return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}

async function handleWebSocketMessage(
  ws: ServerWebSocket<WSData>,
  message: Buffer | ArrayBuffer | Uint8Array
): Promise<void> {
  const data = ws.data;
  const log = (info: string, event?: string) => {
    console.log(`[${data.address}:${data.portWithRandomLog}] ${info}`, event || "");
  };

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

  // Process VLESS header for new connection
  const {
    hasError,
    message: errorMessage,
    portRemote = 443,
    addressRemote = "",
    rawDataIndex = 0,
    vlessVersion = new Uint8Array([0, 0]),
    isUDP,
  } = processVlessHeader(chunk.buffer, userID);

  data.address = addressRemote;
  data.portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? "udp" : "tcp"}`;

  if (hasError) {
    log("VLESS header error", errorMessage);
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
  const rawClientData = new Uint8Array(chunk.buffer.slice(rawDataIndex));

  if (data.isDns) {
    const { write } = await handleUDPOutBound(ws, vlessResponseHeader, log);
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
    log
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
      const log = (info: string) => console.log(`[WS] ${info}`);
      log("WebSocket connection opened");

      // Handle early data (0-RTT)
      const { earlyData, error } = base64ToArrayBuffer(ws.data.earlyData);
      if (error) {
        log(`Early data error: ${error}`);
        ws.close();
        return;
      }
      if (earlyData) {
        handleWebSocketMessage(ws, new Uint8Array(earlyData)).catch((err) => {
          log(`Early data processing error: ${err}`);
          ws.close();
        });
      }
    },

    async message(ws, message) {
      try {
        await handleWebSocketMessage(ws, message as Buffer);
      } catch (err) {
        console.error("WebSocket message error:", err);
        safeCloseWebSocket(ws);
      }
    },

    close(ws) {
      console.log("[WS] Connection closed");
      if (ws.data.remoteSocket.value) {
        ws.data.remoteSocket.value.end();
      }
    },

    error(ws, error) {
      console.error("[WS] Error:", error);
      if (ws.data.remoteSocket.value) {
        ws.data.remoteSocket.value.end();
      }
    },
  },
});

console.log(`VLESS Bun server running on port ${PORT}`);
console.log(`Config URL: http://localhost:${PORT}/${userID}`);
