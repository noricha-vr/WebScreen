# WebScreen

**[日本語](README.ja.md)**

Turn web pages, images and PDFs into MP4 videos you can play on a VRChat video player.

https://web-screen.net

VRChat video players cannot open a web page, a slide deck or a screenshot — they only play video.
WebScreen converts those into an MP4 that scrolls through the content, and gives you a URL to paste
into the player.

## How to use

1. Open https://web-screen.net and sign in with Discord.
2. Give it something to convert:
   - **A URL** — the page is captured top to bottom and turned into a scrolling video.
   - **A PDF** — one page per frame.
   - **Images** (png / jpg / jpeg / webp / gif) — one image per frame.
3. Copy the video URL that appears.
4. Paste it into a VRChat video player.

The video is encoded so that every frame is a keyframe, which is what lets VRChat players seek to any
point instantly.

## Limits

| | |
|---|---|
| File size | 50 MB per video |
| Storage per user | 500 MB |
| Retention | 30 days |
| Pinned videos | 10 per user, kept indefinitely |

Videos are served from a public URL — anyone who knows the URL can play it. The only protection is
that the ID is a random 12-character string. Do not convert anything confidential.

## Privacy

Sign-in uses Discord OAuth. Converted videos are stored on Cloudflare R2 and deleted automatically
after the retention period. See the privacy page on the site for details.

## Development

The service runs on Cloudflare Workers (Astro + D1 + R2). The screenshot service that captures web
pages lives in a separate repository: [web-capture](https://github.com/noricha-vr/web-capture).

```bash
cd web
bun install
cp .dev.vars.example .dev.vars   # fill in the values
bun run dev                      # http://localhost:4321
bun test
bunx playwright test
```

Pushing to `main` deploys to production through GitHub Actions.

Repository layout, conventions and the things you must not break are documented in
[CLAUDE.md](CLAUDE.md).

> [!NOTE]
> The files at the repository root (`router/`, `movie_maker/`, `templates/`, `Dockerfile`, …) are the
> previous FastAPI implementation. It is no longer developed and will be removed.

## License

See [LICENSE.md](LICENSE.md).
