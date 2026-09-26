export const validate = (schema: any) => (req: any, res: any, next: any) => {
  schema.parse(req.body);
  next();
};
