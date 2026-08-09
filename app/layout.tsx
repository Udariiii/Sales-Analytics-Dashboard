import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "RetailPulse AI | SME Sales Intelligence";
  const description = "Historical sales analytics, predictive forecasting and AI-assisted management summaries for Sri Lankan SMEs.";
  return {
    title,
    description,
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1792, height: 920, alt: "RetailPulse AI sales intelligence dashboard" }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
