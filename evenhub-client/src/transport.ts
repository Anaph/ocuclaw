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
  private generation = 0;
  private url = "";
  private token = "";
  private closed = true;
  onSnapshot: (v: any) => void = () => {};
  onState: (v: boolean) => void = () => {};
  connect(url: string, token: string) {
    const target = new URL(url);
    if (
      !["ws:", "wss:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw Error("Нужен адрес ws:// или wss://");
    this.disconnect();
    this.closed = false;
    this.url = url;
    this.token = token;
    this.open();
  }
  private open() {
    const generation = ++this.generation;
    const url = new URL(this.url);
    url.searchParams.set("token", this.token);
    const socket = (this.socket = new WebSocket(url));
    let ready = false;
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "protocolHello",
          supportedProtocolVersions: ["v2"],
          clientName: "ocuclaw-inbox",
          clientVersion: "0.1.0",
          clientCapabilities: ["workspaceV1"],
        }),
      );
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      let frame: any;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "protocolHelloAck" && !ready) {
        ready = true;
        this.online = true;
        this.onState(true);
        void this.subscribe();
        this.heartbeat = setInterval(() => {
          if (this.online) {
            socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
            void this.subscribe();
          }
        }, 15000);
      }
      if (frame.type === "ocuclaw.workspace.changed")
        this.onSnapshot(frame.data);
      if (frame.type === "ocuclaw.workspace.unavailable") this.onState(false);
      if (frame.type === "ocuclaw.workspace.result") {
        const p = this.pending.get(frame.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(frame.id);
          frame.data?.error
            ? p.reject(Error(frame.data.error))
            : p.resolve(frame.data);
        }
      }
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.online = false;
      clearInterval(this.heartbeat);
      this.onState(false);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error("Соединение потеряно; проверьте результат операции"));
      }
      this.pending.clear();
      if (!this.closed) this.reconnect = setTimeout(() => this.open(), 3000);
    };
    socket.onerror = () => socket.close();
  }
  private async subscribe() {
    try {
      const cap = await this.request("capabilities");
      if (cap.version !== 1) throw Error("Сервер не поддерживает Workspace v1");
      this.onSnapshot(await this.request("inbox.subscribe"));
    } catch (e) {
      this.onState(false);
    }
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.online || !this.socket)
      return Promise.reject(Error("Нет связи с VPS"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("Ответ сервера не получен; проверьте состояние"));
      }, 70000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(
        JSON.stringify({
          type: "ocuclaw.workspace.request",
          version: 1,
          id,
          method,
          params,
        }),
      );
    });
  }
  disconnect() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
    this.online = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Отключено"));
    }
    this.pending.clear();
  }
}
