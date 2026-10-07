---
name: svelte
description: Use when working on Svelte or SvelteKit projects. Covers Svelte 5 runes ($state, $derived, $effect, $props, $bindable), snippets, SvelteKit routing (+page.svelte, +layout.svelte, +server.js, load functions, form actions), and all $app/* imports. Do not use for non-Svelte projects.
---

# Svelte 5 & SvelteKit

You **MUST** use the Svelte 5 API. Do not write Svelte 4 syntax unless explicitly asked.

**Full compressed reference (fetch when you need complete details):**
- Combined Svelte + SvelteKit: `https://svelte.dev/llms-small.txt`
- Svelte only: `https://svelte.dev/docs/svelte/llms.txt`
- SvelteKit only: `https://svelte.dev/docs/kit/llms.txt`

---

## Svelte 5 Runes

Runes are **compiler keywords**, not functions. Never import them.

### $state — reactive variables

```svelte
<script>
  let count = $state(0);
  let todos = $state([{ done: false, text: 'add more todos' }]);
</script>
<button onclick={() => count++}>Clicked: {count}</button>
```

- Arrays and objects become **deeply reactive proxies**.
- Do **not** destructure reactive proxies — breaks reactivity.
- `$state.raw` — shallow state, entire object must be reassigned to update.
- `$state.snapshot(value)` — get a plain (non-proxy) copy.

### $derived — computed values

```svelte
<script>
  let count = $state(0);
  let doubled = $derived(count * 2);
  // multi-line:
  let total = $derived.by(() => {
    let sum = 0;
    for (const n of numbers) sum += n;
    return sum;
  });
</script>
```

- Keep derived expressions **pure** — no side effects.
- Replaces `$: doubled = count * 2` from Svelte 4.

### $effect — side effects

```svelte
<script>
  let size = $state(50);
  $effect(() => {
    const interval = setInterval(() => { size += 1; }, 1000);
    return () => clearInterval(interval); // teardown
  });
</script>
```

- Runs **after** DOM updates. Use `$effect.pre` to run **before**.
- Do **not** use `$effect` for state synchronisation — use `$derived` instead.
- `$effect.root` — manual cleanup scope for nested effects.

### $props — component inputs

```svelte
<script>
  let { foo = 'default', bar, ...rest } = $props();
</script>
```

- Do **not** mutate props; use callbacks or `$bindable`.
- Replaces `export let foo` from Svelte 4.
- `$props.id()` — stable unique ID per component instance.

### $bindable — two-way props

```svelte
<!-- FancyInput.svelte -->
<script>
  let { value = $bindable() } = $props();
</script>
<input bind:value={value} />
```

- Only mark props as bindable when two-way flow is genuinely needed.

### Snippets & {@render}

```svelte
<!-- Define -->
{#snippet figure(image)}
  <figure>
    <img src={image.src} alt={image.caption} />
    <figcaption>{image.caption}</figcaption>
  </figure>
{/snippet}

<!-- Use -->
{@render figure(myImage)}
```

- Snippets replace **slots** from Svelte 4.
- Content not in a snippet tag becomes the implicit `children` snippet.
- Type snippets with `Snippet` / `Snippet<[ParamType]>` from `'svelte'`.

```svelte
<!-- Passing children (replaces <slot>) -->
<!-- Button.svelte -->
<script>
  let { children } = $props();
</script>
<button>{@render children()}</button>

<!-- App.svelte -->
<Button>click me</Button>
```

### Event handling

```svelte
<!-- Svelte 5 -->
<button onclick={() => count++}>click</button>

<!-- NOT Svelte 4 style -->
<button on:click={...}>  ← WRONG
```

### Conditional classes (object syntax)

```svelte
<div class={{ active: isActive, disabled: !isEnabled }}>...</div>
```

### Error boundaries

```svelte
<svelte:boundary onerror={(error, reset) => console.error(error)}>
  <FlakyComponent />
  {#snippet failed(error, reset)}
    <button onclick={reset}>Try again</button>
  {/snippet}
</svelte:boundary>
```

---

## SvelteKit

### Scaffolding

```bash
npx sv create my-app   # correct
# NOT: npm create svelte (deprecated)
```

### Project structure

```
src/
  routes/        ← filesystem router
  lib/           ← shared code, import via $lib
  lib/server/    ← server-only code, import via $lib/server
  app.html
  hooks.client.js
  hooks.server.js
static/          ← public assets
svelte.config.js
vite.config.js
```

### Routing — file naming

| File | Purpose |
|---|---|
| `+page.svelte` | Page UI |
| `+page.js` | Universal load (runs client + server) |
| `+page.server.js` | Server-only load + form actions |
| `+layout.svelte` | Shared layout wrapper |
| `+layout.js` / `+layout.server.js` | Layout data loading |
| `+server.js` | HTTP endpoint (GET, POST, …) |
| `+error.svelte` | Error boundary for this route |

- `[param]` — dynamic segment
- `[...rest]` — catch-all / rest params
- `[[optional]]` — optional segment
- `(group)` — layout group (no URL effect)
- `[param=matcher]` — constrained param (see `src/params/`)

### +page.svelte

```svelte
<script lang="ts">
  import type { PageProps } from './$types';
  let { data } = $props() as PageProps;
</script>
<h1>{data.title}</h1>
```

- Do **not** fetch data inside the component — use a `load` function.

### +page.js (universal load)

```ts
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
  const res = await fetch(`/api/items/${params.id}`);
  return { item: await res.json() };
};
```

- Runs on server (SSR) and client (navigation).
- No access to cookies, DB, or private env. Use `+page.server.js` for those.

### +page.server.js (server load + actions)

```ts
import type { PageServerLoad, Actions } from './$types';
import { error, fail, redirect } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ cookies, locals, params }) => {
  if (!locals.user) redirect(303, '/login');
  return { user: locals.user };
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const data = await request.formData();
    if (!data.get('name')) return fail(400, { missing: true });
    // ... save to DB
  }
};
```

### +layout.svelte

```svelte
<script>
  import type { LayoutProps } from './$types';
  let { children, data } = $props() as LayoutProps;
</script>
<nav>...</nav>
{@render children()}
```

### +server.js (API endpoint)

```ts
import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';

export const GET: RequestHandler = ({ url, params }) => {
  return json({ hello: 'world' });
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  return json({ received: body }, { status: 201 });
};
```

### Form actions + progressive enhancement

```svelte
<!-- +page.svelte -->
<script>
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';
  let { form } = $props() as PageProps;
</script>

<form method="POST" use:enhance>
  <input name="email" type="email" value={form?.email ?? ''} />
  {#if form?.missing}<p>Required</p>{/if}
  <button>Submit</button>
</form>
```

- `use:enhance` — progressive enhancement, no full reload.
- Return `fail(400, data)` to send validation errors back.
- Return `redirect(303, '/path')` to redirect after success.

### Loading data patterns

```ts
// Access parent layout data
export const load = async ({ parent }) => {
  const { user } = await parent();
  return { profile: await getProfile(user.id) };
};

// Invalidation
import { invalidate, invalidateAll } from '$app/navigation';
await invalidate('app:posts');   // invalidate specific key
await invalidateAll();            // invalidate everything

// Mark dependency in load
export const load = async ({ fetch, depends }) => {
  depends('app:posts');
  return { posts: await fetch('/api/posts').then(r => r.json()) };
};
```

### Page options (export from +page.js or +layout.js)

```ts
export const prerender = true;   // static HTML at build time
export const ssr = false;        // client-only SPA page
export const csr = false;        // no hydration, no JS (static only)

// For dynamic prerendered routes:
export function entries() {
  return [{ slug: 'hello' }, { slug: 'world' }];
}
```

### Hooks (src/hooks.server.js)

```ts
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = await getUser(event.cookies.get('session'));
  return resolve(event);
};

// Compose multiple handle functions:
export const handle = sequence(auth, logging);
```

### State management rules

- **Never** use shared server-side variables — servers are stateless and shared across users.
- Keep `load` functions pure — no side effects or global store writes.
- Use `setContext` / `getContext` for shared client-only state.
- Use `page.state` + `pushState` / `replaceState` for shallow routing (modals, etc.).
- Do **not** use `$app/stores` — use `$app/state` instead.

---

## Key Imports Reference

### `@sveltejs/kit`

```ts
import { error, fail, redirect, json, text } from '@sveltejs/kit';
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { normalizeUrl } from '@sveltejs/kit';   // v2.18+
```

### `@sveltejs/kit/hooks`

```ts
import { sequence } from '@sveltejs/kit/hooks';
```

### `$app/navigation`

```ts
import {
  goto, invalidate, invalidateAll,
  beforeNavigate, afterNavigate, onNavigate,
  preloadCode, preloadData,
  pushState, replaceState,
  disableScrollHandling
} from '$app/navigation';
```

### `$app/state`

```ts
import { page, navigating, updated } from '$app/state';
// page.url, page.params, page.data, page.error, page.status, page.state
// Do NOT use $app/stores
```

### `$app/forms`

```ts
import { enhance, applyAction, deserialize } from '$app/forms';
```

### `$app/paths`

```ts
import { base, assets, resolveRoute } from '$app/paths';
```

### `$app/environment`

```ts
import { browser, dev, building, version } from '$app/environment';
```

### `$app/server` (server-only)

```ts
import { getRequestEvent, read } from '$app/server';
```

### Environment variables

```ts
// Server-only (secrets safe):
import { DATABASE_URL } from '$env/static/private';
import { env } from '$env/dynamic/private';

// Public (exposed to client):
import { PUBLIC_API_URL } from '$env/static/public';
import { env } from '$env/dynamic/public';
```

---

## Common Pitfalls

| Wrong | Right |
|---|---|
| `on:click={handler}` | `onclick={handler}` |
| `export let foo` | `let { foo } = $props()` |
| `$: doubled = x * 2` | `let doubled = $derived(x * 2)` |
| `$: console.log(x)` | `$effect(() => console.log(x))` |
| `<slot>` / `<slot name="x">` | `{@render children()}` / snippets |
| `import { page } from '$app/stores'` | `import { page } from '$app/state'` |
| `npm create svelte` | `npx sv create` |
| `data-theme` on `<body>` | `data-theme` on `<html>` |
| Server code in `+page.js` | Use `+page.server.js` for DB/cookies/env |
| Mutate props directly | Use callbacks or `$bindable` |
| Destructure reactive proxy | Access properties directly |
