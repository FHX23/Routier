import { uploadAction } from '@/actions/product-actions';

export async function POST(request: Request) {
  const formData = await request.formData();
  return Response.json(await uploadAction(formData));
}
