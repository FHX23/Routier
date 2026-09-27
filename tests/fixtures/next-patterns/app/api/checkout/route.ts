export async function POST(req: Request) {
  const { amount, currency, email, isRecurring = false } = await req.json();
  return Response.json({ amount, currency, email, isRecurring });
}
