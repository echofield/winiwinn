export type Dna = {
  vector: number[];
  color: string;
};

export type User = {
  id: string;
  name: string;
  dna: Dna;
  mollie_customer_id: string | null;
  earnings_cents: number;
  aura_score: number;
  aura_given: number;
  aura_received: number;
  created_at: string;
};

export type FieldNode = {
  id: string;
  name: string;
  color: string;
  earningsCents: number;
  auraScore: number;
};

export type FieldEdge = {
  from: string;
  to: string;
};

export type FieldResponse = {
  nodes: FieldNode[];
  edges: FieldEdge[];
};

export type Recommendation = {
  token: string;
  from_user_id: string;
  title: string;
  amount_cents: number;
  contract_id: string | null;
  created_at: string;
};

export type RecommendationResponse = {
  token: string;
  qrUrl: string;
  paymentLinkUrl: string | null;
  recommendation: Recommendation;
};

export type JoinResponse = {
  user: User;
  field: {
    rootId: string;
    edges: FieldEdge[];
  };
};

export type Merchant = {
  id: string;
  name: string;
  mollie_customer_id: string | null;
  created_at: string;
};

export type Contract = {
  id: string;
  merchant_id: string;
  title: string;
  reward_type: "pct" | "flat";
  reward_value: number;
  conversion_def: string;
  cap_depth: number;
  split_curve: number[];
  token: string;
  payment_link_id: string | null;
  payment_link_url: string | null;
  created_at: string;
};

export type ContractResponse = {
  contract: Contract;
  dealToken: string;
  paymentLinkUrl: string | null;
  qrPayload: string | null;
};

export type ConversionResponse = {
  conversionId: string;
  checkoutUrl: string | null;
  rewardCents: number;
  mode: "live-test" | "simulation";
  settled: Array<{ userId: string; amountCents: number; hop: number }>;
  hint: string;
};

export type SettlementChainRow = {
  userId: string;
  name: string;
  hop: number;
  amountCents: number;
  pct: number;
  auraScore: number;
  auraFactor: number;
};

export type ConversionSettlement = {
  conversionId: string;
  status: "pending" | "settled";
  billCents: number;
  rewardPoolCents: number;
  contract: {
    id: string;
    title: string;
    merchantId: string;
    merchantName: string;
    rewardType: "pct" | "flat";
    rewardValue: number;
    conversionDef: string;
    capDepth: number;
    splitCurve: number[];
  } | null;
  merchant:
    | {
        userId: string;
        name: string;
        netCents: number;
        pct: number;
      }
    | undefined;
  chain: SettlementChainRow[];
  mollie: Record<string, unknown>;
  note: string;
};

export type EconomyResponse = {
  totalSettledCents: number;
  totalPayments: number;
  totalNodes: number;
  totalEdges: number;
  avgChainDepth: number;
  topEarners: Array<{ name: string; earningsCents: number }>;
};

export type ReputationResponse = {
  label: string;
  score: number;
  given: number;
  received: number;
  vouchedBy: Array<{ id: string; name: string }>;
};

export type DemoRail = {
  root: User;
  bob: User;
  carol: User;
  guest: User;
  merchant: Merchant;
  contract: ContractResponse;
  recommendation: RecommendationResponse;
  conversion: ConversionResponse;
  settlement: ConversionSettlement;
  field: FieldResponse;
  economy: EconomyResponse;
};
