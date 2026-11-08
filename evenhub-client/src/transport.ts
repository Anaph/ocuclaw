import { isSnapshot, randomId } from "./protocol";
import type { Snapshot } from "./model";
interface Timing {
  handshake: number;
  request: number;
  heartbeat: number;
  reconnect: number;
}
const DEFAULT_TIMING: Timing = {
  handshake: 10000,
  request: 70000,
  heartbeat: 15000,
  reconnect: 3000,
};
export class Relay {
  socket: WebSocket | null = null;
  online = false;
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private handshake?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private url = "";
  private token = "";
  private closed = true;
  private terminal = false;
  private socketReady = false;
  private subscription: Promise<void> | null = null;
  private snapshot: Snapshot | null = null;
  private timing: Timing;
  capabilities: Record<string, any> = {};
  private observers = new Set<{
    snapshot?: (v: Snapshot) => void;
    state?: (v: boolean) => void;
    error?: (v: string) => void;
    chat?: (v: any) => void;
  }>();
  observe(observer: {
    snapshot?: (v: Snapshot) => void;
    state?: (v: boolean) => void;
    error?: (v: string) => void;
    chat?: (v: any) => void;
  }) {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }
  private emitSnapshot(value: Snapshot) {
    this.onSnapshot(value);
    for (const observer of this.observers) observer.snapshot?.(value);
  }
  private emitError(value: string) {
    this.onError(value);
    for (const observer of this.observers) observer.error?.(value);
  }
  onSnapshot: (value: Snapshot) => void = () => {};
  onState: (online: boolean) => void = () => {};
  onError: (message: string) => void = () => {};
  constructor(
    private createSocket: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
    timing: Partial<Timing> = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }
  connect(address: string, token: string) {
    const target = new URL(address);
    if (
      !["ws:", "wss:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      !token.trim()
    )
      throw Error("Нужны адрес ws:// или wss:// и ключ подключения");
    this.disconnect();
    this.closed = false;
    this.terminal = false;
    this.url = address;
    this.token = token;
    this.snapshot = null;
    this.open();
  }
  private active(generation: number, socket: WebSocket) {
    return (
      generation === this.generation && socket === this.socket && !this.closed
    );
  }
  private state(online: boolean) {
    if (this.online !== online) {
      this.online = online;
      this.onState(online);
      for (const observer of this.observers) observer.state?.(online);
    }
  }
  private clearTimers() {
    clearTimeout(this.handshake);
    clearInterval(this.heartbeat);
  }
  private rejectPending(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error(message));
    }
    this.pending.clear();
  }
  private open() {
    const generation = ++this.generation;
    const url = new URL(this.url);
    url.searchParams.set("token", this.token);
    const socket = (this.socket = this.createSocket(url.toString()));
    this.socketReady = false;
    this.subscription = null;
    const stop = (message: string, terminal = false) => {
      if (!this.active(generation, socket)) return;
      this.terminal = terminal;
      this.emitError(message);
      socket.close();
    };
    this.handshake = setTimeout(
      () => stop("Сервер не завершил подключение"),
      this.timing.handshake,
    );
    socket.onopen = () => {
      if (!this.active(generation, socket)) return;
      socket.send(
        JSON.stringify({
          type: "protocolHello",
          supportedProtocolVersions: ["v2"],
          clientName: "ocuclaw-inbox",
          clientVersion: "0.2.0",
          clientCapabilities: ["workspaceV1"],
        }),
      );
    };
    socket.onmessage = (event) => {
      if (!this.active(generation, socket)) return;
      let frame: any;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "protocolHelloAck" && !this.socketReady) {
        if (frame.protocolVersion !== "v2") {
          stop("Сервер не поддерживает протокол v2", true);
          return;
        }
        clearTimeout(this.handshake);
        this.socketReady = true;
        void this.subscribe(generation, socket, true);
        this.heartbeat = setInterval(() => {
          if (!this.active(generation, socket)) return;
          if (socket.readyState === 1) {
            try {
              socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
              void this.subscribe(generation, socket, false);
            } catch {
              stop("Соединение потеряно");
            }
          }
        }, this.timing.heartbeat);
      }
      if (
        frame.type === "ocuclaw.workspace.changed" &&
        this.online &&
        frame.version === 1
      ) {
        if (isSnapshot(frame.data)) {
          this.snapshot = frame.data;
          this.emitSnapshot(frame.data);
        } else stop("Некорректный снимок Входящих");
      }
      if (frame.type === "ocuclaw.workspace.unavailable" && this.snapshot) {
        this.snapshot = { ...this.snapshot, available: false };
        this.emitSnapshot(this.snapshot);
      }
      if (
        frame.type === "ocuclaw.workspace.chat" &&
        this.online &&
        frame.version === 1 &&
        frame.data &&
        typeof frame.data.sessionKey === "string"
      )
        for (const observer of this.observers) observer.chat?.(frame);
      if (frame.type === "error" && !this.online) {
        stop("Обновите сервер: Workspace v1 недоступен", true);
        return;
      }
      if (frame.type === "ocuclaw.workspace.result") {
        const p = this.pending.get(frame.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        if (frame.version !== 1)
          p.reject(Error("Неподдерживаемая версия Workspace"));
        else if (frame.data?.error) p.reject(Error(String(frame.data.error)));
        else p.resolve(frame.data);
      }
    };
    socket.onclose = (event) => {
      if (!this.active(generation, socket)) return;
      this.socketReady = false;
      this.clearTimers();
      this.state(false);
      this.rejectPending("Соединение потеряно; проверьте результат операции");
      if (event.code === 4001 || event.code === 1008) {
        this.terminal = true;
        this.emitError(
          event.code === 4001
            ? "Ключ подключения отклонён"
            : "Сервер отклонил протокол подключения",
        );
      }
      if (!this.terminal)
        this.reconnect = setTimeout(() => this.open(), this.timing.reconnect);
    };
    socket.onerror = () => {
      if (this.active(generation, socket)) socket.close();
    };
  }
  private subscribe(
    generation: number,
    socket: WebSocket,
    initial: boolean,
  ): Promise<void> {
    if (this.subscription) return this.subscription;
    const work = (async () => {
      try {
        if (initial) {
          const cap = await this.send(
            "capabilities",
            {},
            this.timing.handshake,
          );
          if (!this.active(generation, socket)) return;
          this.capabilities = cap || {};
          if (cap?.version !== 1) {
            this.terminal = true;
            throw Error("Сервер не поддерживает Workspace v1");
          }
        }
        if (!this.active(generation, socket)) return;
        const snapshot = await this.send("inbox.subscribe", {});
        if (!this.active(generation, socket)) return;
        if (!isSnapshot(snapshot)) {
          this.terminal = true;
          throw Error("Некорректный снимок Входящих");
        }
        this.snapshot = snapshot;
        this.state(true);
        this.emitSnapshot(snapshot);
      } catch (error) {
        if (!this.active(generation, socket)) return;
        this.state(false);
        this.emitError((error as Error).message);
        // A non-compatible server needs an explicit reconnect after update.
        if ((error as Error).message === "unsupported_operation")
          this.terminal = true;
        socket.close();
      }
    })();
    this.subscription = work;
    void work.finally(() => {
      if (this.subscription === work) this.subscription = null;
    });
    return work;
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.online
      ? this.send(method, params)
      : Promise.reject(Error("Workspace не подключён"));
  }
  private send(
    method: string,
    params: Record<string, unknown>,
    timeout = this.timing.request,
  ): Promise<any> {
    const socket = this.socket;
    if (!this.socketReady || !socket || socket.readyState !== 1)
      return Promise.reject(Error("Нет связи с VPS"));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Ответ сервера не получен; проверьте состояние"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(
          JSON.stringify({
            type: "ocuclaw.workspace.request",
            version: 1,
            id,
            method,
            params,
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Error("Не удалось отправить запрос"));
      }
    });
  }
  disconnect() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.reconnect);
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.socketReady = false;
    this.subscription = null;
    this.state(false);
    this.rejectPending("Отключено");
  }
}
