import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reasoning Room · Voice coaching",
  description: "Build your own structure. Practise consulting reasoning through focused voice drills.",
  other: {
    "codex-preview": "development",
  },
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
