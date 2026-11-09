import { isQuestion, isSnapshot, randomId } from "./protocol";
import type { Snapshot } from "./model";
interface Timing {
  handshake: number;
  request: number;
  heartbeat: number;
  idle: number;
  reconnect: number;
}
const DEFAULT_TIMING: Timing = {
  handshake: 10000,
  request: 70000,
  heartbeat: 15000,
  idle: 35000,
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
      acceptStatus: boolean;
    }
  >();
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private handshake?: ReturnType<typeof setTimeout>;
  private checkSocket?: () => void;
  private generation = 0;
  private url = "";
  private token = "";
  private closed = true;
  private terminal = false;
  private socketReady = false;
  private subscription: Promise<void> | null = null;
  private snapshot: Snapshot | null = null;
  private snapshotEpoch = 0;
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
  private retire(
    generation: number,
    socket: WebSocket,
    {
      code,
      message,
      terminal = false,
    }: {
      code?: number;
      message?: string;
      terminal?: boolean;
    } = {},
  ) {
    if (!this.active(generation, socket)) return;
    this.socket = null;
    this.socketReady = false;
    this.checkSocket = undefined;
    this.clearTimers();
    this.terminal = terminal || code === 4001 || code === 1008;
    this.rejectPending("Соединение потеряно; проверьте результат операции");
    this.state(false);
    const notice =
      code === 4001
        ? "Ключ подключения отклонён"
        : code === 1008
          ? "Сервер отклонил протокол подключения"
          : message;
    if (notice) this.emitError(notice);
    if (generation === this.generation && !this.closed && !this.terminal)
      this.reconnect = setTimeout(() => this.open(), this.timing.reconnect);
    // Some hosts never deliver the close event after losing the network.
    if (socket.readyState < 2) socket.close();
  }
  resume() {
    this.checkSocket?.();
    if (this.closed || this.terminal || this.socket) return;
    clearTimeout(this.reconnect);
    this.open();
  }
  private open() {
    if (this.closed || this.terminal || this.socket) return;
    const generation = ++this.generation;
    const url = new URL(this.url);
    url.searchParams.set("token", this.token);
    const socket = (this.socket = this.createSocket(url.toString()));
    this.socketReady = false;
    this.subscription = null;
    const stop = (message: string, terminal = false) =>
      this.retire(generation, socket, { message, terminal });
    let lastFrame = Date.now(),
      lastFrameMonotonic = performance.now();
    const checkSocket = () => {
      if (
        this.socketReady &&
        (socket.readyState !== 1 ||
          Date.now() - lastFrame >= this.timing.idle ||
          performance.now() - lastFrameMonotonic >= this.timing.idle)
      )
        stop("Соединение потеряно");
    };
    this.checkSocket = checkSocket;
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
      if (!frame || typeof frame.type !== "string") return;
      lastFrame = Date.now();
      lastFrameMonotonic = performance.now();
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
          checkSocket();
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
        if (!isSnapshot(frame.data)) {
          stop("Некорректный снимок Входящих");
          return;
        }
        void this.applySnapshot(frame.data, generation, socket).catch(
          (error) => {
            if (this.active(generation, socket)) stop(error.message);
          },
        );
      }
      if (frame.type === "ocuclaw.workspace.unavailable" && this.snapshot) {
        this.snapshotEpoch++;
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
        else if (
          frame.data?.error &&
          !(p.acceptStatus && typeof frame.data.status === "string")
        )
          p.reject(Error(String(frame.data.error)));
        else p.resolve(frame.data);
      }
    };
    socket.onclose = (event) =>
      this.retire(generation, socket, { code: event.code });
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
        await this.fetchSnapshot("inbox.subscribe", generation, socket);
      } catch (error) {
        if (!this.active(generation, socket)) return;
        const message = (error as Error).message;
        this.retire(generation, socket, {
          message,
          terminal: this.terminal || message === "unsupported_operation",
        });
      }
    })();
    this.subscription = work;
    void work.finally(() => {
      if (this.subscription === work) this.subscription = null;
    });
    return work;
  }
  async refreshInbox() {
    const socket = this.socket;
    if (!this.online || !socket) throw Error("Workspace не подключён");
    await this.fetchSnapshot("inbox.snapshot", this.generation, socket);
  }
  private async fetchSnapshot(
    method: "inbox.snapshot" | "inbox.subscribe",
    generation: number,
    socket: WebSocket,
  ) {
    const epoch = this.snapshotEpoch;
    const prior = this.snapshot;
    const snapshot = await this.send(method, {});
    if (
      !this.active(generation, socket) ||
      epoch !== this.snapshotEpoch ||
      prior !== this.snapshot
    )
      return;
    if (method === "inbox.subscribe" && !isSnapshot(snapshot)) {
      this.terminal = true;
      throw Error("Некорректный снимок Входящих");
    }
    await this.applySnapshot(snapshot, generation, socket);
  }
  private updateSnapshotScope(namespaces: Snapshot["authorizedNamespaces"]) {
    const previous = this.snapshot;
    if (
      !previous ||
      !Array.isArray(namespaces) ||
      JSON.stringify(previous.authorizedNamespaces) === JSON.stringify(namespaces)
    )
      return;
    const admitted = (key: string) => namespaces.includes(key.split(":")[1]);
    this.snapshot = {
      ...previous,
      authorizedNamespaces: namespaces,
      available: false,
      pending: previous.pending.filter((item) => admitted(item.sessionKey)),
      completed: previous.completed.filter((item) => admitted(item.sessionKey)),
      completedTotal: undefined,
      unreadCompleted: undefined,
    };
    this.emitSnapshot(this.snapshot);
  }
  private async applySnapshot(
    raw: unknown,
    generation: number,
    socket: WebSocket,
  ) {
    if (!this.active(generation, socket)) return;
    if (!isSnapshot(raw)) throw Error("Некорректный снимок Входящих");
    const epoch = ++this.snapshotEpoch;
    const current = () =>
      epoch === this.snapshotEpoch && this.active(generation, socket);
    this.updateSnapshotScope(raw.authorizedNamespaces);
    const pending = new Map(raw.pending.map((item) => [item.id, item]));
    let cursor = raw.pendingNextBefore;
    let namespaces = raw.authorizedNamespaces;
    let available = raw.available;
    while (cursor && available && current()) {
      const page = await this.send("inbox.pending", { before: cursor });
      if (!current()) return;
      if (!Array.isArray(page.pending) || !page.pending.every(isQuestion))
        throw Error("Некорректная страница Входящих");
      if (Array.isArray(page.authorizedNamespaces)) {
        const allowed: string[] = page.authorizedNamespaces;
        namespaces =
          namespaces?.filter((ns) => allowed.includes(ns)) ?? allowed;
        this.updateSnapshotScope(namespaces);
      }
      available = page.available === true;
      for (const item of page.pending) pending.set(item.id, item);
      const next = page.pendingNextBefore;
      if (next && JSON.stringify(next) === JSON.stringify(cursor))
        throw Error("Курсор Входящих не продвинулся");
      cursor = next;
    }
    if (!current()) return;
    const admitted = (key: string) =>
      namespaces?.includes(key.split(":")[1]) ?? true;
    const scopeChanged =
      JSON.stringify(namespaces) !== JSON.stringify(raw.authorizedNamespaces);
    this.snapshot = {
      ...raw,
      available,
      authorizedNamespaces: namespaces,
      pendingNextBefore: null,
      pending: [...pending.values()].filter((item) =>
        admitted(item.sessionKey),
      ),
      completed: raw.completed.filter((item) => admitted(item.sessionKey)),
      completedTotal: scopeChanged ? undefined : raw.completedTotal,
      unreadCompleted: scopeChanged ? undefined : raw.unreadCompleted,
    };
    this.state(true);
    this.emitSnapshot(this.snapshot);
  }
  request(
    method: string,
    params: Record<string, unknown> = {},
    options: { acceptStatus?: boolean } = {},
  ): Promise<any> {
    return this.online
      ? this.send(method, params, this.timing.request, options.acceptStatus)
      : Promise.reject(Error("Workspace не подключён"));
  }
  private send(
    method: string,
    params: Record<string, unknown>,
    timeout = this.timing.request,
    acceptStatus = false,
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
      this.pending.set(id, { resolve, reject, timer, acceptStatus });
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
    this.checkSocket = undefined;
    this.subscription = null;
    this.state(false);
    this.rejectPending("Отключено");
  }
}
