# Project notes

## No SSR

This project does not use SSR. Astro is configured for static output and the
app runs entirely in the browser. Treat all React components as client-only:

- Use `client:only="react"` for React islands rather than `client:idle` /
  `client:load` / `client:visible` — there is no value in producing server
  HTML for them, and SSR-only warnings (e.g. `useLayoutEffect does nothing on
  the server`) should be fixed by skipping SSR, not by working around it.
- Browser-only APIs (`window`, `document`, `localStorage`, etc.) can be used
  directly inside React components without `typeof window` guards.
