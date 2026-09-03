/** PATCH /api/leads/:id — promena statusa leada iz dashboarda. */

import { NextResponse, type NextRequest } from 'next/server';
import { updateLeadStatus } from '@/lib/db/leads';
import type { LeadStatus } from '@/lib/types/lead';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED: LeadStatus[] = ['new', 'contacted', 'replied', 'won', 'lost', 'rejected'];

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  let body: { status?: string; note?: string };
  try {
    body = (await request.json()) as { status?: string; note?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'Telo zahteva nije validan JSON' }, { status: 400 });
  }

  const status = body.status as LeadStatus | undefined;
  if (!status || !ALLOWED.includes(status)) {
    return NextResponse.json({ ok: false, error: `Status mora biti jedan od: ${ALLOWED.join(', ')}` }, { status: 400 });
  }

  const updated = await updateLeadStatus(params.id, status, body.note);
  if (!updated) return NextResponse.json({ ok: false, error: 'Izmena nije sačuvana' }, { status: 500 });

  return NextResponse.json({ ok: true, id: params.id, status });
}
