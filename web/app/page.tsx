"use client";

import { useEffect, useMemo, useState } from "react";
import { FieldCanvas } from "@/components/FieldCanvas";
import {
  buildDemoRail,
  cents,
  createUser,
  demoDna,
  getEconomy,
  getField,
  getReputation,
} from "@/lib/api";
import type { ConversionSettlement, DemoRail, EconomyResponse, FieldNode, ReputationResponse, User } from "@/lib/types";

type Screen = "welcome" | "onboard" | "field";
type View = "value" | "aura";
type Theme = "day" | "night";
type LayoutMode = "desktop" | "phone";

const questions = [
  {
    text: "How much do you share?",
    options: ["I recommend constantly", "Only when it's right", "Rarely, but it lands", "I connect people, quietly"],
  },
  {
    text: "What do you trade in?",
    options: ["Places & taste", "People & intros", "Knowledge & ideas", "Deals & access"],
  },
  {
    text: "When you recommend, you...",
    options: ["Stake behind it", "Vouch lightly", "Just drop it", "Curate, never push"],
  },
  {
    text: "What's your win?",
    options: ["The money back", "Status in the network", "Reciprocity", "Just the connection"],
  },
];

const domainHue = [43, 330, 168, 210];
const incentive = ["yield", "reputation", "exchange", "intrinsic"];

export default function Home() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [name, setName] = useState("Alice");
  const [user, setUser] = useState<User | null>(null);
  const [rail, setRail] = useState<DemoRail | null>(null);
  const [view, setView] = useState<View>("value");
  const [theme, setTheme] = useState<Theme>("day");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [economy, setEconomy] = useState<EconomyResponse | null>(null);
  const [reputation, setReputation] = useState<ReputationResponse | null>(null);
  const [notice, setNotice] = useState("Your field moves while you're away.");
  const [showReceipt, setShowReceipt] = useState(true);

  useEffect(() => {
    getEconomy().then(setEconomy).catch(() => {
      setEconomy(null);
    });
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      getEconomy().then(setEconomy).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  const field = rail?.field || (user ? { nodes: userToField(user), edges: [] } : { nodes: demoPreviewNodes(), edges: demoPreviewEdges() });
  const settlement = rail?.settlement || null;
  const rootUser = rail?.root || user;

  const canvasNodes = useMemo(() => {
    const nodes = [...field.nodes];
    if (settlement?.contract) {
      nodes.push({
        id: settlement.contract.merchantId,
        name: settlement.contract.merchantName,
        color: "hsl(168 58% 64%)",
        earningsCents: settlement.merchant?.netCents || 0,
        auraScore: 0,
        type: "merchant",
        dealPct: settlement.contract.rewardValue,
      } as FieldNode & { type: "merchant"; dealPct: number });
    }
    return nodes;
  }, [field.nodes, settlement]);

  async function pick(answer: number) {
    const next = [...answers];
    next[step] = answer;
    setAnswers(next);
    if (step < questions.length - 1) {
      setStep(step + 1);
      return;
    }

    const dna = buildDna(next);
    setBusy(true);
    setError(null);
    try {
      const created = await createUser(name || "Alice", dna);
      setUser(created);
      setScreen("field");
      setNotice(`${created.name} bloomed into the field — the chain remembers.`);
      const [freshField, freshEconomy] = await Promise.all([getField(created.id), getEconomy()]);
      setRail((current) => (current ? { ...current, field: freshField, economy: freshEconomy } : null));
      setEconomy(freshEconomy);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user.");
    } finally {
      setBusy(false);
    }
  }

  async function runSettlement() {
    setBusy(true);
    setError(null);
    setNotice("Chez Janou is settling the deal…");
    try {
      const next = await buildDemoRail(user);
      setRail(next);
      setShowReceipt(true);
      setUser(next.root);
      setEconomy(next.economy);
      setScreen("field");
      setNotice(
        next.conversion.mode === "simulation"
          ? "Chez Janou settled the reward back through the chain."
          : "Mollie checkout is live — pay it in test mode to settle the chain.",
      );
      const rep = await getReputation(next.carol.id).catch(() => null);
      setReputation(rep);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the demo settlement.");
      setNotice("The field couldn't settle just now — try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`app-shell ${theme === "day" ? "theme-day" : "theme-night"} layout-${layoutMode}`}>
      <div className="top-glow" />
      <FieldCanvas nodes={canvasNodes} edges={field.edges} rootId={rootUser?.id} settlement={settlement} view={view} theme={theme} />

      {notice && <div className="notice">{notice}</div>}

      {screen === "welcome" && (
        <section className="welcome">
          <div className="welcome-inner">
            <h1>Winwinn</h1>
            <h2>
              Everything you'd recommend anyway
              <br />
              now it pays you back.
            </h2>
            <p>The dinner you raved about. The barber you swear by. Your taste, circling back to you.</p>
            <div className="welcome-actions">
              <button className="primary-button" onClick={() => setScreen("onboard")}>
                Build your field
              </button>
              <button className="secondary-button" onClick={runSettlement} disabled={busy}>
                {busy ? "Settling…" : "See a deal settle ▶"}
              </button>
            </div>
            <p className="mono small">Secured by Mollie · {economy?.totalNodes ?? 312} souls already moving</p>
            {error && <p className="error mono">{error}</p>}
          </div>
        </section>
      )}

      {screen === "onboard" && (
        <section className="onboard">
          <div className="onboard-inner">
            <div className="kicker">Build your field</div>
            <label className="small" style={{ marginTop: 12 }}>
              Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                style={{
                  width: "100%",
                  marginTop: 8,
                  padding: "13px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--brd)",
                  background: "var(--card2)",
                  color: "var(--ink)",
                }}
              />
            </label>
            <div className="mono small" style={{ marginTop: 16 }}>
              {String(step + 1).padStart(2, "0")} / 04
            </div>
            <div className="question">
              <h2>{questions[step].text}</h2>
              <div className="answer-list">
                {questions[step].options.map((option, index) => (
                  <button key={option} onClick={() => pick(index)} disabled={busy}>
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div className="mono small" style={{ textAlign: "center" }}>
              One tap to continue / shaping your field
            </div>
            {error && <p className="error mono">{error}</p>}
          </div>
        </section>
      )}

      {screen === "field" && (
        <>
          <aside className="panel left-panel">
            <div className="brand">
              <span className="brand-mark">W</span>
              <span className="brand-name">Winwinn</span>
            </div>
            <div className="headline">Your field moves while you're away.</div>
            <div className="earned">
              <strong>EUR {cents(rootUser?.earnings_cents || settlementTotalForRoot(settlement, rootUser?.id))}</strong>
              <span className="small">come back so far</span>
            </div>
            <div className="small">
              across {economy?.totalNodes ?? field.nodes.length} souls, {economy?.avgChainDepth ?? 0} hops deep
            </div>

            <div className="section-title">your positions</div>
            <div className="position-list">
              <div className="position-row">
                <span className="dot merchant-dot" />
                <div style={{ flex: 1 }}>
                  <div className="mono teal">Chez Janou / 8%</div>
                  <div className="small">via Carol, Bob, Alice</div>
                </div>
                <div className="mono money">+EUR {cents(settlementTotalForRoot(settlement, rootUser?.id))}</div>
              </div>
              <div className="position-row">
                <span className="dot" style={{ background: "#FFC914" }} />
                <div style={{ flex: 1 }}>
                  <div className="mono">Carol</div>
                  <div className="small">{reputation ? `${reputation.label} · trust ${reputation.score}` : "vouch-gated trust"}</div>
                </div>
              </div>
            </div>

            <div className="button-row">
              <button className={`pill ${view === "value" ? "pill-active" : ""}`} onClick={() => setView("value")}>
                Value
              </button>
              <button className={`pill ${view === "aura" ? "pill-active" : ""}`} onClick={() => setView("aura")}>
                Trust
              </button>
              <button className="pill" onClick={() => setTheme(theme === "day" ? "night" : "day")}>
                {theme === "day" ? "Day" : "Night"}
              </button>
              <button className="pill" onClick={() => setLayoutMode(layoutMode === "desktop" ? "phone" : "desktop")}>
                {layoutMode === "desktop" ? "Desktop" : "Phone"}
              </button>
            </div>
          </aside>

          <aside className="panel right-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div className="kicker">economy / live</div>
              <span className="dot merchant-dot" />
            </div>
            <div className="mono money" style={{ fontSize: 30, marginTop: 8 }}>
              EUR {cents(economy?.totalSettledCents)}
            </div>
            <div className="small">
              settled via <span style={{ color: "var(--ink)", fontWeight: 600 }}>Mollie</span> / avg chain{" "}
              {economy?.avgChainDepth ?? 0} hops
            </div>

            <div className="section-title">settlement receipt</div>
            <div className="activity-list">
              {settlement ? (
                <>
                  <div className="activity-row">
                    <span className="dot merchant-dot" />
                    <div style={{ flex: 1 }}>
                      <div>{settlement.contract?.title || "Contract"}</div>
                      <div className="small">
                        bill EUR {cents(settlement.billCents)} / reward pool EUR {cents(settlement.rewardPoolCents)}
                      </div>
                    </div>
                  </div>
                  {settlement.chain.map((row) => (
                    <div className="activity-row" key={`${row.userId}-${row.hop}`}>
                      <span className="dot" style={{ background: colorForName(row.name) }} />
                      <div style={{ flex: 1 }}>
                        <div>{row.name}</div>
                        <div className="small">
                          hop {row.hop} · {row.hop === 1 ? "made the intro" : "up the chain"}
                        </div>
                      </div>
                      <div className="mono" style={{ color: "var(--faint)", width: 40, textAlign: "right" }}>
                        {poolPct(row.amountCents, settlement.rewardPoolCents)}
                      </div>
                      <div className="mono money">+EUR {cents(row.amountCents)}</div>
                    </div>
                  ))}
                  <div className="activity-row">
                    <span className="dot merchant-dot" />
                    <div style={{ flex: 1 }}>
                      <div>{settlement.merchant?.name || "Merchant"}</div>
                      <div className="small">funded the reward · kept the rest</div>
                    </div>
                    <div className="mono teal">EUR {cents(settlement.merchant?.netCents)}</div>
                  </div>
                  <div className="mono" style={{ marginTop: 10, color: "var(--accent)", fontSize: 11, lineHeight: 1.35 }}>
                    ✦ {settleTrustLine(settlement)}
                  </div>
                </>
              ) : (
                <div className="activity-row">
                  <span className="dot merchant-dot" />
                  <div>
                    <div>No settlement yet</div>
                    <div className="small">Recommend something, or watch Chez Janou settle a deal.</div>
                  </div>
                </div>
              )}
            </div>

            <button className="primary-button" onClick={runSettlement} disabled={busy}>
              {busy ? "Settling…" : "Guest scans & pays"}
            </button>
            {rail?.conversion.checkoutUrl && (
              <a className="secondary-button" style={{ display: "block", textAlign: "center", textDecoration: "none" }} href={rail.conversion.checkoutUrl} target="_blank">
                Open Mollie checkout
              </a>
            )}
            {error && <p className="error mono">{error}</p>}
          </aside>

          {settlement && showReceipt && (
            <div className="sheet">
              <div className="kicker">settlement / #{settlement.mollie.paymentId ? String(settlement.mollie.paymentId) : settlement.conversionId}</div>
              <h3>EUR {cents(settlement.rewardPoolCents)}</h3>
              <div className="sheet-copy">
                funded by {settlement.contract?.merchantName || "Chez Janou"} · flowing to the chain
              </div>
              <div className="mono small" style={{ marginTop: 12, color: "var(--ink)", lineHeight: 1.4 }}>
                {settleDealLine(settlement)}
              </div>
              <div className="mono small" style={{ marginTop: 10, color: "var(--accent)", lineHeight: 1.4 }}>
                ✦ {settleTrustLine(settlement)}
              </div>
              <div className="mono small" style={{ marginTop: 14, color: "var(--muted)" }}>
                contract executed on live Mollie payment
                <br />
                {settlement.mollie.paymentId ? String(settlement.mollie.paymentId) : settlement.conversionId} ·{" "}
                <span style={{ color: "#7fd9c9" }}>{String(settlement.mollie.status || "paid")}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
                <span className="small">
                  settled via <strong style={{ color: "var(--ink)" }}>Mollie</strong>
                </span>
                <button className="ghost-button" onClick={() => setShowReceipt(false)}>
                  Done
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function buildDna(answers: number[]) {
  const domain = answers[1] ?? 0;
  const h = domainHue[domain] || domainHue[0];
  return {
    vector: [0, 1, 2, 3].map((index) => ((answers[index] ?? 1) + 1) / 4),
    color: `hsl(${h} 62% 64%)`,
  };
}

function userToField(user: User) {
  return [
    {
      id: user.id,
      name: user.name,
      color: user.dna.color,
      earningsCents: user.earnings_cents,
      auraScore: user.aura_score,
    },
  ];
}

function demoPreviewNodes(): FieldNode[] {
  return [
    { id: "alice", name: "Alice", color: demoDna.alice.color, earningsCents: 0, auraScore: 0 },
    { id: "bob", name: "Bob", color: demoDna.bob.color, earningsCents: 0, auraScore: 0 },
    { id: "carol", name: "Carol", color: demoDna.carol.color, earningsCents: 0, auraScore: 10 },
    { id: "guest", name: "Guest at Chez Janou", color: demoDna.guest.color, earningsCents: 0, auraScore: 0 },
  ];
}

function demoPreviewEdges() {
  return [
    { from: "alice", to: "bob" },
    { from: "bob", to: "carol" },
    { from: "carol", to: "guest" },
  ];
}

function settlementTotalForRoot(settlement: ConversionSettlement | null, userId?: string) {
  if (!settlement || !userId) return 0;
  return settlement.chain.find((row) => row.userId === userId)?.amountCents || 0;
}

function colorForName(name: string) {
  if (name === "Alice") return demoDna.alice.color;
  if (name === "Bob") return demoDna.bob.color;
  if (name === "Carol") return demoDna.carol.color;
  return "hsl(168 58% 64%)";
}

// Each hop's share of the merchant-funded reward pool (rendering only — the
// backend computes the money; we just show its proportion, as the prototype does).
function poolPct(amountCents: number, poolCents?: number) {
  if (!poolCents) return "—";
  return `${Math.round((amountCents / poolCents) * 100)}%`;
}

// Lifted verbatim from the prototype's runDomino() copy.
function settleDealLine(s: ConversionSettlement) {
  const pct = s.contract?.rewardValue ?? 0;
  const bill = Math.round((s.billCents || 0) / 100);
  const reward = ((s.rewardPoolCents || 0) / 100).toFixed(2);
  const cap = s.contract?.capDepth ?? 3;
  const merchant = s.contract?.merchantName || "Chez Janou";
  return `per ${merchant}'s deal · ${pct}% of €${bill} bill = €${reward} · capped at ${cap} hops`;
}

function settleTrustLine(s: ConversionSettlement) {
  const lead = s.chain && s.chain.length ? s.chain[0] : null;
  const name = lead?.name || "The";
  const premium = lead ? (lead.auraFactor ?? 1) > 1 : false;
  return premium
    ? `${name}'s intro carried high trust · +trust premium applied`
    : `${name}'s intro carried fair trust · standard split`;
}
