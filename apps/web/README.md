# DocIntel web

Next.js (App Router) front end for DocIntel: upload, monitor processing, review and correct
extracted invoices, search (keyword / semantic / hybrid) and cross-verify documents.

## Run

```bash
# API must be running (see the repository README); then:
API_URL=http://localhost:4000 API_KEY=dev-admin-key-change-me npm run dev   # http://localhost:3000
npm run build && API_URL=... API_KEY=... npm run start                      # production
docker build -t docintel-web . && docker run -p 3000:3000 -e API_URL=http://host.docker.internal:4000 -e API_KEY=... docintel-web
```

| Variable | Purpose |
| --- | --- |
| `API_URL` | Base URL of the DocIntel API (server-side only) |
| `API_KEY` | API key added by the server-side proxy; never sent to the browser |
| `WEB_BASIC_AUTH` | Optional `user:password`; enables HTTP basic auth for the whole app and is passed to the API as the reviewer (`X-Actor`) |

## How it talks to the API

The browser only calls same-origin routes. `app/api/proxy/[...path]` forwards to `${API_URL}/api/v1/...`,
adds the API key, streams bodies both ways (200 MB uploads, page images, downloads, server-sent events),
and blocks path traversal. `proxy.ts` applies basic auth to pages; the BFF routes check it themselves so
uploads are not buffered by the proxy layer.

## Pages

| Route | What it does |
| --- | --- |
| `/` | Upload (drag and drop, many files), pipeline counts, key figures, review shortlist, recent documents with live progress |
| `/documents` | All documents with filters, progress, failure reasons, reprocess, delete, retry all failed |
| `/documents/[id]` | Page viewer or sheet grid, invoices found (with page ranges), extracted text with OCR details, processing history |
| `/invoices/[id]` | Review and correct: evidence highlight on the page or spreadsheet cell, confidence and source per field, line items with live sum check, validation issues, save (optimistic locking), approve (with override note), reject, history |
| `/review` | Queue of invoices needing review, filter by issue type, sort |
| `/search` | Hybrid, keyword or semantic search with filters; browse all invoices |
| `/reconcile` | Compare two documents (PDF vs Excel/CSV, PDF vs PDF): matched, mismatched with field differences, missing on either side |

Live updates come from the API's server-sent events (`/api/proxy/events`), with polling as a fallback
while documents are processing.

## Tests

```bash
npx playwright install chromium
npm run test:e2e        # smoke: upload, process, correct + revalidate, search, cross-verify page, key not exposed
npm run screenshots     # docs/media/screenshots/*.png
npm run walkthrough     # narrated tour recorded to docs/media/walkthrough.webm (needs eval/data and the recon-a pair processed)
```
