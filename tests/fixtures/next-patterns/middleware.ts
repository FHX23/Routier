import { NextResponse } from 'next/server';
import { auth } from './auth';

const publicApi = ['/api/public/', '/api/webhooks/stripe', '/api/login'];

export default auth((req) => {
  if (publicApi.some((prefix) => req.nextUrl.pathname.startsWith(prefix))) return NextResponse.next();
  if (!req.auth && req.nextUrl.pathname.startsWith('/api/')) return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
});

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
