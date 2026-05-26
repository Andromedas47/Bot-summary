import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll:  () => req.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value, options }) => {
            req.cookies.set(name, value);
            res.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Already on login — let through (avoids redirect loop)
  if (pathname.startsWith("/login") || pathname.startsWith("/auth")) {
    // Redirect authenticated users away from login
    if (user) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return res;
  }

  // Webhook must never be blocked by auth
  if (pathname.startsWith("/api/webhook")) {
    return res;
  }

  // Local parser test endpoint is disabled in production by its route handler.
  if (process.env.NODE_ENV !== "production" && pathname === "/api/test-parser") {
    return res;
  }

  // All other routes require a session
  if (!user) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match every route except Next.js internals and static assets.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
