import type { Request, Response } from 'express';

export async function list(req: Request, res: Response) {
  const { page, limit } = req.query;
  res.json({ page, limit, items: [] });
}

export const create = async (req: Request, res: Response) => {
  res.status(201).json(req.body);
};

export function show(req: Request, res: Response) {
  res.json({ id: req.params.id });
}

export function remove(req: Request, res: Response) {
  res.status(204).end();
}
