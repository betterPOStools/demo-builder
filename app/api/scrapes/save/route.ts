// POST /api/scrapes/save
// Receives raw Outscraper rows from Prospect Tracker and writes them to disk.
// This is a local-only endpoint — only reachable on the Mac via Tailscale.
// Silently ignored by PT if demo-builder isn't running.

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const SCRAPES_DIR = join(
  process.env.PT_SCRAPES_DIR ||
  '/Users/nomad/Projects/betterpostools/prospect-tracker/Scrapes/raw'
)

interface SaveRequest {
  area:     string
  source:   'file' | 'api' | 'webhook'
  task_id?: string
  rows:     unknown[]
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { area, source, task_id, rows } = body as SaveRequest

  if (!area || !source || !Array.isArray(rows)) {
    return Response.json({ error: 'area, source, and rows are required' }, { status: 400 })
  }

  try {
    mkdirSync(SCRAPES_DIR, { recursive: true })

    const date    = new Date().toISOString().slice(0, 10)
    const slug    = area.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    const taskSuffix = task_id ? `_${task_id.slice(0, 12)}` : ''
    const filename = `${date}_${slug}_${source}${taskSuffix}.json`
    const filepath = join(SCRAPES_DIR, filename)

    writeFileSync(filepath, JSON.stringify({
      area,
      source,
      task_id: task_id || null,
      row_count: rows.length,
      exported_at: new Date().toISOString(),
      rows,
    }, null, 2))

    return Response.json({ saved: filename, row_count: rows.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `Write failed: ${msg}` }, { status: 500 })
  }
}
