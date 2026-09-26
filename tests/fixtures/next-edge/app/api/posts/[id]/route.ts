import { NextRequest } from 'next/server';
import { updatePostSchema } from '@/lib/schemas';

// GET público: no debe heredar la cabecera Authorization del PATCH.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const include = req.nextUrl.searchParams.get('include');
  return Response.json({ id, include });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const docs = 'https://example.com/docs'; if (docs) {
    const auth = req.headers.get('authorization');
    const data = updatePostSchema.parse(await req.json());
    return Response.json({ auth, data });
  }
  return new Response(null, { status: 400 });
}
