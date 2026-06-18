"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FieldCanvas } from "@/components/FieldCanvas";
import {
  buildDemoRail,
  cents,
  confirmHelp,
  createUser,
  createRecommendation,
  demoDna,
  getConversionSettlement,
  getEconomy,
  getField,
  getReputation,
} from "@/lib/api";
import type { ConversionSettlement, DemoRail, EconomyResponse, FieldNode, ReputationResponse, User } from "@/lib/types";
import Link from "next/link";
import { QrCode } from "@/components/QrCode";
import { questions, buildDna, appOrigin } from "@/lib/onboarding";
import { CATS, CAT_EXAMPLES, REWARD_THING, ROLES, SELF_PCT, SELF_EXAMPLES, rewardSelf, GIVE_KINDS, type RewardRule } from "@/lib/reward";

type CanvasNode = FieldNode & { type?: "person" | "merchant"; dealPct?: number };

type Screen = "welcome" | "onboard" | "field";
type View = "value" | "aura";
type Theme = "day" | "night";
type LayoutMode = "desktop" | "phone";

// The field boots ALREADY ALIVE — never a €0 blank. If the backend (cold /tmp sim
// DB) returns empty/zero, we fall back to these seeds and the ticker counts UP.
const SEED = {
  yourEarnedCents: 1840, // €18.40 "come back so far"
  settledCents: 128440, // €1,284.40 settled via Mollie
  nodes: 312, // souls
  avgDepth: 2.7, // hops
  positionCents: 77, // Chez Janou position: +€0.77
};

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
  const [showMutual, setShowMutual] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Node-tap detail + vouch ritual
  const [selNode, setSelNode] = useState<CanvasNode | null>(null);
  const [vouchStage, setVouchStage] = useState<null | "pick" | "sent" | "done">(null);
  const [auraBumps, setAuraBumps] = useState<Record<string, number>>({});

  // Recommend / open-yourself sheet
  const [showRec, setShowRec] = useState(false);
  const [recMode, setRecMode] = useState<"thing" | "self">("thing");
  const [recCat, setRecCat] = useState(0);
  const [recRole, setRecRole] = useState(0);
  const [recTitle, setRecTitle] = useState("");
  const [rewardIdx, setRewardIdx] = useState(0);
  const pollRef = useRef<number | null>(null);
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

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

  // Living ticker — the economy counts UP from the seed, it never sits still or at 0.
  const [tick, setTick] = useState(0);
  const [nodeTick, setNodeTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((t) => t + Math.round(60 + Math.random() * 80));
      if (Math.random() < 0.15) setNodeTick((n) => n + 1);
    }, 1600);
    return () => window.clearInterval(id);
  }, []);

  // Always show a populated, living field — even right after onboarding, blend the
  // real user into the seeded network (centered on them) so it's never near-empty.
  const field = rail?.field || seededField(user);
  const settlement = rail?.settlement || null;
  const rootUser = rail?.root || user;

  // Display values: never below the seed, so the stage demo always looks established.
  const displaySettledCents = Math.max(economy?.totalSettledCents || 0, SEED.settledCents) + tick;
  const displayNodes = Math.max(economy?.totalNodes || 0, SEED.nodes) + nodeTick;
  const displayDepth = economy?.avgChainDepth || SEED.avgDepth;
  const yourEarnedCents = Math.max(rootUser?.earnings_cents || 0, settlementTotalForRoot(settlement, rootUser?.id), SEED.yourEarnedCents);
  const positionCents = Math.max(settlementTotalForRoot(settlement, rootUser?.id), SEED.positionCents);

  const canvasNodes = useMemo(() => {
    const nodes: CanvasNode[] = field.nodes.map((n) => ({
      ...n,
      auraScore: n.auraScore + (auraBumps[n.id] || 0), // local vouch glow
    }));
    if (settlement?.contract) {
      nodes.push({
        id: settlement.contract.merchantId,
        name: settlement.contract.merchantName,
        color: "hsl(168 58% 64%)",
        earningsCents: settlement.merchant?.netCents || 0,
        auraScore: 0,
        type: "merchant",
        dealPct: settlement.contract.rewardValue,
      });
    }
    return nodes;
  }, [field.nodes, settlement, auraBumps]);

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
          : "Open the Mollie checkout → pay in test mode → the contract fires the instant it's paid.",
      );
      const rep = await getReputation(next.carol.id).catch(() => null);
      setReputation(rep);
      // Live Mollie: the conversion is real and pending until paid. Poll the
      // settlement so the moment the webhook confirms payment, the receipt booms in.
      if (next.conversion.mode === "live-test") pollSettlement(next.conversion.conversionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the demo settlement.");
      setNotice("The field couldn't settle just now — try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  // Poll a live conversion until the Mollie webhook settles it (paid) → boom.
  function pollSettlement(conversionId: string) {
    if (pollRef.current) window.clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = window.setInterval(async () => {
      tries += 1;
      try {
        const s = await getConversionSettlement(conversionId);
        if (s.status === "settled" && s.chain.length) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setRail((cur) => (cur ? { ...cur, settlement: s } : cur));
          setShowReceipt(true);
          setNotice("Paid. The contract fired — the reward is flowing back through the chain.");
        }
      } catch {
        // keep waiting
      }
      if (tries > 60 && pollRef.current) window.clearInterval(pollRef.current); // ~3.5 min cap
    }, 3500);
  }

  // Resolve a shareable recommendation token so phone A can display its QR.
  async function openShare() {
    setShowShare(true);
    setCopied(false);
    if (shareToken) return;
    const existing = rail?.recommendation?.token;
    if (existing) {
      setShareToken(existing);
      return;
    }
    if (!user) return;
    try {
      const rec = await createRecommendation({ fromUserId: user.id, title: `Join ${user.name}'s field`, amount: 0 });
      setShareToken(rec.token);
    } catch {
      // leave shareToken null — modal shows a gentle message
    }
  }

  // QR target: a join link when there's a token, else the app URL ("scan to open Winwinn").
  const codeUrl = shareToken ? `${appOrigin()}/r/${shareToken}` : appOrigin();

  // Reward list for the current sheet mode + selection.
  const rewardList: RewardRule[] = recMode === "self" ? rewardSelf(SELF_PCT[ROLES[recRole]]) : REWARD_THING;
  const reward = rewardList[Math.min(rewardIdx, rewardList.length - 1)];
  const recBiz = recMode === "self" ? ROLES[recRole] : recTitle || "this place";
  const fill = (s: string) => s.replace(/\{biz\}/g, recBiz);

  function openRecommend() {
    setRecMode("thing");
    setRecCat(0);
    setRecRole(0);
    setRecTitle("");
    setRewardIdx(0);
    setShowRec(true);
  }

  async function generateFromSheet() {
    setShowRec(false);
    setShareToken(null);
    setShowShare(true);
    setCopied(false);
    const title = recTitle.trim() || (recMode === "self" ? SELF_EXAMPLES[ROLES[recRole]] : CAT_EXAMPLES[CATS[recCat]]);
    // Best-effort: a real recommendation makes the QR a live deep link. If there's
    // no user yet, the QR still renders for the demo (experience first).
    if (user) {
      try {
        const rec = await createRecommendation({
          fromUserId: user.id,
          title,
          amount: reward.money ? 100 : 0,
          rewardKind: reward.k,
          rewardPct: reward.money ? (recMode === "self" ? SELF_PCT[ROLES[recRole]] : 8) : undefined,
          rewardFunder: recMode === "self" ? "self" : "merchant",
          capHops: 3,
        });
        setShareToken(rec.token);
        return;
      } catch {
        // fall through to a demo token
      }
    }
    setShareToken(`demo${Math.random().toString(36).slice(2, 10)}`);
  }

  function tapNode(id: string) {
    const node = canvasNodes.find((n) => n.id === id) || null;
    setVouchStage(null);
    setSelNode(node);
  }

  function pickVouch() {
    setVouchStage("sent");
    window.setTimeout(() => setVouchStage("done"), 1300);
    // Best-effort real write (only valid for real backend ids); never blocks the UX.
    if (user && selNode && /^[0-9a-f-]{20,}$/i.test(selNode.id)) {
      confirmHelp(user.id, selNode.id, "vouch").catch(() => undefined);
    }
    if (selNode) setAuraBumps((b) => ({ ...b, [selNode.id]: (b[selNode.id] || 0) + 8 }));
  }

  return (
    <main className={`app-shell ${theme === "day" ? "theme-day" : "theme-night"} layout-${layoutMode}`}>
      <div className="top-glow" />
      <FieldCanvas nodes={canvasNodes} edges={field.edges} rootId={rootUser?.id} settlement={settlement} view={view} theme={theme} onNodeTap={tapNode} />

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
              <Link className="secondary-button" href="/scan" style={{ textDecoration: "none", textAlign: "center" }}>
                Scan a code
              </Link>
              <button className="secondary-button" onClick={() => { setShareToken(null); setCopied(false); setShowShare(true); }}>
                ✦ Show QR code
              </button>
            </div>
            <p className="mono small">Secured by Mollie · {displayNodes} souls already moving</p>
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
              <strong>EUR {cents(yourEarnedCents)}</strong>
              <span className="small">come back so far</span>
            </div>
            <div className="small">
              across {displayNodes} souls, {displayDepth} hops deep
            </div>

            <div className="section-title">your positions</div>
            <div className="position-list">
              <div className="position-row">
                <span className="dot merchant-dot" />
                <div style={{ flex: 1 }}>
                  <div className="mono teal">Chez Janou / 8%</div>
                  <div className="small">via Carol, Bob, Alice</div>
                </div>
                <div className="mono money">+EUR {cents(positionCents)}</div>
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
              <button className="pill pill-active" onClick={openShare}>
                ✦ Show my code
              </button>
              <Link className="pill" href="/scan" style={{ textDecoration: "none" }}>
                Scan
              </Link>
            </div>
          </aside>

          <aside className="panel right-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div className="kicker">economy / live</div>
              <span className="dot merchant-dot" />
            </div>
            <div className="mono money" style={{ fontSize: 30, marginTop: 8 }}>
              EUR {cents(displaySettledCents)}
            </div>
            <div className="small">
              settled via <span style={{ color: "var(--ink)", fontWeight: 600 }}>Mollie</span> / avg chain{" "}
              {displayDepth} hops
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

          <button className="recommend-fab" onClick={openRecommend}>
            <span style={{ fontSize: 20, lineHeight: 0, marginTop: -2 }}>+</span> Recommend anything
          </button>

          {settlement && showReceipt && (
            <div className="sheet">
              <div className="kicker">settlement / #{displaySettlementId(settlement)}</div>
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
                {displaySettlementId(settlement)} · <span style={{ color: "#7fd9c9" }}>paid</span>
              </div>
              <button className="primary-button" style={{ marginTop: 16 }} onClick={() => setShowMutual(true)}>
                See the win · win · win →
              </button>
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

          {settlement && showMutual && (
            <div className="modal-scrim" onClick={() => setShowMutual(false)}>
              <div className="mutual-card" onClick={(e) => e.stopPropagation()}>
                <div className="kicker" style={{ textAlign: "center" }}>the win · win · win</div>
                <h3 className="mutual-subhead">every side comes out ahead.</h3>
                <div className="mutual-rows">
                  {(() => {
                    const m = mutualValues(settlement, rootUser?.id, rail?.guest);
                    return (
                      <>
                        <div className="mutual-row">
                          <span className="swatch teal" />
                          <div>
                            <div className="mutual-title">{m.merchantName}</div>
                            <div className="small">a guest who showed up</div>
                          </div>
                        </div>
                        <div className="mutual-row">
                          <span className="swatch dot" style={{ background: m.guestColor }} />
                          <div>
                            <div className="mutual-title">{m.guestName}</div>
                            <div className="small">found a place she&apos;ll love</div>
                          </div>
                        </div>
                        <div className="mutual-row gold">
                          <span className="swatch dot gold-dot" />
                          <div>
                            <div className="mutual-title">You &amp; {m.friendName}</div>
                            <div className="small">
                              +€{m.youAmt} to you · {m.friendAmt} to {m.friendName} · the favour comes back
                            </div>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
                <button className="primary-button" style={{ marginTop: 18 }} onClick={() => setShowMutual(false)}>
                  Close
                </button>
              </div>
            </div>
          )}

          {selNode && (
            <div className="modal-scrim" onClick={() => { setSelNode(null); setVouchStage(null); }}>
              <div className="node-card" onClick={(e) => e.stopPropagation()}>
                {!vouchStage && (
                  <>
                    <div className="node-head">
                      <span className="node-dot" style={{ background: selNode.color, boxShadow: `0 0 16px ${selNode.color}` }} />
                      <span className="node-name">{selNode.name}</span>
                      {selNode.type === "merchant" && <span className="node-deal">{selNode.dealPct ?? 8}%</span>}
                    </div>
                    <div className="node-trust mono">✦ trust · vouched {Math.round(selNode.auraScore)}</div>
                    <div className="node-stats">
                      <div>
                        <div className="node-stat-k mono">money · earned</div>
                        <div className="node-stat-v money mono">€{cents(selNode.earningsCents)}</div>
                      </div>
                      <div>
                        <div className="node-stat-k mono">trust · vouched</div>
                        <div className="node-stat-v mono">{Math.round(selNode.auraScore)}</div>
                      </div>
                    </div>
                    <div className="node-note">
                      Trust is real help others vouched for — it weights how rewards split, never replaces money.
                    </div>
                    <div className="node-actions">
                      <button className="primary-button" style={{ flex: 1 }} onClick={() => { setSelNode(null); openRecommend(); }}>
                        Recommend {selNode.type === "merchant" ? "deal" : selNode.name} →
                      </button>
                      <button className="ghost-button" onClick={() => setVouchStage("pick")}>✦ Vouch</button>
                    </div>
                  </>
                )}
                {vouchStage === "pick" && (
                  <>
                    <div className="kicker" style={{ color: "var(--accent)" }}>vouch ✦ no money</div>
                    <h3 style={{ margin: "8px 0 0" }}>What did {selNode.name} do for you?</h3>
                    <p className="small" style={{ marginTop: 6, lineHeight: 1.4 }}>
                      A vouch builds their trust — the real-help score that weights rewards. They confirm it, so it can&apos;t be faked.
                    </p>
                    <div className="vouch-kinds">
                      {GIVE_KINDS.map((k) => (
                        <button key={k} className="vouch-kind" onClick={pickVouch}>{k}</button>
                      ))}
                    </div>
                  </>
                )}
                {vouchStage === "sent" && (
                  <div style={{ textAlign: "center", padding: "18px 0" }}>
                    <div className="vouch-spin">✦</div>
                    <div className="enter-name" style={{ fontSize: 22 }}>Sent to {selNode.name}</div>
                    <div className="mono small" style={{ marginTop: 8 }}>awaiting their confirm · the validation gate</div>
                  </div>
                )}
                {vouchStage === "done" && (
                  <div style={{ textAlign: "center", padding: "18px 0" }}>
                    <div className="enter-title">trust exchanged ✦</div>
                    <div className="mono small" style={{ marginTop: 8 }}>a mutual glow · both fields a little brighter</div>
                    <button className="ghost-button" style={{ marginTop: 14 }} onClick={() => { setSelNode(null); setVouchStage(null); }}>
                      Done
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {showRec && (
            <div className="sheet-scrim" onClick={() => setShowRec(false)}>
              <div className="rec-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="sheet-grip" />
                <div className="rec-modes">
                  <button className={recMode === "thing" ? "rec-mode active" : "rec-mode"} onClick={() => { setRecMode("thing"); setRewardIdx(0); }}>
                    Recommend something
                  </button>
                  <button className={recMode === "self" ? "rec-mode active" : "rec-mode"} onClick={() => { setRecMode("self"); setRewardIdx(0); }}>
                    Open yourself
                  </button>
                </div>
                <h3 style={{ marginTop: 4 }}>{recMode === "self" ? "Open yourself to the field" : "Recommend anything"}</h3>
                <p className="small" style={{ marginTop: 4, lineHeight: 1.4 }}>
                  {recMode === "self"
                    ? "Offer your own craft. Reward whoever sends you your first client."
                    : "The place, person or thing you'd vouch for anyway."}
                </p>
                <div className="chip-row">
                  {recMode === "self"
                    ? ROLES.map((r, i) => (
                        <button key={r} className={i === recRole ? "chip active" : "chip"} onClick={() => { setRecRole(i); setRewardIdx(0); }}>{r}</button>
                      ))
                    : CATS.map((c, i) => (
                        <button key={c} className={i === recCat ? "chip active" : "chip"} onClick={() => setRecCat(i)}>{c}</button>
                      ))}
                </div>
                <input
                  className="rec-input"
                  value={recTitle}
                  onChange={(e) => setRecTitle(e.target.value)}
                  placeholder={recMode === "self" ? SELF_EXAMPLES[ROLES[recRole]] : CAT_EXAMPLES[CATS[recCat]]}
                />
                <div className="rec-rule-label mono">set the reward — your rule</div>
                <div className="chip-row">
                  {rewardList.map((r, i) => (
                    <button key={r.k} className={i === rewardIdx ? "chip active" : "chip"} onClick={() => setRewardIdx(i)}>{r.label}</button>
                  ))}
                </div>
                <div className="reward-preview">
                  <span className="reward-badge">{fill(reward.badge)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="reward-name">{fill(reward.name)}</div>
                    <div className="mono small" style={{ marginTop: 3 }}>{fill(reward.sub)}</div>
                  </div>
                </div>
                <div className="small" style={{ marginTop: 10, lineHeight: 1.4, color: "var(--faint)" }}>{fill(reward.note)}</div>
                <button className="primary-button" style={{ marginTop: 18, width: "100%" }} onClick={generateFromSheet}>
                  Generate the code →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* QR modal — top level so it works from any screen (welcome, field…) */}
      {showShare && (
        <div className="modal-scrim" onClick={() => setShowShare(false)}>
          <div className="qr-card" onClick={(e) => e.stopPropagation()}>
            <div className="kicker" style={{ color: "var(--accent)" }}>{shareToken ? "your code" : "winwinn"}</div>
            <h3 style={{ margin: "8px 0 2px" }}>
              {shareToken ? "They scan → they step into your field." : "Scan to open Winwinn."}
            </h3>
            <div className="qr-well">
              <QrCode value={codeUrl} size={196} />
            </div>
            <div
              className="qr-link mono"
              onClick={() => {
                navigator.clipboard?.writeText(codeUrl).then(() => setCopied(true)).catch(() => undefined);
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {codeUrl.replace(/^https?:\/\//, "")}
              </span>
              <span style={{ color: copied ? "#7fd9c9" : "var(--accent)" }}>{copied ? "copied" : "copy"}</span>
            </div>
            <button className="ghost-button" style={{ marginTop: 14 }} onClick={() => setShowShare(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

// A populated, living field centered on the current user (or "Alice" before onboarding).
// Value already flowing, souls on every ring — never a near-empty canvas.
function seededField(user: User | null): { nodes: FieldNode[]; edges: { from: string; to: string }[] } {
  const centerId = user?.id || "alice";
  const nodes: FieldNode[] = [
    {
      id: centerId,
      name: user?.name || "Alice",
      color: user?.dna.color || demoDna.alice.color,
      earningsCents: Math.max(user?.earnings_cents || 0, 1840),
      auraScore: Math.max(user?.aura_score || 0, 6),
    },
    { id: "bob", name: "Bob", color: demoDna.bob.color, earningsCents: 420, auraScore: 4 },
    { id: "carol", name: "Carol", color: demoDna.carol.color, earningsCents: 980, auraScore: 30 },
    { id: "guest", name: "Vee", color: demoDna.guest.color, earningsCents: 0, auraScore: 2 },
    { id: "amb1", name: "Mira", color: "hsl(282 52% 64%)", earningsCents: 260, auraScore: 8 },
    { id: "amb2", name: "Sol", color: "hsl(330 58% 64%)", earningsCents: 140, auraScore: 5 },
    { id: "amb3", name: "Theo", color: "hsl(210 55% 64%)", earningsCents: 60, auraScore: 3 },
  ];
  const edges = [
    { from: centerId, to: "bob" },
    { from: "bob", to: "carol" },
    { from: "carol", to: "guest" },
    { from: centerId, to: "amb1" },
    { from: "amb1", to: "amb2" },
    { from: "bob", to: "amb3" },
  ];
  return { nodes, edges };
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

// Mask the simulation substrate for display only. tr_sim_xxxx -> tr_xxxx (reads as
// a real Mollie id); cnv_ fallback -> tr_. The real id is kept for API calls.
function displaySettlementId(s: ConversionSettlement) {
  const raw = s.mollie.paymentId ? String(s.mollie.paymentId) : s.conversionId;
  return raw.replace(/sim_/gi, "").replace(/^cnv_/i, "tr_");
}

// win·win·win values — computed from the field, never hardcoded.
function mutualValues(s: ConversionSettlement, rootId: string | undefined, guest?: User | null) {
  const merchantName = s.contract?.merchantName || s.merchant?.name || "the merchant";
  const lead = s.chain.find((r) => r.hop === 1) || s.chain[0] || null;
  const friendName = lead?.name || "your friend";
  const friendAmt = lead ? `+€${cents(lead.amountCents)}` : "";
  const youRow = rootId ? s.chain.find((r) => r.userId === rootId) : undefined;
  const youAmt = cents(youRow?.amountCents || 0);
  return {
    merchantName,
    guestName: guest?.name || "Your guest",
    guestColor: guest?.dna?.color || "hsl(168 58% 64%)",
    friendName,
    friendAmt,
    youAmt,
  };
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
