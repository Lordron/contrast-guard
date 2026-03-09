# contrast-guard

**Catch low-contrast text and tiny fonts in Figma before your users squint.**

A free WCAG 2.1 AA accessibility scanner for Figma. Select any frame, click Scan — get an instant list of contrast and font-size violations. Fix issues at design time, not after production.

---

## Why

Designers pick colors that look fine on a calibrated monitor in a bright room. Users see them on a phone in sunlight, or have impaired vision. The gap is invisible until someone complains.

`contrast-guard` makes WCAG violations visible while you still can fix them in 30 seconds.

---

## What it checks

| Rule | Threshold | Severity |
|---|---|---|
| Normal text contrast ratio | < 4.5:1 | Error |
| Large text contrast ratio (18px+ or 14px bold+) | < 3:1 | Error |
| Font size | < 12px | Warning |

Based on [WCAG 2.1 AA](https://www.w3.org/WAI/WCAG21/quickref/).

---

## Usage

1. Select a frame in Figma
2. **Plugins → contrast-guard → Scan**
3. Review the list of issues
4. Fix before handoff to dev

Works in Figma web and desktop.

---

## Run locally

```bash
git clone https://github.com/YOUR_USERNAME/contrast-guard
cd contrast-guard
npm install
npm run build
```

Import into Figma: **Plugins → Development → Import plugin from manifest** → select `manifest.json`.

---

## Contributing

PRs welcome. Common improvements needed:
- Support for CSS variables / design tokens
- Opacity-aware color blending
- Batch scan entire page

---

## License

MIT
