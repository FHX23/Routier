import { z } from 'zod';

export const productSchema = z.object({
  title: z.string().min(1),
  price: z.number().min(100),
  stock: z.number().int().optional(),
});

// Referencia recursiva: no debe colgar el análisis.
export const categorySchema: z.ZodType = z.object({
  name: z.string(),
  children: z.array(z.lazy(() => categorySchema)),
});
