import { NextResponse } from 'next/server';

export function middleware(request) {
  const token = request.cookies.get('nexus_token')?.value || request.cookies.get('token')?.value;
  const isProtectedRoute =
    request.nextUrl.pathname.startsWith('/dashboard') ||
    request.nextUrl.pathname.startsWith('/upload') ||
    request.nextUrl.pathname.startsWith('/forecasting') ||
    request.nextUrl.pathname.startsWith('/inventory') ||
    request.nextUrl.pathname.startsWith('/pricing');

  if (isProtectedRoute && !token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/upload/:path*', '/forecasting/:path*', '/inventory/:path*', '/pricing/:path*'],
};
