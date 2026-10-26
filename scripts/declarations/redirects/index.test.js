import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import config from 'config';

import checkRedirects, { analyzeHtml, collectDeclaredSources, findLocaleInUrl, groupByUrl, isLanguageMismatch, isRedirected, readUrls, resolveFetcherConfig } from './index.js';

use(chaiAsPromised);

const FIRST_HOST_PORT = 8977;
const SECOND_HOST_PORT = 8978;

const termsHTML = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>First provider TOS</title><link rel="canonical" href="https://provider.example/tos"></head><body><h1>Terms of service</h1><p>Dapibus quis diam sagittis</p></body></html>';

describe('Redirects', () => {
  let temporaryDirectory;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-redirects-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  describe('#groupByUrl', () => {
    const entries = [
      { url: 'https://provider.example/tos', executeClientScripts: false, cssSelectors: ['main'], service: 'ServiceA', termsType: 'Terms of Service' },
      { url: 'https://provider.example/privacy', cssSelectors: ['article'], service: 'ServiceA', termsType: 'Privacy Policy' },
      { url: 'https://provider.example/tos', executeClientScripts: true, cssSelectors: [ 'main', 'h1' ], service: 'ServiceB', termsType: 'Terms of Service' },
    ];
    let targets;

    before(() => {
      targets = groupByUrl(entries);
    });

    it('keeps one target per URL, in order of first appearance', () => {
      expect(targets.map(({ url }) => url)).to.deep.equal([ 'https://provider.example/tos', 'https://provider.example/privacy' ]);
    });

    it('keeps every source that uses a URL', () => {
      expect(targets[0].sources).to.deep.equal([
        { service: 'ServiceA', termsType: 'Terms of Service' },
        { service: 'ServiceB', termsType: 'Terms of Service' },
      ]);
    });

    it('merges the CSS selectors of the sources that share a URL', () => {
      expect(targets[0].cssSelectors).to.deep.equal([ 'main', 'h1' ]);
    });

    it('executes client scripts when one of the sources that share a URL requires it', () => {
      expect(targets[0].executeClientScripts).to.be.true;
    });

    it('lets the engine decide when no source sharing a URL forbids or requires client scripts', () => {
      expect(groupByUrl([{ url: 'https://provider.example/tos', executeClientScripts: false }, { url: 'https://provider.example/tos' }])[0].executeClientScripts).to.be.undefined;
    });
  });

  describe('#collectDeclaredSources', () => {
    const serviceId = 'service_with_multiple_source_documents_terms';

    it('returns one entry per source document of the given services', async () => {
      const entries = await collectDeclaredSources({ services: [serviceId] });

      expect(entries.map(({ url }) => url)).to.deep.equal([
        'https://www.service-with-multiple-source-documents-terms.example/community-standards',
        'https://www.service-with-multiple-source-documents-terms.example/community-standards/hate-speech/',
        'https://www.service-with-multiple-source-documents-terms.example/community-standards/violence-incitement/',
      ]);
    });

    it('keeps the declared fetching settings and source of each entry', async () => {
      const [ , hateSpeechEntry ] = await collectDeclaredSources({ services: [serviceId] });

      expect(hateSpeechEntry).to.include({ executeClientScripts: false, service: serviceId, termsType: 'Community Guidelines' });
    });

    it('only returns the source documents of the given terms types', async () => {
      expect(await collectDeclaredSources({ services: [serviceId], types: ['Privacy Policy'] })).to.be.empty;
    });
  });

  describe('#readUrls', () => {
    it('reads the given URLs and the URLs of the given file, ignoring blank and comment lines', () => {
      const urlsFilePath = path.join(temporaryDirectory, 'urls.txt');

      fs.writeFileSync(urlsFilePath, '# Provider\r\nhttps://provider.example/privacy\r\n\r\n  https://provider.example/cookies  \n');

      expect(readUrls({ url: ['https://provider.example/tos'], urls: urlsFilePath })).to.deep.equal([
        { url: 'https://provider.example/tos' },
        { url: 'https://provider.example/privacy' },
        { url: 'https://provider.example/cookies' },
      ]);
    });

    it('throws an error on an invalid URL', () => {
      expect(() => readUrls({ url: ['provider.example/tos'] })).to.throw('Invalid URL "provider.example/tos"');
    });
  });

  describe('#resolveFetcherConfig', () => {
    function writeProductionConfig(fetcherConfig) {
      fs.mkdirSync(path.join(temporaryDirectory, 'config'));
      fs.writeFileSync(path.join(temporaryDirectory, 'config', 'production.json'), JSON.stringify({ '@opentermsarchive/engine': { fetcher: fetcherConfig } }));
    }

    it('uses the fetcher settings of the collection\'s production configuration', () => {
      writeProductionConfig({ language: 'fr-CI,fr', navigationTimeout: 45000 });

      expect(resolveFetcherConfig(temporaryDirectory)).to.include({ language: 'fr-CI,fr', navigationTimeout: 45000 });
    });

    it('removes quality factors from the production language', () => {
      writeProductionConfig({ language: 'en-IE, en-GB;q=0.9, en;q=0.8' });

      expect(resolveFetcherConfig(temporaryDirectory).language).to.equal('en-IE,en-GB,en');
    });

    it('falls back on the engine configuration when the collection has no production configuration', () => {
      expect(resolveFetcherConfig(temporaryDirectory)).to.deep.equal(config.get('@opentermsarchive/engine.fetcher'));
    });

    it('lets the given language override the production one', () => {
      writeProductionConfig({ language: 'fr-CI,fr' });

      expect(resolveFetcherConfig(temporaryDirectory, 'en-KE,en').language).to.equal('en-KE,en');
    });
  });

  describe('#isRedirected', () => {
    it('does not consider as redirected a URL that only differs in its writing', () => {
      expect(isRedirected('https://provider.example', 'https://provider.example/')).to.be.false;
    });

    it('ignores fragments', () => {
      expect(isRedirected('https://provider.example/tos#section-2', 'https://provider.example/tos')).to.be.false;
    });

    it('considers as redirected a URL that ends on another one', () => {
      expect(isRedirected('https://provider.example/tos', 'https://provider.example/en/tos')).to.be.true;
    });
  });

  describe('#analyzeHtml', () => {
    it('extracts the language, title and canonical URL of the page', () => {
      expect(analyzeHtml(termsHTML)).to.include({ htmlLang: 'en', title: 'First provider TOS', canonical: 'https://provider.example/tos' });
    });

    it('returns null values when the page does not declare them', () => {
      expect(analyzeHtml('<html><body>Terms</body></html>')).to.include({ htmlLang: null, title: null, canonical: null });
    });
  });

  describe('#isLanguageMismatch', () => {
    it('matches the page language against every tag of the fetcher language', () => {
      expect(isLanguageMismatch('fr-FR', 'fr-CI,fr')).to.be.false;
    });

    it('reports a page in another language', () => {
      expect(isLanguageMismatch('en', 'fr-CI,fr')).to.be.true;
    });

    it('returns null when the page does not declare its language', () => {
      expect(isLanguageMismatch(null, 'fr-CI,fr')).to.be.null;
    });
  });

  describe('#findLocaleInUrl', () => {
    it('finds a locale in a path segment', () => {
      expect(findLocaleInUrl('https://support.provider.example/hc/en-us/articles/123')).to.equal('/en-us/');
    });

    it('finds a language in a path segment', () => {
      expect(findLocaleInUrl('https://provider.example/en/tos')).to.equal('/en/');
    });

    it('finds a locale in a query parameter', () => {
      expect(findLocaleInUrl('https://provider.example/legal?locale=en_GB')).to.equal('locale=en_GB');
    });

    it('ignores path segments that are not language codes', () => {
      expect(findLocaleInUrl('https://support.provider.example/hc/articles/tos')).to.be.null;
    });
  });

  describe('#checkRedirects', function () {
    this.timeout(60000);

    const firstHost = `http://127.0.0.1:${FIRST_HOST_PORT}`;
    const secondHost = `http://127.0.0.1:${SECOND_HOST_PORT}`;
    let servers;

    before(() => {
      const handle = (request, response) => {
        if (request.url === '/') {
          response.writeHead(200, { 'Content-Type': 'text/html' }).write(termsHTML);
        }
        if (request.url === '/moved') {
          response.writeHead(301, { Location: '/' });
        }
        if (request.url === '/blocked') {
          response.writeHead(403, { 'Content-Type': 'text/html' }).write('<!DOCTYPE html><html><body>Access Denied</body></html>');
        }

        return response.end();
      };

      servers = [ http.createServer(handle).listen(FIRST_HOST_PORT), http.createServer(handle).listen(SECOND_HOST_PORT) ];
    });

    after(() => servers.forEach(server => server.close()));

    context('when URLs are redirected or not', () => {
      let records;

      before(async () => {
        ({ records } = await checkRedirects({ url: [ `${firstHost}/moved`, `${firstHost}/` ], interval: 0 }));
      });

      it('records the URL a redirected URL ends on', () => {
        expect(records[0]).to.include({ url: `${firstHost}/moved`, finalUrl: `${firstHost}/`, redirected: true });
      });

      it('records a URL that is not redirected as such', () => {
        expect(records[1]).to.include({ url: `${firstHost}/`, redirected: false });
      });

      it('records what the final page declares', () => {
        expect(records[0]).to.include({ htmlLang: 'en', title: 'First provider TOS', canonical: 'https://provider.example/tos' });
      });
    });

    context('when a host shows a blocking sign', () => {
      let records;

      before(async () => {
        ({ records } = await checkRedirects({ url: [ `${firstHost}/blocked`, `${firstHost}/`, `${secondHost}/moved` ], interval: 0 }));
      });

      it('records the blocking sign', () => {
        expect(records.find(({ url }) => url == `${firstHost}/blocked`)).to.include({ blockingSign: 'HTTP code 403' });
      });

      it('skips the remaining URLs of that host', () => {
        expect(records.find(({ url }) => url == `${firstHost}/`)).to.have.property('skipped').that.includes('HTTP code 403');
      });

      it('keeps checking the other hosts', () => {
        expect(records.find(({ url }) => url == `${secondHost}/moved`)).to.include({ redirected: true });
      });
    });

    context('when writing records to a file', () => {
      let outputFilePath;

      beforeEach(async () => {
        outputFilePath = path.join(temporaryDirectory, 'redirects.jsonl');
        await checkRedirects({ url: [`${firstHost}/moved`], interval: 0, out: outputFilePath });
      });

      it('writes one JSON line per URL', () => {
        const lines = fs.readFileSync(outputFilePath, 'utf8').trim().split('\n');

        expect(lines.map(line => JSON.parse(line))).to.have.length(1).and.to.have.nested.property('[0].finalUrl', `${firstHost}/`);
      });

      it('refuses to overwrite an existing file', async () => {
        await expect(checkRedirects({ url: [`${firstHost}/`], interval: 0, out: outputFilePath })).to.be.rejectedWith('already exists');
      });

      it('only checks the URLs that are not recorded yet when resuming', async () => {
        const { records, alreadyRecordedCount } = await checkRedirects({ url: [ `${firstHost}/moved`, `${firstHost}/` ], interval: 0, out: outputFilePath, resume: true });

        expect(alreadyRecordedCount).to.equal(1);
        expect(records.map(({ url }) => url)).to.deep.equal([`${firstHost}/`]);
        expect(fs.readFileSync(outputFilePath, 'utf8').trim().split('\n')).to.have.length(2);
      });
    });
  });
});
