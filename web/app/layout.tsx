import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Winwinn",
  description: "A recommendation field where real value returns through the chain.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
