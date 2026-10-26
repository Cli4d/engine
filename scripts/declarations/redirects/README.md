# Redirects

Fetch the declared URLs of a collection, or given URLs, and report the URL each one ends on after redirections.

A URL that is valid where it was declared may redirect elsewhere when fetched from another country, in another language or after the service reorganised its pages. This script shows where each URL lands, from wherever it runs, without recording any snapshot or version.

## How it works

Each URL is fetched through the engine's own fetcher, as `ota track` does: same headers, same proxy (`HTTP_PROXY` and `HTTPS_PROXY`), and the HTML-only fetcher first, then the headless browser when the declaration sets `executeClientScripts` or when the HTML-only fetch looks blocked by a bot protection. Redirections made by the server are reported in every case, while those made by client scripts or meta refresh are only reported when the page is loaded in the headless browser.

The fetcher settings are the ones of the collection's `config/production.json`, so that the `Accept-Language` sent is the production one, even though the engine only loads that file when `NODE_ENV` is `production`.

A URL used by several terms is fetched once. Requests to the same host are spaced, hosts are interleaved, and a host that shows a blocking sign (an HTTP code 403, 429 or 503, or a challenge page) is not requested again during the run: its remaining URLs are recorded as skipped.

## Usage

From the root of a collection:

```sh
node <engine_path>/scripts/declarations/redirects/cli.js [--services <service_id>...] [--types <terms_type>...] [--modified] [options]
node <engine_path>/scripts/declarations/redirects/cli.js (--url <url>... | --urls <file>) [options]
```

Options:

- `--services <service_id>...`, `--types <terms_type>...`: only check the URLs of these services and terms types.
- `--modified`: only check the terms modified in the current branch, as `ota validate --modified` does.
- `--url <url>...`, `--urls <file>`: check these URLs, or the URLs listed in this file (one per line, `#` for comments), instead of the declared ones.
- `--language <tags>`: fetcher language, as comma-separated [BCP 47](https://www.rfc-editor.org/rfc/rfc5646) tags; defaults to the collection's production one.
- `--full-dom`: load every URL in the headless browser, to also report redirections made by client scripts.
- `--interval <seconds>`: number of seconds between two requests to the same host, tripled after a page loaded in the headless browser; defaults to 10.
- `--out <file>`: append each record to this [JSON Lines](https://jsonlines.org) file; an existing file is not overwritten.
- `--resume`: skip the URLs already recorded in the `--out` file, to continue an interrupted run.

Examples:

```sh
node <engine_path>/scripts/declarations/redirects/cli.js --services <service_id> --out redirects.jsonl
node <engine_path>/scripts/declarations/redirects/cli.js --services <service_id> --out redirects.jsonl --resume
node <engine_path>/scripts/declarations/redirects/cli.js --url https://example.com/terms --language fr
```

## Output

The progress is printed on the standard error, one line per URL, and a summary is printed at the end on the standard output: the redirected URLs, the URLs with a language flag, and the URLs that failed or were skipped, each with the terms that use it.

Each record of the `--out` file is one JSON object per line:

| Property | Description |
|---|---|
| `url` | URL as declared or given |
| `finalUrl` | URL the fetch ended on |
| `redirected` | Whether `finalUrl` differs from `url`, ignoring differences in writing and fragments |
| `fetcher` | Fetcher used, `htmlOnly` or `fullDom` |
| `mimeType` | MIME type of the final document |
| `htmlLang`, `title`, `canonical` | Language, title and canonical URL declared by the final page, for HTML documents |
| `languageMismatch` | Whether the language of the final page differs from the fetcher language; `null` when the page does not declare its language |
| `localeInUrl` | Locale found in the final URL, as a path segment (`/en-us/`) or a query parameter (`hl=en`); a hint only, as a path segment that happens to be a language code, such as `eu`, is reported too |
| `sources` | Service IDs and terms types that use the URL |
| `error` | Error message, when the fetch failed |
| `blockingSign` | Blocking sign shown by the host, after which its remaining URLs are skipped |
| `skipped` | Reason why the URL was not fetched |
