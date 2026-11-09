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
export class ScheduleRejected extends Error {
  constructor(readonly code: string) {
    super(errorText(code));
  }
}
interface PendingSend {
  id: string;
  text: string;
  hadFiles: boolean;
  clearDraft?: boolean;
}
export interface SendAttempt {
  pending?: PendingSend;
}
export interface AnswerAttempt {
  operationId?: string;
}
const activeSends = new Set<string>();
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
  historyCursor: string | null = null;
  private selectedProfile = "default";
  options: ScheduleOptions | null = null;
  liveText = "";
  liveRun = "";
  liveSeq = -1;
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
    private storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    > = localStorage,
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
          const seq = typeof data.seq === "number" ? data.seq : 0;
          if (data.runId !== this.liveRun) {
            this.liveRun = data.runId;
            this.liveSeq = -1;
          }
          if (seq < this.liveSeq) return;
          this.liveSeq = seq;
          this.liveText = String(data.text ?? data.content ?? "");
          this.onChange();
        } else if (
          frame.event === "message" ||
          ["complete", "completed", "end", "error"].includes(data.phase)
        )
          void this.refreshChat().catch(() => {});
      },
    });
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
      refresh = ++this.refreshEpoch;
    const data = await this.request(renew ? "chat.subscribe" : "chat.history", {
      sessionKey: key,
      limit: 30,
    });
    if (epoch !== this.chatEpoch || refresh !== this.refreshEpoch) return;
    this.applyChatPage(data, false);
  }
  private applyChatPage(
    data: {
      messages?: Message[];
      hasMore?: boolean;
      nextBeforeId?: string | number | null;
      total?: number;
    },
    changed: boolean,
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
    if (
      changed ||
      (this.liveText &&
        this.messages.some(
          (x) =>
            x.role === "assistant" &&
            messageText(x.content).includes(this.liveText),
        ))
    ) {
      this.liveText = "";
      this.liveSeq = -1;
      if (changed) this.liveRun = "";
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
        const receipt = await this.checkSend(key, prior);
        if (
          attempt &&
          (receipt?.status === "accepted" || receipt?.status === "rejected")
        )
          attempt.pending = undefined;
        if (receipt?.status === "accepted") {
          if (prior.text !== text || prior.hadFiles !== Boolean(files.length))
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
        if (prior.text !== text || prior.hadFiles !== Boolean(files.length))
          throw Error(
            "Восстановите исходный текст и вложения перед повтором неподтверждённой отправки.",
          );
      }
      for (const file of files) uploads.push(await this.upload(file));
      const pending = prior ?? {
        id: randomId(),
        text,
        hadFiles: files.length > 0,
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
      this.applySendReceipt(key, pending, result);
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
  private sendKey(key: string) {
    return `ocuclaw.send:${encodeURIComponent(this.scope)}:${encodeURIComponent(key)}`;
  }
  pendingSend(key = this.chatKey): PendingSend | null {
    try {
      return JSON.parse(this.storage.getItem(this.sendKey(key)) || "null");
    } catch {
      return null;
    }
  }
  async checkSend(key = this.chatKey, pending = this.pendingSend(key)) {
    if (!pending) return null;
    const receipt = await this.outcome("workspace.send.receipt", {
      sessionKey: key,
      operationId: pending.id,
    });
    this.applySendReceipt(key, pending, receipt);
    return receipt;
  }
  private applySendReceipt(
    key: string,
    pending: PendingSend,
    receipt: { status?: string },
  ) {
    if (this.pendingSend(key)?.id !== pending.id) return;
    if (receipt.status === "accepted" || receipt.status === "rejected")
      this.storage.removeItem(this.sendKey(key));
    if (receipt.status === "accepted") {
      if (pending.clearDraft !== false && this.draft(key) === pending.text)
        this.saveDraft("", key);
      void this.refreshChat(key).catch(() => {});
    }
  }
  async checkAnswer(item: Question, attempt: AnswerAttempt) {
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
    return {
      operationId: this.answerReceipt(
        new ReceiptStore(sessionStorage, this.scope),
        item,
      )?.operationId,
    };
  }
  async answer(item: Question, answer: Answer, attempt: AnswerAttempt = {}) {
    const store = new ReceiptStore(sessionStorage, this.scope);
    const identity = { id: item.id, sessionKey: item.sessionKey };
    const pending = () => this.answerReceipt(store, item);
    const previous = pending();
    attempt.operationId ??= previous?.operationId;
    if (previous && previous.operationId !== attempt.operationId)
      return { status: "uncertain" };
    const current = await this.checkAnswer(item, attempt);
    if (current.status !== "pending") return current;
    if (pending()?.operationId !== previous?.operationId)
      return { status: "uncertain" };
    const operationId = (attempt.operationId ??= randomId());
    store.save({ ...identity, operationId });
    const result = await this.outcome("inbox.answer", {
      ...identity,
      operationId,
      answer,
    });
    if (terminalAnswers.has(result.status)) store.clear(operationId);
    return result;
  }
  async schedule(method: string, payload: Record<string, unknown> = {}) {
    const epoch = this.profileEpoch;
    const result = await this.request(method, {
      ...payload,
      profileId: this.profile,
    });
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
  private receiptKey() {
    return `ocuclaw.scheduleOperation:${encodeURIComponent(this.scope)}:${this.profile}`;
  }
  pendingSchedule(): ScheduleOperation | null {
    const saved = this.storage.getItem(this.receiptKey());
    try {
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }
  async mutateSchedule(
    operation: string,
    params: Record<string, unknown>,
    reserved?: (operationId: string) => void,
  ) {
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
