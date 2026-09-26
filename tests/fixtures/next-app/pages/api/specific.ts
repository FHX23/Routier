import { z } from 'zod';

const updateSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean()
});

export default function handler(req: any, res: any) {
  const token = req.headers['authorization'];
  if (req.method === 'DELETE') {
    return res.status(200).end();
  }
  if (req.method === 'PATCH') {
    const data = updateSchema.parse(req.body);
    return res.status(200).json(data);
  }
  switch (req.method) {
    case 'PUT':
      const data2 = updateSchema.parse(req.body);
      return res.status(200).json(data2);
  }
}
