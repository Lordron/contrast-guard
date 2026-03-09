/// <reference path="../node_modules/@figma/plugin-typings/index.d.ts" />

figma.showUI(__html__, { width: 360, height: 520, title: "contrast-guard" });

figma.ui.onmessage = (msg: { type: string; id?: string }) => {
  if (msg.type === "scan") scan();
  if (msg.type === "close") figma.closePlugin();
  if (msg.type === "select" && msg.id) {
    const node = figma.getNodeById(msg.id);
    if (node && "type" in node) {
      figma.currentPage.selection = [node as SceneNode];
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    }
  }
};

// ─── WCAG math ───────────────────────────────────────────────────────────────

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function isLargeText(fontSize: number, fontStyle: string): boolean {
  const bold = /bold|black|heavy|extrabold/i.test(fontStyle);
  return fontSize >= 18 || (bold && fontSize >= 14);
}

// ─── Color helpers ────────────────────────────────────────────────────────────

interface ColorRGBA { r: number; g: number; b: number; a: number; }

function solidFillRGBA(node: SceneNode): ColorRGBA | null {
  if (!("fills" in node)) return null;
  const raw = node.fills;
  if (!Array.isArray(raw)) return null;
  for (const fill of raw as readonly Paint[]) {
    if (fill.type === "SOLID" && fill.visible !== false) {
      const a = (fill.opacity ?? 1) * ("opacity" in node ? (node.opacity ?? 1) : 1);
      if (a === 0) continue;
      return { ...fill.color, a };
    }
  }
  return null;
}

function blendOver(fg: ColorRGBA, bg: RGB): RGB {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

function backgroundOf(node: SceneNode): RGB {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== "PAGE") {
    const rgba = solidFillRGBA(current as SceneNode);
    if (rgba) return { r: rgba.r, g: rgba.g, b: rgba.b };
    current = current.parent;
  }
  return { r: 1, g: 1, b: 1 };
}

function effectiveTextColor(node: SceneNode): RGB | null {
  const rgba = solidFillRGBA(node);
  if (!rgba) return null;
  if (rgba.a >= 0.99) return { r: rgba.r, g: rgba.g, b: rgba.b };
  const bg = backgroundOf(node);
  return blendOver(rgba, bg);
}

// ─── Result types ─────────────────────────────────────────────────────────────

interface Issue {
  type: "contrast" | "font-size";
  severity: "error" | "warning";
  message: string;
}

interface NodeResult {
  id: string;
  name: string;
  preview: string;
  fontSize: number;
  issues: Issue[];
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

function scanNode(node: SceneNode, results: NodeResult[]): void {
  if (node.type === "TEXT") {
    const issues: Issue[] = [];

    const rawSize = node.fontSize;
    const fontSize = rawSize === figma.mixed ? null : rawSize;

    const rawStyle = node.fontName;
    const fontStyle = rawStyle === figma.mixed ? "" : rawStyle.style;

    // Font size check
    if (fontSize !== null && fontSize < 12) {
      issues.push({
        type: "font-size",
        severity: "warning",
        message: `Font size ${fontSize}px — below 12px minimum`,
      });
    }

    // Contrast check — handle both uniform and mixed-color text
    const bg = backgroundOf(node);
    const large = fontSize !== null && isLargeText(fontSize, fontStyle);
    const required = large ? 3.0 : 4.5;

    const uniformColor = effectiveTextColor(node);
    if (uniformColor) {
      // single fill for the whole node
      const l1 = luminance(uniformColor.r * 255, uniformColor.g * 255, uniformColor.b * 255);
      const l2 = luminance(bg.r * 255, bg.g * 255, bg.b * 255);
      const ratio = contrastRatio(l1, l2);
      if (ratio < required) {
        issues.push({
          type: "contrast",
          severity: "error",
          message: `Contrast ${ratio.toFixed(2)}:1 — need ${required}:1 (${large ? "large" : "normal"} text)`,
        });
      }
    } else {
      // mixed fills — check each segment independently
      try {
        const segments = node.getStyledTextSegments(["fills", "fontSize", "fontName"]);
        const worstRatio = segments.reduce((worst, seg) => {
          const fills = seg.fills;
          if (!Array.isArray(fills)) return worst;
          for (const fill of fills as readonly Paint[]) {
            if (fill.type !== "SOLID" || fill.visible === false) continue;
            const a = fill.opacity ?? 1;
            const blended = a >= 0.99
              ? fill.color
              : blendOver({ ...fill.color, a }, bg);
            const l1 = luminance(blended.r * 255, blended.g * 255, blended.b * 255);
            const l2 = luminance(bg.r * 255, bg.g * 255, bg.b * 255);
            return Math.min(worst, contrastRatio(l1, l2));
          }
          return worst;
        }, Infinity);

        if (worstRatio !== Infinity && worstRatio < required) {
          issues.push({
            type: "contrast",
            severity: "error",
            message: `Contrast ${worstRatio.toFixed(2)}:1 — need ${required}:1 (mixed colors, worst segment)`,
          });
        }
      } catch (_) {
        // getStyledTextSegments not available on this node — skip
      }
    }

    if (issues.length > 0) {
      results.push({
        id: node.id,
        name: node.name,
        preview: node.characters.slice(0, 60),
        fontSize: fontSize ?? 0,
        issues,
      });
    }
  }

  if ("children" in node) {
    for (const child of node.children) scanNode(child, results);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

function scan(): void {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({ type: "error", message: "Select a frame or group first." });
    return;
  }

  const results: NodeResult[] = [];
  for (const node of selection) scanNode(node, results);

  figma.ui.postMessage({ type: "results", results });
}
