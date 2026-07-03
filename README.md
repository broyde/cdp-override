# cdp-override

Replace requests on a live site with custom responses, or with content from your local server — via the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).

Useful for testing local UI changes against a real, logged-in production environment without deploying or running a full proxy.

## Why

- **No CA certificate to install.** Interception happens inside Chrome itself, so HTTPS works out of the box.
- **Real cookies, real session.** You navigate the live site as your real user; only the resources you choose are swapped.
- **The top-level HTML can be replaced too**, not just subresources.
- **Original request headers are forwarded** to your local server (everything except `Host`, which you can override). Cookies, `Authorization`, custom headers — all reach your local server unchanged.
- **Source maps work despite a Chrome quirk.** DevTools fetches source maps through a separate channel that CDP can't intercept, so they can't be replaced like normal resources. The tool works around this by fetching the map server-side and inlining it as a `data:` URL directly into the JS/CSS body — so DevTools never has to fetch it separately.
- **Hot reload.** Edit your rules file; the next request picks up the new code, no Chrome restart.
- **Zero runtime dependencies.** Just Node 22+ and a Chrome/Chromium install.

## Install

Run without installing:

```
npx cdp-override replace.js
```

Or install globally:

```
npm i -g cdp-override
override replace.js
```

Requires **Node ≥ 22** (uses the global `WebSocket` and `fetch`).

## Quick start

Create `replace.js`:

```js
export function replace(url) {
  // Forward to a local file:
  if (url === 'https://example.com/test') {
    return 'http://example.local/test';
  }

  // Custom inline response:
  if (url === 'https://example.com/api/ping') {
    return {
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    };
  }

  // Redirect:
  if (url === 'https://example.com/') {
    return { status: 302, headers: { Location: '/index.html' } };
  }

  // Anything else: undefined → pass through to the live origin.
}

export function resolve(host) {
  // Map the logical host returned by replace() to a real host:port.
  if (host === 'example.local') return '127.0.0.1:3000';
}
```

Run:

```
npx cdp-override replace.js
```

A dedicated Chrome window opens (with its own profile, separate from your normal one). Browse to the live site — matching requests are served from your local server; everything else hits live.

## API

### `replace(url) -> string | object | null`

The URL is the full request URL the browser is about to fetch (e.g. `https://example.com/foo`). Return value:

| Return | Behavior |
| --- | --- |
| **String** (URL) | Fetch from this URL and serve the body. Original request headers (cookies, etc.) are forwarded; `Host` is replaced if `resolve()` returns a new host. |
| **`{ status?, headers?, body? }`** | Inline custom response. Defaults: `status=200`, `headers={}`, `body=''`. `body` accepts a string or `Uint8Array` / `Buffer`. |
| `null` / `undefined` / same URL | Pass through to the live origin unchanged. |

May be `async`.

### `resolve(host) -> string | null`

Maps the host portion of a URL returned by `replace()` to a different host (and optional `:port`). The **original** host is then forwarded as the `Host` header so your local server can serve the right vhost / cert / route.

```js
export function resolve(host) {
  if (host === 'example.local') return '127.0.0.1:3000';
}
```

May be `async`. Optional — omit if `replace()` already returns the real local URL.

## How it works

`cdp-override` launches a separate Chrome instance with `--remote-debugging-port`, connects via the Chrome DevTools Protocol, and enables `Fetch` interception browser-wide. Each outgoing request is routed through your `replace()`:

- Pass-through requests are released with `Fetch.continueRequest` — original headers preserved.
- URL replacements are fetched server-side using Node's `http` / `https` modules (so we can set arbitrary `Host` headers, which the global `fetch` forbids) and returned with `Fetch.fulfillRequest`.
- Inline responses go straight to `Fetch.fulfillRequest`.

For replaced **JS** and **CSS** responses, the tool automatically:

1. Looks for a source-map URL in the `SourceMap` response header or the `//# sourceMappingURL=…` comment (block-comment style for CSS).
2. Fetches the map (using the same headers as the original resource) and base64-inlines it as a `data:` URL.
3. Strips the original header/comment.

This sidesteps the fact that DevTools fetches source maps via its own internal fetcher that doesn't go through CDP `Fetch.enable`.

## Remote device (Android Chrome over USB)

Instead of launching a local Chrome, you can attach to Chrome running on a USB-connected Android phone. Interception still happens server-side on your laptop — Node fetches the replacement bytes and pushes them to the phone over the debugging socket — so **the phone never needs to reach your local dev server**. `resolve()` mapping to `127.0.0.1` keeps working (it resolves on the laptop, where Node runs).

1. On the phone: enable **Developer options → USB debugging**, connect via USB, open Chrome, and accept the debugging prompt.
2. Forward the phone's DevTools socket to a local port ([adb](https://developer.android.com/tools/adb) required):

   ```
   adb forward tcp:9222 localabstract:chrome_devtools_remote
   ```

   Verify it works: `curl http://localhost:9222/json/version` should return JSON.
3. Point the tool at that endpoint instead of launching a browser:

   ```
   CDP_ENDPOINT=http://localhost:9222 npx cdp-override replace.js
   ```

Browse on the phone; matching requests are served from your laptop. The attached browser is never launched or killed by the tool. The same approach works for any already-running Chrome started with `--remote-debugging-port` (another machine, a headless instance, etc.) — just point `CDP_ENDPOINT` at its `/json/version` host.

When done, remove the forward with `adb forward --remove tcp:9222` — it holds `localhost:9222` bound on your laptop, so clear it if something else needs that port (e.g. a desktop Chrome on `--remote-debugging-port=9222`).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `CDP_ENDPOINT` | (unset) | Attach to an already-running Chrome at this HTTP debugging endpoint (e.g. `http://localhost:9222`) instead of launching one. See [Remote device](#remote-device-android-chrome-over-usb). |
| `CHROME_PATH` | (auto-discover) | Chrome/Chromium binary path. Falls back to `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome` on PATH. Ignored when `CDP_ENDPOINT` is set. |
| `REPLACER_PROFILE_DIR` | `~/.cache/replacer-profile` | Chrome profile directory. **Persistent** — your tabs, history, extensions, and cookies survive between runs. Ignored when `CDP_ENDPOINT` is set. |

The profile is fully isolated from your default Chrome (`~/.config/google-chrome` is never touched). To wipe it, delete the directory.

## Notes

- The replace file is watched. Edits take effect on the next intercepted request — no restart.
- Don't sign into a personal Google account inside the replacer Chrome unless you want Sync to copy your real data into this profile.
- Memory Saver / `HighEfficiencyMode` is disabled in the launched Chrome to avoid background-tab discarding.
- HSTS isn't a problem because we use `Fetch.fulfillRequest`: the page-visible URL stays on the live origin (`https://…`), even when the actual transport hits an HTTP local server.

## License

MIT — see [LICENSE](./LICENSE).
