import express from 'express';
import { graphqlHTTP } from 'express-graphql';
import usersRouter from './routes/users';
import { postsRouter } from './routes/posts.js';
import { requireAuth } from './middleware/auth';

const app = express();

app.use(express.json());
app.get('env'); // setting getter, not a route

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/users', usersRouter);
app.use('/api/posts', requireAuth, postsRouter);
app.use('/api/legacy', require('./routes/legacy'));
app.use('/graphql', graphqlHTTP({ graphiql: true }));

export default app;
