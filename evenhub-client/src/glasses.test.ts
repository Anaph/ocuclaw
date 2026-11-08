import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvenHubPageContainer } from "@evenrealities/even_hub_sdk";
import { createPage, wavBase64 } from "./glasses";
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
  Object.defineProperty(globalThis, "location", {
    value: { search: "" },
    configurable: true,
  });
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
  const { Glasses } = await import("./glasses");
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
  Object.defineProperty(globalThis, "location", {
    value: { search: "" },
    configurable: true,
  });
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
  const { Glasses } = await import("./glasses");
  const glasses = new Glasses(async () => bridge as any);
  await glasses.init();
  await assert.rejects(glasses.start(), /native start failed/);
  assert.equal(stops, 1);
  await glasses.start();
  await glasses.stop();
});
