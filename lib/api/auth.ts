/**
 * Zaštita API ruta. Bez ovoga ti bilo ko može isprazniti AI kvotu
 * (ili pročitati celu bazu leadova, što je tvoja jedina prava imovina).
 */

import { NextResponse, type NextRequest } from 'next/server';

/** Poređenje otporno na timing napad. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function extractToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const custom = request.headers.get('x-api-token');
  if (custom) return custom.trim();
  return request.nextUrl.searchParams.get('token');
}

/** Vraća NextResponse sa greškom ako token ne valja, ili null ako je sve u redu. */
export function requireToken(request: NextRequest): NextResponse | null {
  const expected = process.env.API_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'API_TOKEN nije podešen na serveru — ruta je zaključana' },
      { status: 503 },
    );
  }
  const provided = extractToken(request);
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'Neispravan token' }, { status: 401 });
  }
  return null;
}

/** Vercel Cron šalje `Authorization: Bearer <CRON_SECRET>`. */
export function requireCronSecret(request: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ ok: false, error: 'CRON_SECRET nije podešen' }, { status: 503 });

  const provided = extractToken(request);
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'Neispravan cron token' }, { status: 401 });
  }
  return null;
}
