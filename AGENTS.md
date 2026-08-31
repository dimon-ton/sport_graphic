# Repository Guidelines

## Project Structure & Module Organization

- `index.html` is the single-page Thai donor appreciation interface. Its inline JavaScript manages form state, local storage, JSONP requests, and prompt interpolation.
- `styles.css` is the committed, browser-ready Tailwind CSS bundle. Edit `tailwind.css` and `tailwind.config.cjs`, then regenerate the bundle when changing utility styles.
- `Code.js` is the Google Apps Script web-app backend. It requests captions through OpenRouter and records submissions in the active spreadsheet.
- `appsscript.json` contains Apps Script runtime and web-app settings.
- `prompt_template.txt` is the approved image-generation prompt. Keep its fixed Thai school and banking text intact; only the marked placeholders are variable.
- `.clasp.json` connects this directory to the deployed Apps Script project. Do not expose or replace its script ID without coordination.

## Build, Test, and Development Commands

There is no checked-in Node package manifest or automated test command. Serve the repository with a static server for local browser testing, for example `python3 -m http.server 8000`, then open `http://localhost:8000`.

Use the Tailwind CLI available in your environment to rebuild `styles.css` from `tailwind.css`; ensure the configured `content` path includes `index.html`. Use `clasp push` to upload Apps Script changes and `clasp deploy` only when intentionally updating the web-app deployment.

## Coding Style & Naming Conventions

Use two-space indentation in HTML, CSS, and JavaScript. Keep browser code in `index.html` organized around named DOM references and small functions. Follow the Apps Script convention of a trailing underscore for private helpers, such as `processRequest_()` and `jsonp_()`. Use descriptive camelCase for variables and constants in UPPER_SNAKE_CASE.

Preserve Thai copy exactly where it represents school, event, account, or tax information. Do not move API keys to frontend code; `OPENROUTER_API_KEY` is read from the spreadsheet `Settings` tab.

## Testing Guidelines

Before committing, manually test the static page: prompt-template loading, form validation, image preview, copy buttons, and a successful/error JSONP response. For backend changes, deploy to a safe Apps Script version and verify that a donation creates or appends to the `Donations` sheet without logging secrets.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, e.g. `Fix Apps Script CORS and build Tailwind CSS`. Keep commits focused and name the affected behavior. Pull requests should explain user-visible changes, note any Apps Script deployment or spreadsheet-setting requirements, and include screenshots for interface changes. Link relevant issues when available.
