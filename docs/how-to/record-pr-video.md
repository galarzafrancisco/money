# How to record a demo video for a PR

Use this to show a UI change working: script a browser walk-through, record it
and attach the MP4 to the PR as a comment.

**Never commit videos.** `*.mp4`, `*.webm`, `*.mov` and `.playwright-mcp/` are
gitignored. Videos go in PR comments, not source control.

## One-time setup

```bash
npm run build:dev                                          # installs playwright-core (exact version, root devDependency)
npx playwright-core install chromium-headless-shell ffmpeg # the browser + ffmpeg builds that version pins
```

You also need a system `ffmpeg` with `libx264` on `PATH` (`apt install ffmpeg`).
Playwright's own ffmpeg can only write WebM.

Each Playwright version pins exact browser and ffmpeg revisions in
`~/.cache/ms-playwright` (`chromium_headless_shell-<rev>`, `ffmpeg-<rev>`). If a
launch fails with `Executable doesn't exist at ...`, run the install command
again. Playwright publishes linux-arm64 builds, so this works on the DGX Spark
too. Don't point `executablePath` at whatever binary happens to be in the cache,
and don't use snap Chromium (`/usr/bin/chromium-browser`). Snap confinement
makes it answer `net::ERR_ACCESS_DENIED` on `localhost`. The headless shell
doesn't need `--no-sandbox`.

## Record

1. Start the app: `npm run build && npm run dev` (serves the web app on
   http://localhost:4180).
2. Write a scenario, a module whose default export drives the page:

   ```js
   // scripts/demos/sign-in-page.mjs
   export default async function signInPage(page, { baseUrl, pause }) {
     await page.goto(`${baseUrl}/`);
     const signIn = page.getByRole('button', { name: /sign in with taico/i });
     await signIn.waitFor();
     await pause(1500);
     await signIn.hover();
     await pause(1200);
   }
   ```

   `page` is a Playwright [`Page`](https://playwright.dev/docs/api/class-page).
   `pause(ms)` gives viewers time to read. Keep demos short, under about
   30 seconds.
3. Record:

   ```bash
   npm run demo:record -- scripts/demos/sign-in-page.mjs --out /tmp/sign-in-page.mp4
   ```

   Option: `--base-url` (default `http://localhost:4180`, or `DEMO_BASE_URL`).
   Recording is always headless. Only the headless shell is installed, and
   the video captures the page either way. The script records 1280×720 WebM, converts it to H.264 MP4,
   and re-encodes at higher CRF until the file is under about 9.5 MB. Without
   `--out` it writes to the OS temp directory, outside the repo.

## Attach to the PR

```bash
gh pr comment <pr> --body "Demo: signed-out landing page" --attach /tmp/sign-in-page.mp4
```

`--attach` needs gh 2.102 or later. GitHub renders the video as a player. The
limit is 10 MB per file.

## Limits

- The local backend has no browser sign-in unless Taico is configured
  ([apps/backend/docs/web-auth.md](../../apps/backend/docs/web-auth.md)), so
  scenarios can only show signed-out screens. Signed-in demos need a configured
  Taico client, or a local fake Taico (not built yet).

## Alternatives

- **Playwright MCP** (`mcp__playwright__*`): good for exploring the page
  interactively. Its tools don't record video. To record from it, create a
  context inside `browser_run_code_unsafe` and save the video with `saveAs`,
  because `video.path()` isn't available over its remote connection:

  ```js
  async (page) => {
    const ctx = await page.context().browser().newContext({ recordVideo: { dir: '/tmp/v' } });
    const p = await ctx.newPage();
    await p.goto('http://localhost:4180/');
    const video = p.video();
    await ctx.close();
    await video.saveAs('/tmp/v/demo.webm');
  }
  ```

  Then convert the file with ffmpeg yourself. The script above is simpler.
- **chrome-devtools MCP** has a `screencast_*` tool. By default it looks for
  Google Chrome at `/opt/google/chrome/chrome`, which doesn't exist for
  linux-arm64. Configure it with `--executablePath` pointing at a Playwright
  Chromium before you use it.
