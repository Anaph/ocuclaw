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
