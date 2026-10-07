import { headers } from 'next/headers';

export async function POST(req: Request) {
  const payload = await req.text();
  const signature = (await headers()).get('Stripe-Signature');
  return Response.json({ received: Boolean(payload && signature) });
}
