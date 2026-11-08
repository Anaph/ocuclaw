import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/cyrillic-400.css";
import "./style.css";
import { Relay } from "./transport";
import { Glasses } from "./glasses";
import { InboxModel } from "./model";
import { mountHud } from "./hud";
import { PhoneApp } from "./phone";
const root = document.querySelector<HTMLElement>("#app")!;
const relay = new Relay(),
  glasses = new Glasses(),
  model = new InboxModel();
const hudRoot = document.createElement("section");
hudRoot.id = "hud-panel";
const legacy = new URLSearchParams(location.search).get("hud") === "1";
if (!legacy) hudRoot.hidden = true;
root.append(hudRoot);
const hud = mountHud(relay, glasses, model, hudRoot);
if (!legacy) {
  const phoneRoot = document.createElement("section");
  root.prepend(phoneRoot);
  new PhoneApp(phoneRoot, relay, glasses, model, hud, hudRoot);
}
