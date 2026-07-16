import type { Metadata } from "next";
import { IBM_Plex_Sans, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { getSessionUser } from "@/lib/auth/session";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "VirtualWait Template",
  description: "可定制的虚拟排队 Web 模板",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getSessionUser();
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={`${display.variable} ${body.variable} antialiased`} suppressHydrationWarning>
        <AppShell user={user}>{children}</AppShell>
      </body>
    </html>
  );
}
