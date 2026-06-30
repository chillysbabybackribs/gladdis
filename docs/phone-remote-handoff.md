# Phone Remote Handoff

Last updated: 2026-06-30 (revised after worktree reconciliation)
Branch: `positioning-one-local-workspace`

## Objective

Build an installable-from-web phone client for Gladdis that acts as a simple remote chat surface for the desktop app:

- user sends a message from their phone
- Gladdis handles it through the same desktop chat path
- responses stream back to the phone
- speed and reliability are first-class
- no app store distribution is required

This is currently being built as a desktop-served remote web app under the phone/PWA bridge, not as a separate native mobile app.

## Current status

The daemon-side remote chat bridge is already real and partially productized.

Shipped commit trail:

1. `a5f9d50` - Scaffold remote chat bridge
2. `9057d60` - Add phone bridge controls
3. `6751ee9` - Add paired phone device sessions
4. `5fe36bd` - Add websocket phone chat transport
5. `4813872` - Add phone chat reconnect queue
6. `c3cdc09` - Add durable phone session resume state

As of `c3cdc09`, the phone flow is no longer just a transient socket demo. It now has:

- a desktop-hosted remote app at `/app`
- websocket transport for live chat turns
- paired device auth support
- reconnect queue behavior
- durable per-phone session restore across reload/reconnect
- persisted conversation id plus pending turns

## What exists in code

### Main server

Primary implementation:

- `src/main/remote/RemoteChatServer.ts`
- `src/main/remote/PhoneSessionStateStore.ts`

The remote server:

- serves the remote app shell
- exposes bridge APIs
- upgrades authenticated websocket connections on `/ws`
- routes phone messages into the existing desktop chat pipeline
- streams assistant updates back to the phone client

`RemoteChatServer` now accepts an optional `sessionStore` and uses a durable `sessionKey` per client:

- paired devices use `device:${device.id}`
- raw token sessions use `token:${sha1(token)}`

### Durable session state

`PhoneSessionStateStore` persists state to:

- `app.getPath('userData')/gladdis-phone-sessions.json`

Stored state includes:

- `conversationId`
- pending turns keyed by `clientMessageId`
- pending turn metadata such as `requestId`, `assistantMessageId`, timestamps, and original text

This means a phone can reload and recover enough local/server state to continue showing the active chat instead of starting cold every time.

### Shared types / API surface

Relevant shared surface:

- `shared/types.ts`
- `shared/api.ts`

There is explicit phone/PWA bridge typing in the shared layer already, including session snapshot types used by the websocket `ready` event.

### Remote web app behavior

The remote app HTML is currently generated from `RemoteChatServer.ts`.

Important behaviors already implemented there:

- local persistence via `localStorage`
- reconnect-safe outbox handling
- fetch conversation by id after reconnect
- reconcile local pending messages with server pending state
- restore assistant placeholders using `assistantMessageId`
- retry unsent messages after reconnect

This is enough for a credible first remote chat surface even before deeper UI polish.

## Validation status

Validated during the last shipped slice:

- `npm run check` passed
- `npm run build` passed

The remote area already has unit coverage committed:

- `src/main/remote/PhoneDeviceStore.test.ts`
- `src/main/remote/PhoneSessionStateStore.test.ts`
- `src/main/remote/RemoteChatServer.test.ts`

Known existing build note:

- `src/main/models/memoryStore.ts` has a dynamic + static import chunking warning during build
- this is a warning, not the blocker for the phone bridge work

What has **not** been fully completed yet:

- a full end-to-end paired phone smoke test driven in-browser after the latest resume-state changes
- a visual polish pass for remote restore/sync states

An app-window screenshot was taken after the last slice, but the actual remote phone page was not fully exercised end-to-end in that pass.

## How to test before a live phone (desktop localhost)

You can validate ~90% of the remote/PWA correctness in desktop Chrome with no
phone and no tunnel, because `localhost` is a secure context.

1. **Start the bridge** (off by default). To also allow a phone later, bind wide:

   ```bash
   GLADDIS_PHONE_BRIDGE=1 GLADDIS_PHONE_BRIDGE_HOST=0.0.0.0 npm run dev
   ```

   The listening URL is logged: `[gladdis] phone bridge listening at http://<host>:<port>/app?token=…`.

2. **Pair a device** in the app to get an `appUrl` (token-bearing). Open it — but
   for the desktop pass, swap the host for `localhost`:
   `http://localhost:<port>/app?token=…`.

3. **DevTools → Application tab:**
   - **Manifest** — name "Gladdis Remote Chat", `standalone`, and a non-empty
     icon (the inline SVG). No "no icons" warning.
   - **Service Workers** — `/sw.js` activated. Confirm reloading the page still
     hits the network (navigations are not cache-served).
   - **Network** — `/manifest.webmanifest` and `/sw.js` both return `200`
     **without** a token (they're pre-auth).

4. **Restart-safety check** (the token-pinning fix): note the token in the URL,
   stop the app, restart it, and confirm the bridge logs the **same** token. A
   previously opened install should still authenticate.

5. **Chat round-trip** — send a message from the localhost page; confirm it lands
   in the desktop chat and the assistant reply streams back over `/ws`.

For the **real phone install** you need HTTPS (SW won't register over plain LAN
HTTP). Put a tunnel in front and open the `https://…/app?token=…` URL on the phone:

```bash
npx localtunnel --port <port>     # or: cloudflared tunnel --url http://localhost:<port>
```

## Known gaps / risks

### 1. Revoke cleanup exists in the worktree but is not yet committed

The committed `c3cdc09` `revokePhoneDevice` is bare — it calls `phoneDeviceStore.revoke(deviceId)` and nothing more, so persisted phone session state is **not** cleared on revoke in any commit.

However, the fix is **already implemented in the working tree** (it just hasn't been committed, because `src/main/index.ts` is dirty with ~350 lines of unrelated in-flight window-chrome work):

```ts
// src/main/index.ts (worktree, uncommitted)
function revokePhoneDevice(deviceId: string): PhoneBridgeStatus {
  phoneDeviceStore.revoke(deviceId)
  phoneSessionStateStore.clear(deviceSessionKey(deviceId))  // <- the cleanup
  return phoneBridgeStatus()
}
```

It also adds `deviceSessionKey` to the `PhoneSessionStateStore` import. So the follow-up here is **not** to re-implement this — it's to:

- verify the worktree version, then **surgically stage just those two lines** (import + `.clear()` call) without dragging in the unrelated `index.ts` window-chrome edits

If the dirty `index.ts` is ever reset/stashed and the fix is lost, the same two
lines are preserved as a standalone patch generated against HEAD:

    git apply docs/phone-revoke-cleanup.patch

(It applies cleanly on a clean checkout of HEAD's `index.ts`.)

### 2. Installability — primitives now exist; a few are hardened, the rest needs a live phone

The remote app **does** serve PWA primitives (`RemoteChatServer.ts`):

- `GET /manifest.webmanifest` — `standalone`, `start_url: /app`, brand colors
- `GET /sw.js` — service worker
- both are served **before the auth gate**, so the phone can fetch them on first load

Hardened in this slice (verifiable without a phone, covered by tests):

- **manifest icons** — was `icons: []` (degraded install); now ships an inline SVG
  data-URI icon (`any maskable`)
- **service-worker token safety** — the SW previously cached `/app`. Because the
  served `/app` HTML embeds the bridge token, and the auto-generated server token
  rotated every desktop restart, a cached `/app` would hand the phone a **dead
  token** after a restart and the offline fallback would keep serving it. The SW
  now **never caches navigations** (`request.mode === 'navigate'` bypasses cache)
  and no longer precaches `/app`.
- **token pinning** — the server bridge token is now persisted
  (`userData/gladdis-phone-bridge-token`) instead of `randomUUID()` per launch, so
  a server-token install survives restarts. `GLADDIS_PHONE_BRIDGE_TOKEN` still
  overrides and is never persisted. (Paired-device tokens already persisted.)

Still requires a real phone / HTTPS tunnel to verify:

- mobile home-screen install behavior across browsers (iOS Safari vs Android Chrome)
- offline/install UX and the maskable icon crop on a real launcher
- whether the phone app reconnects cleanly when the desktop is temporarily unavailable
- **secure-context requirement**: service workers only register over HTTPS or
  `localhost`. A plain-HTTP LAN IP (`http://192.168.x.x:port`) will **not**
  register the SW on the phone — use a tunnel (`localtunnel` / `cloudflared`) for
  a true install test. Desktop `localhost` is exempt and validates everything else.

### 3. "Computer off anywhere in the world" is not solved by the current bridge

Current architecture is desktop-served. That means the desktop process is still the source of truth for running chat work.

Implications:

- if the desktop app is off, the current remote phone client cannot execute turns through this bridge
- worldwide access is possible only if the desktop or a relay remains reachable
- true offline-desktop operation would require a different architecture, such as an always-on relay/service layer

## Recommended next steps

### Immediate next slice

1. Run a real paired-device smoke test:
   - pair a device
   - open the `/app` remote client
   - send a message
   - reload or reconnect mid-session
   - verify session restore and no duplicate turn behavior

2. Add a tiny remote UI state for:
   - restoring session
   - syncing pending messages
   - disconnected / retrying

3. Land revoke cleanup safely:
   - the clear-on-revoke code already exists in the worktree (see Gap #1) — just stage those two `index.ts` lines surgically, don't rewrite them
   - `PhoneSessionStateStore.clear()` is already covered by `PhoneSessionStateStore.test.ts`; add a revoke-path test in `index.ts`'s area only if it's cheap

### After that

1. Audit installability:
   - manifest
   - service worker
   - icons
   - install prompts

2. Decide the product architecture:
   - desktop-hosted remote client only
   - internet-reachable relay/tunnel
   - always-on backend that can operate while the desktop is offline

3. If keeping the no-app-store path, optimize for:
   - add-to-home-screen install
   - websocket reconnect speed
   - minimal boot payload
   - mobile-first chat rendering

## Worktree caution

The repo is currently very dirty with many unrelated user changes.

Important constraint for the next model or engineer:

- do not revert unrelated work
- be surgical, especially in `src/main/index.ts`
- stage only the intended phone-bridge changes

## Best next command set

If picking this up immediately, start here:

1. inspect current phone bridge files:
   - `src/main/remote/RemoteChatServer.ts`
   - `src/main/remote/PhoneSessionStateStore.ts`
   - `src/main/index.ts`
   - `shared/types.ts`

2. run validation baseline:
   - `npm run check`
   - `npm run build`

3. then perform the paired-device remote smoke test before the next code slice

## Bottom line

This is no longer at the "idea" stage. The daemon already has a functioning remote phone bridge with durable session resume. The main missing work is product hardening: end-to-end smoke coverage, installability audit, a few UX states, and architecture decisions if the user truly needs the phone to work while the desktop is off.
