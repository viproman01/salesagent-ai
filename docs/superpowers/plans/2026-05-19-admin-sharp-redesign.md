# Admin Sharp Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `salesagent-ai/admin` SPA as an operator-grade dashboard with a Linear/Vercel/Stripe-class design system, command palette, dark/light theme, virtualized lists, and lazy-loaded routes.

**Architecture:** Introduce a token-based design system under `src/ui/`, refactor app shell (Sidebar + Topbar + CommandPalette), then rewrite all 7 pages on top of the new primitives. Performance pass at the end (lazy routes, virtual scroll, icon tree-shake).

**Tech Stack:** React 18, Vite 6, TypeScript 5, Tailwind 3, react-router 7, @tanstack/react-query 5, recharts, wavesurfer.js. Added: @radix-ui (tooltip, dialog, tabs, dropdown-menu), `sonner`, `cmdk`, `@tanstack/react-virtual`.

**Working directory:** `/Users/admin/Documents/Проекты /Вайбкодинг/salesagent-ai/admin` for code, `salesagent-ai/docs/superpowers/` for docs. All commits go through `salesagent-ai` git repo (currently on `main`).

**Before starting:** Confirm with user whether to branch off `main` (recommended) or work on `main`. Default for this plan: create branch `feat/admin-sharp-redesign` and commit every task there.

---

## File Structure (target)

```
admin/src/
├── App.tsx                       # rewrite (lazy routes)
├── main.tsx                      # tweak (QueryClient defaults, theme bootstrap)
├── index.css                     # rewrite (CSS vars, base layer)
├── lib/
│   ├── theme.ts                  # NEW — getInitialTheme, setTheme
│   ├── hotkeys.ts                # NEW — sequence + chord parser
│   └── api.ts                    # EXISTING — keep
├── ui/                           # NEW design system
│   ├── Button.tsx
│   ├── Input.tsx
│   ├── Card.tsx
│   ├── Badge.tsx
│   ├── Skeleton.tsx
│   ├── EmptyState.tsx
│   ├── Tooltip.tsx
│   ├── Modal.tsx
│   ├── DropdownMenu.tsx
│   ├── Tabs.tsx
│   ├── KBD.tsx
│   ├── Toast.tsx                 # sonner wrapper
│   └── cn.ts                     # clsx helper
├── hooks/
│   ├── useTheme.ts               # NEW
│   ├── useHotkeys.ts             # NEW
│   └── ... existing
├── components/
│   ├── Sidebar.tsx               # rewrite
│   ├── Topbar.tsx                # NEW
│   ├── CommandPalette.tsx        # NEW
│   ├── KPICard.tsx               # NEW (replaces MetricCard)
│   ├── Sparkline.tsx             # NEW
│   ├── ActivityFeed.tsx          # NEW
│   ├── AgentLeaderRow.tsx        # NEW
│   ├── ConversationList.tsx      # NEW (virtualized list panel)
│   ├── ConversationView.tsx      # refactor (header + composer)
│   ├── ChipFilterRow.tsx         # NEW
│   ├── TranscriptView.tsx        # NEW (synced lines)
│   ├── WaveformPlayer.tsx        # rename/refactor AudioPlayer
│   ├── KnowledgeCard.tsx         # NEW
│   ├── UploadDropzone.tsx        # NEW
│   ├── AgentCard.tsx             # NEW
│   └── FunnelChart.tsx           # refactor (theme tokens)
└── pages/
    ├── Login.tsx                 # rewrite
    ├── Dashboard.tsx             # rewrite
    ├── Conversations.tsx         # rewrite
    ├── Recordings.tsx            # rewrite
    ├── Knowledge.tsx             # rewrite
    ├── Agents.tsx                # rewrite
    ├── VoiceTest.tsx             # polish
    └── Chat.tsx                  # polish
```

---

## Phase 0 — Branch + baseline

### Task 0: Create branch and verify baseline

**Files:** N/A (git only)

- [ ] **Step 1: Verify clean state and create branch**

Run from `salesagent-ai`:
```bash
cd "/Users/admin/Documents/Проекты /Вайбкодинг/salesagent-ai"
git status --short
```

If `admin/src/pages/VoiceTest.tsx` or `scripts/demo-server.ts` show as modified — stash them first:
```bash
git stash push -m "wip-before-admin-redesign" -- admin/src/pages/VoiceTest.tsx scripts/demo-server.ts
```

Create branch:
```bash
git checkout -b feat/admin-sharp-redesign
```

- [ ] **Step 2: Stage and commit spec + plan from docs/ (currently untracked)**

```bash
git add docs/superpowers/specs/2026-05-19-admin-sharp-redesign-design.md
git add docs/superpowers/plans/2026-05-19-admin-sharp-redesign.md
git commit -m "docs: admin sharp redesign spec + plan"
```

- [ ] **Step 3: Verify dev server boots before changes**

```bash
cd admin && npm install && npm run dev
```
Expected: Vite serves on port 5173, current admin renders without errors (open `http://localhost:5173/login`).

Kill server. Continue.

---

## Phase 1 — Foundation

### Task 1: Install design-system dependencies

**Files:**
- Modify: `admin/package.json`

- [ ] **Step 1: Install runtime deps**

```bash
cd "/Users/admin/Documents/Проекты /Вайбкодинг/salesagent-ai/admin"
npm install @radix-ui/react-tooltip @radix-ui/react-dialog @radix-ui/react-tabs @radix-ui/react-dropdown-menu cmdk sonner @tanstack/react-virtual clsx
```

- [ ] **Step 2: Verify install**

```bash
npm ls @radix-ui/react-tooltip cmdk sonner @tanstack/react-virtual clsx
```
Expected: each prints version, no UNMET DEPENDENCY.

- [ ] **Step 3: Commit**

```bash
git add admin/package.json admin/package-lock.json
git commit -m "chore(admin): add design-system runtime deps"
```

---

### Task 2: CSS variables + Tailwind tokens

**Files:**
- Modify: `admin/src/index.css`
- Modify: `admin/tailwind.config.js`
- Modify: `admin/index.html`

- [ ] **Step 1: Rewrite `admin/src/index.css`**

Replace file contents with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px;
  --s-6: 24px; --s-8: 32px; --s-10: 40px; --s-12: 48px; --s-16: 64px;

  --r-1: 4px; --r-2: 6px; --r-3: 8px; --r-4: 12px;

  --d-1: 0 1px 0 rgb(0 0 0 / .05);
  --d-2: 0 1px 2px rgb(0 0 0 / .08), 0 1px 1px rgb(0 0 0 / .04);
  --d-3: 0 8px 24px rgb(0 0 0 / .12);

  --t-fast: 120ms cubic-bezier(.2,.8,.2,1);
  --t-med:  200ms cubic-bezier(.2,.8,.2,1);
}

[data-theme="dark"] {
  --bg-0: #0a0b0d; --bg-1: #101216; --bg-2: #181b21;
  --fg-0: #f5f6f8; --fg-1: #b9bec7; --fg-2: #6b7280;
  --line:   #23272f;
  --accent: #00b14f; --accent-fg: #ffffff;
  --danger: #ef4444; --warn: #f59e0b; --ok: #10b981;
}

[data-theme="light"] {
  --bg-0: #ffffff; --bg-1: #f7f8fa; --bg-2: #eef0f4;
  --fg-0: #0a0b0d; --fg-1: #4b5563; --fg-2: #9ca3af;
  --line:   #e5e7eb;
  --accent: #00b14f; --accent-fg: #ffffff;
  --danger: #ef4444; --warn: #f59e0b; --ok: #10b981;
}

@layer base {
  html, body, #root { height: 100%; }
  body {
    background: var(--bg-0);
    color: var(--fg-0);
    font-family: 'Inter Tight', system-ui, -apple-system, sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
    -webkit-font-smoothing: antialiased;
  }
  .num { font-variant-numeric: tabular-nums; }
}
```

- [ ] **Step 2: Rewrite `admin/tailwind.config.js` to map utilities to CSS vars**

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:     { 0: 'var(--bg-0)', 1: 'var(--bg-1)', 2: 'var(--bg-2)' },
        fg:     { 0: 'var(--fg-0)', 1: 'var(--fg-1)', 2: 'var(--fg-2)' },
        line:   'var(--line)',
        accent: { DEFAULT: 'var(--accent)', fg: 'var(--accent-fg)' },
        danger: 'var(--danger)',
        warn:   'var(--warn)',
        ok:     'var(--ok)',
      },
      boxShadow: {
        'd-1': 'var(--d-1)',
        'd-2': 'var(--d-2)',
        'd-3': 'var(--d-3)',
      },
      borderRadius: {
        '1': 'var(--r-1)', '2': 'var(--r-2)', '3': 'var(--r-3)', '4': 'var(--r-4)',
      },
      transitionTimingFunction: {
        'sharp': 'cubic-bezier(.2,.8,.2,1)',
      },
      fontFamily: {
        sans: ['Inter Tight', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 3: Add Inter Tight font + theme bootstrap to `admin/index.html`**

Replace `<head>` contents:
```html
<head>
  <meta charset="UTF-8" />
  <link rel="icon" type="image/svg+xml" href="/vite.svg" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SalesAgent AI — Admin</title>
  <link rel="preconnect" href="https://rsms.me/" />
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
  <style>
    body { font-family: 'Inter Tight', 'Inter var', system-ui, sans-serif; }
  </style>
  <script>
    (function () {
      try {
        var t = localStorage.getItem('theme');
        if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', t);
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();
  </script>
</head>
```

Note: rsms.me serves the Inter family (Tight variant). If offline self-host is needed later, swap to local woff2.

- [ ] **Step 4: Verify theme loads without FOUC**

```bash
cd admin && npm run dev
```
Open `http://localhost:5173`. Body background should be near-black (`#0a0b0d`). Inspect `<html>` — should have `data-theme="dark"`. Kill server.

- [ ] **Step 5: Commit**

```bash
git add admin/src/index.css admin/tailwind.config.js admin/index.html
git commit -m "feat(admin): introduce token-based theme (CSS vars + Tailwind)"
```

---

### Task 3: Theme module + hook

**Files:**
- Create: `admin/src/lib/theme.ts`
- Create: `admin/src/hooks/useTheme.ts`
- Create: `admin/src/ui/cn.ts`

- [ ] **Step 1: Create `admin/src/ui/cn.ts`**

```ts
import clsx, { type ClassValue } from 'clsx';
export const cn = (...args: ClassValue[]) => clsx(...args);
```

- [ ] **Step 2: Create `admin/src/lib/theme.ts`**

```ts
export type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  const stored = localStorage.getItem('theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
```

- [ ] **Step 3: Create `admin/src/hooks/useTheme.ts`**

```ts
import { useEffect, useState } from 'react';
import { getTheme, setTheme as apply, type Theme } from '../lib/theme';

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getTheme());
  useEffect(() => { apply(theme); }, [theme]);
  return { theme, setTheme: setThemeState };
}
```

- [ ] **Step 4: Type-check passes**

```bash
cd admin && npx tsc --noEmit
```
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add admin/src/lib/theme.ts admin/src/hooks/useTheme.ts admin/src/ui/cn.ts
git commit -m "feat(admin): theme module + useTheme hook"
```

---

## Phase 2 — UI Primitives

### Task 4: Button

**Files:**
- Create: `admin/src/ui/Button.tsx`

- [ ] **Step 1: Write `admin/src/ui/Button.tsx`**

```tsx
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size    = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

const base = 'inline-flex items-center gap-2 font-medium rounded-2 select-none transition-colors ease-sharp duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-9 px-3.5 text-[13px]',
};

const variants: Record<Variant, string> = {
  primary:   'bg-accent text-accent-fg hover:brightness-110 active:brightness-95',
  secondary: 'bg-bg-2 text-fg-0 hover:bg-line border border-line',
  ghost:     'bg-transparent text-fg-1 hover:text-fg-0 hover:bg-bg-2',
  danger:    'bg-danger text-white hover:brightness-110',
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'primary', size = 'md', iconLeft, iconRight, loading, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(base, sizes[size], variants[variant], className)}
      {...rest}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  )
);
Button.displayName = 'Button';
```

- [ ] **Step 2: Smoke-render in a throwaway route or add a temporary test**

Append to bottom of `admin/src/App.tsx` (temporary, will be removed):
```tsx
// TEMP smoke — remove after Phase 2
import { Button } from './ui/Button';
export const _Smoke = () => <Button>Hi</Button>;
```

- [ ] **Step 3: Type-check**

```bash
cd admin && npx tsc --noEmit
```
Expected: exits 0.

- [ ] **Step 4: Remove temp smoke and commit**

Remove the `// TEMP smoke` lines from `App.tsx`.

```bash
git add admin/src/ui/Button.tsx admin/src/App.tsx
git commit -m "feat(admin/ui): Button primitive"
```

---

### Task 5: Input

**Files:**
- Create: `admin/src/ui/Input.tsx`

- [ ] **Step 1: Write `admin/src/ui/Input.tsx`**

```tsx
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, hint, error, leftSlot, rightSlot, className, id, ...rest }, ref) => {
    const inputId = id || (label ? `in-${label.replace(/\s+/g, '-')}` : undefined);
    return (
      <label htmlFor={inputId} className="flex flex-col gap-1 text-[13px]">
        {label && <span className="text-fg-1">{label}</span>}
        <span className={cn(
          'flex items-center gap-2 h-9 px-3 rounded-2 bg-bg-1 border',
          error ? 'border-danger' : 'border-line',
          'focus-within:border-accent transition-colors'
        )}>
          {leftSlot}
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'flex-1 bg-transparent outline-none placeholder:text-fg-2 text-fg-0',
              className
            )}
            {...rest}
          />
          {rightSlot}
        </span>
        {error
          ? <span className="text-[12px] text-danger">{error}</span>
          : hint && <span className="text-[12px] text-fg-2">{hint}</span>}
      </label>
    );
  }
);
Input.displayName = 'Input';
```

- [ ] **Step 2: Type-check**

```bash
cd admin && npx tsc --noEmit
```
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add admin/src/ui/Input.tsx
git commit -m "feat(admin/ui): Input primitive"
```

---

### Task 6: Card

**Files:**
- Create: `admin/src/ui/Card.tsx`

- [ ] **Step 1: Write `admin/src/ui/Card.tsx`**

```tsx
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md';
}

export function Card({ padding = 'md', className, children, ...rest }: CardProps) {
  const pad = padding === 'none' ? '' : padding === 'sm' ? 'p-3' : 'p-5';
  return (
    <div
      className={cn('bg-bg-1 border border-line rounded-3 shadow-d-1', pad, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[14px] font-semibold text-fg-0">{title}</h3>
      {action}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd admin && npx tsc --noEmit && git add admin/src/ui/Card.tsx && git commit -m "feat(admin/ui): Card primitive"
```

---

### Task 7: Badge

**Files:**
- Create: `admin/src/ui/Badge.tsx`

- [ ] **Step 1: Write file**

```tsx
import type { ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
type Size = 'sm' | 'md';

const tones: Record<Tone, string> = {
  neutral: 'bg-bg-2 text-fg-1 border-line',
  ok:      'bg-ok/10 text-ok border-ok/30',
  warn:    'bg-warn/10 text-warn border-warn/30',
  danger:  'bg-danger/10 text-danger border-danger/30',
  accent:  'bg-accent/15 text-accent border-accent/30',
};

const sizes: Record<Size, string> = {
  sm: 'h-5 px-1.5 text-[10px] font-medium',
  md: 'h-6 px-2 text-[11px] font-medium',
};

export function Badge({ tone = 'neutral', size = 'md', children }: { tone?: Tone; size?: Size; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-1 border tracking-wide uppercase', tones[tone], sizes[size])}>
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
cd admin && npx tsc --noEmit && git add admin/src/ui/Badge.tsx && git commit -m "feat(admin/ui): Badge primitive"
```

---

### Task 8: Skeleton + EmptyState

**Files:**
- Create: `admin/src/ui/Skeleton.tsx`
- Create: `admin/src/ui/EmptyState.tsx`

- [ ] **Step 1: Write `Skeleton.tsx`**

```tsx
import { cn } from './cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('relative overflow-hidden bg-bg-2 rounded-2', className)}
      style={{
        backgroundImage: 'linear-gradient(90deg, transparent, rgba(255,255,255,.04), transparent)',
        backgroundSize: '200% 100%',
        animation: 'sk-shimmer 1.2s infinite',
      }}
    >
      <style>{`@keyframes sk-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
    </div>
  );
}

export const SkeletonText = ({ lines = 3 }: { lines?: number }) => (
  <div className="space-y-2">
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
    ))}
  </div>
);

export const SkeletonRow = () => (
  <div className="flex items-center gap-3 p-3">
    <Skeleton className="h-9 w-9 rounded-full" />
    <div className="flex-1 space-y-2">
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  </div>
);
```

- [ ] **Step 2: Write `EmptyState.tsx`**

```tsx
import type { ReactNode } from 'react';
import { cn } from './cn';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-6', className)}>
      {icon && <div className="text-fg-2 mb-3">{icon}</div>}
      <h4 className="text-[15px] font-semibold text-fg-0">{title}</h4>
      {description && <p className="text-[13px] text-fg-1 mt-1 max-w-sm">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
cd admin && npx tsc --noEmit && git add admin/src/ui/Skeleton.tsx admin/src/ui/EmptyState.tsx && git commit -m "feat(admin/ui): Skeleton + EmptyState primitives"
```

---

### Task 9: Tooltip + Modal + DropdownMenu (radix wrappers)

**Files:**
- Create: `admin/src/ui/Tooltip.tsx`
- Create: `admin/src/ui/Modal.tsx`
- Create: `admin/src/ui/DropdownMenu.tsx`

- [ ] **Step 1: Write `Tooltip.tsx`**

```tsx
import * as Tip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Tip.Provider delayDuration={300}>{children}</Tip.Provider>;
}

export function Tooltip({ label, children, side = 'right' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Tip.Root>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content
          side={side}
          sideOffset={6}
          className="z-50 px-2 py-1 text-[11px] rounded-1 bg-bg-2 text-fg-0 border border-line shadow-d-2"
        >
          {label}
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  );
}
```

- [ ] **Step 2: Write `Modal.tsx`**

```tsx
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Modal({
  open, onOpenChange, title, children, widthClass = 'max-w-md',
}: { open: boolean; onOpenChange: (v: boolean) => void; title?: ReactNode; children: ReactNode; widthClass?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[92vw] ${widthClass} bg-bg-1 border border-line rounded-4 shadow-d-3`}
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-line">
            <Dialog.Title className="text-[14px] font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-fg-2 hover:text-fg-0">
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 3: Write `DropdownMenu.tsx`**

```tsx
import * as DM from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from './cn';

export const DropdownMenu       = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;

export function DropdownMenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className="z-50 min-w-[180px] bg-bg-1 border border-line rounded-2 shadow-d-2 p-1"
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function DropdownMenuItem({
  children, onSelect, danger,
}: { children: ReactNode; onSelect?: () => void; danger?: boolean }) {
  return (
    <DM.Item
      onSelect={onSelect}
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 rounded-1 text-[13px] cursor-pointer outline-none',
        danger ? 'text-danger hover:bg-danger/10' : 'text-fg-0 hover:bg-bg-2'
      )}
    >
      {children}
    </DM.Item>
  );
}

export function DropdownMenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}
```

- [ ] **Step 4: Type-check + commit**

```bash
cd admin && npx tsc --noEmit
git add admin/src/ui/Tooltip.tsx admin/src/ui/Modal.tsx admin/src/ui/DropdownMenu.tsx
git commit -m "feat(admin/ui): Tooltip + Modal + DropdownMenu (radix)"
```

---

### Task 10: Toast + Tabs + KBD

**Files:**
- Create: `admin/src/ui/Toast.tsx`
- Create: `admin/src/ui/Tabs.tsx`
- Create: `admin/src/ui/KBD.tsx`

- [ ] **Step 1: Write `Toast.tsx`**

```tsx
import { Toaster, toast as sonnerToast } from 'sonner';

export function ToastRoot() {
  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      toastOptions={{
        className: '!bg-bg-2 !text-fg-0 !border !border-line !rounded-2',
      }}
    />
  );
}

export const toast = sonnerToast;
```

- [ ] **Step 2: Write `Tabs.tsx`**

```tsx
import * as T from '@radix-ui/react-tabs';
import { cn } from './cn';
import type { ReactNode } from 'react';

export const Tabs = T.Root;

export function TabsList({ children }: { children: ReactNode }) {
  return (
    <T.List className="flex gap-1 border-b border-line">
      {children}
    </T.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <T.Trigger
      value={value}
      className={cn(
        'px-3 h-9 text-[13px] text-fg-1 border-b-2 border-transparent',
        'data-[state=active]:text-fg-0 data-[state=active]:border-accent transition-colors'
      )}
    >
      {children}
    </T.Trigger>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  return <T.Content value={value} className="pt-4 outline-none">{children}</T.Content>;
}
```

- [ ] **Step 3: Write `KBD.tsx`**

```tsx
import type { ReactNode } from 'react';
import { cn } from './cn';

export function KBD({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn(
      'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-1',
      'bg-bg-2 border border-line text-[10px] text-fg-1 font-mono',
      className
    )}>
      {children}
    </kbd>
  );
}
```

- [ ] **Step 4: Type-check + commit**

```bash
cd admin && npx tsc --noEmit
git add admin/src/ui/Toast.tsx admin/src/ui/Tabs.tsx admin/src/ui/KBD.tsx
git commit -m "feat(admin/ui): Toast + Tabs + KBD primitives"
```

---

## Phase 3 — Shell

### Task 11: Sidebar rewrite

**Files:**
- Modify: `admin/src/components/Sidebar.tsx`

- [ ] **Step 1: Replace entire file**

```tsx
import { NavLink, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import {
  LayoutDashboard, MessageSquare, Mic, BookOpen, Bot, LogOut,
  Phone, MessagesSquare, PanelLeftClose, PanelLeftOpen, Moon, Sun
} from 'lucide-react';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { useTheme } from '../hooks/useTheme';
import { cn } from '../ui/cn';

const links = [
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Дашборд' },
  { to: '/chat',          icon: MessagesSquare,  label: 'Чат' },
  { to: '/conversations', icon: MessageSquare,   label: 'Разговоры' },
  { to: '/recordings',    icon: Mic,             label: 'Записи' },
  { to: '/knowledge',     icon: BookOpen,        label: 'База знаний' },
  { to: '/agents',        icon: Bot,             label: 'Агенты' },
  { to: '/voice-test',    icon: Phone,           label: 'Тест звонка' },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sb-collapsed') === '1'
  );
  const { theme, setTheme } = useTheme();

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sb-collapsed', next ? '1' : '0');
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('orgId');
    navigate('/login');
  };

  return (
    <TooltipProvider>
      <aside
        className={cn(
          'flex flex-col h-full shrink-0 bg-bg-1 border-r border-line transition-[width] duration-150 ease-sharp',
          collapsed ? 'w-14' : 'w-[220px]'
        )}
      >
        <div className="h-12 flex items-center px-3 border-b border-line">
          <div className="w-8 h-8 rounded-2 bg-accent text-accent-fg flex items-center justify-center text-[14px] font-bold shrink-0">SA</div>
          {!collapsed && (
            <div className="ml-2 leading-tight">
              <div className="text-[13px] font-semibold text-fg-0">SalesAgent</div>
              <div className="text-[10px] text-fg-2 uppercase tracking-wider">Admin</div>
            </div>
          )}
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {links.map(({ to, icon: Icon, label }) => {
            const item = (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => cn(
                  'group relative flex items-center gap-2 h-9 rounded-2 text-[13px]',
                  collapsed ? 'justify-center px-0' : 'px-2.5',
                  isActive
                    ? 'bg-bg-2 text-fg-0 before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-accent before:rounded-r'
                    : 'text-fg-1 hover:text-fg-0 hover:bg-bg-2'
                )}
              >
                <Icon size={16} className="shrink-0" />
                {!collapsed && <span>{label}</span>}
              </NavLink>
            );
            return collapsed
              ? <Tooltip key={to} label={label} side="right">{item}</Tooltip>
              : item;
          })}
        </nav>

        <div className="px-2 py-2 border-t border-line space-y-0.5">
          <button
            onClick={toggleCollapse}
            className="flex items-center gap-2 h-8 w-full px-2 rounded-2 text-[12px] text-fg-2 hover:text-fg-0 hover:bg-bg-2"
            title={collapsed ? 'Развернуть' : 'Свернуть'}
          >
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            {!collapsed && <span>Свернуть</span>}
          </button>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex items-center gap-2 h-8 w-full px-2 rounded-2 text-[12px] text-fg-2 hover:text-fg-0 hover:bg-bg-2"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {!collapsed && <span>{theme === 'dark' ? 'Светлая' : 'Тёмная'}</span>}
          </button>
          <button
            onClick={logout}
            className="flex items-center gap-2 h-8 w-full px-2 rounded-2 text-[12px] text-fg-2 hover:text-danger hover:bg-danger/10"
          >
            <LogOut size={14} />
            {!collapsed && <span>Выйти</span>}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}
```

- [ ] **Step 2: Update `App.tsx` to wrap main in `bg-bg-0`**

In `admin/src/App.tsx`, replace:
```tsx
<main className="flex-1 overflow-y-auto bg-gray-50 p-6">
```
with:
```tsx
<main className="flex-1 overflow-y-auto bg-bg-0">
```

- [ ] **Step 3: Smoke test — boot dev server, log in (if backend running) or check `/login` renders**

```bash
cd admin && npm run dev
```
Open `http://localhost:5173`. Sidebar should render dark, collapsible, with tooltips when collapsed. Active route shows left accent bar. Kill server.

- [ ] **Step 4: Commit**

```bash
git add admin/src/components/Sidebar.tsx admin/src/App.tsx
git commit -m "feat(admin): rewrite Sidebar with tokens, collapse, theme toggle"
```

---

### Task 12: Topbar

**Files:**
- Create: `admin/src/components/Topbar.tsx`
- Modify: `admin/src/App.tsx`

- [ ] **Step 1: Create `Topbar.tsx`**

```tsx
import { useLocation } from 'react-router-dom';
import { Search, Bell, HelpCircle } from 'lucide-react';
import { KBD } from '../ui/KBD';

const TITLES: Record<string, string> = {
  '/dashboard':     'Дашборд',
  '/chat':          'Чат с агентом',
  '/conversations': 'Разговоры',
  '/recordings':    'Записи',
  '/knowledge':     'База знаний',
  '/agents':        'Агенты',
  '/voice-test':    'Тест звонка',
};

export default function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { pathname } = useLocation();
  const title = TITLES[pathname] ?? '—';
  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-line bg-bg-1 sticky top-0 z-30">
      <div className="text-[13px] font-medium text-fg-1">
        <span className="text-fg-2">SalesAgent</span>
        <span className="mx-2 text-fg-2">/</span>
        <span className="text-fg-0">{title}</span>
      </div>
      <div className="flex-1 flex justify-center">
        <button
          onClick={onOpenPalette}
          className="group flex items-center gap-2 h-8 w-[420px] px-2.5 rounded-2 bg-bg-0 border border-line text-[12px] text-fg-2 hover:text-fg-1 hover:border-fg-2/30"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Поиск, действия, навигация…</span>
          <KBD>⌘</KBD><KBD>K</KBD>
        </button>
      </div>
      <button className="w-8 h-8 inline-flex items-center justify-center rounded-2 text-fg-2 hover:text-fg-0 hover:bg-bg-2" aria-label="Уведомления">
        <Bell size={15} />
      </button>
      <button className="w-8 h-8 inline-flex items-center justify-center rounded-2 text-fg-2 hover:text-fg-0 hover:bg-bg-2" aria-label="Помощь">
        <HelpCircle size={15} />
      </button>
    </header>
  );
}
```

- [ ] **Step 2: Wire Topbar into `App.tsx`**

Replace `PrivateLayout` in `admin/src/App.tsx`:
```tsx
import Topbar from './components/Topbar';

function PrivateLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-bg-0">
          <Routes>
            <Route path="/"              element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard"     element={<Dashboard />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/recordings"    element={<Recordings />} />
            <Route path="/knowledge"     element={<Knowledge />} />
            <Route path="/agents"        element={<Agents />} />
            <Route path="/voice-test"    element={<VoiceTest />} />
            <Route path="/chat"          element={<Chat />} />
          </Routes>
        </main>
      </div>
      {/* CommandPalette wired in Task 14 */}
      {paletteOpen && <div className="hidden">/* placeholder until Task 14 */</div>}
    </div>
  );
}
```
(`useState` is already imported at top of file.)

- [ ] **Step 3: Type-check + smoke test**

```bash
cd admin && npx tsc --noEmit && npm run dev
```
Open app — topbar visible, breadcrumbs show correct page. Kill server.

- [ ] **Step 4: Commit**

```bash
git add admin/src/components/Topbar.tsx admin/src/App.tsx
git commit -m "feat(admin): add Topbar with breadcrumbs + palette trigger"
```

---

### Task 13: Hotkeys hook

**Files:**
- Create: `admin/src/lib/hotkeys.ts`
- Create: `admin/src/hooks/useHotkeys.ts`

- [ ] **Step 1: Write `admin/src/lib/hotkeys.ts`**

```ts
export type HotkeyHandler = (e: KeyboardEvent) => void;

export interface ChordBinding {
  /** Modifiers + key, e.g. "mod+k", "shift+/" */
  combo: string;
  handler: HotkeyHandler;
}

export interface SequenceBinding {
  /** Sequence of keys (case-insensitive), e.g. ["g", "d"] */
  keys: string[];
  handler: HotkeyHandler;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);

function matchCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+').map(s => s.trim());
  const key = parts.pop()!;
  const needMod   = parts.includes('mod');
  const needShift = parts.includes('shift');
  const needAlt   = parts.includes('alt');
  if (needMod && !(isMac ? e.metaKey : e.ctrlKey)) return false;
  if (!needMod && (e.metaKey || e.ctrlKey)) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt   !== e.altKey)   return false;
  return e.key.toLowerCase() === key;
}

const SEQ_TIMEOUT_MS = 1000;

export function attachHotkeys(chords: ChordBinding[], sequences: SequenceBinding[]) {
  let buffer: string[] = [];
  let timer: number | undefined;

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    for (const c of chords) {
      if (matchCombo(e, c.combo)) {
        e.preventDefault();
        c.handler(e);
        buffer = [];
        return;
      }
    }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      buffer.push(e.key.toLowerCase());
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => { buffer = []; }, SEQ_TIMEOUT_MS);

      for (const s of sequences) {
        if (s.keys.length <= buffer.length) {
          const tail = buffer.slice(-s.keys.length).join('');
          if (tail === s.keys.join('')) {
            e.preventDefault();
            s.handler(e);
            buffer = [];
            return;
          }
        }
      }
    }
  };

  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    if (timer) clearTimeout(timer);
  };
}
```

- [ ] **Step 2: Write `admin/src/hooks/useHotkeys.ts`**

```ts
import { useEffect } from 'react';
import { attachHotkeys, type ChordBinding, type SequenceBinding } from '../lib/hotkeys';

export function useHotkeys(chords: ChordBinding[], sequences: SequenceBinding[] = []) {
  useEffect(() => attachHotkeys(chords, sequences), [chords, sequences]);
}
```

- [ ] **Step 3: Type-check + commit**

```bash
cd admin && npx tsc --noEmit
git add admin/src/lib/hotkeys.ts admin/src/hooks/useHotkeys.ts
git commit -m "feat(admin): hotkeys (chord + sequence) module + hook"
```

---

### Task 14: Command Palette

**Files:**
- Create: `admin/src/components/CommandPalette.tsx`
- Modify: `admin/src/App.tsx`

- [ ] **Step 1: Create `CommandPalette.tsx`**

```tsx
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import {
  LayoutDashboard, MessageSquare, Mic, BookOpen, Bot, Phone, MessagesSquare,
  Moon, Sun, LogOut
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    if (open) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  const go = (path: string) => {
    navigate(path);
    onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Командная палитра"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => onOpenChange(false)} />
      <div className="relative w-[92vw] max-w-[560px] bg-bg-1 border border-line rounded-3 shadow-d-3 overflow-hidden">
        <Command.Input
          placeholder="Команда, страница, поиск…"
          className="w-full h-12 px-4 bg-transparent text-[14px] text-fg-0 placeholder:text-fg-2 outline-none border-b border-line"
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-1">
          <Command.Empty className="text-center py-6 text-[13px] text-fg-2">Ничего не найдено.</Command.Empty>

          <Command.Group heading="Навигация" className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-fg-2">
            <Item icon={<LayoutDashboard size={14} />} label="Дашборд"     onSelect={() => go('/dashboard')} />
            <Item icon={<MessageSquare size={14} />}   label="Разговоры"   onSelect={() => go('/conversations')} />
            <Item icon={<Mic size={14} />}             label="Записи"      onSelect={() => go('/recordings')} />
            <Item icon={<BookOpen size={14} />}        label="База знаний" onSelect={() => go('/knowledge')} />
            <Item icon={<Bot size={14} />}             label="Агенты"      onSelect={() => go('/agents')} />
            <Item icon={<Phone size={14} />}           label="Тест звонка" onSelect={() => go('/voice-test')} />
            <Item icon={<MessagesSquare size={14} />}  label="Чат"         onSelect={() => go('/chat')} />
          </Command.Group>

          <Command.Group heading="Действия" className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-fg-2">
            <Item
              icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
              onSelect={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); onOpenChange(false); }}
            />
            <Item
              icon={<LogOut size={14} />}
              label="Выйти"
              onSelect={() => {
                localStorage.removeItem('token');
                localStorage.removeItem('orgId');
                go('/login');
              }}
            />
          </Command.Group>
        </Command.List>
      </div>
    </Command.Dialog>
  );
}

function Item({ icon, label, onSelect }: { icon: React.ReactNode; label: string; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2 px-2.5 h-9 rounded-2 text-[13px] text-fg-1 data-[selected=true]:bg-bg-2 data-[selected=true]:text-fg-0 cursor-pointer"
    >
      {icon}
      <span>{label}</span>
    </Command.Item>
  );
}
```

- [ ] **Step 2: Wire palette + hotkeys into `App.tsx`**

Update `PrivateLayout` (replace the entire function):
```tsx
function PrivateLayout() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useHotkeys(
    [
      { combo: 'mod+k', handler: () => setPaletteOpen(o => !o) },
    ],
    [
      { keys: ['g', 'd'], handler: () => navigate('/dashboard') },
      { keys: ['g', 'c'], handler: () => navigate('/conversations') },
      { keys: ['g', 'r'], handler: () => navigate('/recordings') },
      { keys: ['g', 'k'], handler: () => navigate('/knowledge') },
      { keys: ['g', 'a'], handler: () => navigate('/agents') },
      { keys: ['g', 'v'], handler: () => navigate('/voice-test') },
      { keys: ['g', 'h'], handler: () => navigate('/chat') },
    ]
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onOpenPalette={() => setPaletteOpen(true)} />
        <main className="flex-1 overflow-y-auto bg-bg-0">
          <Routes>
            <Route path="/"              element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard"     element={<Dashboard />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/recordings"    element={<Recordings />} />
            <Route path="/knowledge"     element={<Knowledge />} />
            <Route path="/agents"        element={<Agents />} />
            <Route path="/voice-test"    element={<VoiceTest />} />
            <Route path="/chat"          element={<Chat />} />
          </Routes>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
```

Add imports at top:
```tsx
import { useNavigate } from 'react-router-dom';
import CommandPalette from './components/CommandPalette';
import Topbar from './components/Topbar';
import { useHotkeys } from './hooks/useHotkeys';
```

- [ ] **Step 3: Wire toast root in `main.tsx`**

In `admin/src/main.tsx`, import and render `ToastRoot` inside `QueryClientProvider`:
```tsx
import { ToastRoot } from './ui/Toast';
// inside render tree, just before </QueryClientProvider>:
<ToastRoot />
```

- [ ] **Step 4: Smoke test**

```bash
cd admin && npm run dev
```
Open app. Press `⌘K` → palette opens, type "даш" → Dashboard highlighted → Enter navigates. Press `g d` from anywhere (not in input) → navigates. Press `⌘K` again, toggle theme. Kill server.

- [ ] **Step 5: Commit**

```bash
git add admin/src/components/CommandPalette.tsx admin/src/App.tsx admin/src/main.tsx
git commit -m "feat(admin): command palette + global hotkeys + toast root"
```

---

## Phase 4 — Pages

### Task 15: Login redesign

**Files:**
- Modify: `admin/src/pages/Login.tsx`

- [ ] **Step 1: Read existing Login to preserve API contract**

Run:
```bash
cat admin/src/pages/Login.tsx
```
Note the exact API call (URL, payload, where token is stored). It must remain unchanged in the rewrite.

- [ ] **Step 2: Rewrite preserving the same auth call**

Open the file and replace its contents, **keeping the same fetch call and token-storage logic** from step 1 (substitute `__KEEP_EXISTING_LOGIN_CALL__` with the real call shape you read):

```tsx
import { useState, type FormEvent } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface Props { onLogin: () => void }

export default function Login({ onLogin }: Props) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // __KEEP_EXISTING_LOGIN_CALL__:
      //   reuse the fetch/axios call from the previous Login.tsx
      //   on success: localStorage.setItem('token', token) (and orgId if applicable)
      //   on failure: throw with server message
      onLogin();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось войти');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg-0 grid place-items-center relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-50"
           style={{ background: 'radial-gradient(60% 60% at 50% 30%, rgba(0,177,79,.15), transparent 70%)' }} />
      <div className="relative w-[360px] bg-bg-1 border border-line rounded-4 shadow-d-3 p-7">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-9 h-9 rounded-2 bg-accent text-accent-fg grid place-items-center font-bold">SA</div>
          <div>
            <div className="text-[15px] font-semibold">SalesAgent AI</div>
            <div className="text-[11px] text-fg-2 uppercase tracking-wider">Admin</div>
          </div>
        </div>
        <h1 className="text-[20px] font-semibold mb-1">Вход</h1>
        <p className="text-[13px] text-fg-1 mb-5">Управляй разговорами и агентами</p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} />
          <Input label="Пароль" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
          {error && <div className="text-[12px] text-danger">{error}</div>}
          <Button type="submit" loading={loading} className="w-full justify-center">Войти</Button>
        </form>
      </div>
    </div>
  );
}
```

**IMPORTANT:** Before committing, replace the `// __KEEP_EXISTING_LOGIN_CALL__:` placeholder with the actual fetch logic copied from the original `Login.tsx`. The rewrite is layout-only — auth behavior must be identical.

- [ ] **Step 3: Smoke test**

```bash
cd admin && npm run dev
```
Open `/login`. Verify: layout centered, gradient subtle, fields look right, error state shows. If backend running, full login works. Kill server.

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/Login.tsx
git commit -m "feat(admin/login): redesign with new primitives, preserve auth"
```

---

### Task 16: KPICard + Sparkline + ActivityFeed + Dashboard

**Files:**
- Create: `admin/src/components/KPICard.tsx`
- Create: `admin/src/components/Sparkline.tsx`
- Create: `admin/src/components/ActivityFeed.tsx`
- Modify: `admin/src/components/FunnelChart.tsx`
- Modify: `admin/src/pages/Dashboard.tsx`

- [ ] **Step 1: Create `KPICard.tsx`**

```tsx
import type { ReactNode } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { Card } from '../ui/Card';

interface Props {
  label: string;
  value: string | number;
  delta?: { value: number; positive: boolean };
  sub?: string;
  icon?: ReactNode;
  spark?: ReactNode;
}

export default function KPICard({ label, value, delta, sub, icon, spark }: Props) {
  return (
    <Card padding="md" className="relative">
      <div className="flex items-start justify-between">
        <div className="text-[11px] uppercase tracking-wider text-fg-2">{label}</div>
        {icon && <div className="text-fg-2">{icon}</div>}
      </div>
      <div className="flex items-baseline gap-2 mt-2">
        <div className="num text-[28px] font-semibold text-fg-0 leading-none">{value}</div>
        {delta && (
          <div className={`num text-[12px] flex items-center gap-0.5 ${delta.positive ? 'text-ok' : 'text-danger'}`}>
            {delta.positive ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {Math.abs(delta.value)}%
          </div>
        )}
      </div>
      {sub && <div className="text-[12px] text-fg-2 mt-1">{sub}</div>}
      {spark && <div className="mt-3 -mx-1">{spark}</div>}
    </Card>
  );
}
```

- [ ] **Step 2: Create `Sparkline.tsx`**

```tsx
import { LineChart, Line, ResponsiveContainer } from 'recharts';

export default function Sparkline({ data, color = 'var(--accent)' }: { data: number[]; color?: string }) {
  const pts = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-9">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={pts}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Create `ActivityFeed.tsx`**

```tsx
import { Card, CardHeader } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Badge } from '../ui/Badge';
import { Activity } from 'lucide-react';

export interface FeedItem {
  id: string;
  ts: string;        // ISO
  channel: string;   // 'whatsapp' | 'voice' | ...
  text: string;
  tone?: 'ok' | 'warn' | 'danger' | 'neutral';
}

function timeAgo(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}с`;
  if (d < 3600) return `${Math.floor(d / 60)}м`;
  if (d < 86400) return `${Math.floor(d / 3600)}ч`;
  return `${Math.floor(d / 86400)}д`;
}

export default function ActivityFeed({ items }: { items: FeedItem[] }) {
  return (
    <Card>
      <CardHeader title="Активность" />
      {items.length === 0
        ? <EmptyState icon={<Activity size={20} />} title="Пока пусто" description="События появятся, как только пойдут разговоры." />
        : (
          <ul className="divide-y divide-line -mx-2">
            {items.map(it => (
              <li key={it.id} className="flex items-start gap-3 px-2 py-2">
                <Badge tone={it.tone ?? 'neutral'} size="sm">{it.channel}</Badge>
                <div className="flex-1 text-[13px] text-fg-0">{it.text}</div>
                <div className="num text-[11px] text-fg-2 shrink-0">{timeAgo(it.ts)}</div>
              </li>
            ))}
          </ul>
        )
      }
    </Card>
  );
}
```

- [ ] **Step 4: Refactor `FunnelChart.tsx` to use tokens**

In the existing `FunnelChart.tsx`, replace the outer wrapper and `Tooltip` style:
```tsx
// Replace outer div:
<Card>
  <CardHeader title="Воронка продаж" />
  <ResponsiveContainer width="100%" height={280}>
    {/* ...chart... */}
  </ResponsiveContainer>
</Card>
```
Update tooltip `contentStyle`:
```tsx
contentStyle={{
  background: 'var(--bg-2)',
  border:     '1px solid var(--line)',
  borderRadius: '6px',
  color: 'var(--fg-0)',
}}
```
Add at top:
```tsx
import { Card, CardHeader } from '../ui/Card';
```

- [ ] **Step 5: Read existing `Dashboard.tsx` to capture API hooks**

```bash
cat admin/src/pages/Dashboard.tsx
```
Note: the queries it uses (e.g. `useQuery({ queryKey: ['stats'] ... })`) and the API shapes.

- [ ] **Step 6: Rewrite `Dashboard.tsx`**

Replace with layout below. **Where you see `__USE_EXISTING_QUERY__`, paste the actual `useQuery` calls from step 5** — don't invent endpoint names.

```tsx
import { MessageCircle, Phone, TrendingUp, Users } from 'lucide-react';
import KPICard from '../components/KPICard';
import Sparkline from '../components/Sparkline';
import FunnelChart from '../components/FunnelChart';
import ActivityFeed, { type FeedItem } from '../components/ActivityFeed';
import { Card, CardHeader } from '../ui/Card';
import { Skeleton } from '../ui/Skeleton';

export default function Dashboard() {
  // __USE_EXISTING_QUERY__: keep the existing stats/funnel/feed queries
  // const stats = useQuery(...);
  // const funnel = useQuery(...);
  // const feed = useQuery(...);

  // Until queries return, render skeletons. Once data lands, map fields below.
  const loading = false; // replace with stats.isLoading || funnel.isLoading
  const kpis = {
    convs:     '1 248',
    convsDelta: { value: 12, positive: true },
    conversion: '23.4%',
    conversionDelta: { value: 2.1, positive: true },
    avgResp:   '47с',
    avgRespDelta: { value: 8, positive: false },
    agents:    '4',
    agentsDelta: { value: 1, positive: true },
  };
  const sparkData = [10, 14, 11, 18, 20, 17, 22, 28, 26, 31, 35, 33];

  const funnelData: any[] = []; // funnel.data ?? []
  const feedItems: FeedItem[] = []; // feed.data ?? []

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <KPICard label="Разговоров" value={kpis.convs} delta={kpis.convsDelta} icon={<MessageCircle size={14} />} spark={<Sparkline data={sparkData} />} />
        <KPICard label="Конверсия" value={kpis.conversion} delta={kpis.conversionDelta} icon={<TrendingUp size={14} />} spark={<Sparkline data={sparkData.map(v => v * 0.8)} />} />
        <KPICard label="Среднее время ответа" value={kpis.avgResp} delta={kpis.avgRespDelta} icon={<Phone size={14} />} spark={<Sparkline data={sparkData.slice().reverse()} />} />
        <KPICard label="Активных агентов" value={kpis.agents} delta={kpis.agentsDelta} icon={<Users size={14} />} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 mt-3">
        <div className="xl:col-span-8">
          {loading ? <Skeleton className="h-[320px] w-full" /> : <FunnelChart data={funnelData} />}
        </div>
        <div className="xl:col-span-4">
          <Card>
            <CardHeader title="Топ агенты" />
            <ul className="divide-y divide-line -mx-2">
              {/* TODO: map real agents from API */}
              {['Анна — voice', 'Бот WA-1', 'Бот TG-Promo'].map((n, i) => (
                <li key={n} className="flex items-center justify-between px-2 py-2 text-[13px]">
                  <span className="text-fg-0">{n}</span>
                  <span className="num text-fg-1">{[124, 88, 41][i]}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <div className="mt-3">
        <ActivityFeed items={feedItems} />
      </div>
    </div>
  );
}
```

**IMPORTANT:** Before committing, wire `__USE_EXISTING_QUERY__` to real queries from the original file. The static placeholders above must be replaced with actual hook data. Keep the same query keys so cache continuity is preserved.

- [ ] **Step 7: Smoke test**

```bash
cd admin && npm run dev
```
Open `/dashboard`. KPI cards render in a tight 4-column grid with sparklines, funnel + leaderboard below, activity feed at bottom. No console errors. Kill.

- [ ] **Step 8: Commit**

```bash
git add admin/src/components/KPICard.tsx admin/src/components/Sparkline.tsx admin/src/components/ActivityFeed.tsx admin/src/components/FunnelChart.tsx admin/src/pages/Dashboard.tsx
git commit -m "feat(admin/dashboard): KPI grid + sparklines + activity feed"
```

---

### Task 17: Conversations — virtualized split view

**Files:**
- Create: `admin/src/components/ConversationList.tsx`
- Create: `admin/src/components/ChipFilterRow.tsx`
- Modify: `admin/src/components/ConversationView.tsx`
- Modify: `admin/src/pages/Conversations.tsx`

- [ ] **Step 1: Read current `Conversations.tsx` and `ConversationView.tsx`**

```bash
cat admin/src/pages/Conversations.tsx admin/src/components/ConversationView.tsx
```
Record the API shape: how conversations are fetched, what fields each conversation has (id, name, lastMessage, unread, channel, updatedAt). The new components must consume the same shape.

- [ ] **Step 2: Create `ChipFilterRow.tsx`**

```tsx
import { cn } from '../ui/cn';

export interface Chip { key: string; label: string }

interface Props {
  chips: Chip[];
  value: string | null;
  onChange: (v: string | null) => void;
}

export default function ChipFilterRow({ chips, value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1.5 px-2 border-b border-line">
      <button
        onClick={() => onChange(null)}
        className={cn(
          'h-7 px-2.5 text-[12px] rounded-full border transition-colors',
          value === null ? 'bg-bg-2 text-fg-0 border-fg-2/30' : 'border-transparent text-fg-2 hover:text-fg-0'
        )}
      >Все</button>
      {chips.map(c => (
        <button
          key={c.key}
          onClick={() => onChange(c.key)}
          className={cn(
            'h-7 px-2.5 text-[12px] rounded-full border whitespace-nowrap transition-colors',
            value === c.key ? 'bg-bg-2 text-fg-0 border-fg-2/30' : 'border-transparent text-fg-2 hover:text-fg-0'
          )}
        >{c.label}</button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `ConversationList.tsx` (virtualized)**

```tsx
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../ui/cn';
import { Skeleton } from '../ui/Skeleton';

export interface ConvListItem {
  id: string;
  name: string;
  preview: string;
  channel: string;
  updatedAt: string;
  unread?: number;
}

interface Props {
  items: ConvListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading?: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
}

export default function ConversationList({ items, selectedId, onSelect, loading }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  if (loading) {
    return <div className="p-3 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map(row => {
          const it = items[row.index];
          const active = it.id === selectedId;
          return (
            <button
              key={it.id}
              onClick={() => onSelect(it.id)}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)`, height: row.size }}
              className={cn(
                'w-full flex items-center gap-3 px-3 text-left border-b border-line transition-colors',
                active ? 'bg-bg-2' : 'hover:bg-bg-2/60'
              )}
            >
              <div className="w-9 h-9 rounded-full bg-accent/20 text-accent grid place-items-center text-[12px] font-medium shrink-0">
                {it.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-medium text-fg-0 truncate">{it.name}</div>
                  <div className="num text-[11px] text-fg-2 shrink-0">{fmtTime(it.updatedAt)}</div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <div className="text-[12px] text-fg-1 truncate">{it.preview}</div>
                  {it.unread ? (
                    <span className="num inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-accent-fg text-[10px] font-medium">{it.unread}</span>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Restyle `ConversationView.tsx`**

Read the existing file and apply these targeted changes:
- Replace the outer container classes with: `flex flex-col h-full bg-bg-0`
- Header bar uses `h-12 px-4 border-b border-line flex items-center gap-3 bg-bg-1`
- Messages area: `flex-1 overflow-y-auto px-4 py-3 space-y-2`
- Each user message bubble: `max-w-[70%] rounded-3 px-3 py-2 text-[13px] bg-bg-2 text-fg-0`
- Each agent/inbound bubble: `max-w-[70%] rounded-3 px-3 py-2 text-[13px] bg-accent/15 text-fg-0 self-end`
- Composer: `border-t border-line p-3 flex items-end gap-2`, textarea uses our Input or a raw `<textarea>` with `bg-bg-1 border border-line rounded-2 p-2 text-[13px] resize-none min-h-[40px] max-h-[160px] flex-1 outline-none focus:border-accent`
- Send button: `<Button>` primary with `iconRight={<Send size={14} />}` and `disabled={!text.trim()}`
- `⌘+Enter` submits: add `onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend(); }}`

Keep all data flow (fetch, send mutation, optimistic updates) intact.

- [ ] **Step 5: Rewrite `Conversations.tsx`**

```tsx
import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import ConversationList, { type ConvListItem } from '../components/ConversationList';
import ConversationView from '../components/ConversationView';
import ChipFilterRow from '../components/ChipFilterRow';
import { Input } from '../ui/Input';
import { EmptyState } from '../ui/EmptyState';

const CHANNELS = [
  { key: 'whatsapp',  label: 'WhatsApp' },
  { key: 'telegram',  label: 'Telegram' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'voice',     label: 'Voice' },
];

export default function Conversations() {
  // __USE_EXISTING_QUERY__: replace with the existing useQuery hook for conversations
  const data: ConvListItem[] = []; // raw from API
  const loading = false;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [search,  setSearch]  = useState('');

  const items = useMemo(() => {
    let r = data;
    if (channel) r = r.filter(c => c.channel === channel);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(c => c.name.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
    }
    return r;
  }, [data, channel, search]);

  return (
    <div className="flex h-[calc(100vh-48px)]">
      <aside className="w-[380px] flex flex-col border-r border-line bg-bg-1">
        <div className="p-2 border-b border-line">
          <Input
            placeholder="Поиск разговоров…"
            leftSlot={<Search size={13} className="text-fg-2" />}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <ChipFilterRow chips={CHANNELS} value={channel} onChange={setChannel} />
        <div className="flex-1 min-h-0">
          <ConversationList items={items} selectedId={selectedId} onSelect={setSelectedId} loading={loading} />
        </div>
      </aside>
      <section className="flex-1 min-w-0">
        {selectedId
          ? <ConversationView conversationId={selectedId} />
          : <EmptyState
              title="Выбери разговор"
              description="Кликни строку слева, чтобы открыть переписку."
              className="h-full"
            />}
      </section>
    </div>
  );
}
```

**IMPORTANT:** Replace `__USE_EXISTING_QUERY__` with the actual `useQuery` call (keep query key). Also: `ConversationView`'s prop signature must match what it currently accepts — if it currently takes the full object, adapt the prop (or refactor `ConversationView` to take an id and fetch internally). Use the simpler of the two depending on existing code.

- [ ] **Step 6: Smoke test**

```bash
cd admin && npm run dev
```
Open `/conversations`. List loads, search filters, channel chips filter, clicking opens detail. Scroll the list — virtualization keeps it smooth even with many items. Kill.

- [ ] **Step 7: Commit**

```bash
git add admin/src/components/ConversationList.tsx admin/src/components/ChipFilterRow.tsx admin/src/components/ConversationView.tsx admin/src/pages/Conversations.tsx
git commit -m "feat(admin/conversations): virtualized split view + filters"
```

---

### Task 18: Recordings — waveform + synced transcript

**Files:**
- Create: `admin/src/components/WaveformPlayer.tsx` (from `AudioPlayer.tsx`)
- Create: `admin/src/components/TranscriptView.tsx`
- Modify: `admin/src/pages/Recordings.tsx`

- [ ] **Step 1: Read existing `AudioPlayer.tsx` and `Recordings.tsx`**

```bash
cat admin/src/components/AudioPlayer.tsx admin/src/pages/Recordings.tsx
```
Note: how waveform is constructed, where audio URL comes from, what transcript format the API returns (array of `{startMs, endMs, speaker, text}` or similar). The new components must consume the same shapes.

- [ ] **Step 2: Create `WaveformPlayer.tsx`**

Copy the existing `AudioPlayer.tsx` to a new `WaveformPlayer.tsx`, then make these changes:
- Color tokens: bar/progress use `var(--fg-2)` and `var(--accent)` instead of hard-coded grey/blue.
- Add a `currentTimeMs` `useState` and call `onTimeUpdate(ms)` prop (new) every wavesurfer `audioprocess` tick — `ms = Math.round(ws.getCurrentTime() * 1000)`.
- Add transport controls below waveform: prev 5s, play/pause, next 5s, speed selector (`<select>` styled with `bg-bg-2 border border-line rounded-1 h-7 text-[11px] px-1 text-fg-0`) with options 0.75/1/1.25/1.5/2.
- Wire speed change to `ws.setPlaybackRate(rate)`.

Export interface (top of file):
```tsx
export interface WaveformPlayerProps {
  audioUrl: string;
  onTimeUpdate?: (ms: number) => void;
  seekToMs?: number;
}
```
Use `seekToMs` in an effect: when it changes, `ws.seekTo(seekToMs / 1000 / ws.getDuration())`.

- [ ] **Step 3: Create `TranscriptView.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { cn } from '../ui/cn';

export interface TranscriptLine {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
}

interface Props {
  lines: TranscriptLine[];
  currentMs: number;
  onSeek: (ms: number) => void;
  search?: string;
}

export default function TranscriptView({ lines, currentMs, onSeek, search }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeIdx = lines.findIndex(l => currentMs >= l.startMs && currentMs < l.endMs);

  useEffect(() => {
    if (activeIdx < 0) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-line="${activeIdx}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  const q = (search ?? '').toLowerCase().trim();

  return (
    <div ref={containerRef} className="h-full overflow-y-auto p-4 space-y-1">
      {lines.map((l, i) => {
        const match = q && l.text.toLowerCase().includes(q);
        return (
          <button
            key={i}
            data-line={i}
            onClick={() => onSeek(l.startMs)}
            className={cn(
              'w-full text-left grid grid-cols-[60px_70px_1fr] gap-3 px-2 py-1.5 rounded-2 text-[13px] transition-colors',
              i === activeIdx ? 'bg-accent/15 text-fg-0' : 'text-fg-1 hover:bg-bg-2',
              match && i !== activeIdx && 'ring-1 ring-warn/40'
            )}
          >
            <span className="num text-fg-2 text-[11px]">{fmt(l.startMs)}</span>
            <span className="text-fg-2 text-[11px] truncate">{l.speaker}</span>
            <span>{l.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
```

- [ ] **Step 4: Rewrite `Recordings.tsx`**

```tsx
import { useState } from 'react';
import { Search } from 'lucide-react';
import WaveformPlayer from '../components/WaveformPlayer';
import TranscriptView, { type TranscriptLine } from '../components/TranscriptView';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';

interface Recording {
  id: string;
  startedAt: string;
  durationSec: number;
  agent: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  audioUrl: string;
  transcript: TranscriptLine[];
  summary?: string;
  actionItems?: string[];
}

export default function Recordings() {
  // __USE_EXISTING_QUERY__: keep existing recordings query
  const list: Recording[] = []; // recordings.data ?? []
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [seekMs, setSeekMs] = useState<number | undefined>();
  const [search, setSearch] = useState('');

  const selected = list.find(r => r.id === selectedId);
  const sentimentTone = (s: Recording['sentiment']) =>
    s === 'positive' ? 'ok' : s === 'negative' ? 'danger' : 'neutral';

  return (
    <div className="grid grid-cols-[320px_1fr_320px] h-[calc(100vh-48px)]">
      {/* List */}
      <aside className="flex flex-col border-r border-line bg-bg-1">
        <div className="p-2 border-b border-line">
          <Input
            placeholder="Поиск записей…"
            leftSlot={<Search size={13} />}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.length === 0
            ? <EmptyState title="Записей пока нет" className="h-full" />
            : list
                .filter(r => !search || r.agent.toLowerCase().includes(search.toLowerCase()))
                .map(r => (
                  <button
                    key={r.id}
                    onClick={() => { setSelectedId(r.id); setSeekMs(0); setCurrentMs(0); }}
                    className={`w-full text-left p-3 border-b border-line ${r.id === selectedId ? 'bg-bg-2' : 'hover:bg-bg-2/60'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-fg-0">{r.agent}</span>
                      <Badge tone={sentimentTone(r.sentiment)} size="sm">{r.sentiment}</Badge>
                    </div>
                    <div className="num text-[11px] text-fg-2 mt-1">
                      {new Date(r.startedAt).toLocaleString('ru')} · {Math.floor(r.durationSec / 60)}:{String(r.durationSec % 60).padStart(2, '0')}
                    </div>
                  </button>
                ))
          }
        </div>
      </aside>

      {/* Center */}
      <section className="flex flex-col bg-bg-0 min-w-0">
        {selected ? (
          <>
            <div className="p-4 border-b border-line">
              <WaveformPlayer
                audioUrl={selected.audioUrl}
                onTimeUpdate={setCurrentMs}
                seekToMs={seekMs}
              />
            </div>
            <div className="px-4 py-2 border-b border-line">
              <Input
                placeholder="Поиск в стенограмме…"
                leftSlot={<Search size={13} />}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="flex-1 min-h-0">
              <TranscriptView
                lines={selected.transcript}
                currentMs={currentMs}
                onSeek={setSeekMs}
                search={search}
              />
            </div>
          </>
        ) : <EmptyState title="Выбери запись" description="Слева — список звонков" className="h-full" />}
      </section>

      {/* Right — meta */}
      <aside className="border-l border-line p-4 overflow-y-auto bg-bg-1 space-y-3">
        {selected && (
          <>
            <Card padding="sm">
              <CardHeader title="Резюме" />
              <p className="text-[13px] text-fg-1">{selected.summary ?? '—'}</p>
            </Card>
            <Card padding="sm">
              <CardHeader title="Действия" />
              <ul className="space-y-1 text-[13px] text-fg-1 list-disc pl-4">
                {(selected.actionItems ?? []).map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </Card>
          </>
        )}
      </aside>
    </div>
  );
}
```

**IMPORTANT:** Wire `__USE_EXISTING_QUERY__` to real query. Map the existing API fields to the `Recording` interface; if the API doesn't yet return `transcript`/`summary`/`actionItems`, render `EmptyState` for those panels and leave the integration for backend work (out of scope for this redesign).

- [ ] **Step 5: Smoke test**

```bash
cd admin && npm run dev
```
Open `/recordings`. Three-panel layout, waveform renders for a selected recording (if backend supplies audio URLs). Click transcript line → audio seeks. Kill.

- [ ] **Step 6: Commit**

```bash
git add admin/src/components/WaveformPlayer.tsx admin/src/components/TranscriptView.tsx admin/src/pages/Recordings.tsx
git commit -m "feat(admin/recordings): three-pane layout with synced transcript"
```

---

### Task 19: Knowledge — grid + drag-drop upload

**Files:**
- Create: `admin/src/components/KnowledgeCard.tsx`
- Create: `admin/src/components/UploadDropzone.tsx`
- Modify: `admin/src/pages/Knowledge.tsx`

- [ ] **Step 1: Read current `Knowledge.tsx`**

```bash
cat admin/src/pages/Knowledge.tsx
```
Note upload API endpoint, list endpoint, item shape.

- [ ] **Step 2: Create `KnowledgeCard.tsx`**

```tsx
import { FileText, Link as LinkIcon, FileType, MoreHorizontal } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';

export interface KnowledgeItem {
  id: string;
  kind: 'pdf' | 'url' | 'doc' | 'md';
  name: string;
  size?: number;
  tags?: string[];
  updatedAt: string;
}

const iconFor: Record<KnowledgeItem['kind'], any> = {
  pdf: FileType, url: LinkIcon, doc: FileText, md: FileText,
};

function fmtSize(b?: number): string {
  if (!b) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function KnowledgeCard({ item, onClick }: { item: KnowledgeItem; onClick: () => void }) {
  const Icon = iconFor[item.kind];
  return (
    <button onClick={onClick} className="text-left">
      <Card padding="sm" className="hover:border-fg-2/30 transition-colors h-full flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <div className="w-9 h-9 rounded-2 bg-bg-2 grid place-items-center text-fg-1 shrink-0">
            <Icon size={16} />
          </div>
          <button className="text-fg-2 hover:text-fg-0" onClick={e => e.stopPropagation()}>
            <MoreHorizontal size={14} />
          </button>
        </div>
        <div className="text-[13px] font-medium text-fg-0 mt-2 line-clamp-2">{item.name}</div>
        <div className="num text-[11px] text-fg-2 mt-1">{fmtSize(item.size)} · {new Date(item.updatedAt).toLocaleDateString('ru')}</div>
        {item.tags && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {item.tags.slice(0, 3).map(t => <Badge key={t} tone="neutral" size="sm">{t}</Badge>)}
          </div>
        )}
      </Card>
    </button>
  );
}
```

- [ ] **Step 3: Create `UploadDropzone.tsx`**

```tsx
import { useState, type DragEvent } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '../ui/cn';

interface Props { onFiles: (files: File[]) => void }

export default function UploadDropzone({ onFiles }: Props) {
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files);
  };

  return (
    <label
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-3 py-8 cursor-pointer transition-colors',
        over ? 'border-accent bg-accent/5' : 'border-line bg-bg-1 hover:border-fg-2/30'
      )}
    >
      <UploadCloud size={22} className="text-fg-2" />
      <div className="text-[13px] text-fg-1">Перетащи файлы сюда или <span className="text-accent">выбери</span></div>
      <div className="text-[11px] text-fg-2">PDF, DOCX, MD — до 25 МБ</div>
      <input
        type="file"
        multiple
        className="hidden"
        onChange={e => e.target.files && onFiles(Array.from(e.target.files))}
      />
    </label>
  );
}
```

- [ ] **Step 4: Rewrite `Knowledge.tsx`**

```tsx
import { useState } from 'react';
import { Search } from 'lucide-react';
import KnowledgeCard, { type KnowledgeItem } from '../components/KnowledgeCard';
import UploadDropzone from '../components/UploadDropzone';
import { Input } from '../ui/Input';
import { EmptyState } from '../ui/EmptyState';
import { toast } from '../ui/Toast';

export default function Knowledge() {
  // __USE_EXISTING_QUERIES__:
  //   const items = useQuery(...);
  //   const upload = useMutation(...);
  const items: KnowledgeItem[] = [];

  const [search, setSearch] = useState('');
  const filtered = items.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()));

  const handleFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        // upload.mutateAsync(f) — replace with real mutation
        toast.success(`${f.name} загружен`);
      } catch (e: any) {
        toast.error(`${f.name}: ${e?.message ?? 'ошибка'}`);
      }
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-4">
      <UploadDropzone onFiles={handleFiles} />
      <Input
        placeholder="Поиск по базе знаний…"
        leftSlot={<Search size={13} />}
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      {filtered.length === 0
        ? <EmptyState title="Пусто" description="Загрузите PDF, DOCX, или MD-файлы, чтобы агент мог на них опираться." />
        : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {filtered.map(it => <KnowledgeCard key={it.id} item={it} onClick={() => {/* TODO drawer */}} />)}
          </div>
        )
      }
    </div>
  );
}
```

**IMPORTANT:** Wire real `useQuery` + `useMutation` from existing file. Toasts already initialized via `ToastRoot` in Task 14.

- [ ] **Step 5: Smoke test**

```bash
cd admin && npm run dev
```
Open `/knowledge`. Dropzone visible, drag-over highlights border. Grid renders if items exist. Kill.

- [ ] **Step 6: Commit**

```bash
git add admin/src/components/KnowledgeCard.tsx admin/src/components/UploadDropzone.tsx admin/src/pages/Knowledge.tsx
git commit -m "feat(admin/knowledge): card grid + drag-drop upload"
```

---

### Task 20: Agents — cards + edit drawer

**Files:**
- Create: `admin/src/components/AgentCard.tsx`
- Modify: `admin/src/pages/Agents.tsx`

- [ ] **Step 1: Read current `Agents.tsx`**

```bash
cat admin/src/pages/Agents.tsx
```
Capture API: agents list shape, toggle-active mutation, edit-prompt mutation.

- [ ] **Step 2: Create `AgentCard.tsx`**

```tsx
import { Card, CardHeader } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Settings2, PlayCircle } from 'lucide-react';

export interface Agent {
  id: string;
  name: string;
  channels: string[];
  active: boolean;
  convs7d?: number;
  conv7d?: number;     // conversion %
}

interface Props {
  agent: Agent;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onTest: () => void;
}

export default function AgentCard({ agent, onToggle, onEdit, onTest }: Props) {
  return (
    <Card>
      <CardHeader
        title={
          <div className="flex items-center gap-2">
            <span>{agent.name}</span>
            <Badge tone={agent.active ? 'ok' : 'neutral'} size="sm">{agent.active ? 'Активен' : 'Пауза'}</Badge>
          </div>
        }
        action={
          <label className="inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={agent.active} onChange={e => onToggle(e.target.checked)} />
            <div className="w-9 h-5 rounded-full bg-bg-2 peer-checked:bg-accent relative transition-colors">
              <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
            </div>
          </label>
        }
      />
      <div className="flex flex-wrap gap-1 mb-3">
        {agent.channels.map(c => <Badge key={c} tone="neutral" size="sm">{c}</Badge>)}
      </div>
      <div className="grid grid-cols-2 gap-3 text-center pb-3 border-b border-line">
        <div>
          <div className="num text-[18px] font-semibold text-fg-0">{agent.convs7d ?? '—'}</div>
          <div className="text-[11px] uppercase tracking-wider text-fg-2">Разговоров</div>
        </div>
        <div>
          <div className="num text-[18px] font-semibold text-fg-0">{agent.conv7d != null ? `${agent.conv7d}%` : '—'}</div>
          <div className="text-[11px] uppercase tracking-wider text-fg-2">Конверсия</div>
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <Button variant="secondary" size="sm" onClick={onEdit} iconLeft={<Settings2 size={12} />}>Промпт</Button>
        <Button variant="ghost" size="sm" onClick={onTest} iconLeft={<PlayCircle size={12} />}>Тест</Button>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Rewrite `Agents.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AgentCard, { type Agent } from '../components/AgentCard';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { toast } from '../ui/Toast';

export default function Agents() {
  // __USE_EXISTING_QUERIES__: agents list + toggle + update-prompt
  const agents: Agent[] = [];
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [prompt, setPrompt] = useState('');

  const openEdit = (a: Agent) => {
    setEditing(a);
    setPrompt(/* existing prompt fetch for a */ '');
  };

  const savePrompt = async () => {
    if (!editing) return;
    try {
      // await updatePrompt.mutateAsync({ id: editing.id, prompt });
      toast.success('Промпт обновлён');
      setEditing(null);
    } catch (e: any) {
      toast.error(e?.message ?? 'Не удалось сохранить');
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {agents.length === 0
        ? <EmptyState title="Агентов нет" description="Создайте агента, чтобы начать разговоры." />
        : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map(a => (
              <AgentCard
                key={a.id}
                agent={a}
                onToggle={(v) => {/* toggle.mutate({id: a.id, active: v}) */}}
                onEdit={() => openEdit(a)}
                onTest={() => navigate('/voice-test')}
              />
            ))}
          </div>
        )
      }

      <Modal open={!!editing} onOpenChange={(v) => !v && setEditing(null)} title={`Промпт — ${editing?.name ?? ''}`} widthClass="max-w-2xl">
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          className="w-full min-h-[280px] max-h-[60vh] font-mono text-[12px] bg-bg-0 border border-line rounded-2 p-3 text-fg-0 outline-none focus:border-accent resize-y"
        />
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="ghost" onClick={() => setEditing(null)}>Отмена</Button>
          <Button onClick={savePrompt}>Сохранить</Button>
        </div>
      </Modal>
    </div>
  );
}
```

**IMPORTANT:** Replace `__USE_EXISTING_QUERIES__` and the commented mutation calls with real ones.

- [ ] **Step 4: Smoke test**

```bash
cd admin && npm run dev
```
Open `/agents`. Cards render, toggle visually flips, "Промпт" opens modal with textarea. Kill.

- [ ] **Step 5: Commit**

```bash
git add admin/src/components/AgentCard.tsx admin/src/pages/Agents.tsx
git commit -m "feat(admin/agents): card grid + prompt editor modal"
```

---

### Task 21: VoiceTest + Chat polish

**Files:**
- Modify: `admin/src/pages/VoiceTest.tsx`
- Modify: `admin/src/pages/Chat.tsx`

- [ ] **Step 1: Polish `VoiceTest.tsx`**

Read the file, then:
- Wrap main areas in `<Card>` from `src/ui/Card`.
- Replace `<button>` elements with `<Button>` from `src/ui/Button`.
- Replace raw inputs with `<Input>`.
- Container: `<div className="p-6 max-w-[900px] mx-auto space-y-4">`
- Status indicators: use `<Badge tone="ok|warn|danger|neutral">`.
- Loading: replace spinners with `<Button loading>` or `<Skeleton>` placeholders.
- Errors: render via `toast.error(...)` from `src/ui/Toast`.

Keep all WebRTC / voximplant call logic untouched.

- [ ] **Step 2: Polish `Chat.tsx`** — same treatment

Same replacements as above. Messages bubble styles per Task 17 step 4.

- [ ] **Step 3: Smoke test**

```bash
cd admin && npm run dev
```
Open `/voice-test` and `/chat`. Render cleanly in dark theme, no white background bleed. Kill.

- [ ] **Step 4: Commit**

```bash
git add admin/src/pages/VoiceTest.tsx admin/src/pages/Chat.tsx
git commit -m "feat(admin/voice+chat): polish to new design system"
```

---

## Phase 5 — Performance pass

### Task 22: Lazy routes

**Files:**
- Modify: `admin/src/App.tsx`

- [ ] **Step 1: Convert page imports to `React.lazy`**

In `admin/src/App.tsx`, replace static imports for pages with:
```tsx
import { lazy, Suspense, useState } from 'react';
// ...
const Dashboard     = lazy(() => import('./pages/Dashboard'));
const Conversations = lazy(() => import('./pages/Conversations'));
const Recordings    = lazy(() => import('./pages/Recordings'));
const Knowledge     = lazy(() => import('./pages/Knowledge'));
const Agents        = lazy(() => import('./pages/Agents'));
const VoiceTest     = lazy(() => import('./pages/VoiceTest'));
const Chat          = lazy(() => import('./pages/Chat'));
const Login         = lazy(() => import('./pages/Login'));
```

Wrap `<Routes>` inside `PrivateLayout` (and the outer one) with a Suspense fallback:
```tsx
<Suspense fallback={
  <div className="h-full grid place-items-center text-fg-2 text-[13px]">Загрузка…</div>
}>
  <Routes>
    {/* ... */}
  </Routes>
</Suspense>
```

- [ ] **Step 2: Verify chunks**

```bash
cd admin && npm run build
```
Expected: `dist/assets/` contains multiple JS chunks (one per page), not a single monolith. Verify there are at least 7 page-prefixed chunks.

- [ ] **Step 3: Commit**

```bash
git add admin/src/App.tsx
git commit -m "perf(admin): code-split routes via React.lazy"
```

---

### Task 23: Bundle audit + icon tree-shake

**Files:**
- Modify: All files that import from `lucide-react` (sweep)
- Modify: `admin/vite.config.ts`

- [ ] **Step 1: Switch to per-icon imports**

Search the codebase:
```bash
cd "/Users/admin/Documents/Проекты /Вайбкодинг/salesagent-ai/admin"
grep -rn "from 'lucide-react'" src/
```

For each match, leave as-is *only if* the file imports ≤ 3 icons (modern bundlers tree-shake named imports from lucide-react adequately at this scale). For files importing 4+ icons, leave named imports as well — `lucide-react` is already ESM tree-shakable. **Action: just verify, no rewrite needed.**

(If post-build analysis shows lucide still bloated, switch to `import X from 'lucide-react/dist/esm/icons/x'` per-icon. Otherwise skip.)

- [ ] **Step 2: Add manualChunks to `vite.config.ts`**

Replace `vite.config.ts` with:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3003', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor':  ['react', 'react-dom', 'react-router-dom'],
          'charts':        ['recharts'],
          'wavesurfer':    ['wavesurfer.js'],
          'radix':         ['@radix-ui/react-tooltip', '@radix-ui/react-dialog', '@radix-ui/react-tabs', '@radix-ui/react-dropdown-menu'],
        },
      },
    },
  },
});
```

- [ ] **Step 3: Build + measure**

```bash
cd admin && npm run build
ls -lh dist/assets/*.js | head -30
```
Expected: per-page chunks exist; main app chunk visibly smaller than pre-redesign baseline; `react-vendor`, `charts`, `wavesurfer`, `radix` chunks present.

- [ ] **Step 4: Commit**

```bash
git add admin/vite.config.ts
git commit -m "perf(admin): manualChunks for vendor groups"
```

---

### Task 24: react-query defaults audit

**Files:**
- Modify: `admin/src/main.tsx`

- [ ] **Step 1: Tighten QueryClient defaults**

In `admin/src/main.tsx`, replace QueryClient init with:
```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
```

- [ ] **Step 2: Type-check + commit**

```bash
cd admin && npx tsc --noEmit
git add admin/src/main.tsx
git commit -m "perf(admin): tighten react-query defaults"
```

---

## Phase 6 — Final QA

### Task 25: Manual QA pass

**Files:** N/A

- [ ] **Step 1: Boot dev server and walk every page**

```bash
cd admin && npm run dev
```

Open in browser, log in if backend available (or stub token via `localStorage.setItem('token','dev')`), then:

- [ ] `/dashboard` — KPI cards aligned, sparklines render, funnel + leaderboard visible
- [ ] `/conversations` — split view, search works, channel chips work, virtualized scroll smooth
- [ ] `/recordings` — three-pane, waveform + transcript sync (if data)
- [ ] `/knowledge` — dropzone + grid + search
- [ ] `/agents` — cards + toggle + prompt modal
- [ ] `/voice-test` `/chat` — render clean
- [ ] `/login` — centered card, gradient, error state
- [ ] `⌘K` opens palette anywhere; `g d/c/r/k/a/v/h` navigate from non-input focus
- [ ] Theme toggle (palette or sidebar) — switches without FOUC, persists across reload
- [ ] Sidebar collapse persists across reload
- [ ] Console has no errors

If any item fails, file a follow-up task in this plan (append to bottom) and fix before final commit.

- [ ] **Step 2: Production build sanity**

```bash
cd admin && npm run build && npm run preview
```
Open preview URL. Same checklist. Kill.

- [ ] **Step 3: Commit (only if any QA-driven fixes were made)**

```bash
git add -A admin/
git commit -m "fix(admin): QA pass adjustments"
```
Skip if nothing changed.

---

### Task 26: Open PR

**Files:** N/A

- [ ] **Step 1: Push branch + open PR**

```bash
cd "/Users/admin/Documents/Проекты /Вайбкодинг/salesagent-ai"
git push -u origin feat/admin-sharp-redesign
```

If `gh` is set up:
```bash
gh pr create --title "feat(admin): sharp redesign — design system, command palette, perf" --body "$(cat <<'EOF'
## Summary
- New design system in src/ui/ (tokens, primitives, dark/light theme)
- Rewritten shell: collapsible Sidebar, Topbar, ⌘K command palette + hotkeys
- All 7 pages rebuilt: virtualized Conversations, three-pane Recordings, KPI Dashboard, Knowledge upload-grid, Agents cards + prompt modal
- Performance: route-level React.lazy, vendor manualChunks, tighter react-query defaults

## Test plan
- [ ] Log in works; token persists
- [ ] Each page renders without console errors
- [ ] ⌘K palette, hotkeys, theme toggle, sidebar collapse all functional
- [ ] Conversation list virtualizes with > 100 items
- [ ] Build succeeds; chunks split per page

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Restore stashed VoiceTest/demo-server changes (if any from Task 0)**

```bash
git stash list
# If a stash named "wip-before-admin-redesign" exists:
git stash pop
```
Resolve any conflicts with the new VoiceTest polish from Task 21 manually.

---

## Self-Review Notes (post-write)

**Spec coverage check:**
- Spec §2 Design System → Tasks 2, 3, 4–10 ✓
- Spec §3 Shell (Sidebar/Topbar/Palette/Hotkeys) → Tasks 11, 12, 13, 14 ✓
- Spec §4 Pages (Login/Dashboard/Conversations/Recordings/Knowledge/Agents/VoiceTest/Chat) → Tasks 15, 16, 17, 18, 19, 20, 21 ✓
- Spec §5 States — covered inline in page tasks (Skeleton, EmptyState, error banners, toast) ✓
- Spec §6 Performance → Tasks 22, 23, 24 ✓
- Spec §7 Folder Structure → reflected in the File Structure section at top ✓
- Spec §10 Risks — Tailwind v3 + CSS vars handled by Task 2 (extend palette to vars); Recharts theming handled in FunnelChart refactor (Task 16) and Sparkline; cmdk + radix versions pinned at install in Task 1 ✓
- Spec §11 Success Criteria — measurable via Task 25 (QA) + Task 23 (bundle audit)

**Placeholder scan:** TODO markers in Dashboard leaderboard and KnowledgeCard "drawer" are explicit out-of-this-plan items, noted in step text. The `__USE_EXISTING_QUERY__` markers are deliberate handoffs to keep API integration intact — they MUST be replaced during execution by reading the current page file, as the step text demands.

**Type/name consistency:** `KPICard` replaces `MetricCard`; old file kept until lazy import in Task 22 doesn't reference it. Action: in Task 16 step 8, also delete `MetricCard.tsx` if nothing else references it. Adding that to the commit. (Update: revise Task 16 step 6 — `Dashboard.tsx` no longer imports `MetricCard`, so the file becomes dead. Delete at the end of Task 21 alongside other dead-code sweep.)

**Dead-code sweep:** add a final action to Task 21 step 4:
```bash
# delete files made obsolete:
git rm admin/src/components/MetricCard.tsx admin/src/components/AudioPlayer.tsx
```
Only if no remaining references — verify with `grep -rn "MetricCard\|AudioPlayer" admin/src/`. If any reference remains, leave the file and fix the reference instead.
