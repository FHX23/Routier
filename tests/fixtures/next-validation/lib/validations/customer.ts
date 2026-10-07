import { number, object, string, z } from 'zod';

// Schema sintético con validaciones típicas (RUT chileno, celular, nombres) usando imports con nombre.
export const customerSchema = object({
  name: string({ required_error: 'Name is required' })
    .min(1)
    .max(50)
    .regex(/^[A-Za-zÀ-ÿ\s]+$/, 'Only letters'),
  rut: string()
    .min(9)
    .max(12)
    .regex(/^(\d{1,2}\.\d{3}\.\d{3}-[\dkK]|\d{7,8}-[\dkK])$/, 'Invalid RUT'),
  phone: string().regex(/^\+569\d{8}$/),
  address: string().min(5).max(60),
  email: string().trim().min(6).max(100).email(),
  kind: z.enum(['PERSON', 'COMPANY']),
  netPrice: number().min(100),
  stock: number().int().nonnegative().optional(),
  website: string().url().optional().or(z.literal('')),
  password: string().regex(/^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).*$/).min(8),
}).superRefine((data, ctx) => {
  if (data.kind === 'COMPANY' && !data.website) {
    ctx.addIssue({ code: 'custom', path: ['website'], message: 'Companies need a website' });
  }
});
