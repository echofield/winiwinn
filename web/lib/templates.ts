// Deal templates — one-tap merchant onboarding (Cardin-style presets). A merchant
// picks a business type; we set the reward %, hop cap, and decay curve for them.
export type DealTemplate = {
  key: string;
  label: string;
  emoji: string;
  rewardValue: number; // % of the covered bill
  capDepth: number; // warm-intro hops paid
  splitCurve: number[]; // decay across the chain
  blurb: string; // operator-clear, concrete
};

export const DEAL_TEMPLATES: DealTemplate[] = [
  { key: "restaurant", label: "Restaurant", emoji: "🍽", rewardValue: 8, capDepth: 3, splitCurve: [0.6, 0.3, 0.1], blurb: "8% of the covered bill · 3 hops" },
  { key: "cafe", label: "Café", emoji: "☕️", rewardValue: 5, capDepth: 2, splitCurve: [0.7, 0.3], blurb: "5% of the ticket · 2 hops" },
  { key: "boutique", label: "Boutique", emoji: "🛍", rewardValue: 10, capDepth: 3, splitCurve: [0.6, 0.3, 0.1], blurb: "10% of the first basket · 3 hops" },
  { key: "salon", label: "Salon", emoji: "💈", rewardValue: 12, capDepth: 2, splitCurve: [0.7, 0.3], blurb: "12% of the first visit · 2 hops" },
  { key: "studio", label: "Studio", emoji: "🎧", rewardValue: 15, capDepth: 2, splitCurve: [0.7, 0.3], blurb: "15% of the first session · 2 hops" },
];
