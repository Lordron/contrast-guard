/// <reference path="../node_modules/@figma/plugin-typings/index.d.ts" />

figma.showUI(__html__, { width: 400, height: 580, title: "contrast-guard" });

const KEY_IGNORED  = "cg:ignored";
const KEY_LAST     = "cg:lastScan";

// ─── Message router ───────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: any) => {
  switch (msg.type) {
    case "scan":         await scan(); break;
    case "close":        figma.closePlugin(); break;
    case "select":       selectNode(msg.id); break;
    case "ignore":       await setIgnored(msg.id, true); break;
    case "unignore":     await setIgnored(msg.id, false); break;
    case "clear-ignore": await clearIgnored(); break;
  }
};

function selectNode(id: string): void {
  const node = figma.getNodeById(id);
  if (node && "type" in node) {
    figma.currentPage.selection = [node as SceneNode];
    figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
  }
}

async function setIgnored(id: string, add: boolean): Promise<void> {
  const list = (await figma.clientStorage.getAsync(KEY_IGNORED) as string[]) ?? [];
  const set  = new Set(list);
  add ? set.add(id) : set.delete(id);
  await figma.clientStorage.setAsync(KEY_IGNORED, [...set]);
  await scan();
}

async function clearIgnored(): Promise<void> {
  await figma.clientStorage.setAsync(KEY_IGNORED, []);
  await scan();
}

// ─── WCAG math ────────────────────────────────────────────────────────────────

function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function isLargeText(fontSize: number, fontStyle: string): boolean {
  return fontSize >= 18 || (/bold|black|heavy|extrabold/i.test(fontStyle) && fontSize >= 14);
}

// ─── Color helpers ────────────────────────────────────────────────────────────

interface ColorRGBA { r: number; g: number; b: number; a: number; }

function blendOver(fg: ColorRGBA, bg: RGB): RGB {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1/3), g: hue2rgb(p, q, h), b: hue2rgb(p, q, h - 1/3) };
}

// ─── Variable resolution ──────────────────────────────────────────────────────

function resolveVariableColor(alias: VariableAlias): RGB | null {
  try {
    const variable = figma.variables.getVariableById(alias.id);
    if (!variable || variable.resolvedType !== "COLOR") return null;
    const modes = Object.values(variable.valuesByMode);
    if (!modes.length) return null;
    const val = modes[0] as RGBA;
    return { r: val.r, g: val.g, b: val.b };
  } catch (_) {
    return null;
  }
}

// ─── Fill extraction ──────────────────────────────────────────────────────────

function solidFillRGBA(node: SceneNode): ColorRGBA | null {
  if (!("fills" in node)) return null;
  const raw = node.fills;
  if (!Array.isArray(raw)) return null;
  for (const fill of raw as readonly Paint[]) {
    if (fill.type !== "SOLID" || fill.visible === false) continue;

    let color = fill.color as RGB;

    // Try to resolve Figma variable override
    const boundColor = (fill as any).boundVariables?.color as VariableAlias | undefined;
    if (boundColor) {
      const resolved = resolveVariableColor(boundColor);
      if (resolved) color = resolved;
    }

    const layerOpacity = "opacity" in node ? (node.opacity ?? 1) : 1;
    const a = (fill.opacity ?? 1) * layerOpacity;
    if (a === 0) continue;
    return { ...color, a };
  }
  return null;
}

function gradientAverageColor(node: SceneNode): RGB | null {
  if (!("fills" in node)) return null;
  const raw = node.fills;
  if (!Array.isArray(raw)) return null;
  for (const fill of raw as readonly Paint[]) {
    if (fill.visible === false) continue;
    if (fill.type === "GRADIENT_LINEAR" || fill.type === "GRADIENT_RADIAL" ||
        fill.type === "GRADIENT_ANGULAR" || fill.type === "GRADIENT_DIAMOND") {
      const stops = (fill as GradientPaint).gradientStops;
      if (!stops.length) continue;
      // weighted average by stop position
      let r = 0, g = 0, b = 0, totalW = 0;
      for (let i = 0; i < stops.length; i++) {
        const w = i === 0 || i === stops.length - 1 ? 1 : 2; // trapezoidal
        r += stops[i].color.r * w;
        g += stops[i].color.g * w;
        b += stops[i].color.b * w;
        totalW += w;
      }
      return { r: r / totalW, g: g / totalW, b: b / totalW };
    }
  }
  return null;
}

function backgroundOf(node: SceneNode): RGB {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== "PAGE") {
    const scene = current as SceneNode;
    const solid = solidFillRGBA(scene);
    if (solid) {
      const rgb = { r: solid.r, g: solid.g, b: solid.b };
      return solid.a >= 0.99 ? rgb : blendOver(solid, { r: 1, g: 1, b: 1 });
    }
    const grad = gradientAverageColor(scene);
    if (grad) return grad;
    current = current.parent;
  }
  return { r: 1, g: 1, b: 1 };
}

function effectiveTextColor(node: TextNode): RGB | null {
  const rgba = solidFillRGBA(node);
  if (!rgba) return null;
  if (rgba.a >= 0.99) return { r: rgba.r, g: rgba.g, b: rgba.b };
  return blendOver(rgba, backgroundOf(node));
}

// ─── Auto-fix suggestion ──────────────────────────────────────────────────────

function suggestFix(textRgb: RGB, bgRgb: RGB, required: number): string | null {
  const bgLum     = luminance(bgRgb.r * 255, bgRgb.g * 255, bgRgb.b * 255);
  const bgIsLight = bgLum > 0.18;
  const [h, s]    = rgbToHsl(textRgb.r, textRgb.g, textRgb.b);

  // Check if full extreme (black/white preserving hue) passes
  const extremeL   = bgIsLight ? 0.0 : 1.0;
  const extremeRgb = hslToRgb(h, s, extremeL);
  const extremeLum = luminance(extremeRgb.r * 255, extremeRgb.g * 255, extremeRgb.b * 255);
  if (contrastRatio(extremeLum, bgLum) < required) return null;

  // Binary search: find L closest to original that still passes
  let lo = bgIsLight ? 0.0 : 0.5;
  let hi = bgIsLight ? 0.5 : 1.0;
  let bestL = extremeL;

  for (let i = 0; i < 22; i++) {
    const mid    = (lo + hi) / 2;
    const rgb    = hslToRgb(h, s, mid);
    const lum    = luminance(rgb.r * 255, rgb.g * 255, rgb.b * 255);
    const passes = contrastRatio(lum, bgLum) >= required;
    if (passes) {
      bestL = mid;
      if (bgIsLight) lo = mid; // try lighter (closer to original)
      else           hi = mid; // try darker
    } else {
      if (bgIsLight) hi = mid;
      else           lo = mid;
    }
  }

  const fixed = hslToRgb(h, s, bestL);
  return rgbToHex(fixed.r, fixed.g, fixed.b);
}

// ─── Result types ─────────────────────────────────────────────────────────────

interface Issue {
  type: "contrast" | "font-size";
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
}

interface NodeResult {
  id: string;
  name: string;
  preview: string;
  fontSize: number;
  issues: Issue[];
  status?: "new" | "unchanged";
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

function checkContrast(
  textRgb: RGB,
  bg: RGB,
  large: boolean,
  issues: Issue[]
): void {
  const required = large ? 3.0 : 4.5;
  const l1       = luminance(textRgb.r * 255, textRgb.g * 255, textRgb.b * 255);
  const l2       = luminance(bg.r * 255, bg.g * 255, bg.b * 255);
  const ratio    = contrastRatio(l1, l2);
  if (ratio < required) {
    issues.push({
      type: "contrast",
      severity: "error",
      message: `Contrast ${ratio.toFixed(2)}:1 — need ${required}:1 (${large ? "large" : "normal"} text)`,
      suggestion: suggestFix(textRgb, bg, required) ?? undefined,
    });
  }
}

function scanNode(node: SceneNode, ignored: Set<string>, results: NodeResult[]): void {
  if ("visible" in node && node.visible === false) return;
  if (ignored.has(node.id)) return;

  if (node.type === "TEXT") {
    const issues: Issue[] = [];

    const rawSize  = node.fontSize;
    const fontSize = rawSize === figma.mixed ? null : rawSize;
    const rawStyle = node.fontName;
    const fontStyle = rawStyle === figma.mixed ? "" : rawStyle.style;
    const large = fontSize !== null && isLargeText(fontSize, fontStyle);
    const bg    = backgroundOf(node);

    if (fontSize !== null && fontSize < 12) {
      issues.push({ type: "font-size", severity: "warning", message: `Font size ${fontSize}px — below 12px minimum` });
    }

    const uniform = effectiveTextColor(node);
    if (uniform) {
      checkContrast(uniform, bg, large, issues);
    } else {
      // mixed-color text: check each segment
      try {
        const segments = node.getStyledTextSegments(["fills", "fontSize", "fontName"]);
        let worstRatio = Infinity;
        let worstColor: RGB | null = null;
        for (const seg of segments) {
          if (!Array.isArray(seg.fills)) continue;
          for (const fill of seg.fills as readonly Paint[]) {
            if (fill.type !== "SOLID" || fill.visible === false) continue;
            const a = fill.opacity ?? 1;
            const blended = a >= 0.99 ? fill.color : blendOver({ ...fill.color, a }, bg);
            const l1    = luminance(blended.r * 255, blended.g * 255, blended.b * 255);
            const l2    = luminance(bg.r * 255, bg.g * 255, bg.b * 255);
            const ratio = contrastRatio(l1, l2);
            if (ratio < worstRatio) { worstRatio = ratio; worstColor = blended; }
          }
        }
        const segLarge = fontSize !== null ? large : false;
        const required = segLarge ? 3.0 : 4.5;
        if (worstRatio !== Infinity && worstRatio < required && worstColor) {
          issues.push({
            type: "contrast",
            severity: "error",
            message: `Contrast ${worstRatio.toFixed(2)}:1 — need ${required}:1 (mixed colors, worst segment)`,
            suggestion: suggestFix(worstColor, bg, required) ?? undefined,
          });
        }
      } catch (_) { /* not available */ }
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
    for (const child of node.children) scanNode(child, ignored, results);
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

async function scan(): Promise<void> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({ type: "error", message: "Select a frame or group first." });
    return;
  }

  const ignored  = new Set((await figma.clientStorage.getAsync(KEY_IGNORED) as string[]) ?? []);
  const prev     = (await figma.clientStorage.getAsync(KEY_LAST) as NodeResult[]) ?? [];
  const prevIds  = new Set(prev.map(r => r.id));

  const results: NodeResult[] = [];
  for (const node of selection) scanNode(node, ignored, results);

  // Mark new vs unchanged
  for (const r of results) r.status = prevIds.has(r.id) ? "unchanged" : "new";

  // Fixed = were in prev, not in current
  const curIds = new Set(results.map(r => r.id));
  const fixed  = prev.filter(r => !curIds.has(r.id) && !ignored.has(r.id));

  await figma.clientStorage.setAsync(KEY_LAST, results);

  figma.ui.postMessage({ type: "results", results, fixed, ignoredCount: ignored.size });
}
