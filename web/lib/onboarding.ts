// Shared onboarding ritual — used by the welcome flow (/) and the deep-link
// newcomer flow (/r/[token]) so the "shape who you are" questions never drift.
import type { Dna } from "./types";

export const questions = [
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

export function buildDna(answers: number[]): Dna {
  const domain = answers[1] ?? 0;
  const h = domainHue[domain] || domainHue[0];
  return {
    vector: [0, 1, 2, 3].map((index) => ((answers[index] ?? 1) + 1) / 4),
    color: `hsl(${h} 62% 64%)`,
  };
}

// The absolute origin this app is served from — what generated QR codes encode,
// so any phone camera (even the native one) opens the deep link.
export function appOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return (process.env.NEXT_PUBLIC_APP_URL || "https://winwinn.vercel.app").replace(/\/$/, "");
}

// Pull a recommendation token out of a scanned/pasted Winwinn URL or raw token.
// Accepts https://winwinn.vercel.app/r/<token>, /r/<token>, or a bare token.
export function parseToken(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/\/r\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  // bare token (hex-ish, no slashes/spaces)
  if (/^[A-Za-z0-9_-]{4,}$/.test(s)) return s;
  return null;
}
