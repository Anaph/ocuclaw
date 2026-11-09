import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const local = args[0] === "--lan";
const addresses = local ? args.slice(1) : args;
if (!addresses.length) {
  console.error("Укажите адрес релея: npm run pack -- wss://<hermes-host>/");
  process.exit(1);
}

const whitelist = new Set();
for (const address of addresses) {
  let url;
  try {
    url = new URL(address);
  } catch {
    console.error("Нужен полный адрес WebSocket.");
    process.exit(1);
  }
  if (
    (url.protocol !== "wss:" && !(local && url.protocol === "ws:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    console.error(
      "Укажите wss:// без учётных данных, запроса или фрагмента. ws:// доступен только с --lan.",
    );
    process.exit(1);
  }
  const httpScheme = url.protocol === "wss:" ? "https" : "http";
  whitelist.add(`${httpScheme}://${url.host}`);
  whitelist.add(url.origin);
}

const manifest = JSON.parse(readFileSync("app.json", "utf8"));
manifest.permissions.find(({ name }) => name === "network").whitelist = [
  ...whitelist,
];

const directory = mkdtempSync(join(tmpdir(), "ocuclaw-pack-"));
try {
  const path = join(directory, "app.json");
  writeFileSync(path, JSON.stringify(manifest));
  const result = spawnSync(
    "evenhub",
    [
      "pack",
      path,
      "dist",
      "--sdk-ver",
      manifest.min_sdk_version,
      "-o",
      local ? "ocuclaw-inbox-qa.ehpk" : "ocuclaw-inbox.ehpk",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
