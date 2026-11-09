import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  AudioInputSource,
  EventSourceType,
  List_ItemEvent,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
  validateEvenHubPageContainer,
} from "@evenrealities/even_hub_sdk";
import { Glasses, createPage, wavBase64 } from "./glasses";
import { gesture } from "./hud-input";
beforeEach(() => {
  Object.defineProperty(globalThis, "location", {
    value: { search: "" },
    configurable: true,
  });
});
test("production HUD meets SDK layout validation and tile bounds", () => {
  const page = createPage();
  assert.deepEqual(validateEvenHubPageContainer(page), { valid: true });
  assert.equal(page.imageObject?.length, 4);
  for (const tile of page.imageObject!) {
    assert(tile.width! <= 288 && tile.height! <= 144);
    assert(tile.xPosition! + tile.width! <= 576);
    assert(tile.yPosition! + tile.height! <= 288);
  }
});
test("ring gestures accept protobuf click defaults and ignore system lifecycle events", () => {
  const ring = EventSourceType.TOUCH_EVENT_FROM_RING;
  assert.equal(
    gesture({ sysEvent: new Sys_ItemEvent({ eventSource: ring }) }),
    "select",
  );
  assert.equal(
    gesture({
      sysEvent: new Sys_ItemEvent({
        eventSource: ring,
        eventType: OsEventTypeList.DOUBLE_CLICK_EVENT,
      }),
    }),
    "back",
  );
  assert.equal(
    gesture({
      textEvent: new Text_ItemEvent({
        eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT,
      }),
    }),
    "down",
  );
  assert.equal(gesture({ listEvent: new List_ItemEvent() }), "select");
  assert.equal(
    gesture({
      sysEvent: new Sys_ItemEvent({
        eventSource: ring,
        eventType: OsEventTypeList.LONG_PRESS_EVENT,
      }),
    }),
    undefined,
  );
  assert.equal(
    gesture({
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT,
      }),
    }),
    undefined,
  );
  assert.equal(gesture({ sysEvent: new Sys_ItemEvent() }), undefined);
});
test("captured bytes retain exact PCM and WAV rate/channel metadata", () => {
  const pcm = new Uint8Array([1, 2, 253, 254]);
  const wav = Buffer.from(wavBase64(pcm), "base64");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual([...wav.subarray(44)], [...pcm]);
});

test("microphone stop is shared and retains tail PCM until host acknowledgment", async () => {
  let emit: (event: any) => void = () => {},
    ack: (value: boolean) => void = () => {};
  let stops = 0;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    onEvenHubEvent: (cb: any) => {
      emit = cb;
      return () => {};
    },
    audioControl: async (open: boolean) => {
      if (open) return true;
      stops++;
      return await new Promise<boolean>((resolve) => (ack = resolve));
    },
  };
  const glasses = new Glasses(async () => bridge as any);
  await glasses.init();
  await glasses.start();
  emit({ audioEvent: { audioPcm: new Uint8Array([1, 2]) } });
  const first = glasses.stop(),
    second = glasses.stop();
  emit({ audioEvent: { audioPcm: new Uint8Array([3, 4]) } });
  ack(true);
  assert.deepEqual([...(await first)], [1, 2, 3, 4]);
  assert.deepEqual([...(await second)], [1, 2, 3, 4]);
  assert.equal(stops, 1);
});
test("failed microphone start disarms capture and attempts native cleanup", async () => {
  let stops = 0;
  let first = true;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    onEvenHubEvent: () => () => {},
    audioControl: async (open: boolean) => {
      if (open && first) {
        first = false;
        throw Error("native start failed");
      }
      if (!open) stops++;
      return true;
    },
  };
  const glasses = new Glasses(async () => bridge as any);
  await glasses.init();
  await assert.rejects(glasses.start(), /native start failed/);
  assert.equal(stops, 1);
  await glasses.start();
  await glasses.stop();
});

test("phone microphone remains available when G2 refuses its display page", async () => {
  const sources: any[] = [];
  const bridge = {
    createStartUpPageContainer: async () => 1,
    onEvenHubEvent: () => () => {},
    audioControl: async (open: boolean, source: any) => {
      if (open) sources.push(source);
      return true;
    },
  };
  const glasses = new Glasses(async () => bridge as any);
  await glasses.init();
  assert(!glasses.displayReady);
  assert(glasses.bridge);
  await glasses.start(AudioInputSource.Phone);
  await glasses.stop();
  assert.deepEqual(sources, [AudioInputSource.Phone]);
});
test("a late page acknowledgment cannot revive a disconnected G2 display", async () => {
  const connectPage: ((value: number) => void)[] = [];
  let deviceStatus: (status: { connectType: string }) => void = () => {};
  const bridge = {
    createStartUpPageContainer: () =>
      new Promise<number>((resolve) => connectPage.push(resolve)),
    onDeviceStatusChanged: (listener: typeof deviceStatus) => {
      deviceStatus = listener;
    },
    onEvenHubEvent: () => () => {},
  };
  const glasses = new Glasses(async () => bridge as any);
  const initialized = glasses.init();
  await Promise.resolve();
  deviceStatus({ connectType: "disconnected" });
  deviceStatus({ connectType: "connected" });
  assert.equal(connectPage.length, 2);
  connectPage[0](0);
  await initialized;
  assert.equal(glasses.displayReady, false);
  connectPage[1](0);
  await Promise.resolve();
  assert.equal(glasses.displayReady, true);
});

test("repeated status updates keep the live page and ring input pauses while G2 is absent", async () => {
  let builds = 0;
  let deviceStatus: (status: { connectType: string }) => void = () => {};
  let emit: (event: any) => void = () => {};
  const inputs: string[] = [];
  const menus: number[] = [];
  const bridge = {
    createStartUpPageContainer: async () => {
      builds++;
      return 0;
    },
    onDeviceStatusChanged: (listener: typeof deviceStatus) => {
      deviceStatus = listener;
    },
    onEvenHubEvent: (listener: typeof emit) => {
      emit = listener;
      return () => {};
    },
  };
  const glasses = new Glasses(async () => bridge as any);
  glasses.onInput = (input) => inputs.push(input);
  glasses.onMenu = (id) => menus.push(id);
  await glasses.init();
  deviceStatus({ connectType: "connected" });
  assert.equal(builds, 1);
  const ring = (type: OsEventTypeList) =>
    emit({
      sysEvent: new Sys_ItemEvent({
        eventSource: EventSourceType.TOUCH_EVENT_FROM_RING,
        eventType: type,
      }),
    });
  deviceStatus({ connectType: "disconnected" });
  ring(OsEventTypeList.SCROLL_BOTTOM_EVENT);
  ring(OsEventTypeList.DOUBLE_CLICK_EVENT);
  emit({ menuItemClickEvent: { itemID: 101 } });
  assert.deepEqual(inputs, []);
  assert.deepEqual(menus, []);
  deviceStatus({ connectType: "connected" });
  await Promise.resolve();
  ring(OsEventTypeList.SCROLL_BOTTOM_EVENT);
  ring(OsEventTypeList.DOUBLE_CLICK_EVENT);
  emit({ menuItemClickEvent: { itemID: 101 } });
  assert.deepEqual(inputs, ["down", "back"]);
  assert.deepEqual(menus, [101]);
  assert.equal(builds, 2);
});

test("a failed startup from an old G2 connection leaves the new display intact", async () => {
  let rejectOld: (error: Error) => void = () => {};
  let status: (status: { connectType: string }) => void = () => {};
  let first = true;
  const bridge = {
    createStartUpPageContainer: () => {
      if (!first) return Promise.resolve(0);
      first = false;
      return new Promise<number>((_, reject) => { rejectOld = reject; });
    },
    onDeviceStatusChanged: (listener: typeof status) => {
      status = listener;
    },
    onEvenHubEvent: () => () => {},
  };
  const glasses = new Glasses(async () => bridge as any);
  const initialized = glasses.init();
  await Promise.resolve();
  status({ connectType: "disconnected" });
  status({ connectType: "connected" });
  rejectOld(Error("old page failed"));
  await initialized;
  assert(glasses.displayReady);
});
