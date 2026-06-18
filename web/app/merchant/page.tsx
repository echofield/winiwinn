"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createMerchant, createContract } from "@/lib/api";
import { DEAL_TEMPLATES } from "@/lib/templates";

// Winwinn Lite — one reward link for one merchant. One tap to a deal, no graph,
// no jargon. Operator-clear: you only pay when a real guest pays.
export default function MerchantPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [tpl, setTpl] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = DEAL_TEMPLATES[tpl];

  async function createDeal() {
    if (!name.trim()) {
      setError("Name your place first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const merchant = await createMerchant(name.trim());
      const res = await createContract({
        merchantId: merchant.id,
        title: `${name.trim()} — warm intro deal`,
        rewardType: "pct",
        rewardValue: t.rewardValue,
        conversionDef: "covered_bill",
        capDepth: t.capDepth,
        splitCurve: t.splitCurve,
        linkAmountCents: 5000,
      });
      router.push(`/deal/${res.contract.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the deal.");
      setBusy(false);
    }
  }

  return (
    <main className="app-shell theme-night layout-phone enter-shell">
      <div className="top-glow" />
      <div className="scan-head">
        <Link href="/" className="scan-back">← Winwinn</Link>
        <span className="kicker">for merchants</span>
      </div>

      <section className="enter-card" style={{ margin: "auto 0" }}>
        <div className="kicker" style={{ color: "var(--accent)" }}>set up your deal</div>
        <h1 className="enter-name" style={{ fontSize: 34 }}>One reward link for your place.</h1>
        <p className="small" style={{ marginTop: 12, lineHeight: 1.5 }}>
          You only pay when a <strong style={{ color: "var(--ink)" }}>real guest pays</strong>. Pick your type — we set the
          reward and the cap. Change it later.
        </p>

        <div className="chip-row" style={{ marginTop: 18 }}>
          {DEAL_TEMPLATES.map((d, i) => (
            <button key={d.key} className={i === tpl ? "chip active" : "chip"} onClick={() => setTpl(i)}>
              {d.emoji} {d.label}
            </button>
          ))}
        </div>

        <div className="reward-preview" style={{ marginTop: 16 }}>
          <span className="reward-badge">{t.rewardValue}%</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="reward-name">{t.label} deal</div>
            <div className="mono small" style={{ marginTop: 3 }}>{t.blurb} · merchant-funded</div>
          </div>
        </div>

        <input
          className="rec-input"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          placeholder="Your place — e.g. Chez Janou"
        />

        <button className="primary-button" style={{ marginTop: 16, width: "100%" }} onClick={createDeal} disabled={busy}>
          {busy ? "Creating…" : "Create my deal →"}
        </button>
        {error && <p className="error mono">{error}</p>}
        <div className="mono small" style={{ marginTop: 12, color: "var(--faint)", lineHeight: 1.4 }}>
          Cap at {t.capDepth} hops · settles via Mollie · see every settlement.
        </div>
      </section>
    </main>
  );
}
