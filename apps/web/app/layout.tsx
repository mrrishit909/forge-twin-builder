import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FORGE · digital twin builder",
  description: "Browser-native industrial digital twin builder on synthetic data: drag assets with snapping gizmos, bind MQTT telemetry, branch the factory, simulate throughput, compare with confidence intervals, collaborate in world space.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0e13" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
