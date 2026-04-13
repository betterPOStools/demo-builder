import { NextRequest, NextResponse } from 'next/server'

// Allowed origins — Capacitor WebView + local browser dev
const ALLOWED_ORIGINS = [
  'https://localhost',        // Capacitor Android (androidScheme: https)
  'capacitor://localhost',   // Capacitor legacy
  'http://localhost',
  'http://localhost:5176',
  'http://100.118.51.78:5176',
]

export default function proxy(req: NextRequest) {
  const origin = req.headers.get('origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin)

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  allowed ? origin : '',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age':       '86400',
      },
    })
  }

  const res = NextResponse.next()
  if (allowed) {
    res.headers.set('Access-Control-Allow-Origin',  origin)
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }
  return res
}

export const config = {
  matcher: '/api/:path*',
}
