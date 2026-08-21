# Vendored fonts

`JetBrainsMono-latin.woff2` — JetBrains Mono, latin subset, variable (`wght`
axis 400–800). Licensed under the SIL Open Font License 1.1; see `OFL.txt`.

## Why it's committed rather than fetched

`next/font/google` downloads the woff2 from `fonts.gstatic.com` **during
`next build`**. That happens inside `podman compose build`, so any machine
whose build sandbox can't reach Google either fails the build or silently
substitutes a system font. claudio is a locally-built container; its image
build shouldn't need the internet for a typeface.

## Refreshing it

One file covers every weight the app uses because this is the variable cut.
To update:

```sh
# Grab the CSS with a browser UA so Google serves woff2 rather than ttf,
# then pull the src URL from the @font-face block whose unicode-range
# starts at U+0000-00FF (that's the latin subset).
curl -sS -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' \
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap'
```

If the `wght` axis range changes, update `weight` in `webapp/app/layout.tsx`
to match.
