export { auth as middleware } from "./auth";

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - api/auth (NextAuth routes)
     * - _next/static, _next/image (Next.js internals)
     * - favicon.ico, icon.svg, public assets
     * - /login (login page)
     */
    "/((?!api/auth|_next/static|_next/image|favicon.ico|icon.svg|login).*)",
  ],
};
