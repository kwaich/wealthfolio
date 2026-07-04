# Wealthfolio i18n Implementation Plan

Status: partially implemented · Owner: TBD · Last updated: 2026-07-02

## 0. Implementation status (as built)

**Done & verified** (`pnpm --filter frontend type-check` + full test suite (977)

- `cargo check` all green):

* Runtime: `src/i18n/i18n.ts` (lazy-loaded locales, no detector),
  `src/i18n/locales.ts`.
* Locale content: **en + fr + de** across all 9 namespaces (~1,213 keys). FR is
  100% (from PR #416); DE is ~65% (value-joined from PR #845), rest falls back
  to English. `{var}` → `{{var}}` converted.
* Backend: `language` field added to `Settings` (Rust model + sqlite repository,
  no migration) and the TS `Settings` type.
* Language switcher: `components/language-selector.tsx`, General settings card
  (`settings/general/language-settings.tsx`, next to Timezone), and onboarding
  (`onboarding-appearance.tsx`). Applied via the settings provider.
* Tooling: `i18next.config.ts`, `i18n:extract|status|lint|types` scripts,
  `scripts/i18n-remap.mjs`, `src/i18n/README.md`. Test i18n init in
  `test/setup.ts`.

**Partial** — component string conversion. A parallel-agent pass wired only ~35
strings across ~12 files before the agents stalled (watchdog). The
infrastructure is complete, so the remaining conversion is a repeatable crank
(Phase 3): use the per-namespace English→key dictionaries + `t()` wiring, or
`i18next-cli instrument`, verifying `type-check`/tests each namespace.

**Not started**: locale-aware number/currency/date formatting (§4, real gap —
formatters hard-code `en-US`), `packages/ui` strings (scope caveat in §4 Phase
0), CI gates (§5), community platform (§6), `language` device-sync (§7 note).

## 1. Goal & guiding principles

Add multi-language support to the Wealthfolio frontend so the OSS community can
contribute and own translations, without a fragile bespoke pipeline.

Principles:

- **i18next JSON is the source of truth.** Plain, greppable, PR-reviewable,
  compatible with every translation platform.
- **Tool-maintained keys.** `i18next-cli` extracts/syncs keys; no hand-merging.
- **Preserve human translations.** The FR (PR #416) and DE (PR #845) work is the
  expensive asset — recover it by joining on English source text, not key names.
- **Feature namespaces, not one giant file.** Small files = fewer merge
  conflicts across simultaneous community translation PRs.
- **Formatting via `Intl`, not JSON.** Currency/number/date localization is a
  runtime concern keyed off the active locale.
- **Frontend-only for v1.** Rust backend strings are a later, separate effort.

## 2. Stack decisions

| Concern                  | Decision                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                  | `i18next` + `react-i18next` (no `i18next-browser-languagedetector` — language is an explicit stored setting)                                                                 |
| Extraction / maintenance | `i18next-cli` (`instrument`, `extract`, `status`, `lint`, `types`)                                                                                                           |
| Interpolation            | i18next default `{{var}}` (NOT PR #416's non-standard `{var}`)                                                                                                               |
| Namespaces               | `common`, `dashboard`, `holdings`, `activity`, `performance`, `account`, `settings`, `goals`, `income` (from PR #416; extend as needed)                                      |
| Key style                | Semantic, feature-prefixed (e.g. `account.page.actions.holdings`)                                                                                                            |
| Locale file layout       | `apps/frontend/src/i18n/locales/{{lng}}/{{ns}}.json`                                                                                                                         |
| Loading                  | `i18next-resources-to-backend` lazy dynamic imports (avoids bundling all locales into initial web load)                                                                      |
| Fallback                 | `fallbackLng: "en"`, `load: "languageOnly"` (`fr-CA` → `fr`)                                                                                                                 |
| Language preference      | **Explicit stored setting** — `language` field in `Settings`, set in onboarding + General settings. **No browser auto-detect.** Driven by the settings provider (see §5/§7). |
| AI draft translations    | Lingo.dev CLI or Locize, BYO key, build-time, human-reviewed. Never runtime MT.                                                                                              |
| Community workflow       | Weblate or Tolgee (deferred to §8).                                                                                                                                          |

## 3. Migration strategy: CLI-first with English-source value join

The two PRs already contain reviewed translations keyed to their own schemes. We
regenerate keys cleanly with `i18next-cli`, then re-attach the human
translations by matching on the **English source string** (the column both the
CLI output and the PR files share).

```
new_fr[cliKey] = pr416_fr[ pr416_key where pr416_en == new_en[cliKey] ]
new_de[cliKey] = pr845_de[ pr845_key where pr845_en == new_en[cliKey] ]
```

Expected auto-match ~70–90%; normalize both sides (trim, collapse whitespace,
lowercase, strip trailing punctuation, unify `{var}`→`{{var}}`) before joining
to raise the rate. Scope the join **per namespace** to disambiguate context
duplicates (e.g. "Balance" meaning different things in `account` vs
`dashboard`). Everything unmatched becomes an explicit gap to draft + review.

## 4. Phased implementation

Each phase has a verifiable exit check (per repo behavioral guidelines).

### Phase 0 — Scaffolding & config

1. Add deps to `apps/frontend`: `i18next`, `react-i18next`,
   `i18next-resources-to-backend`; dev dep `i18next-cli`. (No
   `i18next-browser-languagedetector` — language is an explicit stored setting,
   not auto-detected.)
2. Create `apps/frontend/src/i18n/i18n.ts` (ported from PR #416, adapted): lazy
   backend, `fallbackLng: "en"`, `load: "languageOnly"`, standard `{{ }}`
   interpolation. Init with `lng: "en"`; the actual language is applied by the
   settings provider once settings load (see §5). No detector.
3. Create `apps/frontend/i18next.config.ts`:
   ```ts
   import { defineConfig } from "i18next-cli";
   export default defineConfig({
     locales: ["en", "fr", "de"],
     extract: {
       input: ["src/**/*.{ts,tsx}"],
       output: "src/i18n/locales/{{language}}/{{namespace}}.json",
       defaultNS: "common",
       // feature namespaces resolved from key prefixes / useTranslation(ns)
     },
   });
   ```
4. Import `./i18n/i18n` in `apps/frontend/src/main.tsx` (before `<App />`), wrap
   render tree in `<Suspense>` for lazy locale loading.
   - **Verify:** app boots in English, `npm run type-check` passes, no console
     i18n warnings.

**Scope caveat — `packages/ui`.** The `input` glob only covers
`apps/frontend/src`. The shared `@wealthfolio/ui` package has its own
user-facing copy (e.g. "Find in table…", "No results", aria labels in
[packages/ui/src/components/data-grid/data-grid-search.tsx](../packages/ui/src/components/data-grid/data-grid-search.tsx)).
Those will **not** be translated by this setup. Decide per component: either (a)
push copy up to app-level props so the app owns the strings, or (b) give
`packages/ui` its own i18next wiring and add it to the extraction input. Until
then, the "all user-facing frontend strings" success criterion (§11) is scoped
to `apps/frontend` only.

### Phase 1 — Proof-of-concept on ONE namespace (`settings`)

1. `npx i18next-cli instrument --namespace settings --interactive` over
   `src/pages/settings/**` → wraps strings, injects `useTranslation`, generates
   keys + English defaults.
2. `npx i18next-cli extract --sync-primary` → `en/settings.json`.
3. Run the remap script (§6) to attach PR #416 FR + PR #845 DE for `settings`.
4. Measure and record the auto-match rate; hand-fix the tail.
   - **Verify:** settings pages render in en/fr/de; switch language and confirm
     live; `status --namespace settings` shows ~100% for fr/de after fixes.
   - **Gate decision:** if match rate & effort look good, proceed; else adjust
     normalization or reconsider key-preservation.

### Phase 2 — Language as a stored setting: switcher + onboarding (see §5/§7)

- Add `language` to the `Settings` model (frontend + Rust; no SQL migration —
  §7), wire the settings provider to apply it via `i18n.changeLanguage`.
- Add a Language selector to General settings, **next to Timezone**.
- Add a language step/field to the onboarding flow.
  - **Verify:** picking a language in onboarding or General updates the UI
    immediately and persists across restart.
  - **Note:** language is stored **per-device**, like `theme`/`baseCurrency`.
    Device-sync deliberately allowlists only spending-related `app_settings`
    keys
    ([crates/storage-sqlite/src/sync/app_sync/repository.rs](../crates/storage-sqlite/src/sync/app_sync/repository.rs))
    — `theme` is explicitly excluded and tested. To make `language` sync across
    devices, add its key to that allowlist (out of scope for v1).

### Phase 3 — Roll out namespace by namespace

Repeat Phase 1 loop for each namespace: `common`, `dashboard`, `holdings`,
`activity`, `performance`, `account`, `goals`, `income`.

- Prefer harvesting PR #845's already-wrapped components (current monorepo
  layout, ~4,700 keys) where they exist; run `instrument` only on gaps.
- Split PR #845's single `common.json` into feature namespaces by key prefix
  (its keys are already prefixed like `account.*`, `dashboard.*` → mechanical).
  - **Verify per namespace:** `type-check` + `lint` (no new hardcoded strings)
    - `status` coverage report.

### Phase 4 — Formatting localization (currency / number / date)

- **Existing formatters hard-code / cache `en-US`** and must be made
  locale-aware — this is a real blocker for the "1 234,56 €" outcome:
  - [apps/frontend/src/lib/utils.ts](../apps/frontend/src/lib/utils.ts)
    (~line 276)
  - [packages/ui/src/lib/utils.ts](../packages/ui/src/lib/utils.ts) (~line 16)
  - Both memoize `Intl.NumberFormat`/`DateTimeFormat` instances; the cache key
    must include the active locale, and the locale must be threaded in (via a
    shared formatter helper that reads `i18n.language`, or an explicit `locale`
    param). Until this lands, numbers/dates stay `en-US` regardless of language.
- Route currency display names through `Intl.DisplayNames` (from PR #416).
- Numbers via `Intl.NumberFormat`, dates via `date-fns` locales (already a dep),
  both keyed off the active i18next language. Do NOT store formatted strings in
  JSON.
- French typography: narrow non-breaking space (U+202F) before `! ? : ;` (from
  PR #416) — apply in translations, not code.
  - **Verify:** switch to fr/de and confirm `1 234,56 €` style formatting and
    localized dates.

### Phase 5 — CI gates & types

1. `npx i18next-cli extract --ci` (fails if code/JSON drift).
2. `npx i18next-cli lint` (advisory at first — it flags every remaining
   hardcoded string, so don't hard-gate until conversion is broadly complete).
3. `npx i18next-cli types --ci` — the **check-only** drift gate (plain `types`
   just writes generated files; `--ci` fails when they're stale).
4. Add to `.github/workflows/pr-check.yml`.
   - **Verify:** CI red on an intentionally-unsynced key; green when synced.

### Phase 6 — Community workflow (deferred, §8)

Stand up Weblate/Tolgee once contributor demand appears. No code change to the
file format — platforms read the same namespaced JSON.

## 5. Language selector — concrete changes

Language is an **explicit user setting**, stored like `timezone`. It is chosen
in onboarding and editable in **General settings, next to Timezone**. No browser
auto-detection.

### Frontend

- **`apps/frontend/src/components/language-selector.tsx`** (new)
  - Reusable, mirrors
    [`theme-selector.tsx`](../apps/frontend/src/components/theme-selector.tsx) /
    `font-selector.tsx`: takes `value` + `onChange`, renders a `Select` of
    `supportedLngs` with native language names (e.g. "English", "Français",
    "Deutsch").
- **`apps/frontend/src/pages/settings/general/language-settings.tsx`** (new)
  - Card + form mirroring
    [`timezone-settings.tsx`](../apps/frontend/src/pages/settings/general/timezone-settings.tsx):
    reads `settings.language`, writes via `updateSettings({ language })` from
    `useSettingsContext()`.
- **`apps/frontend/src/pages/settings/general/general-page.tsx`**
  - Render `<LanguageSettings />` immediately after `<TimezoneSettings />`.
- **Settings provider**
  ([`lib/settings-provider.tsx`](../apps/frontend/src/lib/settings-provider.tsx))
  - Add `"language"` to the `updateSettings` `Pick<Settings, …>` union.
  - In `applySettingsToDocument(settings)` call
    `i18n.changeLanguage(settings.language || "en")` — this is what actually
    switches the UI language, on initial load and on every settings change. This
    replaces the browser detector.
- **Types** ([`lib/types.ts:841`](../apps/frontend/src/lib/types.ts)) — add
  `language: string` to `Settings`.
- **Supported-locales constant** in `src/i18n/i18n.ts`
  (`supportedLngs: ["en", "fr", "de"]`) — the selector reads this list, so
  adding a language is a one-line change.

### Onboarding

- Add a language field to the onboarding flow (the same `<LanguageSelector />`),
  written through the existing onboarding settings save. Pre-selection defaults
  to **`en`** — no OS/browser detection at all.

Because settings drive the language, there is no separate `localStorage` cache
to reconcile; the stored `language` setting is the single source of truth. It is
persisted **per-device** (not device-synced — see the note in §4 Phase 2).

## 6. Remap script (`apps/frontend/scripts/i18n-remap.mjs`)

One-off helper, ~50 lines, run per namespace:

1. Load PR #416 `fr/*` (+ its `en/*`) and PR #845 `de/*` (+ its `en/*`) from
   their branches (or vendored snapshots under `scripts/_i18n_seed/`).
2. Build normalized maps: `normalize(englishValue) -> translation`.
3. For each key in the freshly extracted `en/<ns>.json`, look up fr/de by the
   normalized English value; write matches into `fr/<ns>.json` / `de/<ns>.json`.
4. Emit `i18n-remap-report.json`: matched / unmatched counts + unmatched keys.

`normalize()` = trim, collapse internal whitespace, lowercase, strip trailing
`.,:;!?`, convert `{x}`→`{{x}}`. Keep it conservative to avoid false joins;
prefer leaving a key untranslated over mis-translating it.

## 7. Backend: `language` in Settings (no SQL migration)

Settings are stored as generic **key-value pairs** (`app_settings` table:
`setting_key` / `setting_value`) with a typed `Settings` struct as the view.
Adding `language` therefore needs **no database migration** — only struct +
repository field wiring. Mirror exactly how `timezone` is handled.

Rust (`crates/core` + `crates/storage-sqlite`):

- [`crates/core/src/settings/settings_model.rs`](../crates/core/src/settings/settings_model.rs)
  - Add `pub language: String` to `Settings` + `Default` (`"en"`).
  - Add `pub language: Option<String>` to `SettingsUpdate`.
- [`crates/storage-sqlite/src/settings/repository.rs`](../crates/storage-sqlite/src/settings/repository.rs)
  - `get_settings`: add match arm `"language" => settings.language = value`.
  - `update_settings`: add a block writing `setting_key: "language"` (copy the
    `timezone` block).
  - `get_setting` defaults: add `"language" => "en"`.
- Verify `apps/server` reuses the core settings service (it does via the shared
  crate) — no separate handler change expected.

Frontend:

- Add `language: string` to `Settings` and `language?` to any `SettingsUpdate`
  type in [`lib/types.ts`](../apps/frontend/src/lib/types.ts).
- The Tauri and web adapters pass the partial through unchanged (generic
  `update_settings` payload) — no per-field adapter edits needed.

- **Verify:** `cargo test -p wealthfolio-core` (settings) passes; setting
  language persists across restart and round-trips through `get_settings`.

## 8. Deferred: community translation workflow

- **Weblate** (OSS, self-host or free libre hosting, git-native, opens PRs) —
  best ethos fit; or **Tolgee** (OSS, official docker-compose, in-context edit)
  if the earlier docker-compose interest still stands; or **Crowdin** (free OSS
  plan, lowest setup).
- All consume the same `locales/{{lng}}/{{ns}}.json`. Adopt when non-developer
  translators or unreviewed languages appear.

## 9. Non-JSX & backend strings (later)

- Non-JSX UI strings (action-object `label:`s, toasts, zod messages, table
  column defs): `instrument` catches some; finish by hand, guided by `lint`.
- Rust backend error messages: map error **codes** → frontend translations
  (keeps all UI text in one i18next system). Don't localize Rust in v1.

## 10. Risks & mitigations

| Risk                                             | Mitigation                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `instrument` heuristic false +/-, big noisy diff | Run per-namespace, `--dry-run` then `--interactive`, review each; commit before proceeding |
| Low remap auto-match                             | Normalize aggressively; accept manual tail; measure in Phase 1 before scaling              |
| Context-duplicate English mistranslated          | Join per namespace; review collisions                                                      |
| Interpolation/plurals not auto-handled           | Manual cleanup; standardize on `{{var}}` early                                             |
| PR #416 stale layout / `{var}`                   | Take its design not its diff; convert interpolation                                        |
| PR #845 scope creep (taxonomy refactor)          | Harvest only its i18n keys/wrapping; leave refactor to its own PR                          |
| Web bundle bloat                                 | Lazy-load via `i18next-resources-to-backend`                                               |

## 11. Success criteria

- App fully usable in en / fr / de; language switch is live and persists.
- All user-facing frontend strings resolve via i18next (lint clean).
- `extract --ci` and `lint` gate the pipeline in CI.
- fr/de coverage ≥95% (`status`), remainder tracked as gaps.
- Adding a new language = drop a `locales/<lng>/` folder + one line in
  `supportedLngs`; no code changes.

## 12. Open questions

1. **Key preservation vs regeneration** — confirmed approach: regenerate with
   CLI + English-value join. OK to discard PR key names? (assumed yes)
2. ~~Language storage~~ — **Decided:** explicit stored `language` setting
   (onboarding + General near Timezone), no browser detection, no migration
   (§7).
3. ~~Launch language set~~ — **Decided:** ship with **en + fr + de** (en source;
   fr from PR #416, de from PR #845). More languages later via AI drafts +
   community.
4. **AI draft engine** — Lingo.dev CLI (BYO Anthropic/Ollama key) vs Locize
   (pairs natively with i18next-cli)?
5. **Community platform** — Weblate vs Tolgee vs Crowdin, and self-host vs
   hosted? (only blocks Phase 6)
6. **PR #845 taxonomy refactor** — extract as a separate PR, or drop entirely?
