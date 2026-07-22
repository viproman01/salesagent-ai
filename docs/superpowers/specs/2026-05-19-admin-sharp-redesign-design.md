# Spec — `admin/` Sharp Redesign

**Date:** 2026-05-19
**Target:** `salesagent-ai/admin` (React 18 + Vite + Tailwind + react-router 7)
**Goal:** "Неимоверно чёткий" operator-grade dashboard for SalesAgent AI — Linear/Vercel/Stripe-grade density and clarity, with Kaspi-style tactile precision.

---

## 1. Vision

Не Apple "wow"-лендинг, а **операторская рабочая поверхность** менеджера продаж: каждая страница — рабочий инструмент. Высокая плотность, sharp typography, табличные числа, мгновенная навигация (cmd+K, hotkeys), быстрые загрузки (lazy chunks, virtualization).

Целевые качества:
- **Density**: на 1080p помещается в 1.5× больше полезной информации, чем сейчас
- **Sharpness**: 0 размытых краёв, 1px borders, integer letter-spacing, no fuzzy shadows
- **Speed**: TTI < 1.5s on broadband, route-switch < 100ms (lazy + cache)
- **Cohesion**: единая палитра, spacing scale, motion timing curve по всем экранам

---

## 2. Design System (`src/ui/`)

### 2.1 Tokens — CSS vars

```css
:root {
  /* spacing — 4px base */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px;
  --s-6: 24px; --s-8: 32px; --s-10: 40px; --s-12: 48px; --s-16: 64px;

  /* radii */
  --r-1: 4px; --r-2: 6px; --r-3: 8px; --r-4: 12px; --r-full: 9999px;

  /* depth */
  --d-1: 0 1px 0 rgb(0 0 0 / .05);
  --d-2: 0 1px 2px rgb(0 0 0 / .08), 0 1px 1px rgb(0 0 0 / .04);
  --d-3: 0 8px 24px rgb(0 0 0 / .12);

  /* timing */
  --t-fast: 120ms cubic-bezier(.2,.8,.2,1);
  --t-med:  200ms cubic-bezier(.2,.8,.2,1);
}

[data-theme="dark"] {
  --bg-0: #0a0b0d;  --bg-1: #101216; --bg-2: #181b21;
  --fg-0: #f5f6f8;  --fg-1: #b9bec7; --fg-2: #6b7280;
  --line:  #23272f;
  --accent: #00b14f;        /* Kaspi green */
  --accent-fg: #ffffff;
  --danger: #ef4444; --warn: #f59e0b; --ok: #10b981;
}

[data-theme="light"] {
  --bg-0: #ffffff;  --bg-1: #f7f8fa; --bg-2: #eef0f4;
  --fg-0: #0a0b0d;  --fg-1: #4b5563; --fg-2: #9ca3af;
  --line:  #e5e7eb;
  --accent: #00b14f; --accent-fg: #ffffff;
  --danger: #ef4444; --warn: #f59e0b; --ok: #10b981;
}
```

Tailwind extends through `theme.extend.colors` mapped to `var(--bg-0)` etc., so utilities `bg-bg-1 text-fg-0 border-line` work natively.

### 2.2 Typography

- Font: **Inter Tight** (variable, self-hosted woff2) — primary
- Numerals: `font-variant-numeric: tabular-nums` on all metric/table cells
- Scale: 11/12/13/14/16/20/24/32 px; line-heights 1.2 for headings, 1.5 for body
- Letter-spacing: -0.01em on 16+, 0 below

### 2.3 Primitives (`src/ui/`)

| File | Purpose |
|------|---------|
| `Button.tsx` | variants: primary/secondary/ghost/danger; sizes: sm/md; icon-only mode |
| `Input.tsx` | text/email/password; label, hint, error; left/right slot |
| `Card.tsx` | container with `--d-1`, header/body/footer slots |
| `Badge.tsx` | semantic colors (ok/warn/danger/neutral), sm/md |
| `Skeleton.tsx` | animated shimmer; presets: text/avatar/row/card |
| `EmptyState.tsx` | icon + title + sub + optional action |
| `Toast.tsx` | wrap `sonner` with our styles |
| `Modal.tsx` | dialog with backdrop, focus-trap, esc-to-close |
| `Tooltip.tsx` | radix tooltip styled |
| `Tabs.tsx` | underline style, keyboard nav |
| `DropdownMenu.tsx` | radix menu styled |
| `KBD.tsx` | render keyboard hint chips (`⌘K`) |

Deps add: `@radix-ui/react-tooltip`, `@radix-ui/react-dialog`, `@radix-ui/react-tabs`, `@radix-ui/react-dropdown-menu`, `sonner`, `cmdk`, `@tanstack/react-virtual`.

### 2.4 Theme bootstrap

`src/lib/theme.ts` — `getInitialTheme()` reads `localStorage.theme` or `prefers-color-scheme`, sets `data-theme` on `<html>` pre-React (inline script in `index.html` to avoid FOUC).

---

## 3. Shell

### 3.1 Sidebar — `src/components/Sidebar.tsx` (rewrite)

- Width: 56px collapsed (default), 220px expanded (toggle, localStorage)
- Logo at top, items as icon+tooltip when collapsed, icon+label expanded
- Badge counts per item (Conversations: unread, Recordings: new)
- Bottom: theme toggle, user avatar dropdown (logout)
- Active route: 2px left accent bar + `bg-bg-2` row

### 3.2 Topbar — new `src/components/Topbar.tsx`

- Breadcrumbs (current page title + sub if relevant)
- Center: global search trigger button `⌘K` (opens command palette)
- Right: notifications bell (placeholder), help `?`, user pill
- Height 48px, sticky, `border-b border-line`

### 3.3 Command Palette — new `src/components/CommandPalette.tsx`

Use `cmdk`. Open with `⌘K`/`Ctrl+K`. Groups:
- **Navigate**: all routes (g d / g c / g r / g k / g a / g v / g h)
- **Actions**: new conversation, upload file, toggle theme, logout
- **Search**: conversations, recordings, KB docs (fetch with debounce)

Global hotkey listener in `src/hooks/useHotkeys.ts`: registers `g d`, `g c`, etc. (sequence with 1s timeout), `⌘K`, `⌘\` (toggle sidebar), `?` (help modal).

---

## 4. Pages

### 4.1 Dashboard — `src/pages/Dashboard.tsx`

Layout 12-col grid:
- Row 1: 4 KPI cards (Total conv, Conversion %, Avg response, Active agents) — each with sparkline
- Row 2: Funnel chart (8 cols) + Top agents leaderboard (4 cols)
- Row 3: Live activity feed (12 cols) — last 20 events, auto-poll 10s

Components: `KPICard`, `Sparkline` (recharts mini), `FunnelChart` (refactor existing), `AgentLeaderRow`, `ActivityFeed`.

### 4.2 Conversations — `src/pages/Conversations.tsx`

**Split view:**
- Left: list 380px wide, virtualized (`@tanstack/react-virtual`), each row 64px (avatar, name, last-msg preview, channel icon, time, unread dot)
- Right: detail (`ConversationView` reused, restyled) — header (contact info + actions), messages (scroll), reply composer (multiline, attach, send `⌘+Enter`)

**Filter chip row** above list: channel (all/whatsapp/telegram/instagram/voice), status (open/closed/snoozed), agent, date range.

Search box top of list.

### 4.3 Recordings — `src/pages/Recordings.tsx`

Three-panel:
- Left: list of recordings (virtualized) — date, duration, agent, sentiment badge
- Center top: waveform with scrub (wavesurfer existing) + transport controls + speed (0.75/1/1.25/1.5/2×)
- Center bottom: synced transcript — click line jumps to time, currently-playing line highlighted
- Right: details — call meta, AI summary, action items, sentiment timeline

Search in transcript bar.

### 4.4 Knowledge — `src/pages/Knowledge.tsx`

Grid of file/url cards, drag-drop upload zone over whole panel. Each card: type icon, name, size/url, tag chips, updated. Click → preview drawer.

Filters: type (pdf/url/docx/md), tags. Search.

### 4.5 Agents — `src/pages/Agents.tsx`

Cards 3-col. Each: name, channel(s), status toggle (active/paused), perf metrics (conv this week, conv %), "Edit prompt" → drawer with `<textarea>` (auto-resize, monospace, max-h 70vh) + variable-chip insert row (`{{name}}` etc.). "Test" → opens VoiceTest pre-filled.

### 4.6 VoiceTest / Chat — minor polish: consistent layout, KBD hints, loading states, error banners.

### 4.7 Login — `src/pages/Login.tsx`

Centered card 360px, mesh-gradient background (subtle, dark theme), brand mark top, email+password fields, "Sign in" primary, magic-link hint below. Form errors inline.

---

## 5. States

Everywhere:
- **Loading**: skeletons matching final layout (not spinners) — defined per page
- **Empty**: `EmptyState` with relevant icon + CTA
- **Error**: inline banner `border-l-2 border-danger` + retry action
- **Optimistic UI**: replies/toggles update immediately, rollback on failure

---

## 6. Performance

- Route-level `React.lazy` for all 7 pages → 7 chunks (current: 1 bundle)
- `@tanstack/react-query`: defaults `staleTime: 30_000`, `refetchOnWindowFocus: false`; per-key tuning where needed
- Lists > 50 items: `@tanstack/react-virtual`
- Icons: import per-icon from `lucide-react/dist/esm/icons/...` (tree-shake)
- Charts: `recharts` only on Dashboard route (already gated by lazy)
- Fonts: woff2 + `font-display: swap`, preload Inter Tight 400/500/600

Bundle target: initial JS ≤ 180KB gzip (currently ~280KB est).

---

## 7. Folder Structure (after)

```
admin/src/
├── App.tsx
├── main.tsx
├── index.css                # CSS vars + base
├── lib/
│   ├── theme.ts
│   ├── queryClient.ts       # react-query setup
│   ├── api.ts               # existing axios client (kept)
│   └── hotkeys.ts
├── ui/                      # NEW design-system primitives
│   ├── Button.tsx ...
├── components/              # composite
│   ├── Sidebar.tsx (rewrite)
│   ├── Topbar.tsx (new)
│   ├── CommandPalette.tsx (new)
│   ├── ConversationView.tsx (refactor)
│   ├── FunnelChart.tsx (refactor)
│   ├── MetricCard.tsx (replaced by KPICard)
│   ├── KPICard.tsx (new)
│   ├── Sparkline.tsx (new)
│   ├── ActivityFeed.tsx (new)
│   ├── AudioPlayer.tsx (refactor)
│   └── TranscriptView.tsx (new)
├── hooks/
│   ├── useHotkeys.ts (new)
│   └── ... existing
└── pages/
    └── ... (all rewritten with new primitives)
```

---

## 8. Migration Strategy

1. Land design system + theme + tailwind tokens (no visual break — old pages still render old way)
2. Add Topbar + new Sidebar + cmd palette (App shell)
3. Rewrite pages one-by-one, behind nothing (direct replace), commit per page
4. Add hotkeys + perf pass (lazy + virtual)
5. Final QA + bundle audit

Each step independently shippable.

---

## 9. Out of Scope (Phase 2)

- Real-time WebSocket updates (currently poll)
- AI-suggested reply chips in composer
- Multi-language UI (RU/KZ/EN switcher)
- Mobile breakpoints (admin is desktop-first; mobile = read-only later)
- E2E tests (Playwright) — add after design lands

---

## 10. Risks

- **Tailwind v3 + CSS vars**: works, but utility colors via `[var(--bg-0)]` are verbose. Mitigation: extend palette in `tailwind.config.js` to bind to vars, e.g. `colors: { bg: { 0: 'var(--bg-0)', ... } }`.
- **Recharts theming**: doesn't read CSS vars natively — pass `stroke`/`fill` from JS reading `getComputedStyle` or via Tailwind classes on container.
- **cmdk + radix focus**: known minor focus-trap interaction; pin versions.
- **Bundle bloat from radix**: each primitive ~3-6KB gzip; net add ~25KB acceptable for UX gain.

---

## 11. Success Criteria

- All 7 pages re-rendered with new primitives, theme toggle works, no console errors
- `⌘K` palette navigates and runs actions
- Conversations list scrolls smoothly with 1000+ items (virtualization confirmed)
- Lighthouse perf ≥ 90 (desktop), initial JS ≤ 180KB gzip
- Designer review (self): density audit — no page wastes > 30% whitespace
