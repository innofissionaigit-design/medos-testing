import { NextResponse, type NextRequest } from "next/server";

/** UX redirect only: the API enforces authentication and permissions on every call. */
export function middleware(req: NextRequest) {
  const has = req.cookies.has("medos_at") || req.cookies.has("medos_rt");
  const { pathname } = req.nextUrl;
  // The patient app has its own sign-in (a code on the patient's mobile) and its own cookie; it is never part of the staff login.
  // A sign-in form submitted before the page finished loading must never leave a password in the address bar: drop anything like that and start again.
  if (pathname === "/login" && (req.nextUrl.searchParams.has("password") || req.nextUrl.searchParams.has("identifier"))) return NextResponse.redirect(new URL("/login", req.url));
  if (pathname === "/patient" || pathname.startsWith("/patient/")) return NextResponse.next();
  if (!has && pathname !== "/login") return NextResponse.redirect(new URL("/login", req.url));
  if (has && pathname === "/login") return NextResponse.redirect(new URL("/dashboard", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!api|_next|favicon.ico).*)"] };
