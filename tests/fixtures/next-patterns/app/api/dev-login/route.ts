type Role = 'ADMIN' | 'MEMBER';

export async function POST(request: Request) {
  const body = await request.json();
  const role = body.role as Role;
  return Response.json({ role });
}
