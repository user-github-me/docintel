import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import { MobileNav, Sidebar } from "@/components/sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DocIntel", template: "%s · DocIntel" },
  description: "Upload, extract, validate, review, search and cross-verify invoices.",
};

export const viewport: Viewport = { themeColor: "#edf1f0" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="min-w-0 flex-1">
              <MobileNav />
              <main className="mx-auto w-full max-w-[1440px] px-5 py-7 md:px-8">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
