import type {
  ContractResponse,
  ConversionResponse,
  ConversionSettlement,
  DemoRail,
  Dna,
  EconomyResponse,
  FieldResponse,
  JoinResponse,
  Merchant,
  RecommendationResponse,
  ReputationResponse,
  User,
} from "./types";

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080").trim().replace(/\/$/, "");

type JsonBody = Record<string, unknown>;

async function request<T>(path: string, init: RequestInit & { body?: BodyInit | null } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error || detail;
    } catch {
      // Keep the HTTP status text when the body is not JSON.
    }
    throw new Error(`${res.status} ${detail}`);
  }

  return (await res.json()) as T;
}

function post<T>(path: string, body: JsonBody): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export const apiBaseUrl = API_URL;

export function cents(centsValue: number | null | undefined): string {
  return ((centsValue || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function createUser(name: string, dna: Dna): Promise<User> {
  return post<User>("/users", { name, dna });
}

export function getField(userId: string): Promise<FieldResponse> {
  return request<FieldResponse>(`/users/${userId}/field`);
}

export function getEconomy(): Promise<EconomyResponse> {
  return request<EconomyResponse>("/economy");
}

export function getReputation(userId: string): Promise<ReputationResponse> {
  return request<ReputationResponse>(`/users/${userId}/reputation`);
}

export function createRecommendation(input: {
  fromUserId: string;
  title: string;
  amount?: number;
  contractId?: string;
  linkAmountCents?: number;
}): Promise<RecommendationResponse> {
  return post<RecommendationResponse>("/recommendations", input);
}

export function joinField(input: { token: string; newUserName: string; dna: Dna }): Promise<JoinResponse> {
  return post<JoinResponse>("/join", input);
}

export function createMerchant(name: string): Promise<Merchant> {
  return post<Merchant>("/merchants", { name });
}

export function createContract(input: {
  merchantId: string;
  title: string;
  rewardType: "pct" | "flat";
  rewardValue: number;
  conversionDef?: string;
  capDepth?: number;
  splitCurve?: number[];
  linkAmountCents?: number;
}): Promise<ContractResponse> {
  return post<ContractResponse>("/contracts", input);
}

export function createConversion(input: {
  contractId: string;
  guestUserId?: string;
  connectorToken?: string;
  amountCents: number;
}): Promise<ConversionResponse> {
  return post<ConversionResponse>("/conversions", input);
}

export function getConversionSettlement(conversionId: string): Promise<ConversionSettlement> {
  return request<ConversionSettlement>(`/conversions/${conversionId}/settlement`);
}

export async function confirmHelp(fromUserId: string, toUserId: string, kind: "vouch" | "intro" = "vouch"): Promise<void> {
  const created = await post<{ helpEvent: { id: string } }>("/help", {
    fromUserId,
    toUserId,
    kind,
    note: kind === "vouch" ? "Demo vouch for the Winwinn field." : "Demo warm intro.",
  });
  await post("/thank", { helpEventId: created.helpEvent.id, byUserId: toUserId });
}

const dna = (vector: number[], color: string): Dna => ({ vector, color });

export const demoDna = {
  alice: dna([0.9, 0.2, 0.5, 0.1], "#E4572E"),
  bob: dna([0.3, 0.8, 0.4, 0.6], "#17BEBB"),
  carol: dna([0.5, 0.5, 0.9, 0.3], "#FFC914"),
  guest: dna([0.7, 0.4, 0.8, 0.5], "hsl(168 58% 64%)"),
};

export async function buildDemoRail(existingRoot?: User | null): Promise<DemoRail> {
  const root = existingRoot || (await createUser("Alice", demoDna.alice));

  const bobDoor = await createRecommendation({
    fromUserId: root.id,
    title: "Alice opens the field",
    amount: 0,
  });
  const bob = (await joinField({ token: bobDoor.token, newUserName: "Bob", dna: demoDna.bob })).user;

  const carolDoor = await createRecommendation({
    fromUserId: bob.id,
    title: "Bob carries the field",
    amount: 0,
  });
  const carol = (await joinField({ token: carolDoor.token, newUserName: "Carol", dna: demoDna.carol })).user;

  await confirmHelp(root.id, carol.id, "vouch");
  await confirmHelp(bob.id, carol.id, "vouch");

  const merchant = await createMerchant("Chez Janou");
  const contract = await createContract({
    merchantId: merchant.id,
    title: "Chez Janou warm intro deal",
    rewardType: "pct",
    rewardValue: 8,
    conversionDef: "covered_bill",
    capDepth: 3,
    splitCurve: [0.6, 0.3, 0.1],
    linkAmountCents: 12000,
  });

  const recommendation = await createRecommendation({
    fromUserId: carol.id,
    title: "Dinner at Chez Janou",
    amount: 120,
    contractId: contract.contract.id,
    linkAmountCents: 12000,
  });

  const guest = (await joinField({ token: recommendation.token, newUserName: "Guest at Chez Janou", dna: demoDna.guest })).user;
  const conversion = await createConversion({
    contractId: contract.contract.id,
    guestUserId: guest.id,
    connectorToken: recommendation.token,
    amountCents: 12000,
  });

  const settlement = await getConversionSettlement(conversion.conversionId);
  const field = await getField(root.id);
  const economy = await getEconomy();

  return { root, bob, carol, guest, merchant, contract, recommendation, conversion, settlement, field, economy };
}
