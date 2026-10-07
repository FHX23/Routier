import { Type } from '@fastify/type-provider-typebox';

const IdSchema = Type.Integer({ minimum: 1 });
export const EmailSchema = Type.String({ format: 'email' });

export const CredentialsSchema = Type.Object({
  email: EmailSchema,
  password: Type.String({ minLength: 8 }),
});

export const CreateTaskSchema = Type.Object({
  name: Type.String(),
  assigned_user_id: Type.Optional(IdSchema),
  status: Type.Union([Type.Literal('new'), Type.Literal('done')]),
});

export const QueryTasksSchema = Type.Object({
  page: Type.Integer({ minimum: 1, default: 1 }),
  status: Type.Optional(Type.String()),
});
