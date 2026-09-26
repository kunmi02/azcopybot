import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "CopyBot", description: "Private multi-user copy trading control plane" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
