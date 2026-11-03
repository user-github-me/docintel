import { NextResponse, type NextRequest } from "next/server";
import { AUTH_CHALLENGE, checkBasicAuth } from "@/lib/basic-auth";

/**
 * Optional basic auth for pages (enabled when WEB_BASIC_AUTH is set). The BFF routes under
 * /api/* run the same check themselves: excluding them here avoids request-body buffering,
 * which would otherwise cap uploads at the proxy body limit.
 */
export function proxy(request: NextRequest) {
  if (!process.env.WEB_BASIC_AUTH) return NextResponse.next();
  const auth = checkBasicAuth(request.headers.get("authorization"));
  if (!auth.ok) return new NextResponse("Authentication required", { status: 401, headers: AUTH_CHALLENGE });
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
