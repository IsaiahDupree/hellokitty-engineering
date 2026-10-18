import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HelloKitty Engineering",
  description: "Private requirements, CAD evidence and engineering iteration workspace for the civilian tandem VTOL demonstrator.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
