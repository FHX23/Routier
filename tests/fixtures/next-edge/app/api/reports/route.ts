import { withAuth } from '@/lib/with-auth';

async function handler(request: Request) {
  const key = request.headers.get('X-Api-Key');
  return Response.json({ key });
}

export const DELETE = withAuth(async (req: Request) => {
  const token = req.headers.get('Authorization');
  return Response.json({ token });
});

export { handler as POST };
