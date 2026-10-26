import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import config from 'config';

import fetch, { launchHeadlessBrowser, stopHeadlessBrowser, FETCHER_TYPES } from '../../../src/archivist/fetcher/index.js';
import * as services from '../../../src/archivist/services/index.js';
import DeclarationUtils from '../utils/index.js';

export const DEFAULT_INTERVAL = 10; // Number of seconds between two requests to the same host
const FULL_DOM_INTERVAL_FACTOR = 3; // A page loaded in the headless browser fires many sub-requests, so its host is left alone longer afterwards
const BLOCKING_HTTP_CODE_PATTERN = /Received HTTP code (403|429|503)\b/;
const CHALLENGE_TITLE_PATTERN = /captcha|just a moment|attention required|access denied|verify you are (a )?human|are you a robot|security check/i;
const CHALLENGE_PAGE_MAX_TEXT_LENGTH = 2000; // Challenge pages carry little text, while a document whose title mentions one of the challenge words is usually long
const LOCALE_QUERY_PARAMETERS = [ 'hl', 'lang', 'language', 'locale' ];
const LOCALE_TAG_PATTERN = /^([a-z]{2})(?:[-_](?:[a-z]{2}|[0-9]{3}|[a-z]{4}))?$/i;

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const instancePath = path.resolve(process.cwd(), config.get('@opentermsarchive/engine.collectionPath'));

/**
 * Fetch each URL of the collection's declarations, or of a given list, and record the URL it ends on after redirections
 * @param   {object}                                                               [options]          Options, as parsed from the command line
 * @param   {Array<string>}                                                        [options.services] IDs of the services whose declared URLs are checked; all services when empty
 * @param   {Array<string>}                                                        [options.types]    Terms types whose declared URLs are checked; all terms types when empty
 * @param   {boolean}                                                              [options.modified] Only check the terms modified in the current branch, as `ota validate --modified` does
 * @param   {Array<string>}                                                        [options.url]      URLs to check instead of the declared ones
 * @param   {string}                                                               [options.urls]     Path of a file listing URLs to check instead of the declared ones, one per line
 * @param   {string}                                                               [options.language] Fetcher language, overriding the collection's production one
 * @param   {boolean}                                                              [options.fullDom]  Load every URL in the headless browser
 * @param   {number|string}                                                        [options.interval] Number of seconds between two requests to the same host
 * @param   {string}                                                               [options.out]      Path of the JSON Lines file to which each record is appended
 * @param   {boolean}                                                              [options.resume]   Skip the URLs already recorded in the `out` file
 * @param   {object}                                                               [hooks]            Hooks
 * @param   {(record: object, progress: { index: number, total: number }) => void} [hooks.onRecord]   Called with each record and its progress, as soon as it is available
 * @returns {Promise<object>}                                                                         The records, the fetcher language used and the number of URLs skipped as already recorded
 */
export default async function checkRedirects(options = {}, { onRecord = () => {} } = {}) {
  const fetcherConfig = resolveFetcherConfig(instancePath, options.language);
  const interval = Number(options.interval ?? DEFAULT_INTERVAL) * 1000;
  const entries = options.url?.length || options.urls ? readUrls(options) : await collectDeclaredSources(options);
  const alreadyRecordedUrls = getAlreadyRecordedUrls(options);
  const targets = groupByUrl(entries).filter(({ url }) => !alreadyRecordedUrls.has(url));

  const queues = new Map(); // Targets grouped by host, so that hosts are interleaved while requests to the same host are spaced
  const nextRequestTimes = new Map();
  const blockingSigns = new Map();
  const records = [];

  targets.forEach(target => {
    const { host } = new URL(target.url);

    queues.set(host, (queues.get(host) || []).concat(target));
  });

  if (targets.length) {
    await launchHeadlessBrowser(fetcherConfig.language);
  }

  try {
    while (queues.size) {
      const host = pickNextHost(queues, nextRequestTimes, blockingSigns);
      const target = queues.get(host).shift();

      if (!queues.get(host).length) {
        queues.delete(host);
      }

      let record;

      if (blockingSigns.has(host)) {
        record = { url: target.url, sources: target.sources, skipped: `${host} showed a blocking sign earlier in this run: ${blockingSigns.get(host)}` };
      } else {
        const delay = (nextRequestTimes.get(host) || 0) - Date.now();

        if (delay > 0) {
          await sleep(delay); // eslint-disable-line no-await-in-loop
        }

        record = await check(target, fetcherConfig, options.fullDom); // eslint-disable-line no-await-in-loop
        nextRequestTimes.set(host, Date.now() + (record.fetcher == FETCHER_TYPES.FULL_DOM ? interval * FULL_DOM_INTERVAL_FACTOR : interval));

        if (record.blockingSign) {
          blockingSigns.set(host, record.blockingSign);
        }
      }

      records.push(record);

      if (options.out) {
        fs.appendFileSync(options.out, `${JSON.stringify(record)}\n`);
      }

      onRecord(record, { index: records.length, total: targets.length });
    }
  } finally {
    await stopHeadlessBrowser();
  }

  return { records, language: fetcherConfig.language, alreadyRecordedCount: alreadyRecordedUrls.size };
}

export function resolveFetcherConfig(collectionPath, language) {
  const fetcherConfig = { ...config.get('@opentermsarchive/engine.fetcher'), ...readProductionFetcherConfig(collectionPath) };

  if (language) {
    fetcherConfig.language = language;
  }

  return fetcherConfig;
}

function readProductionFetcherConfig(collectionPath) { // The collection's production configuration is only loaded by the engine when NODE_ENV is "production", which would also enable publishing; reading its fetcher settings makes the check send what production sends
  const productionConfigPath = path.join(collectionPath, 'config', 'production.json');

  if (!fs.existsSync(productionConfigPath)) {
    return {};
  }

  const fetcherConfig = { ...JSON.parse(fs.readFileSync(productionConfigPath, 'utf8'))['@opentermsarchive/engine']?.fetcher };

  if (fetcherConfig.language) {
    fetcherConfig.language = fetcherConfig.language.split(',').map(tag => tag.split(';')[0].trim()).filter(Boolean).join(','); // The headless browser refuses quality factors, which older configurations may still have
  }

  return fetcherConfig;
}

export async function collectDeclaredSources({ services: servicesIds = [], types: termsTypes = [], modified = false } = {}) {
  let servicesTermsTypes = {};

  if (modified) {
    ({ services: servicesIds, servicesTermsTypes } = await new DeclarationUtils(instancePath).getModifiedServicesAndTermsTypes());

    if (!servicesIds.length) {
      return [];
    }
  }

  const declaredServices = await services.load(servicesIds);

  return Object.keys(declaredServices).sort().flatMap(serviceId => {
    const service = declaredServices[serviceId];

    return service.getTermsTypes(termsTypes)
      .filter(termsType => !servicesTermsTypes[serviceId]?.length || servicesTermsTypes[serviceId].includes(termsType))
      .flatMap(termsType => service.getTerms({ type: termsType }).sourceDocuments.map(sourceDocument => ({
        url: sourceDocument.location,
        executeClientScripts: sourceDocument.executeClientScripts,
        cssSelectors: sourceDocument.cssSelectors,
        service: serviceId,
        termsType,
      })));
  });
}

export function readUrls({ url: urls = [], urls: urlsFilePath }) {
  const urlsFromFile = urlsFilePath ? fs.readFileSync(urlsFilePath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')) : [];

  return urls.concat(urlsFromFile).map(url => {
    if (!URL.canParse(url)) {
      throw new Error(`Invalid URL "${url}"`);
    }

    return { url };
  });
}

export function groupByUrl(entries) {
  const targets = new Map();

  entries.forEach(({ url, executeClientScripts, cssSelectors = [], service, termsType }) => {
    if (!targets.has(url)) {
      targets.set(url, { url, executeClientScripts, cssSelectors: [], sources: [] });
    }

    const target = targets.get(url);

    if (target.executeClientScripts !== true && executeClientScripts !== false) { // When sources share a URL, the most permissive setting wins: required scripts, then automatic escalation, then never executing scripts
      target.executeClientScripts = executeClientScripts;
    }

    target.cssSelectors = [...new Set(target.cssSelectors.concat(cssSelectors))];

    if (service) {
      target.sources.push({ service, termsType });
    }
  });

  return Array.from(targets.values());
}

function getAlreadyRecordedUrls({ out, resume }) {
  if (!out || !fs.existsSync(out)) {
    return new Set();
  }

  if (!resume) {
    throw new Error(`The output file "${out}" already exists; pass the resume option to continue it, or choose another file`);
  }

  return new Set(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).url));
}

function pickNextHost(queues, nextRequestTimes, blockingSigns) { // Hosts with a blocking sign come first, as their remaining URLs are skipped without any request, then the host that can be requested the soonest
  let nextHost;
  let nextTime = Infinity;

  queues.forEach((targets, host) => {
    const time = blockingSigns.has(host) ? -Infinity : nextRequestTimes.get(host) || 0;

    if (time < nextTime) {
      nextHost = host;
      nextTime = time;
    }
  });

  return nextHost;
}

async function check({ url, executeClientScripts, cssSelectors, sources }, fetcherConfig, fullDom) {
  const record = { url };

  try {
    const { mimeType, content, fetcher, finalUrl } = await fetch({
      url,
      executeClientScripts: fullDom || executeClientScripts,
      cssSelectors,
      config: fetcherConfig,
    });

    Object.assign(record, { finalUrl, redirected: isRedirected(url, finalUrl), fetcher, mimeType });

    if (mimeType?.includes('html')) {
      const { htmlLang, title, canonical, textLength } = analyzeHtml(content);

      Object.assign(record, { htmlLang, title, canonical, languageMismatch: isLanguageMismatch(htmlLang, fetcherConfig.language) });

      if (title && CHALLENGE_TITLE_PATTERN.test(title) && textLength < CHALLENGE_PAGE_MAX_TEXT_LENGTH) {
        record.blockingSign = `challenge page titled "${title}"`;
      }
    }

    record.localeInUrl = findLocaleInUrl(finalUrl);
  } catch (error) {
    record.error = error.message;

    const [ , blockingHttpCode ] = error.message.match(BLOCKING_HTTP_CODE_PATTERN) || [];

    if (blockingHttpCode) {
      record.blockingSign = `HTTP code ${blockingHttpCode}`;
    }
  }

  record.sources = sources;

  return record;
}

export function isRedirected(url, finalUrl) {
  return withoutFragment(url) != withoutFragment(finalUrl); // Comparing normalised URLs prevents reporting as redirected a URL that only differs in its writing, such as a missing trailing slash after the host
}

function withoutFragment(url) {
  const parsedUrl = new URL(url);

  parsedUrl.hash = '';

  return parsedUrl.href;
}

export function analyzeHtml(html) {
  return {
    htmlLang: html.match(/<html[^>]*\blang=["']?([\w-]+)/i)?.[1] || null,
    title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null,
    canonical: [
      /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
      /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
    ].map(pattern => html.match(pattern)?.[1]).find(Boolean) || null,
    textLength: html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length,
  };
}

export function isLanguageMismatch(htmlLang, language) {
  if (!htmlLang || !language) {
    return null;
  }

  const expectedLanguages = language.split(',').map(tag => primaryLanguageOf(tag.trim()));

  return !expectedLanguages.includes(primaryLanguageOf(htmlLang));
}

function primaryLanguageOf(tag) {
  return tag.split(/[-_]/)[0].toLowerCase();
}

export function findLocaleInUrl(url) { // A hint only: a path segment that happens to be a language code, such as "eu", is reported too
  const { pathname, searchParams } = new URL(url);
  const localeSegment = pathname.split('/').find(isLocaleTag);

  if (localeSegment) {
    return `/${localeSegment}/`;
  }

  const localeParameter = LOCALE_QUERY_PARAMETERS.find(parameter => isLocaleTag(searchParams.get(parameter)));

  return localeParameter ? `${localeParameter}=${searchParams.get(localeParameter)}` : null;
}

function isLocaleTag(value) {
  const [ , language ] = value?.match(LOCALE_TAG_PATTERN) || [];

  return Boolean(language && languageNames.of(language.toLowerCase()));
}
