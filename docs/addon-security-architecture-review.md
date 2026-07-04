# Addon System — Security & Architecture Review

Status: Draft for review (rev. 2 — SOTA + code re-verification pass) Scope:
`packages/addon-sdk`, `apps/frontend/src/addons`,
`apps/frontend/src/pages/settings/addons`, `crates/core/src/addons`,
`apps/tauri/src/commands/addon.rs`, `apps/server/src/api/addons.rs`,
`apps/tauri/tauri.conf.json`, `apps/tauri/capabilities/` Applies to: Tauri
desktop/mobile app **and** the Axum web/server mode.

This document consolidates two independent reviews of the addon system, verified
against the current code, and lays out the recommended target architecture for
both platforms. Revision 2 adds finding S12 (desktop `withGlobalTauri` + `fs`
capability exposure) found during a re-verification pass, corrects the S10
citations to the actual assignment sites, benchmarks the recommendations against
current SOTA (Figma, VS Code, Chrome MV3, MetaMask Snaps, and Tauri's own
Isolation Pattern / v2 capabilities), and hedges the import-map and ShadowRealm
maturity claims.

---

## 1. Executive summary

The addon system is functional and has good developer ergonomics, but its
security posture is **Obsidian-level: excellent DX, effectively zero
isolation.** Addons are untrusted third-party JavaScript that execute in the
main application realm with the same privileges as first-party app code. The
permission system is **advisory only** — it is displayed to the user but never
enforced at runtime — and the Content-Security-Policy is disabled, so a
malicious or compromised addon can read every piece of financial data and secret
in the app and exfiltrate it to any server with a single `fetch()`.

On desktop the exposure is **worse than "same privileges as app code"**: because
`withGlobalTauri` is enabled and the Tauri filesystem capability is scoped to
the whole `$APPDATA/**` tree, addon code can bypass the HostAPI entirely and
read, overwrite, or delete the SQLite database, other addons' files, and secret
storage directly (S12). The brokered ~90-function API is not the ceiling of what
an addon can reach — it is a convenience layered over unrestricted access.

None of this is exotic; addon/plugin isolation is a solved problem across the
industry — Figma (sandboxed realm + iframe UI), VS Code (out-of-process
extension host), Chrome extensions (declared host allowlists), and, most
directly relevant, MetaMask Snaps (untrusted third-party plugins in a financial
app, isolated with SES/Compartments). The work here is host-side plumbing, not
novel security research. Tauri itself ships two mechanisms that are currently
unused: the **Isolation Pattern** (sandboxed-iframe IPC broker) and the **v2
capabilities/ACL** system.

The single highest-leverage principle: **treat addons as untrusted and give them
a capability-scoped, brokered API behind a real isolation boundary — the same
design for Tauri and web.**

### Findings at a glance

| #   | Issue                                                                | Severity | Type             | Verified location                                                     |
| --- | -------------------------------------------------------------------- | -------- | ---------------- | --------------------------------------------------------------------- |
| S1  | No runtime permission enforcement — full API handed to every addon   | Critical | Architecture     | `addons-runtime-context.ts:167–392`                                   |
| S2  | No sandboxing — addons execute in host JS realm                      | Critical | Architecture     | `addons-core.ts:126–133`                                              |
| S3  | CSP disabled (`"csp": null`)                                         | Critical | Configuration    | `apps/tauri/tauri.conf.json` security block                           |
| S4  | Backend cannot verify addon identity; secret scoping is JS-only      | High     | Architecture     | `addons-runtime-context.ts:147–164`, `commands/addon.rs`              |
| S5  | Static permission analysis trivially bypassable                      | High     | Design           | `crates/core/src/addons/service.rs:150–494`                           |
| S6  | Path traversal via unvalidated `addon_id`                            | High     | Input validation | `service.rs:87–90`, all `get_addon_path` callers                      |
| S7  | Install proceeds on permission-analysis failure                      | Medium   | Logic            | `use-addon-actions.ts:171–182`                                        |
| S8  | Server mode: addons are global + auth optional (multi-tenant unsafe) | Medium   | Architecture     | `apps/server/src/api.rs:92,144–151`, `api/addons.rs`                  |
| S9  | Dev mode fetches & executes remote code from localhost:3001          | Medium   | Dev security     | `addons-dev-mode.ts:42–83,144–226,327–347`                            |
| S10 | Global state exposed on `window`                                     | Medium   | Architecture     | `main.tsx:26–27`, `App.tsx:30`, `use-navigation-event-listener.ts`    |
| S11 | No ZIP extraction limits (zip bomb / OOM)                            | Low→Med  | Input validation | `service.rs:496–545`                                                  |
| S12 | Desktop config grants addons direct filesystem + IPC access          | Critical | Configuration    | `tauri.conf.json:65` (`withGlobalTauri`), `capabilities/desktop.json` |

> Severity note: S6 and S11 were rated "Low" in the original review. On closer
> reading `addon_id` flows from the attacker-controlled manifest **and** from
> raw command/HTTP arguments into `fs::remove_dir_all`, and the web server
> exposes those paths remotely, so S6 is raised to **High**. S11 is raised to
> **Low→Medium** because `read_to_string` over unbounded entries is both a DoS
> and a functional bug (binary assets break). **S12 is new to this revision**
> (surfaced during the code re-verification pass): on desktop, `withGlobalTauri`
> plus the filesystem capability scope give addon code a data-access path that
> is strictly _worse_ than the ~90-function HostAPI, and it is the concrete
> mechanism behind S2 and S4 rather than a theoretical one — hence **Critical**.

---

## 2. Architecture overview (how it works today)

1. **Package format.** An addon is a ZIP containing `manifest.json` (id, name,
   version, `main`, declared `permissions`) and a JS bundle.
2. **Install (Rust).** The backend extracts the ZIP, runs substring-based static
   analysis on the JS to _detect_ which host-API functions are used, and merges
   detected vs declared permissions into the stored manifest. Files are written
   to `<app_data>/addons/<id>/`.
3. **Approval (Frontend).** A permission dialog (`addon-permission-dialog.tsx`)
   shows the merged permissions and a coarse risk label, then the user approves
   or denies.
4. **Runtime load (Frontend).** `load_addon_for_runtime` returns the main file
   **as a string**; the loader strips the sourcemap comment, wraps the code in a
   `Blob`, `createObjectURL`s it, and `import()`s the blob URL — executing the
   code in the host window.
5. **Context injection.** The addon's `enable(ctx)` is called with an
   `AddonContext` whose `ctx.api` is a bridge (`type-bridge.ts`) to ~90 host
   functions (portfolio, activities, accounts, settings, secrets, files, market
   data, etc.), plus `sidebar.addItem`, `router.add`, `onDisable`, and scoped
   `secrets`.

Both the Tauri IPC layer (`commands/addon.rs`) and the Axum server
(`api/addons.rs`) expose the same operations. The web runtime path is identical
to desktop except the transport is HTTP instead of Tauri `invoke`.

Two desktop-config facts compound the above and are load-bearing for S2/S4/S12:
`tauri.conf.json` sets `"withGlobalTauri": true`, injecting `window.__TAURI__`
into every script in the webview; and `capabilities/desktop.json` grants
`fs:allow-read-file`/`write-file`/`remove` scoped to `$APPDATA/**` plus
`shell:allow-open`. App-defined `#[tauri::command]`s are not gated by the
capability ACL at all — capabilities govern core/plugin commands, not custom
ones — so every addon/secret command is freely invokable from the webview.

The load boundary — the fact that step 4 runs addon code **in the same realm as
the host** — is the root cause of S1, S2, S4, S10, and S12 simultaneously.

---

## 3. Detailed findings

### S1 — Critical: Permissions are informational only; no runtime enforcement

`createAddonContext()` (`addons-runtime-context.ts:167`) builds the **full**
`HostAPI` bridge for every addon regardless of what was declared or approved:

```ts
// Every addon receives the same complete API — nothing is filtered by grant:
api: createSDKHostAPIBridge(
  {
    getHoldings,
    getActivities,
    getAccounts,
    getExchangeRates,
    updateSettings,
    backupDatabase,
    createActivity,
    updateActivity,
    importActivities,
    openCsvFileDialog,
    openFileSaveDialog,
    setSecret,
    getSecret,
    deleteSecret,
    // ...everything
  },
  addonId,
);
```

**Impact.** An addon that declares only `portfolio.getHoldings` can call
`settings.update()`, `activities.create()`, `accounts.create()`,
`backupDatabase()`, or any other function. The permission dialog is purely
cosmetic. Detection (`is_detected`) and declaration (`is_declared`) flags are
computed and stored, but nothing reads them to gate the API surface.

### S2 — Critical: No sandboxing — addons run in the host's JS context

`addons-core.ts:126`:

```ts
const blob = new Blob([addonCode], { type: "text/javascript" });
blobUrl = URL.createObjectURL(blob);
const mod = await import(/* @vite-ignore */ blobUrl);
```

This runs addon code in the same origin, window, and DOM as the host. A
malicious addon can:

- Read `window.__wealthfolio_query_client__` to read/invalidate/refetch any
  cache entry.
- Call `window.__wealthfolio_navigate__` to redirect the user.
- Reach `window.React` / `window.ReactDOM` to inject arbitrary UI anywhere.
- On desktop, reach the Tauri IPC directly via `window.__TAURI__` (exposed by
  `withGlobalTauri: true`) to call **any** command, bypassing the HostAPI
  entirely — including the filesystem plugin (see S12).
- Read/modify DOM, `localStorage`, `sessionStorage`, cookies.
- Monkey-patch any global (`fetch`, `XMLHttpRequest`) to intercept traffic.

The `ctx` object handed to `enable()` is not a boundary — it is a convenience.
Ignoring it grants no less access. On desktop it grants strictly _more_ access
than the HostAPI (S12).

### S3 — Critical: CSP is disabled

`apps/tauri/tauri.conf.json` sets:

```json
"security": { "csp": null }
```

With no Content-Security-Policy, addon code has unrestricted ability to:

- `fetch()`/`XHR` to **any** external host → one-line exfiltration of the entire
  portfolio and all secrets.
- Load remote scripts.
- Use `eval()` / `new Function()`.

This is the highest-leverage single fix. Even without a full sandbox, a strict
`connect-src` allowlist neutralizes the _impact_ of S1/S2 by preventing data
from leaving the machine.

### S4 — High: Backend cannot verify addon identity; secret scoping is JS-only

Secret isolation is implemented purely in JS via a key prefix
(`addons-runtime-context.ts:147`):

```ts
function createAddonScopedSecrets(addonId: string) {
  const addonPrefix = `addon_${addonId}_`;
  return {
    set: (key, value) => setSecret(`${addonPrefix}${key}`, value), // raw invoke
    get: (key) => getSecret(`${addonPrefix}${key}`),
    delete: (key) => deleteSecret(`${addonPrefix}${key}`),
  };
}
```

Because all addons share the JS realm (S2), any addon can call
`setSecret("addon_OTHER_ID_apiKey", ...)` or
`getSecret("addon_OTHER_ID_apiKey")` directly. On desktop this is not
hypothetical: `window.__TAURI__.core.invoke("get_secret", { key })` reaches the
command directly (S12), for any addon's key. The Tauri/server commands receive
raw parameters with **no caller identity**, so the backend cannot validate
scope. The prefix is a naming convention, not a security boundary.

### S5 — High: Static analysis is trivially bypassable

Permission detection (`service.rs:150–494`) is substring matching:

```rust
let api_patterns = vec![
    format!("api.{}.{}(", api_category, function),
    format!(".api.{}.{}(", api_category, function),
    format!("ctx.api.{}.{}(", api_category, function),
];
```

Bypasses (any one suffices):

- Bracket access: `ctx.api["settings"]["update"]()`
- Reference capture: `const fn = ctx.api.settings.update; fn()`
- Dynamic dispatch: `ctx.api[cat][method]()`
- Minification/obfuscation renaming
- `eval()` / `new Function()` to build calls at runtime
- Reaching the Tauri IPC directly instead of the HostAPI

It also produces false positives (a comment or unrelated string containing the
pattern), and, because of S1, it changes nothing at runtime regardless of
accuracy. Detection is at best a UI hint, never a control.

### S6 — High: Path traversal via unvalidated `addon_id`

`service.rs:87`:

```rust
pub fn get_addon_path(base_dir: impl AsRef<Path>, addon_id: &str) -> Result<PathBuf, String> {
    let addons_dir = ensure_addons_directory(base_dir)?;
    Ok(addons_dir.join(addon_id))   // no validation
}
```

`validated_addon_archive_path` guards only the **file names inside** the ZIP —
never the `addon_id` used as the directory name. `addon_id` originates from (a)
the attacker-controlled manifest `id` and (b) raw command/HTTP arguments
(`uninstall_addon`, `toggle_addon`, `load_addon_for_runtime`). Consequences:

- Install with `"id": "../../../../some/path"` writes addon files outside the
  addons tree.
- `uninstall_addon("../../some/path")` → `fs::remove_dir_all` on an arbitrary
  directory.
- `toggle`/`load` read and rewrite `manifest.json` outside the tree.

On the web server these are remotely reachable (auth-gated when auth is
configured — see S8). Fix: validate `addon_id` against a strict charset at every
entry point.

### S7 — Medium: Install proceeds on permission-analysis failure

`use-addon-actions.ts:171`:

```ts
} catch (error) {
  toast({ title: "Permission analysis failed", ... });
  // Still allow installation but with warning
  await performAddonInstallation(fileData);
}
```

If permission extraction throws (e.g. a deliberately malformed manifest), the
addon is installed anyway behind a toast. A malicious addon can intentionally
trip this path to skip the permission surface entirely. Fail closed instead.

### S8 — Medium: Server mode is multi-tenant unsafe; auth is optional

The Axum server has a single `addon_service` over a single `addons_root`
(`WF_ADDONS_DIR`, `config.rs:67`). `get_enabled_addons_on_startup` returns the
same addon set to **every** connected user. In any shared/multi-user deployment,
one user installing an addon runs it in every other user's browser, against
their data and their authenticated session. Additionally, addon routes are
behind JWT only when `state.auth.is_some()` (`api.rs:92,144`); a server started
without auth exposes all addon install/uninstall/toggle endpoints
unauthenticated.

### S9 — Medium: Dev mode fetches and executes remote code without verification

`addons-dev-mode.ts` auto-discovers a dev server on `localhost:3001`, then
fetches and executes its JS:

```ts
const addonResponse = await fetch(`${devServer.url}/addon.js`);
const addonCode = await addonResponse.text();
await this.executeAddonCode(addonCode, manifest, addonId); // Blob import
```

It also opens `new EventSource("http://localhost:3001/addon-updates")` for hot
reload. No integrity checks; any local process can serve on that port and inject
code into a dev build. Gated behind `import.meta.env.DEV`, so it is
developer-machine-only — but it is a real supply-chain vector for developers.
Ensure it can never be present in a production bundle and document the risk.

### S10 — Medium: Global state pollution

Sensitive objects are reachable by any script on the page, including addons:

- `window.__wealthfolio_query_client__` — full React Query client
- `window.__wealthfolio_navigate__` — router navigation
- `window.React` / `window.ReactDOM` — framework singletons
- `window.__ADDON_DEV__`, `window.__DEV_ADDONS__`, `globalThis.discoverAddons`,
  `globalThis.reloadAddons` (dev mode)

These are ambient authority. They should be non-enumerable, closured, or
replaced by the RPC broker (below).

### S11 — Low→Medium: No ZIP extraction limits

`extract_addon_zip_internal` (`service.rs:496`) reads every entry with
`read_to_string` into memory with no cap on total uncompressed size, entry
count, or per-file size — a zip-bomb / OOM vector. Because it uses
`read_to_string`, it is _also_ a functional bug: any binary asset (icon, font,
wasm) fails to extract or is corrupted. Read as bytes and enforce limits.

### S12 — Critical: Desktop config grants addons direct filesystem + IPC access

This is the finding that makes the desktop threat model concretely worse than
"addon has the same privileges as app code." Two configuration facts combine:

- **`"withGlobalTauri": true`** (`tauri.conf.json:65`) injects the
  `window.__TAURI__` bridge into every script in the webview, addon blobs
  included. The host app itself does **not** use this global — it calls `invoke`
  exclusively through `@tauri-apps/api` module imports (verified:
  `adapters/tauri/core.ts` and 5 other files; zero references to
  `window.__TAURI__` in app code) — so the global is gratuitous attack surface
  that can be turned off with no app changes.
- **Filesystem capability scoped to
  `$APPDATA/**`** (`capabilities/desktop.json`): `fs:allow-read-file`, `fs:allow-write-file`, `fs:allow-remove`, `fs:allow-rename`, plus `shell:allow-open`. That scope contains the SQLite database (`app.db`),
  every installed addon's files, and secret storage.

Combined, an addon can do the following without touching the HostAPI:

```js
// Directly, from inside an addon blob, on desktop:
const { readFile, writeFile, remove } = window.__TAURI__.fs;
await readFile("$APPDATA/app.db"); // exfiltrate the whole DB
await remove("$APPDATA/addons/<other-addon>", { recursive: true });
await window.__TAURI__.core.invoke("get_secret", {
  key: "addon_OTHER_ID_apiKey",
});
```

The Tauri v2 capability ACL does not mitigate this: capabilities gate core and
plugin commands, but app-defined `#[tauri::command]`s (install, uninstall,
`get_secret`, etc.) are invokable from the main window regardless of the
capability file. So the ACL that exists provides **no** boundary against addon
code, and the `fs` plugin grant is a direct read/write primitive over all app
data.

Web mode is not affected by `withGlobalTauri`/`fs` (no Tauri bridge), but the
equivalent there is the authenticated session (S8): an addon inherits the user's
cookies/JWT and can call every protected `/api/*` route.

Fixes are cheap and independent of the isolation work: set
`withGlobalTauri: false`, and tighten the `fs` scope to the minimum the app
needs (ideally not the whole `$APPDATA/**`), or accept the scope and rely on
Tier 1 isolation to keep addons out of the webview's ambient authority.

---

## 4. Non-security architecture & code-quality issues

These do not have CVEs but drive the security debt and maintenance cost.

- **Duplication across three surfaces.** Install/extract/write logic exists in
  `AddonService` **and** is re-inlined in `commands/addon.rs` (the Tauri command
  reimplements extraction and file writing rather than calling the service).
  This is why a fix in one path (e.g. `write_addon_files` validation) doesn't
  cover the other. Collapse to a single `AddonService` consumed by thin
  Tauri/server wrappers.
- **Permission table lives in 3 places** —
  `packages/addon-sdk/src/permissions.ts` (`PERMISSION_CATEGORIES`),
  `service.rs` (`permission_patterns`), and the frontend risk lists in
  `use-addon-actions.ts` (`calculateRiskLevel`). They drift. Establish one
  source of truth (ideally code-generated).
- **`type-bridge.ts` hand-maps ~90 functions** between "internal" and "SDK"
  shapes (436 lines). Every new host function touches the adapter,
  `InternalHostAPI`, the bridge, and `permissions`. High friction, easy to
  desync.
- **Fragile `enable()` resolution.** `addons-core.ts:144` tries five bundle
  shapes including a hardcoded `PortfolioTrackerAddon` name — an
  example-specific hack leaked into the loader. Standardize on one entry
  contract (`export default function enable(ctx)`).
- **Lifecycle is best-effort.** A blob module can register
  timers/listeners/portals that `disable()` won't reliably clean up; nav/route
  maps are global singletons. "Disable" does not guarantee the addon stops
  running.
- **Silent failure swallowing** (`catch {}`, `let _ = ...`, install-on-failure)
  throughout.
- **`enabled` defaults to `true`** (`models.rs:91`,
  `is_enabled → unwrap_or(true)`): a manifest with no `enabled` field auto-runs.

---

## 5. Target architecture

### How comparable systems solve this (SOTA)

The recommendations below are not speculative — every major plugin platform has
converged on "untrusted code behind an enforced boundary," differing mainly in
_which_ boundary:

| System             | Logic isolation                       | UI                         | Host access                           |
| ------------------ | ------------------------------------- | -------------------------- | ------------------------------------- |
| **Figma**          | Sandboxed JS realm (no DOM)           | Sandboxed iframe           | `postMessage` to a typed API          |
| **VS Code**        | Separate OS process (extension host)  | Declarative API + Webviews | RPC; no direct DOM access             |
| **Chrome (MV3)**   | Isolated world / service worker       | Own pages                  | Declared `host_permissions` allowlist |
| **MetaMask Snaps** | SES `Compartment` (hardened JS)       | Constrained UI schema      | Capability-gated RPC methods          |
| **Obsidian**       | **None** — same thread, full `window` | Direct DOM                 | Everything (this is today's model)    |

Wealthfolio is currently at the **Obsidian** row: best DX, zero isolation. The
Chrome model informs the Tier 2 network broker; the Figma/Snaps models inform
the Tier 1 isolation choice. None of this requires inventing anything new.

Adopt in tiers, ordered by return on effort. Tier 0 is shippable in days and
removes most real-world impact; Tier 1 is the correct long-term isolation model;
Tier 2 hardens supply chain and multi-tenancy.

### Tier 0 — Stop the bleeding (no architecture change)

1. **Strict CSP** in `tauri.conf.json` and as server response headers. The
   critical directive is a tight `connect-src` allowlist (`'self'` +
   `https://wealthfolio.app`) so addons cannot exfiltrate. Constrain
   `script-src` to `'self' blob:`. Note the residual: allowing `blob:` in
   `script-src` is what keeps the current loader working, but it also means CSP
   does **not** constrain addon _code execution_ — only its network egress. The
   `connect-src` allowlist is doing the real work here; full script isolation
   waits for Tier 1. (S3)
2. **Set `withGlobalTauri: false`** and tighten the `fs` capability scope below
   `$APPDATA/**`. The host app doesn't use the global bridge, so this is a
   no-app-change removal of a direct filesystem/IPC primitive from addon reach.
   (S12)
3. **Validate `addon_id`** with a strict regex — e.g.
   `^[a-z0-9][a-z0-9._-]{0,63}$`, explicitly rejecting `.`-only, `..`, `/`, `\`
   — at every service/command/route entry. (S6)
4. **Enforce approved permissions when building `ctx.api`.** Store the granted
   category set in the manifest; have `createAddonContext` include **only**
   granted namespaces and return `undefined`/throw for the rest. This makes the
   dialog meaningful without any sandbox work. (S1, partially S5)
5. **ZIP limits + byte reads.** Cap entry count, per-file size, and total
   uncompressed size; read entries as bytes. (S11)
6. **Fail closed on analysis failure** — deny install, don't fall through. (S7)
7. **De-globalize** the `__wealthfolio_*`, `React`, and `ReactDOM` handles
   behind a non-enumerable closured accessor. (S10)

### Tier 1 — Real isolation: sandboxed iframe + postMessage RPC broker

Run each addon in a **sandboxed `<iframe sandbox="allow-scripts">`** (UI addons)
or a **Web Worker** (headless), with **no direct host access**. The host exposes
the API over `postMessage` RPC. The RPC router becomes the **single enforcement
point**: it checks the calling addon's granted capabilities per call, validates
arguments, and rate-limits.

```
Addon iframe                         Host SPA
────────────                         ──────────────────────────────
ctx.api.portfolio.getHoldings()  ──postMessage──►  RPC broker
                                                    ├─ verify addon identity (iframe origin)
                                                    ├─ check granted capability
                                                    ├─ validate args
                                                    └─ call local adapter (invoke) / HTTP
                                     ◄──postMessage── result
```

Why this is the right model for **both** platforms:

- Addon code cannot touch `window`, the Tauri IPC, secrets, or other addons.
- Permissions are **actually enforced** at the broker — deny by capability, not
  detected by substring. S1, S4, S5, S10, and S12 collapse into "the broker is
  the only door" — the iframe has no `window.__TAURI__`, no `fs` plugin, and no
  host globals.
- Identical design in Tauri and web — the broker just dispatches to the local
  adapter (`invoke`) or to HTTP.
- Backend identity is solved: the broker attaches the verified addon id to every
  brokered call, so Rust can scope secrets server-side (an addon physically
  cannot name another addon's secret).

**Layout model.** Only the _content slot_ is the iframe; the host still renders
the sidebar, header, and routes. See §6 for the UX analysis — SPA navigation,
toasts, and query invalidation are preserved because they already go through the
`ctx.api` bridge; the iframe just makes that indirection explicit.

**Alternative isolation mechanisms** (for reference):

| Approach                | Isolation       | DX   | Notes                                                                   |
| ----------------------- | --------------- | ---- | ----------------------------------------------------------------------- |
| Same context (current)  | None            | Best | Addon can access `window`, crash host                                   |
| Sandboxed iframe        | Strong DOM + JS | Good | Figma's model for plugin UI                                             |
| Web Worker              | Strong JS       | Poor | No DOM; awkward for React UI                                            |
| SES / Compartments      | Strong JS       | Good | MetaMask Snaps' model; same-realm, no iframe; `endo`/`ses` runtime      |
| Separate Tauri WebView  | Process-level   | Good | Tauri supports `WebviewWindow` natively                                 |
| Tauri Isolation Pattern | IPC broker      | Good | Native Tauri feature; sandboxed iframe validates every IPC message      |
| ShadowRealm             | Strong JS       | Fair | TC39 proposal, stalled; **no shipping browser support** — not near-term |

Recommendation: **sandboxed iframe** for UI addons (Figma model), **Web Worker**
for headless/background addons. If a future direction wants same-realm isolation
without an iframe (better DX for React), **SES/Compartments** is the proven path
— it is exactly how MetaMask Snaps runs untrusted third-party plugins in a
financial product. On the IPC side specifically, enabling Tauri's **Isolation
Pattern** is a native, lower-effort complement that validates every
webview→backend message through a sandboxed broker iframe.

> Naming note: the repo already contains `apps/frontend/src/lockdown.ts`, but it
> is a **UI** lockdown (disables context menu, copy/cut/select-all) and is
> unrelated to Agoric SES `lockdown()`. Don't confuse the two when evaluating
> the SES option.

### Tier 2 — Network broker, supply chain, multi-tenancy

**Network access via a host-brokered, manifest-allowlisted proxy
(Chrome-extension model).** Rather than let addons `fetch()` freely (blocked by
the Tier 0 CSP anyway), give them an explicit `ctx.api.http` whose requests are
validated against a declared host allowlist and executed by the Rust backend
(which is also CORS-free):

Manifest declares network permissions:

```json
{
  "permissions": [
    {
      "category": "http",
      "hosts": [
        "https://gdcdyn.interactivebrokers.com/*",
        "https://www.interactivebrokers.com/*"
      ],
      "purpose": "Fetch Flex Query statements from IBKR API"
    }
  ]
}
```

Tauri command proxies and validates:

```rust
#[tauri::command]
async fn addon_http_request(
    addon_id: String,          // supplied by the broker, not the addon
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let manifest = get_addon_manifest(&addon_id)?;
    if !manifest.allows_host(&url) {
        return Err("URL not in addon's allowed hosts".into());
    }
    let resp = reqwest::Client::new()
        .request(method.parse()?, &url)
        .headers(headers)
        .body(body.unwrap_or_default())
        .send().await?;
    Ok(HttpResponse { status: resp.status().as_u16(), /* headers, body */ })
}
```

SDK surface: `ctx.api.http.request(url, options)`. The allowed domains appear in
the permission dialog for user transparency. This is standard Tauri plumbing;
the design is not the hard part.

**Supply chain.** Sign addon packages (publisher key), verify signature +
integrity hash on install, and surface verified-publisher status in the dialog.
Removes blind trust in the download channel (`download_addon_from_store`
currently trusts TLS + backend only).

**Multi-tenancy (server mode).** Namespace `addons_root` per user, or make addon
management explicitly admin-only and document that addons run for all users.
Make auth **mandatory** for addon mutation routes rather than silently open when
`auth` is `None`. (S8)

### Module sharing (bundle size, orthogonal to isolation)

Addons currently rely on host globals for `React`/`ReactDOM`/UI. Two better
options:

- **Import maps** (browser-native): the host declares `react`,
  `@wealthfolio/ui`, `@tanstack/react-query` → addon ESM bundles just `import`
  them and the browser resolves to the host copy. Zero addon-side config;
  bundles drop from ~1.8 MB to ~100–200 KB. Works cleanly with the iframe model
  (inject the import map into the iframe document before the addon loads).
  **WebView caveat:** import maps need a recent engine — Safari 16.4+ (macOS
  WKWebView), a recent WebKitGTK (Linux), and any WebView2 (Windows, Chromium).
  Older macOS/Linux system webviews silently won't resolve them, so verify the
  minimum-supported OS/webview before relying on this. If coverage is a problem,
  a build-time `externals` mapping to a single host-provided global is the
  fallback (roughly what exists today, but explicit).
- **Module Federation v2** (Rspack/Webpack): singleton negotiation at runtime;
  powerful for large micro-frontend ecosystems but significant tooling overhead.
  Overkill here.

Recommendation: **import maps**, short term, independently of the isolation
work.

---

## 6. UX analysis of the iframe model (navigation, chrome, redirects)

A common concern: does sandboxing cost the SPA feel — cross-app navigation,
redirects to native pages, toasts? For the content-slot iframe model, **almost
nothing is lost**, because the host stays in charge of routing and chrome.

**Layout.** Only the page body is the iframe:

```
┌─────────────────────────────────────────────────┐
│  Host SPA                                        │
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ Sidebar  │  │  Content area                │ │
│  │ (host)   │  │  ┌────────────────────────┐  │ │
│  │ nav works│  │  │  <iframe> addon body   │  │ │
│  └──────────┘  │  └────────────────────────┘  │ │
│                └──────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Preserved for free** (already routed through `ctx.api` today): SPA navigation
via host `<NavLink>`, `navigateToRoute`, toasts, query invalidation, layout
chrome.

**Cross-app navigation from an addon** (e.g. addon → asset detail page) works
unchanged. The addon does not navigate itself — it _asks_ the host to navigate;
the host owns the router:

```
Addon iframe                          Host SPA
ctx.api.navigateToRoute('/assets/AAPL')
   └─postMessage──►  navigate('/assets/AAPL')
                      React Router navigates
                      addon iframe unmounts
                      asset detail page renders
```

The only change is the call travels through `postMessage` instead of touching
`window.__wealthfolio_navigate__` directly — **the addon code does not change.**
UX is identical to clicking any host link.

**Needs explicit re-bridging** when moving to an iframe:

| Concern                      | Today                | With iframe                                            |
| ---------------------------- | -------------------- | ------------------------------------------------------ |
| CSS theme vars               | shared automatically | inject into iframe document on mount + on theme change |
| Privacy/balance-blur context | shared React context | `postMessage` on change                                |
| Query cache                  | same `QueryClient`   | already brokered                                       |
| Keyboard shortcuts           | app-wide             | can break at iframe boundary; delegate                 |
| Focus management             | native               | explicit `tabindex`/focus delegation                   |

CSS variables are the biggest item — inject the host's theme vars (or full
`<style>`) into `iframe.contentDocument` on mount and whenever the theme
changes. Figma does exactly this.

**Genuinely harder cases** (only affect addons that render _outside_ their
slot): full-app overlay modals, drag-drop crossing the iframe boundary, tooltips
that overflow and get clipped. A full-page content addon (e.g. a dividend
tracker) hits none of these. Provide host-brokered primitives (a
`ctx.ui.openModal`, a toast API — already present) for the cases that need to
escape the slot.

---

## 7. Prioritized remediation roadmap

| Priority | Item                                                                | Addresses                | Effort   |
| -------- | ------------------------------------------------------------------- | ------------------------ | -------- |
| **P0**   | Strict CSP with `connect-src` allowlist                             | S3, mitigates S1/S2      | Low      |
| **P0**   | `withGlobalTauri: false` + tighten `fs` capability scope            | S12                      | Low      |
| **P0**   | Validate `addon_id` at every entry point                            | S6                       | Low      |
| **P0**   | Enforce approved permissions when building `ctx.api`                | S1, part of S5           | Low–Med  |
| **P0**   | Fail closed on permission-analysis failure                          | S7                       | Low      |
| **P1**   | ZIP entry/size limits; read bytes not `String`                      | S11                      | Low      |
| **P1**   | Consolidate to a single `AddonService`; delete duplicate Tauri path | §4                       | Med      |
| **P1**   | De-globalize `__wealthfolio_*` / `React` / `ReactDOM` handles       | S10                      | Low      |
| **P1**   | Per-user addon roots + mandatory auth (server)                      | S8                       | Med      |
| **P1**   | Enable Tauri Isolation Pattern (IPC broker)                         | S4, S12                  | Low–Med  |
| **P2**   | Sandboxed iframe/Worker + `postMessage` RPC broker                  | S1, S2, S4, S5, S10, S12 | High     |
| **P2**   | Host-brokered `ctx.api.http` with manifest host allowlist           | network access           | Med      |
| **P2**   | Package signing + verified publishers                               | S5 (trust), supply chain | Med–High |
| **P3**   | Import maps for shared modules (bundle size)                        | DX / size                | Low–Med  |
| **P3**   | Single source of truth for the permission table                     | §4                       | Med      |

The **P0** items are small, self-contained, and independently shippable;
together they convert the permission system from cosmetic to enforced, remove
the direct filesystem/IPC primitive from addon reach on desktop (S12), and close
the exfiltration and traversal holes without touching the isolation model.

---

## 8. Open questions

1. **Is web/server mode intended for multi-user deployments?** Determines the
   urgency of S8 (per-user addon roots vs. admin-only).
2. **Must addons render React directly into the host tree today,** or is the
   content-slot iframe model acceptable? This decides whether we can reach Tier
   1 or are constrained to Tier 0/1 enforcement only.
3. **Is there an addon store backend we control** that could host
   signatures/publisher keys for Tier 2 signing?
4. **What is the compatibility commitment to already-published addons?** Runtime
   permission enforcement (P0 #3) and the iframe model (P2) are potentially
   breaking for addons that reach outside `ctx`.
