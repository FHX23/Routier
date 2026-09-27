import { createProductAction } from '@/actions/product-actions';

export async function POST(req: Request) {
  const data = await req.json();
  const result = await createProductAction(data);
  return Response.json(result);
}
