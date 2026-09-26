import { z } from 'zod';

const filterSchema = z.object({ q: z.string() });

// GET que valida con Zod: nunca debe generar body.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filters = filterSchema.parse({ q: searchParams.get('q') });
  return Response.json(filters);
}
