#! /usr/bin/env node
import '../../../bin/env.js';

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { program } from 'commander';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { default: checkRedirects, DEFAULT_INTERVAL } = await import(pathToFileURL(path.resolve(__dirname, './index.js'))); // load asynchronously to ensure env.js is loaded before

program
  .name('redirects')
  .description('Fetch the declared URLs of the collection, or given URLs, and report the URL each one ends on after redirections')
  .option('-s, --services [serviceId...]', 'service IDs of services whose URLs to check')
  .option('-t, --types [termsType...]', 'terms types whose URLs to check')
  .option('-m, --modified', 'to only check the terms modified in the current branch')
  .option('--url <url...>', 'URLs to check instead of the declared ones')
  .option('--urls <file>', 'file listing URLs to check instead of the declared ones, one per line')
  .option('--language <tags>', 'fetcher language, as comma-separated BCP 47 tags; defaults to the collection\'s production one')
  .option('--full-dom', 'to load every URL in the headless browser')
  .option('--interval <seconds>', 'number of seconds between two requests to the same host', DEFAULT_INTERVAL)
  .option('--out <file>', 'JSON Lines file to which each record is appended')
  .option('--resume', 'to skip the URLs already recorded in the output file');

const options = program.parse(process.argv).opts();

process.on('SIGINT', () => process.exit(130)); // Puppeteer closes the headless browser when the process exits; records already written to the output file are kept for a later resume

try {
  const { records, language, alreadyRecordedCount } = await checkRedirects(options, { onRecord: printProgress });

  printSummary(records, language, alreadyRecordedCount);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

function printProgress(record, { index, total }) {
  console.error(`[${index}/${total}] ${record.url} → ${statusOf(record)}`);
}

function statusOf(record) {
  if (record.skipped) {
    return 'skipped';
  }

  if (record.error) {
    return `error: ${record.error}`;
  }

  return record.redirected ? record.finalUrl : 'not redirected';
}

function printSummary(records, language, alreadyRecordedCount) {
  const redirected = records.filter(record => record.redirected);
  const languageFlagged = records.filter(record => record.languageMismatch || record.localeInUrl);
  const failed = records.filter(record => record.error);
  const skipped = records.filter(record => record.skipped);

  console.log(`\n${records.length} URLs checked with language "${language}"${alreadyRecordedCount ? `, ${alreadyRecordedCount} already recorded` : ''}: ${redirected.length} redirected, ${languageFlagged.length} with a language flag, ${failed.length} failed, ${skipped.length} skipped`);

  printSection('Redirected', redirected, record => `${record.url}\n    → ${record.finalUrl}`);
  printSection('Language flags', languageFlagged, record => `${record.finalUrl}\n    ${[
    record.languageMismatch && `page language "${record.htmlLang}"`,
    record.localeInUrl && `locale in URL ${record.localeInUrl}`,
  ].filter(Boolean).join(', ')}`);
  printSection('Failed', failed, record => `${record.url}\n    ${record.error}`);
  printSection('Skipped', skipped, record => `${record.url}\n    ${record.skipped}`);
}

function printSection(title, records, describe) {
  if (!records.length) {
    return;
  }

  console.log(`\n${title}`);
  records.forEach(record => {
    const sources = record.sources.map(({ service, termsType }) => `${service} · ${termsType}`).join(', ');

    console.log(`  ${sources ? `${sources}\n  ` : ''}${describe(record)}`);
  });
}
