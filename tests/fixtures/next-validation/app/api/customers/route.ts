import { NextResponse } from 'next/server';
import { customerSchema } from '@/lib/validations/customer';

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = customerSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  return NextResponse.json(parsed.data, { status: 201 });
}
