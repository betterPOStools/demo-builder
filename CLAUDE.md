# CLAUDE.md — Demo Builder

Unified POS pipeline app: Extract menus → Design templates → Deploy to MariaDB.

## Stack

- **Framework:** Next.js 15 (App Router, TypeScript)
- **Styling:** Tailwind CSS 4 + shadcn/ui
- **State:** Zustand (4 slices: extraction, design, modifier, deploy)
- **DnD:** @dnd-kit/core + sortable
- **AI:** Anthropic SDK (Haiku 4.5 text, Sonnet 4.6 vision)
- **Database:** Supabase PostgreSQL (`demo_builder` schema)
- **Hosting:** Vercel

## Dev Commands

```bash
npm run dev          # Start dev server on port 3002
npm run build        # Production build
npm run lint         # ESLint
```

## Architecture

- `app/` — Next.js App Router pages + API routes
- `lib/` — Business logic (extraction, SQL generation, types)
- `store/` — Zustand store with 4 slices
- `components/` — React components (layout, extract, design, deploy, ui)
- `agent/` — Local deploy agent (Python, runs on laptop)

## Port

| Port | Service |
|------|---------|
| 3002 | Next.js dev server |

## Pipeline

```
Step 1: Extract → Step 2: Design → Step 3: Deploy
```

Data flows through Zustand store:
1. Extraction produces `MenuRow[]` + modifier suggestions
2. `parseMenuRows()` converts to `ImportedMenuItem[]` → creates `GroupNode[]` + `ItemNode[]`
3. `serializeDesignConfig()` produces `DesignConfigV2` → SQL generation
4. SQL staged in Supabase → local deploy agent executes against MariaDB

## Sibling Apps (READ ONLY — never modify)

- `../adv-menu-import/` — Source for extraction prompts + file processing patterns
- `../template-builder/` — Source for design types, reducer logic, serializer
- `../pos-scaffold/` — Source for SQL generation, MariaDB deployer

## Supabase

- Schema: `demo_builder`
- Tables: `sessions`, `usage_logs`, `connections`
- Project: same shared instance as other suite apps
