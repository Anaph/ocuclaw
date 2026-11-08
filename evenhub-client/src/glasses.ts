import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
  OsEventTypeList,
  AudioInputSource,
  StartUpPageCreateResult,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
} from "@evenrealities/even_hub_sdk";
export type Input = "up" | "down" | "select" | "back" | "menu";
export class Glasses {
  bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>> | null = null;
  private queue = Promise.resolve();
  private desired: HTMLCanvasElement | null = null;
  private pcm: Uint8Array[] = [];
  private bytes = 0;
  private recording = false;
  private off?: () => void;
  private stopping: Promise<Uint8Array> | null = null;
  constructor(private bridgeFactory = waitForEvenAppBridge) {}
  onInput: (v: Input) => void = () => {};
  onMenu: (id: number) => void = () => {};
  onLimit: () => void = () => {};
  onError: (v: string) => void = () => {};
  async init() {
    if (new URLSearchParams(location.search).get("preview") === "1")
      throw Error("preview_mode");
    const bridge = await this.bridgeFactory();
    const result = await bridge.createStartUpPageContainer(createPage());
    if (result !== StartUpPageCreateResult.success)
      throw Error("G2 отклонили страницу");
    this.bridge = bridge;
    this.off = bridge.onEvenHubEvent((event) => {
      if (event.menuItemClickEvent?.itemID) {
        this.onMenu(event.menuItemClickEvent.itemID);
        return;
      }
      if (event.audioEvent && this.recording) {
        const part = new Uint8Array(event.audioEvent.audioPcm);
        if (this.bytes + part.length > 560000) {
          this.onLimit();
          return;
        }
        this.pcm.push(part);
        this.bytes += part.length;
      }
      const input = event.textEvent ?? event.listEvent ?? event.sysEvent;
      if (!input) return;
      const type = input.eventType;
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) this.onInput("up");
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT)
        this.onInput("down");
      else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT)
        this.onInput("back");
      else if (type === OsEventTypeList.CLICK_EVENT || type === undefined)
        this.onInput("select");
    });
  }
  paint(canvas: HTMLCanvasElement) {
    this.desired = canvas;
    this.queue = this.queue
      .then(async () => {
        const next = this.desired;
        this.desired = null;
        if (!next || !this.bridge) return;
        for (let i = 0; i < 4; i++) {
          const tile = document.createElement("canvas");
          tile.width = 288;
          tile.height = 144;
          tile
            .getContext("2d")!
            .drawImage(
              next,
              (i % 2) * 288,
              Math.floor(i / 2) * 144,
              288,
              144,
              0,
              0,
              288,
              144,
            );
          const blob = await new Promise<Blob>((resolve, reject) =>
            tile.toBlob(
              (b) => (b ? resolve(b) : reject(Error("PNG encoding failed"))),
              "image/png",
            ),
          );
          const result = await this.bridge.updateImageRawData(
            new ImageRawDataUpdate({
              containerID: 10 + i,
              containerName: `tile${i}`,
              imageData: new Uint8Array(await blob.arrayBuffer()),
            }),
          );
          if (!ImageRawDataUpdateResult.isSuccess(result))
            throw Error("G2 не приняли изображение");
        }
      })
      .catch((e) => this.onError(String(e.message)));
  }
  async start() {
    if (!this.bridge) throw Error("Откройте клиент в Even Hub");
    if (this.stopping) await this.stopping;
    if (this.recording) throw Error("Запись уже идёт");
    this.pcm = [];
    this.bytes = 0;
    this.recording = true;
    try {
      if (!(await this.bridge.audioControl(true, AudioInputSource.Glasses)))
        throw Error("Микрофон недоступен. Откройте плагин заново.");
    } catch (error) {
      this.recording = false;
      this.pcm = [];
      this.bytes = 0;
      try {
        await this.bridge.audioControl(false);
      } catch {}
      throw error;
    }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    const work = (async () => {
      try {
        // Keep accepting tail PCM until the host acknowledges microphone stop.
        if (this.bridge && !(await this.bridge.audioControl(false)))
          throw Error(
            "Остановка микрофона не подтверждена. Откройте плагин заново.",
          );
        const result = new Uint8Array(this.bytes);
        let at = 0;
        for (const part of this.pcm) {
          result.set(part, at);
          at += part.length;
        }
        return result;
      } finally {
        this.recording = false;
        this.pcm = [];
        this.bytes = 0;
      }
    })();
    this.stopping = work;
    try {
      return await work;
    } finally {
      if (this.stopping === work) this.stopping = null;
    }
  }
  async dispose() {
    try {
      await this.stop();
    } finally {
      this.off?.();
    }
  }
}
export function wavBase64(pcm: Uint8Array) {
  const data = new Uint8Array(44 + pcm.length);
  const v = new DataView(data.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => (data[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, pcm.length, true);
  data.set(pcm, 44);
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function createPage() {
  const images = [0, 1, 2, 3].map(
    (i) =>
      new ImageContainerProperty({
        containerID: 10 + i,
        containerName: `tile${i}`,
        xPosition: (i % 2) * 288,
        yPosition: Math.floor(i / 2) * 144,
        width: 288,
        height: 144,
        zOrderIndex: i + 1,
      }),
  );
  return new CreateStartUpPageContainer({
    containerTotalNum: 5,
    textObject: [
      new TextContainerProperty({
        containerID: 1,
        containerName: "input",
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        content: "",
        isEventCapture: 1,
        zOrderIndex: 0,
      }),
    ],
    imageObject: images,
    menuObject: new MenuContainerProperty({
      menuItems: [
        new MenuItemProperty({ itemID: 101, itemName: "Inbox" }),
        new MenuItemProperty({ itemID: 102, itemName: "Sessions" }),
        new MenuItemProperty({ itemID: 103, itemName: "Actions" }),
      ],
    }),
  });
}
