import type { Metadata } from "next";
import localFont from "next/font/local";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import "./globals.css";

// Self-hosted rather than next/font/google on purpose. `next/font/google`
// downloads the woff2 from fonts.gstatic.com *at build time*, so `podman
// compose up --build` fails (or silently falls back to a system font) on any
// machine whose build sandbox can't reach Google. claudio is a locally-built
// container; its image build shouldn't need the internet for a typeface.
//
// One file covers every weight we use: this is the variable cut of JetBrains
// Mono, latin subset, wght axis 400-800. Refresh it from
// https://fonts.googleapis.com/css2?family=JetBrains+Mono if it ever needs
// updating.
const mono = localFont({
  src: "./fonts/JetBrainsMono-latin.woff2",
  variable: "--font-mono",
  display: "swap",
  weight: "400 800",
  style: "normal",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: "claudio",
  description: "Claude Code through your GitHub Copilot subscription.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={cn("dark", mono.variable)}>
      <body>
        {children}
        <Toaster position="bottom-right" theme="dark" duration={3000} />
      </body>
    </html>
  );
}
