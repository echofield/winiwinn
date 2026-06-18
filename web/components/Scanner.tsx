"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";

type Status = "starting" | "scanning" | "denied" | "error";

// Live QR scanner. Opens the rear camera, decodes continuously, and hands the
// decoded text up. iOS-safe (<video> playsinline+muted+autoplay, started from the
// user's Scan tap). Stops all tracks on unmount. Falls back to paste on denial.
export function Scanner({ onResult }: { onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [status, setStatus] = useState<Status>("starting");

  useEffect(() => {
    let done = false;
    let controls: IScannerControls | null = null;
    const reader = new BrowserQRCodeReader();
    const video = videoRef.current;

    (async () => {
      try {
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } } },
          video!,
          (result) => {
            if (result && !done) {
              done = true;
              const text = result.getText();
              controls?.stop();
              onResultRef.current(text);
            }
          },
        );
        setStatus("scanning");
      } catch (err) {
        const name = (err as { name?: string })?.name;
        setStatus(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error");
      }
    })();

    return () => {
      done = true;
      controls?.stop();
      const stream = video?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, []);

  return (
    <div className="scanner-frame">
      <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
      <div className="scanner-reticle" />
      <div className="scanner-hint">
        {status === "scanning" && "Point at a Winwinn code"}
        {status === "starting" && "Waking the camera…"}
        {status === "denied" && "Camera blocked — paste the link below instead"}
        {status === "error" && "No camera here — paste the link below instead"}
      </div>
    </div>
  );
}
