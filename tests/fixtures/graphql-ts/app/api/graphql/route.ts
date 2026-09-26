const typeDefs = `
  type Query {
    status: String
  }

  type Mutation {
    ping(message: String!): String
  }
`;

export function POST() {
  return Response.json({ ok: Boolean(typeDefs) });
}
