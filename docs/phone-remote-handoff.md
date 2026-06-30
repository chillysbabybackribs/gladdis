# Phone Remote Handoff

Last updated: 2026-06-30
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

Known existing build note:

- `src/main/models/memoryStore.ts` has a dynamic + static import chunking warning during build
- this is a warning, not the blocker for the phone bridge work

What has **not** been fully completed yet:

- a full end-to-end paired phone smoke test driven in-browser after the latest resume-state changes
- a visual polish pass for remote restore/sync states

An app-window screenshot was taken after the last slice, but the actual remote phone page was not fully exercised end-to-end in that pass.

## Known gaps / risks

### 1. Revoke cleanup is probably incomplete in committed code

There was intent to clear persisted phone session state when a paired device is revoked, but that cleanup did **not** make it into the final committed `c3cdc09` diff.

Because `src/main/index.ts` has many unrelated local edits in the worktree, only the safe store wiring was staged and committed.

Assume this still needs a clean follow-up patch:

- on device revoke, clear `deviceSessionKey(deviceId)` from `PhoneSessionStateStore`

### 2. Installability is not yet the same thing as "production PWA"

The phone web app exists, but that does not automatically mean the full PWA install story is complete.

Things to verify explicitly before calling it done:

- manifest presence and correctness
- service worker strategy
- offline/install UX
- mobile home-screen install behavior across browsers
- whether the phone app can reconnect cleanly when the desktop is temporarily unavailable

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
   - clear persisted device session state on device revoke
   - add a focused test if feasible

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
