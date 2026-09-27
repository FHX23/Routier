import { z } from 'zod';
import { productSchema } from '@/lib/product-schema';

export const createProductAction = async (values: z.infer<typeof productSchema>) => {
  const parsed = productSchema.safeParse(values);
  return parsed.success ? { ok: true } : { error: 'invalid' };
};

export async function uploadAction(form: FormData) {
  const file = form.get('file') as File | null;
  const folder = form.get('folder') as string;
  return { file, folder };
}
