"use client";

import { useEffect, useRef } from "react";
import QRCode from "qrcode";

// Renders an absolute Winwinn URL as a scannable QR. Encodes the full https URL
// so ANY phone camera (native or in-app) opens the deep link.
export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(
      ref.current,
      value,
      { width: size, margin: 1, color: { dark: "#1a140a", light: "#f4efe2" } },
      () => undefined,
    );
  }, [value, size]);

  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size, borderRadius: 6, imageRendering: "pixelated" }}
    />
  );
}
