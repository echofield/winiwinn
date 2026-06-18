"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ConversionSettlement, FieldEdge, FieldNode } from "@/lib/types";

type CanvasNode = FieldNode & {
  type?: "person" | "merchant";
  dealPct?: number;
};

type Props = {
  nodes: CanvasNode[];
  edges: FieldEdge[];
  rootId?: string;
  settlement?: ConversionSettlement | null;
  view: "value" | "aura";
  theme?: "day" | "night";
  reduced?: boolean;
  onNodeTap?: (id: string) => void;
};

type LayoutNode = CanvasNode & {
  ring: number;
  angle: number;
  phase: number;
};

const ringScale: Record<number, number> = { 0: 0, 1: 0.2, 2: 0.34, 3: 0.46, 4: 0.58 };

export function FieldCanvas({ nodes, edges, rootId, settlement, view, theme = "day", reduced = false, onNodeTap }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5 });
  const startedRef = useRef(0);
  // Live screen positions of every drawn node, so taps hit-test exactly (no re-derivation).
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const onTapRef = useRef(onNodeTap);
  onTapRef.current = onNodeTap;

  const layout = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const root = rootId && byId.has(rootId) ? rootId : nodes[0]?.id;
    const children = new Map<string, string[]>();
    for (const edge of edges) {
      const list = children.get(edge.from) || [];
      list.push(edge.to);
      children.set(edge.from, list);
    }

    const depth = new Map<string, number>();
    if (root) {
      depth.set(root, 0);
      const queue = [root];
      while (queue.length) {
        const current = queue.shift()!;
        for (const child of children.get(current) || []) {
          if (depth.has(child)) continue;
          depth.set(child, Math.min(4, (depth.get(current) || 0) + 1));
          queue.push(child);
        }
      }
    }

    const rings = new Map<number, CanvasNode[]>();
    for (const node of nodes) {
      const ring = node.type === "merchant" ? 2 : depth.get(node.id) ?? 3;
      const list = rings.get(ring) || [];
      list.push(node);
      rings.set(ring, list);
    }

    const placed = new Map<string, LayoutNode>();
    for (const [ring, list] of rings) {
      const count = Math.max(1, list.length);
      list.forEach((node, index) => {
        const merchantAngle = node.type === "merchant" ? 5.55 : undefined;
        placed.set(node.id, {
          ...node,
          ring,
          angle: merchantAngle ?? index * ((Math.PI * 2) / count) + ring * 0.62,
          phase: index * 1.7 + ring,
        });
      });
    }

    return { nodes: [...placed.values()], byId: placed };
  }, [edges, nodes, rootId]);

  useEffect(() => {
    startedRef.current = performance.now();
  }, [settlement?.conversionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerRef.current = {
        x: (event.clientX - rect.left) / Math.max(1, rect.width),
        y: (event.clientY - rect.top) / Math.max(1, rect.height),
      };
    };

    const onTap = (event: PointerEvent) => {
      if (!onTapRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let best: string | null = null;
      let bestD = 30; // tap-friendly threshold (px)
      for (const [id, p] of Object.entries(positionsRef.current)) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      if (best) onTapRef.current(best);
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onTap);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onTap);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = (now: number) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h * 0.46;
      const radius = Math.min(w, h) * 0.78;
      const pointer = pointerRef.current;

      ctx.clearRect(0, 0, w, h);
      const day = theme === "day";
      drawDust(ctx, now, w, h, pointer, day);
      drawSeat(ctx, cx, cy, radius, day);

      for (let ring = 1; ring <= 4; ring++) {
        const r = (ringScale[ring] || 0) * radius;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, 0.88);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.strokeStyle = ring === 1
          ? day ? "rgba(151,117,40,0.2)" : "rgba(194,162,95,0.18)"
          : day ? "rgba(70,55,30,0.09)" : "rgba(160,160,190,0.08)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }

      const pos = (node: LayoutNode) => nodePos(node, now, cx, cy, radius, pointer, reduced);

      for (const edge of edges) {
        const a = layout.byId.get(edge.from);
        const b = layout.byId.get(edge.to);
        if (!a || !b) continue;
        const pa = pos(a);
        const pb = pos(b);
        const aura = (a.auraScore + b.auraScore) / 100;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        const mx = (pa.x + pb.x) / 2;
        const my = (pa.y + pb.y) / 2;
        ctx.quadraticCurveTo(mx + (cx - mx) * 0.18, my + (cy - my) * 0.18, pb.x, pb.y);
        ctx.strokeStyle =
          view === "aura"
            ? day ? `rgba(151,117,40,${0.12 + Math.min(0.24, aura)})` : `rgba(194,162,95,${0.12 + Math.min(0.26, aura)})`
            : day ? "rgba(88,78,110,0.17)" : "rgba(130,150,190,0.16)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      drawDomino(ctx, settlement, layout.byId, pos, now, startedRef.current);

      const sorted = [...layout.nodes].sort((a, b) => pos(a).y - pos(b).y);
      const positions: Record<string, { x: number; y: number }> = {};
      for (const node of sorted) {
        const p = pos(node);
        positions[node.id] = { x: p.x, y: p.y };
        if (node.type === "merchant") {
          drawMerchant(ctx, p.x, p.y, node.dealPct || settlement?.contract?.rewardValue || 8, day);
        } else {
          drawPerson(ctx, p.x, p.y, node, view, day);
        }
      }
      positionsRef.current = positions;

      drawEuroLabels(ctx, settlement, layout.byId, pos, now, startedRef.current);

      const vignette = ctx.createRadialGradient(cx, cy, radius * 0.25, cx, cy, radius * 0.9);
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, day ? "rgba(231,220,198,0.5)" : "rgba(4,3,8,0.58)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [edges, layout, reduced, settlement, theme, view]);

  return <canvas ref={canvasRef} className="field-canvas" aria-label="Winwinn field graph" />;
}

function nodePos(
  node: LayoutNode,
  now: number,
  cx: number,
  cy: number,
  radius: number,
  pointer: { x: number; y: number },
  reduced: boolean,
) {
  const dir = [0, 1, -0.7, 0.55, 0.9][node.ring] || 0;
  const rot = reduced ? 0 : now * 0.000025;
  const angle = node.angle + rot * dir;
  const rr = (ringScale[node.ring] || 0.46) * radius;
  const bob = reduced ? 0 : Math.sin(now * 0.0009 + node.phase) * 3;
  const px = (pointer.x - 0.5) * (6 + node.ring * 5);
  const py = (pointer.y - 0.5) * (4 + node.ring * 4);
  return {
    x: cx + Math.cos(angle) * rr + px,
    y: cy + Math.sin(angle) * rr * 0.88 + bob + py,
  };
}

function drawDust(
  ctx: CanvasRenderingContext2D,
  now: number,
  width: number,
  height: number,
  pointer: { x: number; y: number },
  day: boolean,
) {
  for (let i = 0; i < 80; i++) {
    const seed = i * 97.13;
    const x = ((Math.sin(seed) * 0.5 + 0.5) * width + now * 0.003 * ((i % 4) + 1)) % (width + 20);
    const y = (Math.cos(seed * 1.4) * 0.5 + 0.5) * height + Math.sin(now * 0.0002 + i) * 4;
    const parX = (pointer.x - 0.5) * ((i % 3) + 2);
    const parY = (pointer.y - 0.5) * ((i % 4) + 2);
    const gold = i % 7 === 0;
    ctx.globalAlpha = gold ? 0.35 : 0.22;
    ctx.fillStyle = gold ? day ? "#bba066" : "#d8bd7e" : day ? "#9aa6c0" : "#9fb0d8";
    ctx.beginPath();
    ctx.arc(x - 10 + parX, y + parY, gold ? 1.2 : 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSeat(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, day: boolean) {
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.55);
  gradient.addColorStop(0, day ? "rgba(150,120,60,0.12)" : "rgba(40,30,70,0.3)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, node: LayoutNode, view: "value" | "aura", day: boolean) {
  const aura = Math.min(1, Math.max(0, node.auraScore / 50));
  const earned = Math.min(1, Math.max(0, node.earningsCents / 1600));
  const focal = node.ring === 0; // the gold "you" node — the only truly warm glow
  const base = 8 + earned * 7 + (focal ? 5 : 0);
  const color = view === "aura" ? `hsl(43 ${Math.round(25 + aura * 50)}% ${Math.round(42 + aura * 28)}%)` : node.color;
  // Non-focal nodes glow cooler/dimmer so the focal node reads as the warm centre.
  const halo = base * (1.7 + aura * 2.8) * (focal ? 1 : 0.78);
  const glowAlpha = (0.16 + aura * 0.42) * (focal ? 1 : 0.5);

  ctx.save();
  if (!day) ctx.globalCompositeOperation = "lighter";
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, halo);
  gradient.addColorStop(0, colorToAlpha(color, glowAlpha));
  gradient.addColorStop(1, colorToAlpha(color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, halo, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, base * 0.44, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  if (node.ring === 0) {
    ctx.beginPath();
    ctx.arc(x, y, base, 0, Math.PI * 2);
  ctx.strokeStyle = day ? "rgba(151,117,40,0.55)" : "rgba(236,230,218,0.55)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function drawMerchant(ctx: CanvasRenderingContext2D, x: number, y: number, pct: number, day: boolean) {
  ctx.save();
  if (!day) ctx.globalCompositeOperation = "lighter";
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, 38);
  gradient.addColorStop(0, day ? "rgba(79,141,130,0.22)" : "rgba(79,182,168,0.34)");
  gradient.addColorStop(1, "rgba(79,182,168,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.beginPath();
  ctx.rect(-8, -8, 16, 16);
  ctx.strokeStyle = day ? "hsl(168 48% 40%)" : "hsl(168 58% 64%)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#c2a25f";
  ctx.font = "500 10px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${pct}%`, x, y - 24);
  ctx.textAlign = "start";
}

function drawDomino(
  ctx: CanvasRenderingContext2D,
  settlement: ConversionSettlement | null | undefined,
  byId: Map<string, LayoutNode>,
  pos: (node: LayoutNode) => { x: number; y: number },
  now: number,
  started: number,
) {
  if (!settlement || !settlement.contract || settlement.chain.length === 0) return;
  const merchant = byId.get(settlement.contract.merchantId);
  const sequence = [
    ...(merchant ? [merchant] : []),
    ...settlement.chain.map((row) => byId.get(row.userId)).filter((node): node is LayoutNode => Boolean(node)),
  ];
  if (sequence.length < 2) return;

  const elapsed = now - started;
  const duration = Math.max(1, sequence.length - 1) * 820;
  const progress = Math.min(1.2, elapsed / duration) * (sequence.length - 1);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < sequence.length - 1; i++) {
    const local = Math.max(0, Math.min(1, progress - i));
    if (local <= 0) continue;
    const a = pos(sequence[i]);
    const b = pos(sequence[i + 1]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + (b.x - a.x) * local, a.y + (b.y - a.y) * local);
    ctx.strokeStyle = "rgba(232,220,180,0.58)";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (local < 1) {
      const hx = a.x + (b.x - a.x) * local;
      const hy = a.y + (b.y - a.y) * local;
      const glow = ctx.createRadialGradient(hx, hy, 0, hx, hy, 18);
      glow.addColorStop(0, "rgba(244,234,210,0.95)");
      glow.addColorStop(1, "rgba(244,234,210,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(hx, hy, 18, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawEuroLabels(
  ctx: CanvasRenderingContext2D,
  settlement: ConversionSettlement | null | undefined,
  byId: Map<string, LayoutNode>,
  pos: (node: LayoutNode) => { x: number; y: number },
  now: number,
  started: number,
) {
  if (!settlement) return;
  const elapsed = now - started;
  if (elapsed > 7200) return;
  settlement.chain.forEach((row, index) => {
    const node = byId.get(row.userId);
    if (!node) return;
    const delay = 900 + index * 520;
    const local = (elapsed - delay) / 1500;
    if (local < 0 || local > 1) return;
    const p = pos(node);
    const alpha = local < 0.15 ? local / 0.15 : 1 - (local - 0.15) / 0.85;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = "#c2a25f";
    ctx.font = "600 15px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(`+EUR ${(row.amountCents / 100).toFixed(2)}`, p.x, p.y - local * 44);
    ctx.textAlign = "start";
    ctx.globalAlpha = 1;
  });
}

function colorToAlpha(color: string, alpha: number) {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.startsWith("hsl(")) {
    return color.replace("hsl(", "hsla(").replace(")", ` / ${alpha})`);
  }
  return color;
}
