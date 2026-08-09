import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket, type RawData } from "ws";

export const GATEWAY_PROTOCOL_VERSION = 4 as const;

export interface GatewayErrorShape {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

export interface GatewayRequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface GatewayResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: GatewayErrorShape;
}

export interface GatewayEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
}

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame;

export interface GatewayDeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKeyPem: string;
}

export interface GatewayHello {
  type: "hello-ok";
  protocol: number;
  server: {
    version: string;
    connId: string;
  };
  features: {
    methods: string[];
    events: string[];
    capabilities?: string[];
  };
  auth: {
    role: string;
    scopes: string[];
    deviceToken?: string;
  };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
  snapshot: unknown;
}

export type GatewayConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "stopped";

export interface GatewayConnectionStatus {
  state: GatewayConnectionState;
  connected: boolean;
  attempt: number;
  retryInMs?: number;
  error?: string;
}

export interface GatewayClientOptions {
  url?: string;
  token: string;
  clientVersion?: string;
  platform?: string;
  locale?: string;
  userAgent?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  reconnect?: boolean;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectFactor?: number;
  reconnectJitter?: number;
  maxPayloadBytes?: number;
  deviceIdentity?: GatewayDeviceIdentity;
  /** Operator scopes requested during the Gateway handshake. Defaults to read + write. */
  scopes?: string[];
}

export interface GatewayRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  cleanupAbort?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseError(value: unknown): GatewayErrorShape | undefined {
  if (!isRecord(value) || !nonEmptyString(value.code) || !nonEmptyString(value.message)) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    ...(value.details !== undefined ? { details: value.details } : {}),
    ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
    ...(typeof value.retryAfterMs === "number" ? { retryAfterMs: value.retryAfterMs } : {}),
  };
}

/** Parses only the transport envelope. Method-specific payloads remain opaque. */
export function parseGatewayFrame(raw: string): GatewayFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayProtocolError("Gateway sent invalid JSON");
  }
  if (!isRecord(value)) throw new GatewayProtocolError("Gateway frame must be an object");

  if (value.type === "req") {
    if (!nonEmptyString(value.id) || !nonEmptyString(value.method)) {
      throw new GatewayProtocolError("Malformed gateway request frame");
    }
    return {
      type: "req",
      id: value.id,
      method: value.method,
      ...(value.params !== undefined ? { params: value.params } : {}),
    };
  }

  if (value.type === "res") {
    if (!nonEmptyString(value.id) || typeof value.ok !== "boolean") {
      throw new GatewayProtocolError("Malformed gateway response frame");
    }
    const error = parseError(value.error);
    return {
      type: "res",
      id: value.id,
      ok: value.ok,
      ...(value.payload !== undefined ? { payload: value.payload } : {}),
      ...(error ? { error } : {}),
    };
  }

  if (value.type === "event") {
    if (!nonEmptyString(value.event)) throw new GatewayProtocolError("Malformed gateway event frame");
    return {
      type: "event",
      event: value.event,
      ...(value.payload !== undefined ? { payload: value.payload } : {}),
      ...(typeof value.seq === "number" ? { seq: value.seq } : {}),
      ...(value.stateVersion !== undefined ? { stateVersion: value.stateVersion } : {}),
    };
  }

  throw new GatewayProtocolError("Unknown gateway frame type");
}

export function encodeGatewayRequest(
  id: string,
  method: string,
  params?: unknown,
): string {
  if (!nonEmptyString(id) || !nonEmptyString(method)) {
    throw new GatewayProtocolError("Gateway request id and method are required");
  }
  return JSON.stringify({
    type: "req",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  } satisfies GatewayRequestFrame);
}

export function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  const normalize = (value?: string | null) => typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["v3", params.deviceId, params.clientId, params.clientMode, params.role, params.scopes.join(","), String(params.signedAtMs), params.token ?? "", params.nonce, normalize(params.platform), normalize(params.deviceFamily)].join("|");
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function buildGatewayDevice(params: {
  identity: GatewayDeviceIdentity;
  client: { id: string; mode: string; platform: string };
  role: string;
  scopes: string[];
  token: string;
  nonce: string;
}) {
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: params.identity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: signedAt,
    token: params.token,
    nonce: params.nonce,
    platform: params.client.platform,
  });
  return {
    id: params.identity.deviceId,
    publicKey: params.identity.publicKey,
    signature: base64Url(sign(null, Buffer.from(payload, "utf8"), createPrivateKey(params.identity.privateKeyPem))),
    signedAt,
    nonce: params.nonce,
  };
}

export class GatewayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayProtocolError";
  }
}

export class GatewayRequestError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error?: GatewayErrorShape) {
    super(error?.message ?? "Gateway request failed");
    this.name = "GatewayRequestError";
    this.code = error?.code ?? "UNAVAILABLE";
    this.details = error?.details;
    this.retryable = error?.retryable === true;
    this.retryAfterMs = error?.retryAfterMs;
  }
}

export class GatewayClient extends EventEmitter {
  private readonly options: Required<
    Pick<
      GatewayClientOptions,
      | "url"
      | "clientVersion"
      | "platform"
      | "requestTimeoutMs"
      | "handshakeTimeoutMs"
      | "reconnect"
      | "reconnectInitialDelayMs"
      | "reconnectMaxDelayMs"
      | "reconnectFactor"
      | "reconnectJitter"
      | "maxPayloadBytes"
      | "scopes"
    >
  > &
    GatewayClientOptions;
  private socket: WebSocket | undefined;
  private pending = new Map<string, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private connectRequestId: string | undefined;
  private connectionPromise: Promise<GatewayHello> | undefined;
  private resolveConnection: ((hello: GatewayHello) => void) | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private hello: GatewayHello | undefined;
  private stopped = true;
  private attempt = 0;
  private lastSeq: number | undefined;
  private state: GatewayConnectionState = "idle";

  constructor(options: GatewayClientOptions) {
    super();
    if (!nonEmptyString(options.token)) throw new TypeError("Gateway shared token is required");
    const scopes = options.scopes ?? ["operator.read", "operator.write"];
    if (!scopes.length || scopes.some((scope) => !nonEmptyString(scope))) throw new TypeError("At least one valid Gateway operator scope is required");
    this.options = {
      ...options,
      url: options.url ?? "ws://127.0.0.1:18789",
      clientVersion: options.clientVersion ?? "0.1.0",
      platform: options.platform ?? process.platform,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 15_000,
      reconnect: options.reconnect ?? true,
      reconnectInitialDelayMs: options.reconnectInitialDelayMs ?? 500,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 30_000,
      reconnectFactor: options.reconnectFactor ?? 2,
      reconnectJitter: options.reconnectJitter ?? 0.2,
      maxPayloadBytes: options.maxPayloadBytes ?? 25 * 1024 * 1024,
      scopes: [...new Set(scopes)],
    };
  }

  get connected(): boolean {
    return this.state === "connected" && this.socket?.readyState === WebSocket.OPEN;
  }

  get connectionState(): GatewayConnectionState {
    return this.state;
  }

  get serverHello(): GatewayHello | undefined {
    return this.hello;
  }

  start(): Promise<GatewayHello> {
    return this.connect();
  }

  connect(): Promise<GatewayHello> {
    if (this.connected && this.hello) return Promise.resolve(this.hello);
    if (this.connectionPromise) return this.connectionPromise;
    this.stopped = false;
    this.connectionPromise = new Promise<GatewayHello>((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });
    this.openSocket();
    return this.connectionPromise;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHandshakeTimer();
    this.rejectConnect(new Error("Gateway client stopped"));
    this.rejectPending(new Error("Gateway client stopped"));
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "client stopped");
    this.setStatus("stopped");
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: GatewayRequestOptions = {},
  ): Promise<T> {
    if (!nonEmptyString(method)) throw new TypeError("Gateway request method is required");
    if (!this.connected) await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Gateway is disconnected" });
    }

    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request aborted");
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayRequestError({ code: "TIMEOUT", message: `Gateway request timed out: ${method}` }));
      }, timeoutMs);
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      };
      if (options.signal) {
        const abort = () => {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(options.signal?.reason ?? new Error("Request aborted"));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        pending.cleanupAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      try {
        socket.send(encodeGatewayRequest(id, method, params));
      } catch (error) {
        clearTimeout(timeout);
        pending.cleanupAbort?.();
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private openSocket(): void {
    if (this.stopped) return;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.clearHandshakeTimer();
    this.connectRequestId = undefined;
    this.hello = undefined;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url, { maxPayload: this.options.maxPayloadBytes });
    } catch (error) {
      this.failAttempt(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.handshakeTimer = setTimeout(() => {
        const error = new GatewayProtocolError("Timed out waiting for connect.challenge");
        this.emitError(error);
        socket.close(1008, "connect challenge timeout");
      }, this.options.handshakeTimeoutMs);
    });
    socket.on("message", (data) => this.handleMessage(socket, data));
    socket.on("error", (error) => this.emitError(error));
    socket.on("close", (code, reason) => this.handleClose(socket, code, reason.toString("utf8")));
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    if (this.socket !== socket) return;
    let frame: GatewayFrame;
    try {
      frame = parseGatewayFrame(rawDataToString(data));
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (frame.type === "event") {
      if (frame.event === "connect.challenge" && !this.connectRequestId) {
        this.handleChallenge(socket, frame.payload);
        return;
      }
      if (typeof frame.seq === "number") {
        if (this.lastSeq !== undefined && frame.seq > this.lastSeq + 1) {
          this.emit("gap", { expected: this.lastSeq + 1, received: frame.seq });
        }
        this.lastSeq = frame.seq;
      }
      this.emit("event", frame);
      this.emit(frame.event, frame.payload, frame);
      return;
    }

    if (frame.type !== "res") return;
    if (frame.id === this.connectRequestId) {
      this.handleConnectResponse(socket, frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timeout);
    pending.cleanupAbort?.();
    if (frame.ok) pending.resolve(frame.payload);
    else pending.reject(new GatewayRequestError(frame.error));
  }

  private handleChallenge(socket: WebSocket, payload: unknown): void {
    if (!isRecord(payload) || !nonEmptyString(payload.nonce)) {
      const error = new GatewayProtocolError("Malformed connect.challenge event");
      this.emitError(error);
      socket.close(1008, "malformed challenge");
      return;
    }
    const id = randomUUID();
    this.connectRequestId = id;
    const client = {
      id: "gateway-client",
      version: this.options.clientVersion,
      platform: this.options.platform,
      mode: "backend",
    } as const;
    const role = "operator";
    const scopes = this.options.scopes;
    const device = this.options.deviceIdentity
      ? buildGatewayDevice({ identity: this.options.deviceIdentity, client, role, scopes, token: this.options.token, nonce: payload.nonce })
      : undefined;
    const params = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client,
      role,
      scopes,
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: this.options.token },
      ...(device ? { device } : {}),
      ...(this.options.locale ? { locale: this.options.locale } : {}),
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
    };
    socket.send(encodeGatewayRequest(id, "connect", params));
  }

  private handleConnectResponse(socket: WebSocket, frame: GatewayResponseFrame): void {
    this.clearHandshakeTimer();
    if (!frame.ok) {
      const error = new GatewayRequestError(frame.error);
      this.emitError(error);
      this.rejectConnect(error);
      socket.close(1008, "connect rejected");
      return;
    }
    let hello: GatewayHello;
    try {
      hello = parseHello(frame.payload);
    } catch (error) {
      const parsed = error instanceof Error ? error : new Error(String(error));
      this.emitError(parsed);
      this.rejectConnect(parsed);
      socket.close(1008, "invalid hello");
      return;
    }
    this.hello = hello;
    this.attempt = 0;
    this.lastSeq = undefined;
    this.setStatus("connected");
    this.resolveConnection?.(hello);
    this.clearConnectPromise();
    this.emit("connected", hello);
  }

  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clearHandshakeTimer();
    const wasConnected = this.state === "connected";
    this.rejectPending(new GatewayRequestError({ code: "UNAVAILABLE", message: "Gateway connection closed" }));
    if (!wasConnected) this.rejectConnect(new GatewayRequestError({ code: "UNAVAILABLE", message: reason || "Gateway connection closed" }));
    this.setStatus(this.stopped ? "stopped" : "disconnected");
    this.emit("disconnected", { code, reason, wasConnected });
    if (!this.stopped && this.options.reconnect) this.scheduleReconnect();
  }

  private failAttempt(error: Error): void {
    this.emitError(error);
    this.rejectConnect(error);
    this.setStatus("disconnected", undefined, error.message);
    if (!this.stopped && this.options.reconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const base = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectInitialDelayMs * this.options.reconnectFactor ** this.attempt,
    );
    const spread = base * Math.max(0, this.options.reconnectJitter);
    const delay = Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
    this.attempt += 1;
    this.setStatus("reconnecting", delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private setStatus(state: GatewayConnectionState, retryInMs?: number, error?: string): void {
    this.state = state;
    this.emit("status", {
      state,
      connected: state === "connected",
      attempt: this.attempt,
      ...(retryInMs !== undefined ? { retryInMs } : {}),
      ...(error ? { error } : {}),
    } satisfies GatewayConnectionStatus);
  }

  private emitError(error: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectConnect(error: Error): void {
    this.rejectConnection?.(error);
    this.clearConnectPromise();
  }

  private clearConnectPromise(): void {
    this.connectionPromise = undefined;
    this.resolveConnection = undefined;
    this.rejectConnection = undefined;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.concat(data).toString("utf8");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function parseHello(value: unknown): GatewayHello {
  if (!isRecord(value) || value.type !== "hello-ok" || value.protocol !== GATEWAY_PROTOCOL_VERSION) {
    throw new GatewayProtocolError("Gateway negotiated an unsupported protocol");
  }
  const server = value.server;
  const features = value.features;
  const auth = value.auth;
  const policy = value.policy;
  if (
    !isRecord(server) ||
    !nonEmptyString(server.version) ||
    !nonEmptyString(server.connId) ||
    !isRecord(features) ||
    !stringArray(features.methods) ||
    !stringArray(features.events) ||
    !isRecord(auth) ||
    !nonEmptyString(auth.role) ||
    !stringArray(auth.scopes) ||
    !isRecord(policy) ||
    typeof policy.maxPayload !== "number" ||
    typeof policy.maxBufferedBytes !== "number" ||
    typeof policy.tickIntervalMs !== "number"
  ) {
    throw new GatewayProtocolError("Malformed hello-ok payload");
  }
  return {
    type: "hello-ok",
    protocol: value.protocol,
    server: { version: server.version, connId: server.connId },
    features: {
      methods: features.methods,
      events: features.events,
      ...(stringArray(features.capabilities) ? { capabilities: features.capabilities } : {}),
    },
    auth: { role: auth.role, scopes: auth.scopes, ...(nonEmptyString(auth.deviceToken) ? { deviceToken: auth.deviceToken } : {}) },
    policy: {
      maxPayload: policy.maxPayload,
      maxBufferedBytes: policy.maxBufferedBytes,
      tickIntervalMs: policy.tickIntervalMs,
    },
    snapshot: value.snapshot,
  };
}
