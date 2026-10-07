export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  body = await request.json();
  return Response.json({ email: body.email });
}
