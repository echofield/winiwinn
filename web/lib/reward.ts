// Reward rules + categories, lifted verbatim from the prototype (REWARD_THING,
// REWARD_SELF, SELF_PCT, ROLES, CATS, GIVE_KINDS). The "rule" a recommender sets.
// Note: the backend doesn't persist reward KIND yet — these ride on the client as
// the prototype does; money stays merchant-funded, non-money kinds credit trust.

export type RewardKind = "cut" | "free" | "off" | "gift";

export type RewardRule = {
  k: RewardKind;
  label: string;
  badge: string;
  name: string;
  sub: string;
  note: string;
  money: boolean; // cut = money; free/off/gift = trust / non-money
};

export const CATS = ["Place", "Product", "Service", "Person", "Job", "Stay"] as const;

export const CAT_EXAMPLES: Record<string, string> = {
  Place: "Sister Ray — record shop in Soho",
  Product: "Aesop Resurrection — the only hand wash",
  Service: "Lera — the tailor who saved my suit",
  Person: "Dr. Hauser — the derm who actually listens",
  Job: "Backend role at a studio worth joining",
  Stay: "Casa Mira — the cliff house in Sifnos",
};

export const REWARD_THING: RewardRule[] = [
  { k: "cut", label: "% of bill", badge: "8%", name: "{biz} rewards warm intros", sub: "8% of covered bill · 3 hops · merchant-funded", note: "Your intro stays warm — no price between friends. {biz} funds the reward when a guest converts.", money: true },
  { k: "free", label: "Free item", badge: "FREE", name: "First one on the house", sub: "a free item for the newcomer · merchant-funded", note: "No money between you and your friend — {biz} welcomes them with something free.", money: false },
  { k: "off", label: "% off", badge: "−15%", name: "A welcome discount", sub: "15% off the first visit · 3 hops", note: "The newcomer arrives to a discount; the chain that carried them earns trust.", money: false },
  { k: "gift", label: "A small gift", badge: "GIFT", name: "A token on arrival", sub: "a small perk for the newcomer", note: "A non-money welcome from {biz} — plus trust to whoever sent them.", money: false },
];

export const ROLES = ["Yogi", "Coach", "Maker", "Advisor", "Host", "Healer"] as const;

export const SELF_PCT: Record<string, number> = { Yogi: 10, Coach: 12, Maker: 15, Advisor: 20, Host: 12, Healer: 12 };

export const SELF_EXAMPLES: Record<string, string> = {
  Yogi: "Maya — vinyasa at dawn, Canal St-Martin",
  Coach: "Ivo — the run coach who got me to 42k",
  Maker: "Lera — bespoke tailoring, made to last",
  Advisor: "Theo — the fractional CFO founders trust",
  Host: "Sol — supper club, twelve seats, no menu",
  Healer: "Nadia — the osteo who fixed my back",
};

export function rewardSelf(pct: number): RewardRule[] {
  return [
    { k: "cut", label: "% of first session", badge: `${pct}%`, name: "You reward whoever sends you", sub: `${pct}% of a first session · 3 hops · you-funded`, note: "Money flows back along the chain the moment someone books their first session through you.", money: true },
    { k: "free", label: "Free first class", badge: "FREE", name: "Their first one is on you", sub: "1 free session for the newcomer · sender earns trust", note: "No money changes hands — you gift the first class. Whoever sent them earns trust when they show up.", money: false },
    { k: "off", label: "% off first month", badge: "−20%", name: "A welcome discount", sub: "20% off the first month · 3 hops", note: "The newcomer arrives to a discount; the chain that carried them is credited with trust.", money: false },
    { k: "gift", label: "A small gift", badge: "GIFT", name: "A token for arriving warm", sub: "a small perk for the newcomer · sender earns trust", note: "A non-money thank-you — a drink, a guide, a sample — plus trust to whoever sent them.", money: false },
  ];
}

// What a vouch can be — the anti-gaming "what did they do for you?"
export const GIVE_KINDS = ["an intro", "advice", "a job lead", "showed up", "a vouch"] as const;
