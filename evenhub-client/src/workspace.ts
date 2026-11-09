import { Relay } from "./transport";
import { endpointScope, randomId, ReceiptStore } from "./protocol";
import type { Answer, Question, Session, InboxModel } from "./model";
export interface Agent {
  id: string;
  name: string;
  model?: { primary: string };
}
export interface Model {
  id: string;
  provider: string;
  name?: string;
}
interface ChatStream {
  runId: string;
  seq?: number;
  text?: string;
  content?: string;
}
export interface Message {
  id?: string | number;
  role: string;
  content: unknown;
  createdAt?: number;
}
export interface Job {
  id: string;
  name: string;
  state: string;
  paused?: boolean;
  schedule: string;
  nextRunAt?: string;
  lastExecution?: Execution;
  lastStatus?: string;
  registration?: string;
  fields?: Record<string, unknown>;
  revision?: string;
}
export interface Execution {
  id: string;
  jobId: string;
  status: string;
  delivery?: string;
  needsAnswer?: boolean;
  stopRequested?: boolean;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  sessionKey?: string;
  reason?: string;
}
export interface ScheduleFields {
  name: string;
  prompt: string;
  schedule: string;
  model?: string;
  provider?: string;
  deliver?: string;
}
export interface ScheduleOptions {
  serverNowMs: number;
  serverLocalTime?: string;
  timezone: string;
  supported: boolean;
  reason?: string;
  missedPolicy: string;
  parallelPolicy: string;
  runNowPolicy: string;
  stopSupported: boolean;
}
interface ScheduleOperation {
  operationId: string;
  operation: string;
  params: Record<string, unknown>;
}
export type UnconfirmedOperation =
  | { kind: "message"; sessionKey: string; operationId: string }
  | { kind: "answer"; sessionKey: string; id: string; operationId: string }
  | { kind: "schedule"; profile: string; operationId: string };
export class ScheduleRejected extends Error {
  constructor(readonly code: string) {
    super(errorText(code));
  }
}
interface PendingSend {
  id: string;
  text: string;
  hadFiles: boolean;
  fileIds?: string[];
  clearDraft?: boolean;
}
export interface SendAttempt {
  pending?: PendingSend;
}
export interface AnswerAttempt {
  operationId?: string;
  answer?: Answer;
}
const activeSends = new Set<string>();
const fileIdentities = new WeakMap<File, string>();
function fileId(file: File) {
  let id = fileIdentities.get(file);
  if (!id) {
    id = randomId();
    fileIdentities.set(file, id);
  }
  return id;
}
const terminalAnswers = new Set([
  "accepted",
  "rejected",
  "already_answered",
  "expired",
  "not_found",
]);
export class Workspace {
  scope = "";
  generation = 0;
  agents: Agent[] = [];
  models: Model[] = [];
  sessions: Session[] = [];
  messages: Message[] = [];
  chatKey = "";
  nextBeforeId: string | number | null = null;
  hasMore = false;
  jobs: Job[] = [];
  history: Execution[] = [];
  historyCursor: string | { claimedAt: string; id: string } | null = null;
  private selectedProfile = "default";
  options: ScheduleOptions | null = null;
  liveText = "";
  liveRun = "";
  liveSeq = -1;
  private liveRevision = 0;
  private finishedRuns = new Set<string>();
  onChange = () => {};
  private chatEpoch = 0;
  private openingChat = "";
  private refreshEpoch = 0;
  private catalogProfile = "";
  private catalogEpoch = 0;
  private listEpoch = 0;
  private jobsEpoch = 0;
  private profileEpoch = 0;
  private namespaces: Set<string> | null = null;
  get profile() {
    return this.selectedProfile;
  }
  constructor(
    readonly relay: Relay,
    readonly inbox: InboxModel,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> &
      Partial<Pick<Storage, "length" | "key">> = localStorage,
  ) {
    relay.observe({
      snapshot: (snapshot) => {
        const allowed = snapshot.authorizedNamespaces;
        if (!Array.isArray(allowed)) return;
        this.namespaces = new Set(allowed);
        let removed = false;
        const oldSessions = this.sessions.length,
          oldAgents = this.agents.length;
        this.sessions = this.sessions.filter((row) =>
          this.canRead(row.key.split(":")[1]),
        );
        this.agents = this.agents.filter((row) => this.canRead(row.id));
        if (this.catalogProfile && !this.canRead(this.catalogProfile)) {
          this.catalogProfile = "";
          this.models = [];
          removed = true;
        }
        if (
          [this.chatKey, this.openingChat].some(
            (key) => key && !this.canRead(key.split(":")[1]),
          )
        ) {
          removed = true;
          this.clearChat();
        }
        if (!this.canRead(this.profile)) {
          removed ||= Boolean(
            this.jobs.length || this.history.length || this.options,
          );
          this.selectProfile("default", true);
        }
        if (
          removed ||
          oldSessions !== this.sessions.length ||
          oldAgents !== this.agents.length
        )
          this.onChange();
      },
      chat: (frame) => {
        const data = frame.data;
        if (data.sessionKey !== this.chatKey) return;
        if (frame.event === "streaming") {
          this.applyStream(data);
        } else if (
          frame.event === "message" ||
          ["complete", "completed", "end", "error"].includes(data.phase)
        ) {
          if (data.runId && frame.event !== "message")
            this.finishRun(data.runId);
          if (data.runId && data.runId === this.liveRun) {
            this.liveText = "";
            this.liveRevision++;
            this.onChange();
          }
          void this.refreshChat().catch(() => {});
        }
      },
    });
  }
  private finishRun(run: string) {
    this.finishedRuns.add(run);
    if (this.finishedRuns.size > 64)
      this.finishedRuns.delete(this.finishedRuns.values().next().value!);
  }
  private applyStream(data: ChatStream) {
    if (!data.runId || this.finishedRuns.has(data.runId)) return;
    if (data.runId !== this.liveRun) {
      if (this.liveRun) this.finishRun(this.liveRun);
      this.liveRun = data.runId;
      this.liveSeq = -1;
    }
    const seq = data.seq ?? 0;
    if (seq < this.liveSeq) return;
    this.liveSeq = seq;
    this.liveText = String(data.text ?? data.content ?? "");
    this.liveRevision++;
    this.onChange();
  }
  reset(address: string) {
    this.generation++;
    this.clearChat();
    this.scope = endpointScope(address);
    this.namespaces = null;
    this.agents = [];
    this.catalogProfile = "";
    this.catalogEpoch++;
    this.models = [];
    this.sessions = [];
    this.selectProfile("default", true);
  }
  async request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    options: { acceptStatus?: boolean } = {},
  ): Promise<T> {
    const generation = this.generation;
    const result = await this.relay.request(method, params, options);
    if (generation !== this.generation) throw Error("Подключение изменилось");
    return result;
  }
  async transcribe(wav: string, provider?: string) {
    if (!provider) {
      const listing = await this.request<{
        providers?: { id: string; available: boolean }[];
      }>("workspace.stt.providers");
      provider = listing.providers?.find((item) => item.available)?.id;
    }
    if (!provider) throw Error("В Hermes не настроено распознавание речи");
    const result = await this.request<{
      success: boolean;
      transcript?: string;
      error?: string;
    }>("workspace.stt.transcribe", { wav, provider, language: "ru" });
    const text = result.transcript?.trim();
    if (!result.success || !text)
      throw Error(result.error || "Речь не распознана. Повторите запись.");
    return text;
  }
  private outcome(method: string, params: Record<string, unknown>) {
    return this.request(method, params, { acceptStatus: true });
  }
  private draftKey(key: string) {
    return `ocuclaw.draft:${encodeURIComponent(this.scope)}:${encodeURIComponent(key)}`;
  }
  draft(key = this.chatKey) {
    return this.storage.getItem(this.draftKey(key)) || "";
  }
  saveDraft(text: string, key = this.chatKey) {
    if (key) this.storage.setItem(this.draftKey(key), text);
  }
  private canRead(namespace: string) {
    return (
      this.namespaces?.has(namespace === "default" ? "main" : namespace) ?? true
    );
  }
  async catalog(profileId = "default") {
    const epoch = ++this.catalogEpoch;
    const result = await this.request("workspace.catalog", { profileId });
    if (epoch !== this.catalogEpoch) return;
    this.agents = (result.agents || []).filter((agent: Agent) =>
      this.canRead(agent.id),
    );
    if (this.canRead(profileId)) {
      this.catalogProfile = profileId;
      this.models = result.models || [];
    }
    this.onChange();
  }
  async list(search = "", includeHidden = false) {
    const epoch = ++this.listEpoch;
    const result = await this.request("sessions.list", {
      search,
      includeHidden,
    });
    if (epoch !== this.listEpoch) return;
    this.sessions = (result.sessions || []).filter((session: Session) =>
      this.canRead(session.key.split(":")[1]),
    );
    this.onChange();
  }
  async create(profileId: string, model: string, provider: string) {
    const result = await this.request("sessions.create", {
      profileId,
      ...(model ? { model, provider } : {}),
    });
    await this.openChat(result.key);
    return result.key as string;
  }
  private clearChat() {
    this.chatEpoch++;
    this.openingChat = "";
    this.chatKey = "";
    this.messages = [];
    this.nextBeforeId = null;
    this.hasMore = false;
    this.liveText = "";
    this.liveRun = "";
    this.liveSeq = -1;
    this.liveRevision++;
    this.finishedRuns.clear();
  }
  async closeChat() {
    this.clearChat();
    this.onChange();
    if (this.relay.online) await this.request("chat.unsubscribe");
  }
  async openChat(key: string) {
    const epoch = ++this.chatEpoch;
    this.openingChat = key;
    try {
      const data = await this.request("chat.subscribe", {
        sessionKey: key,
        limit: 30,
      });
      if (epoch !== this.chatEpoch) return;
      const changed = this.chatKey !== key;
      this.chatKey = key;
      this.applyChatPage(data, changed);
    } finally {
      if (epoch === this.chatEpoch) this.openingChat = "";
    }
  }
  async refreshChat(key = this.chatKey, renew = false) {
    if (!key || key !== this.chatKey || this.openingChat) return;
    const epoch = this.chatEpoch,
      refresh = ++this.refreshEpoch,
      liveRevision = this.liveRevision;
    const data = await this.request(renew ? "chat.subscribe" : "chat.history", {
      sessionKey: key,
      limit: 30,
    });
    if (epoch !== this.chatEpoch || refresh !== this.refreshEpoch) return;
    this.applyChatPage(data, false, liveRevision === this.liveRevision);
  }
  private applyChatPage(
    data: {
      messages?: Message[];
      hasMore?: boolean;
      nextBeforeId?: string | number | null;
      total?: number;
      live?: ChatStream | null;
    },
    changed: boolean,
    applyLive = true,
  ) {
    const page = data.messages || [];
    const first = page[0]?.id;
    const overlap =
      changed || first == null
        ? -1
        : this.messages.findIndex((message) => message.id === first);
    if (overlap > 0) {
      this.messages = [...this.messages.slice(0, overlap), ...page];
    } else {
      this.messages = page;
      const hasMore = data.hasMore ?? (data.total ?? 0) > page.length;
      this.nextBeforeId = hasMore ? (data.nextBeforeId ?? first ?? null) : null;
      this.hasMore = this.nextBeforeId !== null;
    }
    if (changed) {
      this.liveText = "";
      this.liveRun = "";
      this.liveSeq = -1;
      this.finishedRuns.clear();
    }
    if (applyLive && data.live !== undefined) {
      if (data.live) this.applyStream(data.live);
      else this.liveText = "";
    }
    this.onChange();
  }
  async older() {
    if (!this.hasMore || this.nextBeforeId === null) return;
    const key = this.chatKey,
      epoch = this.chatEpoch,
      cursor = this.nextBeforeId;
    const data = await this.request("chat.history", {
      sessionKey: key,
      limit: 30,
      beforeId: cursor,
    });
    if (
      epoch !== this.chatEpoch ||
      key !== this.chatKey ||
      cursor !== this.nextBeforeId
    )
      return;
    const ids = new Set(this.messages.map((x) => x.id));
    this.messages = [
      ...(data.messages || []).filter(
        (x: Message) => x.id === undefined || !ids.has(x.id),
      ),
      ...this.messages,
    ];
    this.hasMore = data.hasMore === true;
    this.nextBeforeId = data.nextBeforeId ?? null;
    this.onChange();
  }
  async upload(file: File) {
    const generation = this.generation;
    const limits = this.relay.capabilities.uploads;
    if (!limits || file.size > limits.fileBytes || file.size === 0)
      throw Error("Файл превышает лимит сервера или пуст");
    const row = await this.request("uploads.begin", {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
    try {
      for (let offset = 0; offset < file.size; offset += row.chunkBytes) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + row.chunkBytes).arrayBuffer(),
        );
        if (generation !== this.generation)
          throw Error("Подключение изменилось");
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await this.request("uploads.chunk", {
          id: row.id,
          offset,
          content: btoa(binary),
        });
      }
      return row.id as string;
    } catch (error) {
      if (generation === this.generation)
        void this.request("uploads.cancel", { id: row.id }).catch(() => {});
      throw error;
    }
  }
  async send(
    text: string,
    files: File[],
    key = this.chatKey,
    attempt?: SendAttempt,
    currentFiles = () => files,
  ) {
    if (!key || (!text.trim() && !files.length))
      throw Error("Добавьте сообщение или вложение");
    const operationKey = this.sendKey(key);
    if (activeSends.has(operationKey))
      throw Error("Сообщение уже отправляется");
    activeSends.add(operationKey);
    const generation = this.generation;
    const uploads: string[] = [];
    try {
      const prior =
        this.pendingSend(key) ??
        (attempt?.pending?.text === text ? attempt.pending : undefined);
      if (prior) {
        const receipt = await this.checkSend(key, prior, currentFiles);
        if (
          attempt &&
          (receipt?.status === "accepted" || receipt?.status === "rejected")
        )
          attempt.pending = undefined;
        if (receipt?.status === "accepted") {
          if (!this.matchesSend(prior, text, files))
            throw Error(
              "Предыдущее сообщение принято. Отправьте новый черновик отдельно.",
            );
          return receipt;
        }
        if (receipt?.status === "rejected")
          throw Error(
            errorText(receipt.error || "Hermes отклонил предыдущую отправку"),
          );
        if (receipt?.status !== "not_found")
          throw Error(
            "Предыдущая отправка не подтверждена. Проверьте историю и квитанцию.",
          );
        if (!this.matchesSend(prior, text, files))
          throw Error(
            "Восстановите исходный текст и вложения перед повтором неподтверждённой отправки.",
          );
      }
      const fileIds = files.map(fileId);
      for (const file of files) uploads.push(await this.upload(file));
      const pending = prior ?? {
        id: randomId(),
        text,
        hadFiles: files.length > 0,
        ...(files.length ? { fileIds } : {}),
        clearDraft: this.chatKey === key,
      };
      if (attempt) attempt.pending = pending;
      this.storage.setItem(operationKey, JSON.stringify(pending));
      const result = await this.outcome("agent", {
        sessionKey: key,
        message: text,
        idempotencyKey: pending.id,
        uploadIds: uploads,
      });
      uploads.length = 0; // The relay consumed the staged files before dispatching.
      this.applySendReceipt(key, pending, result, currentFiles());
      if (
        attempt &&
        (result.status === "accepted" || result.status === "rejected")
      )
        attempt.pending = undefined;
      if (result.status !== "accepted")
        throw Error(
          errorText(
            result.error || result.status || "Отправка не подтверждена",
          ),
        );
      return result;
    } finally {
      activeSends.delete(operationKey);
      if (generation === this.generation)
        for (const id of uploads)
          void this.request("uploads.cancel", { id }).catch(() => {});
    }
  }
  private sendPrefix() {
    return `ocuclaw.send:${encodeURIComponent(this.scope)}:`;
  }
  private sendKey(key: string) {
    return this.sendPrefix() + encodeURIComponent(key);
  }
  pendingSend(key = this.chatKey): PendingSend | null {
    try {
      return JSON.parse(this.storage.getItem(this.sendKey(key)) || "null");
    } catch {
      return null;
    }
  }
  matchesSend(pending: PendingSend, text: string, files: File[]) {
    return (
      pending.text === text &&
      (pending.hadFiles
        ? pending.fileIds?.length === files.length &&
          pending.fileIds.every(
            (id, index) => fileIdentities.get(files[index]) === id,
          )
        : files.length === 0)
    );
  }
  async discardUnsent(key: string, operationId: string) {
    const storageKey = this.sendKey(key);
    if (activeSends.has(storageKey)) throw Error("Сообщение уже отправляется");
    activeSends.add(storageKey);
    try {
      const pending = this.pendingSend(key);
      if (pending?.id !== operationId) throw Error("Операция изменилась");
      const receipt = await this.checkSend(key, pending);
      if (
        receipt?.status !== "not_found" ||
        this.pendingSend(key)?.id !== operationId
      )
        throw Error("Hermes больше не подтверждает отсутствие операции");
      this.storage.removeItem(storageKey);
    } finally {
      activeSends.delete(storageKey);
    }
  }
  async checkSend(
    key = this.chatKey,
    pending = this.pendingSend(key),
    currentFiles = () => [] as File[],
  ) {
    if (!pending) return null;
    const receipt = await this.outcome("workspace.send.receipt", {
      sessionKey: key,
      operationId: pending.id,
    });
    this.applySendReceipt(key, pending, receipt, currentFiles());
    return receipt;
  }
  private applySendReceipt(
    key: string,
    pending: PendingSend,
    receipt: { status?: string },
    files: File[],
  ) {
    if (this.pendingSend(key)?.id !== pending.id) return;
    if (receipt.status === "accepted" || receipt.status === "rejected")
      this.storage.removeItem(this.sendKey(key));
    if (receipt.status === "accepted") {
      if (
        pending.clearDraft !== false &&
        this.matchesSend(pending, this.draft(key), files)
      )
        this.saveDraft("", key);
      void this.refreshChat(key).catch(() => {});
    }
  }
  async checkAnswer(
    item: Pick<Question, "id" | "sessionKey">,
    attempt: AnswerAttempt,
  ) {
    const store = new ReceiptStore(sessionStorage, this.scope);
    if (attempt.operationId) {
      const receipt = await this.outcome("inbox.operation", {
        operationId: attempt.operationId,
      });
      if (receipt.status !== "not_found") {
        if (terminalAnswers.has(receipt.status))
          store.clear(attempt.operationId);
        return receipt;
      }
    }
    const current = await this.request("inbox.get", {
      id: item.id,
      sessionKey: item.sessionKey,
    });
    if (attempt.operationId && terminalAnswers.has(current.status))
      store.clear(attempt.operationId);
    return current;
  }
  private answerReceipt(store: ReceiptStore, item: Question) {
    return store
      .list()
      .find(
        (entry) => entry.id === item.id && entry.sessionKey === item.sessionKey,
      );
  }
  answerAttempt(item: Question): AnswerAttempt {
    const pending = this.answerReceipt(
      new ReceiptStore(sessionStorage, this.scope),
      item,
    );
    return { operationId: pending?.operationId, answer: pending?.answer };
  }
  isPreviousAnswer(attempt: AnswerAttempt, answer: Answer) {
    return Boolean(
      attempt.operationId &&
        JSON.stringify(attempt.answer) !== JSON.stringify(answer),
    );
  }
  prepareAnswerRetry(attempt: AnswerAttempt, answer: Answer) {
    if (!this.isPreviousAnswer(attempt, answer)) return;
    new ReceiptStore(sessionStorage, this.scope).clear(attempt.operationId!);
    attempt.operationId = undefined;
    attempt.answer = undefined;
  }
  async answer(item: Question, answer: Answer, attempt: AnswerAttempt = {}) {
    const store = new ReceiptStore(sessionStorage, this.scope);
    const identity = { id: item.id, sessionKey: item.sessionKey };
    const pending = () => this.answerReceipt(store, item);
    const previous = pending();
    attempt.operationId ??= previous?.operationId;
    attempt.answer ??= previous?.answer;
    if (previous && previous.operationId !== attempt.operationId)
      return { status: "uncertain" };
    const current = await this.checkAnswer(item, attempt);
    if (current.status !== "pending") return current;
    if (pending()?.operationId !== previous?.operationId)
      return { status: "uncertain" };
    if (this.isPreviousAnswer(attempt, answer))
      throw Error("Проверьте предыдущий ответ перед отправкой другого");
    const operationId = (attempt.operationId ??= randomId());
    attempt.answer = answer;
    store.save({ ...identity, operationId, answer });
    const result = await this.outcome("inbox.answer", {
      ...identity,
      operationId,
      answer,
    });
    if (terminalAnswers.has(result.status)) store.clear(operationId);
    return result;
  }
  scheduleGuard() {
    const epoch = this.profileEpoch;
    return () => {
      if (epoch !== this.profileEpoch || !this.canRead(this.profile))
        throw Error("Профиль задачи изменился или больше недоступен");
    };
  }
  async schedule(method: string, payload: Record<string, unknown> = {}) {
    const epoch = this.profileEpoch;
    let result;
    try {
      result = await this.request(method, {
        ...payload,
        profileId: this.profile,
      });
    } catch (error) {
      if (error instanceof Error) throw Error(errorText(error.message));
      throw error;
    }
    if (epoch !== this.profileEpoch) throw Error("Профиль изменился");
    return result;
  }
  private selectProfile(profile: string, reset = false) {
    if (profile === this.profile && !reset) return;
    this.profileEpoch++;
    this.jobsEpoch++;
    this.selectedProfile = profile;
    this.jobs = [];
    this.history = [];
    this.historyCursor = null;
    this.options = null;
  }
  async loadJobs(profile = this.profile) {
    this.selectProfile(profile);
    const epoch = ++this.jobsEpoch;
    const options = await this.request("automations.options", {
      profileId: profile,
    });
    if (epoch !== this.jobsEpoch) return;
    const data = options.supported
      ? await this.request("jobs.list", { profileId: profile })
      : { jobs: [] };
    if (epoch !== this.jobsEpoch) return;
    this.options = options;
    this.jobs = data.jobs || [];
    this.onChange();
    if (this.catalogProfile !== profile) await this.catalog(profile);
  }
  private schedulePrefix() {
    return `ocuclaw.scheduleOperation:${encodeURIComponent(this.scope)}:`;
  }
  private receiptKey(profile = this.profile) {
    return this.schedulePrefix() + profile;
  }
  pendingSchedule(profile = this.profile): ScheduleOperation | null {
    const saved = this.storage.getItem(this.receiptKey(profile));
    try {
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }
  unconfirmed(): UnconfirmedOperation[] {
    if (!this.scope) return [];
    const items: UnconfirmedOperation[] = new ReceiptStore(
      sessionStorage,
      this.scope,
    )
      .list()
      .filter((entry) => this.canRead(entry.sessionKey.split(":")[1]))
      .map((entry) => ({ ...entry, kind: "answer" }));
    const sends = this.sendPrefix();
    const schedules = this.schedulePrefix();
    for (let i = 0; i < (this.storage.length ?? 0); i++) {
      const key = this.storage.key?.(i);
      if (!key) continue;
      if (key.startsWith(sends)) {
        let sessionKey: string;
        try {
          sessionKey = decodeURIComponent(key.slice(sends.length));
        } catch {
          continue;
        }
        const pending = this.pendingSend(sessionKey);
        if (pending?.id && this.canRead(sessionKey.split(":")[1]))
          items.push({ kind: "message", sessionKey, operationId: pending.id });
      } else if (key.startsWith(schedules)) {
        const profile = key.slice(schedules.length);
        const pending = this.pendingSchedule(profile);
        if (pending?.operationId && this.canRead(profile))
          items.push({
            kind: "schedule",
            profile,
            operationId: pending.operationId,
          });
      }
    }
    return items;
  }
  async mutateSchedule(
    operation: string,
    params: Record<string, unknown>,
    reserved?: (operationId: string) => void,
  ) {
    this.scheduleGuard()();
    const key = this.receiptKey(),
      profileId = this.profile;
    if (this.storage.getItem(key))
      throw Error("Сначала проверьте предыдущую операцию расписания");
    const operationId = randomId();
    const saved = JSON.stringify({ operationId, operation, params });
    this.storage.setItem(key, saved);
    reserved?.(operationId);
    return this.submitSchedule(key, saved, profileId);
  }
  private async submitSchedule(key: string, saved: string, profileId: string) {
    const { operation, operationId, params } = JSON.parse(saved);
    const result = await this.outcome(operation, {
      ...params,
      operationId,
      profileId,
    });
    this.applyScheduleReceipt(key, saved, result);
    if (result.status === "rejected")
      throw new ScheduleRejected(result.error || "Hermes отклонил изменение");
    if (result.status === "uncertain" || !result.status)
      throw Error("Результат неизвестен. Проверьте операцию перед повтором.");
    return result;
  }
  private applyScheduleReceipt(
    key: string,
    saved: string,
    result: { status?: string },
  ) {
    if (
      result.status &&
      !["uncertain", "not_found"].includes(result.status) &&
      this.storage.getItem(key) === saved
    )
      this.storage.removeItem(key);
  }
  async retrySchedule(
    expectedOperationId = this.pendingSchedule()?.operationId,
  ) {
    const key = this.receiptKey(),
      profileId = this.profile,
      epoch = this.profileEpoch;
    const saved = this.storage.getItem(key);
    if (!saved || JSON.parse(saved).operationId !== expectedOperationId)
      throw Error("Операция изменилась. Проверьте её состояние заново.");
    const receipt = await this.outcome("automations.receipt", {
      operationId: expectedOperationId,
      profileId,
    });
    this.applyScheduleReceipt(key, saved, receipt);
    if (receipt.status !== "not_found") return receipt;
    if (epoch !== this.profileEpoch || this.storage.getItem(key) !== saved)
      throw Error("Операция или профиль изменились. Повтор не отправлен.");
    return this.submitSchedule(key, saved, profileId);
  }
  async reconcileSchedule(operationId = this.pendingSchedule()?.operationId) {
    const key = this.receiptKey(),
      profileId = this.profile;
    const saved = this.storage.getItem(key);
    if (!operationId) return null;
    const result = await this.outcome("automations.receipt", {
      operationId,
      profileId,
    });
    if (saved && JSON.parse(saved).operationId === operationId)
      this.applyScheduleReceipt(key, saved, result);
    return result;
  }
}
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((x) =>
        typeof x?.text === "string"
          ? x.text
          : x?.type === "image_url"
            ? "[Изображение]"
            : "",
      )
      .filter(Boolean)
      .join("\n");
  return "";
}
export function statusText(status: string) {
  return (
    (
      {
        accepted: "Принято",
        rejected: "Hermes отклонил операцию",
        saved: "Сохранено",
        applied: "Выполнено",
        deleted: "Удалено",
        stop_requested: "Остановка запрошена",
        scheduled: "По расписанию",
        running: "Работает",
        claimed: "Запуск принят",
        completed: "Готово",
        failed: "Ошибка",
        error: "Ошибка",
        paused: "На паузе",
        unknown: "Нет подтверждения",
        delivered: "Доставлено",
        not_configured: "Сохранено в Hermes",
        queued: "В очереди доставки",
        suppressed: "Доставка отключена",
        expired: "Срок вопроса истёк",
        already_answered: "Ответ уже дан",
        not_found: "Запрос не найден",
        source_unavailable: "Hermes недоступен",
        uncertain: "Отправка не подтверждена",
      } as Record<string, string>
    )[status] || status
  );
}
export function scheduleExpression(
  kind: string,
  date: string,
  time: string,
  days: string[],
  interval: string,
  cron: string,
) {
  if (kind === "once") return `${date}T${time}:00`;
  if (kind === "interval") return `every ${interval}`;
  if (kind === "cron") return cron.trim();
  const [hours, minutes] = time.split(":").map(Number);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours > 23 ||
    minutes > 59
  )
    throw Error("Укажите время");
  if (kind === "weekly" && !days.length) throw Error("Выберите дни недели");
  return `${minutes} ${hours} * * ${kind === "weekly" ? days.join(",") : "*"}`;
}

export function errorText(code: string): string {
  return (
    (
      {
        stale_edit:
          "Задача изменилась в другом интерфейсе. Откройте её заново.",
        preview_expired: "Проверка расписания устарела. Проверьте его ещё раз.",
        job_not_found: "Задача больше не существует",
        resume_before_run: "Сначала возобновите задачу на паузе",
        execution_not_running: "Этот запуск уже завершился",
        invalid_fields: "Проверьте название, инструкцию и расписание",
        schedule_has_no_future_run: "Расписание не содержит будущих запусков",
        hermes_workspace_api_unavailable:
          "На сервере недоступен публичный Workspace API Hermes",
        native_job_lock_unavailable:
          "Хранилище Hermes занято. Обновите состояние перед повтором",
      } as Record<string, string>
    )[code] || code
  );
}
export interface ScheduleForm {
  kind: string;
  date: string;
  time: string;
  days: string[];
  interval: string;
  cron: string;
}
export function scheduleForm(expression: string): ScheduleForm {
  const form = {
    kind: "cron",
    date: "",
    time: "09:00",
    days: [] as string[],
    interval: "2h",
    cron: expression,
  };
  const interval = /^every (\d+[mhd])$/.exec(expression);
  const once = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(?::00)?$/.exec(expression);
  const simple = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*|\*)$/.exec(
    expression,
  );
  if (interval) {
    form.kind = "interval";
    form.interval = interval[1];
  } else if (once) {
    form.kind = "once";
    form.date = once[1];
    form.time = once[2];
  } else if (simple) {
    form.kind = simple[3] === "*" ? "daily" : "weekly";
    form.time = simple[2].padStart(2, "0") + ":" + simple[1].padStart(2, "0");
    form.days = simple[3] === "*" ? [] : simple[3].split(",");
  }
  return form;
}
export function serializeSchedule(form: ScheduleForm, original?: string) {
  const encode = ({ kind, date, time, days, interval, cron }: ScheduleForm) =>
    scheduleExpression(kind, date, time, [...days].sort(), interval, cron);
  const expression = encode(form);
  return original && expression === encode(scheduleForm(original))
    ? original
    : expression;
}
