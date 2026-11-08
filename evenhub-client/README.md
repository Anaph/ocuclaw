# OcuClaw Inbox — Even Hub client

A separate stock-firmware G2 application for the Hermes OcuClaw server. It does not
replace the installed OcuClaw phone app or change the relay's selected session.
Inbox / Done / Sessions, explicit confirmation, multiple choice, typed replies,
microphone dictation, history pagination and supported session actions are included.

## Local development

Use Node 22.13+ (or a newer supported Node) and Python 3.9+.

```sh
npm ci
npm test
npm run build
npm run dev
```

Open the Vite URL on the phone from Even Hub's developer QR preview. The phone and
computer must reach that development server. Open `http://localhost:5173/?preview=1` for a browser preview with a 576×288 HUD
and input buttons; the native microphone/display require Even Hub.

The connection form takes the existing relay WebSocket address and credential.
Prefer the HTTPS/WSS Tailscale endpoint configured for OcuClaw. The token stays in
memory, not localStorage. Reconnect works while the runtime survives; a destroyed
WebView needs a new connection. UI locations and uncertain-operation receipts are scoped to the relay endpoint. Explicitly switching servers clears cached rows and drafts. UI locations survive without saving message drafts
or credentials. Results and answer receipts remain on the server. A ws:// LAN URL
is useful for tests; Android cleartext/mixed-content policies may reject it.

SDK 0.0.16 and CLI 0.2.0 are pinned. Minimum Even App version is 2.3.2.
The CLI language enum lacks `ru`, so the catalogue language is `en`; the UI itself
is Russian. Noto Sans is packaged under the included OFL. Four serial 288×144 PNG
tiles preserve Cyrillic independently of firmware fonts. Contextual menu labels
use ASCII (Inbox / Sessions / Actions), since those labels use the OS font.

## Package and browser acceptance

```sh
npm run pack
npx playwright install chromium
npm run test:e2e
```

`ocuclaw-inbox.ehpk` is a private-build artifact; packaging does not publish it.
Browser tests simulate a relay with three sessions. They check confirmation,
addressed single/multiple answers, text input, answers from another interface and
mobile layout. Screenshots land in `test-results/`.

## Server prerequisite

The server must run this plugin branch. Workspace v1 is opt-in over protocol v2.
Legacy clients continue using existing frames.

Hermes may lack public enumeration of all gateway questions/permissions. Coverage
is reported as `allGatewayQuestions` and `permissions`. Without the extension the
server only enumerates questions delivered through OcuClaw and its approval mirror.

PREPARE, without installing, extensions for the exact candidate Hermes source:

```sh
python3 scripts/prepare_hermes_inbox_source.py /candidate/hermes/tools/clarify_gateway.py --output /tmp/clarify_gateway.py
python3 scripts/prepare_hermes_inbox_source.py /candidate/hermes/tools/approval.py --output /tmp/approval.py
```

Run those commands from the repository root. The tool refuses unsupported source,
checks Python syntax, leaves input untouched and prints input/output SHA-256.
The public list functions live inside the owning Hermes modules. The plugin does
not read private registries. Native approval resolution must accept a request id;
there is no fallback to resolving an unrelated FIFO entry.

Deployment must pin the tested Hermes revision and install reviewed files alongside
the plugin. This has NOT been done on the user's VPS.

Desktop sessions expose only operations the native controller supports. The current
bridge cannot rename, stop or continue a Desktop-owned conversation from this
client. Its questions are independently answerable. The UI explains unavailable
actions rather than adopting the Desktop session.

## Acceptance boundary

Local tests and packaging are not proof of physical display/microphone behavior.
VPS, Android and G2 acceptance/deployment are the final step, as requested. Verify:
Desktop and OcuClaw share the SAME gateway process (sharing a database is not
sufficient); native API version/shapes and profile admission; Desktop finalizer
callbacks; STT provider; Tailscale; locked-phone behavior; four-tile throughput;
ring/touch input and Cyrillic. Native source preparation remains an integration
candidate until these checks pass.

Dictation is limited to 17 seconds / 560,000 PCM bytes to stay below the existing
control-link cap after WAV/base64 encoding. Longer replies can be typed. STT uses
an existing configured Hermes provider and never installs a model. Delivery while
the plugin is closed is not included. Results are paginated in pages of 100 with a global unread count; storage prunes at seven days. No pending question is resurrected from disk.

## Connection and admission guarantees

The client becomes ready only after protocol-v2 / Workspace-v1 negotiation and a
validated initial snapshot. Invalid credentials stop reconnect attempts until an
explicit new connection. A native question-source outage does not pretend the
WebSocket disconnected, and does not discard uncertain answer receipts.

Persisted results and unread counts are filtered by the currently admitted profile
namespaces on every read. The 0.1.0 SQLite store is migrated in place with its read
receipts preserved. Cached client rows from a revoked profile are also removed,
including during a question-source outage. Result pages are bounded by both 100
records and a UTF-8 byte budget; continuation cursors preserve the rest.

Session-title enrichment is asynchronous and limited to four concurrent lookups.
Slow title reads cannot block delivery of the question queue. Microphone stop is
shared across simultaneous callers and retains tail PCM until native acknowledgment.
