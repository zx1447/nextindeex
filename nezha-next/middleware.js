import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // 首页重写到静态 HTML
  if (pathname === '/' || pathname === '/index.html') {
    return NextResponse.rewrite(new URL('/greenleaf.html', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/'],
};
