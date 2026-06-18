"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { FieldCanvas } from "@/components/FieldCanvas";
import { resolveRecommendation, createUser, joinField, cents, type DeepLinkResponse } from "@/lib/api";
import { questions, buildDna } from "@/lib/onboarding";
import type { JoinResponse } from "@/lib/types";

type Stage = "loading" | "enter" | "onboard" | "joining" | "joined" | "gone";

// The deep-link landing — scanning a code OR opening the link both arrive here.
// You're entering someone's field: shape who you are, then bloom into it.
export default function EnterFieldPage() {
  const params = useParams<{ token: string }>();
  const token = String(params.token || "");

  const [stage, setStage] = useState<Stage>("loading");
  const [link, setLink] = useState<DeepLinkResponse | null>(null);
  const [name, setName] = useState("");
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    resolveRecommendation(token)
      .then((r) => {
        setLink(r);
        setStage("enter");
      })
      .catch(() => setStage("gone"));
  }, [token]);

  const inviter = link?.fromUser?.name || "someone";
  const title = link?.recommendation?.title || "a warm intro";

  async function pick(answer: number) {
    const next = [...answers];
    next[step] = answer;
    setAnswers(next);
    if (step < questions.length - 1) {
      setStep(step + 1);
      return;
    }
    setStage("joining");
    setError(null);
    try {
      const dna = buildDna(next);
      const created = await createUser(name.trim() || "Newcomer", dna);
      const res = await joinField({ token, newUserName: created.name, dna });
      setJoined(res);
      setStage("joined");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the field.");
      setStage("enter");
    }
  }

  const joinedNodes = (joined?.field.edges || []).reduce<Set<string>>((set, e) => {
    set.add(e.from);
    set.add(e.to);
    return set;
  }, new Set<string>());

  return (
    <main className="app-shell theme-night layout-phone enter-shell">
      <div className="top-glow" />

      {stage === "loading" && <div className="notice">Opening the field…</div>}

      {stage === "gone" && (
        <section className="welcome">
          <div className="welcome-inner">
            <h2>This code&apos;s field has moved.</h2>
            <p>The invite expired or the link is off. Ask for a fresh one.</p>
            <Link className="primary-button" href="/" style={{ textDecoration: "none" }}>
              Go to Winwinn
            </Link>
          </div>
        </section>
      )}

      {stage === "enter" && (
        <section className="enter-card">
          <div className="kicker" style={{ color: "var(--accent)" }}>you&apos;re entering</div>
          <h1 className="enter-name">{inviter}&apos;s field</h1>
          <div className="enter-title">“{title}”</div>
          <p className="small" style={{ marginTop: 18, lineHeight: 1.5 }}>
            Four taps to shape who you are, then you bloom into the field — and the chain remembers.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            style={{
              width: "100%",
              marginTop: 16,
              padding: "14px 15px",
              borderRadius: 12,
              border: "1px solid var(--brd)",
              background: "var(--card2)",
              color: "var(--ink)",
            }}
          />
          <button className="primary-button" style={{ marginTop: 14, width: "100%" }} onClick={() => setStage("onboard")}>
            Enter the field →
          </button>
          {error && <p className="error mono">{error}</p>}
        </section>
      )}

      {stage === "onboard" && (
        <section className="onboard">
          <div className="onboard-inner">
            <div className="kicker">entering {inviter}&apos;s field</div>
            <div className="mono small" style={{ marginTop: 8 }}>
              {String(step + 1).padStart(2, "0")} / 04
            </div>
            <div className="question">
              <h2>{questions[step].text}</h2>
              <div className="answer-list">
                {questions[step].options.map((option, index) => (
                  <button key={option} onClick={() => pick(index)}>
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div className="mono small" style={{ textAlign: "center" }}>
              One tap to continue / shaping your field
            </div>
          </div>
        </section>
      )}

      {stage === "joining" && <div className="notice">Blooming into {inviter}&apos;s field…</div>}

      {stage === "joined" && joined && (
        <>
          <FieldCanvas
            nodes={[
              // YOU — first, the gold light at the centre of your own space.
              { id: joined.user.id, name: joined.user.name, color: joined.user.dna.color, earningsCents: 0, auraScore: Math.max(2, joined.user.aura_score) },
              // the one who brought you in, and a few souls already around you
              { id: "inviter", name: inviter, color: link?.fromUser?.dna?.color || "hsl(43 62% 64%)", earningsCents: 460, auraScore: 14 },
              { id: "s1", name: "Mira", color: "hsl(282 52% 64%)", earningsCents: 180, auraScore: 7 },
              { id: "s2", name: "Sol", color: "hsl(330 58% 64%)", earningsCents: 90, auraScore: 5 },
              { id: "s3", name: "Theo", color: "hsl(210 55% 64%)", earningsCents: 60, auraScore: 4 },
            ]}
            edges={[
              { from: joined.user.id, to: "inviter" },
              { from: joined.user.id, to: "s1" },
              { from: "inviter", to: "s2" },
              { from: "s1", to: "s3" },
            ]}
            rootId={joined.user.id}
            settlement={null}
            view="value"
            theme="night"
          />
          <section className="enter-card joined-card">
            <div className="kicker" style={{ color: "var(--accent)" }}>this is your space</div>
            <h1 className="enter-name">You&apos;re in, {joined.user.name}.</h1>
            <div className="enter-title">{inviter} opened the door — you&apos;re the newest light here.</div>
            <p className="small" style={{ marginTop: 14, lineHeight: 1.5 }}>
              The glow at the centre is you. Recommend a place, a person, anything you&apos;d vouch for —
              when someone you send converts, the reward flows <strong style={{ color: "var(--ink)" }}>back to you</strong>,
              and back to {inviter} who brought you in. No price between friends.
            </p>
            <Link className="primary-button" href="/" style={{ marginTop: 16, display: "block", textAlign: "center", textDecoration: "none" }}>
              Enter your field →
            </Link>
          </section>
        </>
      )}
    </main>
  );
}
