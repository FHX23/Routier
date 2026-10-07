import { PLANS } from '@/lib/billing';

const CURRENCIES = ['CLP', 'USD'] as const;

export async function POST(req: Request) {
  const { amount, currency, email, plan, interval, isRecurring = false } = await req.json();
  if (!CURRENCIES.includes(currency)) {
    return Response.json({ error: 'Unsupported currency' }, { status: 400 });
  }
  if (!PLANS.has(plan) || !['month', 'year'].includes(interval)) {
    return Response.json({ error: 'Invalid plan' }, { status: 400 });
  }
  return Response.json({ amount, currency, email, plan, interval, isRecurring });
}
