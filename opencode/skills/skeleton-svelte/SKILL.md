---
name: skeleton-svelte
description: Use when working on Svelte or SvelteKit projects that use the Skeleton UI component library (@skeletonlabs/skeleton-svelte, @skeletonlabs/skeleton). Covers component patterns, design system conventions, theming, Tailwind integration, and migration from prior versions.
---

# Skeleton for Svelte

Skeleton is a UI component library and design system built on top of Tailwind CSS, targeting Svelte and SvelteKit projects. Components are powered by [Zag.js](https://zagjs.com/) for framework-agnostic logic.

**Full LLM reference (always fetch for comprehensive docs):**
```
https://www.skeleton.dev/llms-svelte.txt
```
Use `WebFetch` to retrieve that URL when you need complete API details, component prop tables, or anything not covered below.

---

## Packages

| Purpose | Package |
|---|---|
| Core design system + Tailwind utilities | `@skeletonlabs/skeleton` |
| Svelte components | `@skeletonlabs/skeleton-svelte` |

```ts
import { Avatar, Accordion, Switch } from '@skeletonlabs/skeleton-svelte';
import type { AvatarRootProps } from '@skeletonlabs/skeleton-svelte';
```

---

## Component Patterns

### Composed (nested) structure

Components are granular — children are exposed as sub-components. Always use this pattern.

```svelte
<Avatar>
  <Avatar.Image src="https://i.pravatar.cc/150?img=48" alt="Jane Doe" />
  <Avatar.Fallback>SK</Avatar.Fallback>
</Avatar>
```

### Styling via `class`

Pass any Tailwind utility class directly on any component or sub-component:

```svelte
<Avatar class="rounded-2xl">
  <Avatar.Image src="..." class="greyscale" />
  <Avatar.Fallback>SK</Avatar.Fallback>
</Avatar>
```

### Data model pattern (state in / event out — no two-way binding)

```svelte
<script lang="ts">
  import { Switch } from '@skeletonlabs/skeleton-svelte';
  let checked = $state(false);
</script>

<Switch checked={checked} onCheckedChange={(e) => (checked = e.checked)}>
  <Switch.Control><Switch.Thumb /></Switch.Control>
  <Switch.Label>Label</Switch.Label>
  <Switch.HiddenInput />
</Switch>
```

Common patterns per component:
- `<Accordion>` → `open` / `onOpenChange` / `e.change`
- `<Slider>` → `value` / `onValueChange` / `e.value`
- `<Stepper>` → `step` / `onStepChange` / `e.step`

### Extensible markup (advanced — override internal HTML)

Use the `element` snippet prop to inject custom elements, e.g. for custom animations:

```svelte
<Accordion.ItemContent>
  {#snippet element(attributes)}
    {#if !attributes.hidden}
      <div {...attributes} transition:slide>Content</div>
    {/if}
  {/snippet}
</Accordion.ItemContent>
```

### Provider pattern (programmatic control)

```svelte
<script lang="ts">
  import { Portal, Tooltip, useTooltip } from '@skeletonlabs/skeleton-svelte';
  const id = $props.id();
  const tooltip = useTooltip({ id });
</script>

<Tooltip.Provider value={tooltip}>
  <Tooltip.Trigger>Anchor</Tooltip.Trigger>
  <Portal>
    <Tooltip.Positioner>
      <Tooltip.Content>Content</Tooltip.Content>
    </Tooltip.Positioner>
  </Portal>
</Tooltip.Provider>
```

---

## Design System

Skeleton extends Tailwind CSS — no `tailwind.config.js` in v4 (CSS-first config).

### Global stylesheet (`app.css`) setup

```css
@import 'tailwindcss';
@import '@skeletonlabs/skeleton-svelte';
```

### Color system

Skeleton exposes colors as CSS custom properties:

```
--color-{color}-{shade}          → [property]-[color]-[shade]
--color-{color}-contrast-{shade} → [property]-[color]-contrast-[shade]
--color-{color}-{shade}-{shade}  → color pairings (auto-balance light/dark)
```

### Presets (canned styles for buttons, badges, cards, etc.)

```html
<button class="btn preset-filled">Primary</button>
<button class="btn preset-outlined-surface-200-800">Outlined</button>
<div class="card preset-outlined-surface-200-800 bg-surface-50-950 p-4">Card</div>
```

### Radius tokens

```
rounded-base       → --radius-base
rounded-container  → --radius-container
```

### Theme variant

Target elements for a specific theme:

```html
<div class="bg-green-500 theme-cerberus:bg-red-500">...</div>
```

### Typography classes

```
h1 h2 h3 h4 h5 h6   → heading styles
anchor               → styled anchor links
```

---

## Theming

- **Preset themes**: set `data-theme="cerberus"` (or other) on `<html>`.
- **Custom themes**: generate at https://themes.skeleton.dev/ — outputs a CSS file to import.
- **Theme generator import**: paste a v2 theme at https://themes.skeleton.dev/themes/import to auto-convert.

---

## Component Reference (v4 names)

| Component | Notes |
|---|---|
| `<Accordion>` | `<Accordion.Item>`, `<Accordion.ItemTrigger>`, `<Accordion.ItemContent>` |
| `<Avatar>` | `<Avatar.Image>`, `<Avatar.Fallback>` |
| `<Combobox>` | Replaces v2 `<Autocomplete>` |
| `<Dialog>` | Replaces v3 `<Modal>` — also covers drawer usage |
| `<FileUpload>` | Replaces v2 `<FileButton>` + `<FileDropzone>` |
| `<Navigation>` | `layout="bar"` or `layout="rail"` — replaces v3 `<Navigation.Bar>` / `<Navigation.Rail>` |
| `<Pagination>` | Replaces v2 `<Paginator>` |
| `<Popover>` | Replaces v2 popups + focus trap |
| `<Progress>` | Linear — replaces v2 `<ProgressBar>` |
| `<Progress>` (circular) | Replaces v3 `<ProgressRing>` |
| `<RatingGroup>` | Replaces v3 `<Ratings>` |
| `<SegmentedControl>` | Replaces v2 `<RadioGroup>` / v3 `<Segment>` |
| `<Slider>` | Replaces v2 `<RangeSlider>` |
| `<Switch>` | Replaces v2 `<Slider>` (slide toggle) |
| `<Table>` | Tailwind component (not a Svelte component) |
| `<Tabs>` | Replaces v2 `<TabGroup>` |
| `<TagsInput>` | Replaces v2 `<InputChip>` |
| `<Toast.Group>` | Replaces v3 `<Toaster>` |

---

## Tailwind Components (no JS — pure CSS utility classes)

```html
<!-- Buttons -->
<button class="btn preset-filled">Click me</button>

<!-- Badges -->
<span class="badge preset-filled-primary-500">New</span>

<!-- Cards -->
<div class="card p-4">...</div>

<!-- Tables -->
<table class="table">...</table>

<!-- Forms / Input Groups -->
<div class="input-group">
  <span class="ig-cell">@</span>
  <input class="ig-input" type="text" />
  <button class="ig-button preset-filled">Go</button>
</div>
```

---

## SvelteKit Integration

- Global stylesheet is typically `src/app.css`, imported in `src/routes/+layout.svelte`.
- Set `data-theme` on `<html>` in `src/app.html` (Tailwind v4 / Skeleton v4+).
- Use `@tailwindcss/vite` Vite plugin (not PostCSS) for Tailwind v4:

```ts
// vite.config.ts
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default { plugins: [tailwindcss(), sveltekit()] };
```

---

## Key Rules

1. **Always use the composed sub-component pattern** — never pass `src` or `name` directly to the root (v2-style).
2. **State flows in via props, out via event callbacks** — avoid `bind:` on Skeleton components.
3. **Style via `class`** — Skeleton does not use `style` props.
4. **Avoid `@apply`** — use CSS custom properties and Tailwind utilities directly.
5. **`data-theme` goes on `<html>`**, not `<body>` (changed in v4 / Tailwind v4).
6. **Svelte 5 runes** (`$state`, `$derived`, `$effect`, snippets) are the expected API.
7. For anything not listed here, **fetch the full reference**: `https://www.skeleton.dev/llms-svelte.txt`.
