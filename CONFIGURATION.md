# Donation Content Manager configuration

The site remains a static page. Google Apps Script is the only backend, Google
Sheets is the record database, and Google Drive stores both donor portraits and
generated posters. Sheets contains Drive file IDs and URLs; it does not contain
base64 image data.

## Deploy the Apps Script backend

1. Push `Code.js` and `appsscript.json` to the existing Apps Script project with
   `clasp push`. Do not replace the script ID in `.clasp.json`.
2. In the Apps Script editor, run `authorizeDrive()` once and approve the
   requested Drive, Sheets, and external-request permissions.
3. Deploy a new web-app version, executing as the deploying user and using the
   access policy appropriate for the school's site. The current static frontend
   expects an anonymously callable web-app URL.
4. Paste the `/exec` URL into **ตั้งค่า Google Apps Script** in the page. It is
   stored only in that browser's local storage.

The first request creates the `Donations` sheet with the current schema. A
legacy sheet whose first heading is `Timestamp` is migrated automatically. The
migration cannot infer the old donation type, so legacy rows are marked
`money`; review those rows if old records include in-kind donations.

Uploads are limited to JPEG, PNG, WebP, and GIF. Drive files are shared as
"anyone with the link" so the static page can render and copy them. If donor
photos must remain private, this deployment model needs an authenticated image
proxy before use.

## Facebook Page publishing

Set these values in **Apps Script > Project settings > Script properties**:

| Property | Value |
| --- | --- |
| `ADMIN_ACCESS_KEY` | A long random passphrase used to protect every data and publishing operation |
| `FACEBOOK_PAGE_ID` | Numeric ID of the Facebook Page |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Page access token with permission to publish Page posts |
| `FACEBOOK_GRAPH_API_VERSION` | Optional pinned version, currently `v26.0` by default |

Never put the Page token in `index.html`, a spreadsheet cell, or a committed
file. `.env.example` documents property names only and is not loaded by the app.
Enter `ADMIN_ACCESS_KEY` in the page's administrator field. It is kept in
`sessionStorage`, cleared when the browser session ends, and sent in POST bodies
rather than query strings. Use HTTPS and do not share this key.

The backend uploads the Drive blob with a caption to the official Page Photos
edge, `POST /{page-id}/photos`, and records the returned photo/post ID. The Page
token normally needs `pages_manage_posts` and related Page access granted to the
Meta app. Confirm current token and App Review requirements in Meta's
[Pages API documentation](https://developers.facebook.com/docs/pages-api/) and
[Page Photos reference](https://developers.facebook.com/docs/graph-api/reference/page/photos/)
before production use. Pinning the version in Script Properties allows an API
upgrade without changing the frontend.

## Retry and duplicate behavior

- Create requests carry both a stable donation ID and a request ID. Retrying the
  same request returns the existing record.
- Sheet writes use `LockService` to serialize row creation and mutation.
- Uploading a generated poster updates the record by stable ID and never appends
  another donation row.
- Facebook publishing first claims the record as `publishing`. Published records
  return their saved result instead of posting again. Failures become
  `publish_failed` and can be retried after the cause is fixed.

## Local verification

Serve the directory rather than opening `index.html` directly, because the
prompt template is fetched as a separate file:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`, enter a safe Apps Script deployment URL, and test
create, history/search, detail, both image uploads, clipboard fallbacks, caption
editing, and Facebook publication on a test Page before deploying to production.
