"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getContract, createConversion, getConversionSettlement, cents } from "@/lib/api";
import { QrCode } from "@/components/QrCode";
import { appOrigin } from "@/lib/onboarding";
import type { Contract, ConversionSettlement } from "@/lib/types";

type Stage = "loading" | "ready" | "paying" | "settled" | "gone";

// The merchant's page — what they display on the table. The QR, the reward %, the
// cap, and live receipt proof. One scan → a guest pays → the contract settles.
export default function DealPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id || "");
  const [stage, setStage] = useState<Stage>("loading");
  const [contract, setContract] = useState<Contract | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<ConversionSettlement | null>(null);

  useEffect(() => {
    getContract(id)
      .then((c) => { setContract(c); setStage("ready"); })
      .catch(() => setStage("gone"));
  }, [id]);

  const name = (contract?.title || "").replace(/ — warm intro deal$/, "") || "this place";
  // The scannable code points at the app deal page, so any camera opens it.
  const dealUrl = `${appOrigin()}/deal/${id}`;

  async function guestPays() {
    if (!contract) return;
    setStage("paying");
    try {
      const conv = await createConversion({ contractId: contract.id, amountCents: 12000 });
      setCheckoutUrl(conv.checkoutUrl);
      if (conv.checkoutUrl) window.open(conv.checkoutUrl, "_blank");
      // Poll until the webhook settles it (live), then show the receipt.
      let tries = 0;
      const iv = window.setInterval(async () => {
        tries += 1;
        try {
          const s = await getConversionSettlement(conv.conversionId);
          if (s.status === "settled" && s.chain.length) {
            window.clearInterval(iv);
            setSettlement(s);
            setStage("settled");
          }
        } catch { /* keep waiting */ }
        if (tries > 60) window.clearInterval(iv);
      }, 3500);
    } catch {
      setStage("ready");
    }
  }

  return (
    <main className="app-shell theme-night layout-phone enter-shell">
      <div className="top-glow" />
      <div className="scan-head">
        <Link href="/" className="scan-back">← Winwinn</Link>
        <span className="kicker">merchant deal</span>
      </div>

      {stage === "loading" && <div className="notice">Opening the deal…</div>}

      {stage === "gone" && (
        <section className="enter-card" style={{ margin: "auto 0" }}>
          <h2>This deal has moved.</h2>
          <p className="small">The link is off or expired.</p>
          <Link className="primary-button" href="/merchant" style={{ textDecoration: "none", display: "block", textAlign: "center", marginTop: 12 }}>
            Create a deal
          </Link>
        </section>
      )}

      {contract && (stage === "ready" || stage === "paying") && (
        <section className="qr-card" style={{ margin: "auto 0", maxWidth: 360 }}>
          <div className="kicker" style={{ color: "var(--accent)" }}>{name}</div>
          <h3 style={{ margin: "8px 0 2px" }}>Warm intros pay {contract.reward_value}% — capped at {contract.cap_depth} hops.</h3>
          <div className="qr-well">
            <QrCode value={contract.payment_link_url || dealUrl} size={196} />
          </div>
          <div className="mono small" style={{ marginTop: 12, color: "var(--muted)", lineHeight: 1.45 }}>
            Sits on the table. Guests scan to pay — the contract handles the spread, and you only pay when a real guest pays.
          </div>
          <button className="primary-button" style={{ marginTop: 16, width: "100%" }} onClick={guestPays} disabled={stage === "paying"}>
            {stage === "paying" ? "Waiting for payment…" : "A guest pays €120 →"}
          </button>
          {checkoutUrl && stage === "paying" && (
            <a className="secondary-button" href={checkoutUrl} target="_blank" style={{ display: "block", textAlign: "center", textDecoration: "none", marginTop: 9 }}>
              Open Mollie checkout
            </a>
          )}
          <div className="mono small" style={{ marginTop: 12, color: "var(--faint)" }}>settles via Mollie · see every settlement</div>
        </section>
      )}

      {stage === "settled" && settlement && (
        <section className="qr-card" style={{ margin: "auto 0", maxWidth: 380 }}>
          <div className="kicker" style={{ color: "var(--accent)" }}>settled · live receipt</div>
          <h3 style={{ margin: "8px 0 2px" }}>
            €{cents(settlement.rewardPoolCents)} flowed back through the chain.
          </h3>
          <div className="mono small" style={{ marginTop: 10, color: "var(--muted)" }}>
            {contract?.reward_value}% of €{cents(settlement.billCents)} bill · capped at {contract?.cap_depth} hops
          </div>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {settlement.chain.map((r) => (
              <div key={`${r.userId}-${r.hop}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="small">{r.name} · hop {r.hop}</span>
                <span className="mono money">+€{cents(r.amountCents)}</span>
              </div>
            ))}
          </div>
          <div className="mono small" style={{ marginTop: 14, color: "var(--faint)" }}>
            this recommendation caused this payment · settled via Mollie
          </div>
          <button className="ghost-button" style={{ marginTop: 12 }} onClick={() => setStage("ready")}>Done</button>
        </section>
      )}
    </main>
  );
}
