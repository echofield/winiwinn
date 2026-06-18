"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Scanner } from "@/components/Scanner";
import { parseToken } from "@/lib/onboarding";

// Phone B points its camera at phone A's Winwinn QR → lands on /r/{token},
// the same handler the deep link uses. Scanning ≡ opening the link.
export default function ScanPage() {
  const router = useRouter();
  const [pasted, setPasted] = useState("");
  const [bad, setBad] = useState(false);

  const go = useCallback(
    (text: string) => {
      const token = parseToken(text);
      if (token) router.push(`/r/${token}`);
      else setBad(true);
    },
    [router],
  );

  return (
    <main className="app-shell theme-night layout-phone scan-shell">
      <div className="scan-head">
        <Link href="/" className="scan-back">
          ← field
        </Link>
        <span className="kicker">scan a code</span>
      </div>

      <Scanner onResult={go} />

      <div className="scan-paste">
        <div className="mono small" style={{ color: "var(--faint)" }}>
          or paste a Winwinn link
        </div>
        <input
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
            setBad(false);
          }}
          placeholder="winwinn.vercel.app/r/…"
          style={{
            width: "100%",
            marginTop: 8,
            padding: "13px 14px",
            borderRadius: 12,
            border: "1px solid var(--brd)",
            background: "var(--card2)",
            color: "var(--ink)",
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 13,
          }}
        />
        {bad && <div className="error mono" style={{ marginTop: 8 }}>That doesn&apos;t look like a Winwinn link.</div>}
        <button className="primary-button" style={{ marginTop: 12, width: "100%" }} onClick={() => go(pasted)}>
          Enter this field →
        </button>
      </div>
    </main>
  );
}
