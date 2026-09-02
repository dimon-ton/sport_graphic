# Repository Guidelines

## Project Structure & Module Organization

- `index.html` is the single-page Thai donor appreciation interface. Its inline JavaScript manages form state, browser storage, JSONP/iframe API requests, donation editing, prompt interpolation, PWA installation, and offline UI guards.
- `styles.css` is the committed, browser-ready Tailwind CSS bundle. Edit `tailwind.css` and `tailwind.config.cjs`, then regenerate the bundle when changing utility styles.
- `Code.js` is the Google Apps Script web-app backend. It performs authenticated donation CRUD in the active spreadsheet, stores images in Google Drive, and publishes approved images to Facebook.
- `appsscript.json` contains Apps Script runtime and web-app settings.
- `prompt_template.txt` is the approved school sports-day image-generation prompt. Keep its fixed Thai school, event, banking, account, and tax text intact; only marked placeholders are variable.
- `prompt_styles.json` contains exactly 20 sports-day-first visual variants. Each entry must retain a unique `name` and a non-empty `direction` while remaining compatible with portrait and person-free modes.
- `manifest.webmanifest`, `service-worker.js`, and `icons/` provide installable PWA metadata, versioned app-shell caching, offline loading, and platform icons.
- `.clasp.json` connects this directory to the deployed Apps Script project. Do not expose or replace its script ID without coordination.
- `.claspignore` intentionally uploads only `appsscript.json`, `Code.js`, and `index.html`. Prompt files, compiled CSS, the manifest, service worker, and icons are deployed through the static host, not Apps Script.

## Build, Test, and Development Commands

There is no checked-in Node package manifest or automated test command. Serve the repository with a static server for local browser and service-worker testing, for example `python3 -m http.server 8000`, then open `http://localhost:8000`.

Rebuild the committed CSS bundle with `npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i tailwind.css -o styles.css --minify`. Keep `index.html` in the Tailwind content configuration.

When changing any app-shell resource listed in `service-worker.js`, increment `CACHE_NAME` so installed PWAs activate a fresh cache. Use `clasp push` to upload tracked Apps Script files and `clasp deploy --deploymentId ...` only when intentionally updating the existing web-app deployment. A clasp deployment does not publish the static-only files excluded by `.claspignore`.

## Coding Style & Naming Conventions

Use two-space indentation in HTML, CSS, and JavaScript. Keep browser code in `index.html` organized around named DOM references and small functions. Follow the Apps Script convention of a trailing underscore for private helpers, such as `updateDonation_()` and `jsonp_()`. Use descriptive camelCase for variables and UPPER_SNAKE_CASE for constants.

Preserve Thai copy exactly where it represents school, event, donation labels, account, or tax information. Keep the no-image prompt strictly person-free: no people, silhouettes, crowds, avatars, mockups, or portrait placeholders. When core donor data changes, regenerate the prompt and caption; unpublished generated-poster associations must be invalidated so stale artwork cannot be published.

Do not put secrets in frontend code, local-storage defaults, URLs, or committed files. `ADMIN_ACCESS_KEY`, `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`, and optional `FACEBOOK_GRAPH_API_VERSION` are Apps Script Properties. The administrator key is stored only in `sessionStorage` at runtime.

## Testing Guidelines

Before committing, manually test prompt/template loading, all 20 style records, form validation, image preview, history/search/filtering, detail loading, donor-data editing, poster invalidation, copy buttons, and successful/error API responses. Test prompt generation both with a supplied portrait and without one; the latter must remain entirely person-free.

For PWA changes, verify manifest/icon paths, service-worker registration, the expected app-shell cache, offline reload, disabled server actions while offline, and recovery after reconnection. For backend changes, deploy to a safe Apps Script version and verify create/update/delete operations against the `Donations` sheet, Drive upload behavior, and Facebook publishing on a test Page without logging secrets.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, e.g. `Fix Apps Script CORS and build Tailwind CSS`. Keep commits focused and name the affected behavior. Pull requests should explain user-visible changes, note any Apps Script deployment or spreadsheet-setting requirements, and include screenshots for interface changes. Link relevant issues when available.
