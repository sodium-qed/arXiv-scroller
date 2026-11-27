#!/usr/bin/env python3
"""Freeze an authoritative arXiv population using the production JS parser.

Dependencies: Python Playwright plus Chromium. This script never calls an AI or
readership provider. Source HTML is parsed inertly and retained with hashes.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 32 * 1024 * 1024


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def canonical_url(raw, population):
    value = urlparse(raw)
    expected = '/list/math/' + ('new' if population == 'today' else 'recent')
    pairs = parse_qsl(value.query, keep_blank_values=True)
    if value.scheme != 'https' or value.netloc != 'arxiv.org' or value.path.rstrip('/') != expected:
        raise ValueError('The source URL must remain on the authoritative arXiv mathematics listing.')
    if len({key for key, _ in pairs}) != len(pairs):
        raise ValueError('Duplicate source query parameters.')
    for key, val in pairs:
        if key not in ('skip', 'show') or not val.isascii() or not val.isdigit() or len(val) > 9 or (key == 'show' and int(val) == 0):
            raise ValueError('Invalid source pagination parameter.')
    return urlunparse(('https', 'arxiv.org', expected, '', urlencode(sorted(pairs)), ''))


class SourceRedirects(HTTPRedirectHandler):
    def __init__(self, population):
        self.population = population

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        canonical_url(newurl, self.population)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--population', choices=['today', 'recent'], default='recent')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--raw-dir', type=Path)
    parser.add_argument('--max-pages', type=int, default=80, help='Maximum additional pagination requests.')
    parser.add_argument('--delay', type=float, default=3.0, help='Seconds between requests; minimum 3.')
    parser.add_argument('--timeout', type=float, default=30.0)
    parser.add_argument('--replay-manifest', type=Path, help='Replay previously fetched HTML; no network access.')
    args = parser.parse_args()
    if not 0 <= args.max_pages <= 1000 or args.delay < 3 or not 1 <= args.timeout <= 300:
        parser.error('Use 0–1000 pages, delay at least 3 seconds and timeout 1–300 seconds.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    raw_dir = args.raw_dir or args.output.parent / (args.output.stem + '-pages')
    raw_dir.mkdir(parents=True, exist_ok=True)
    source = 'https://arxiv.org/list/math/' + ('new' if args.population == 'today' else 'recent')
    initial_url = canonical_url(source + '?skip=0&show=2000', args.population)
    observed = []
    replay = {}
    if args.replay_manifest:
        manifest = json.loads(args.replay_manifest.read_text(encoding='utf-8'))
        for record in manifest if isinstance(manifest, list) else manifest['pages']:
            replay[canonical_url(record['url'], args.population)] = record
    opener = build_opener(SourceRedirects(args.population))
    last_request = 0.0

    def fetch(url, options=None):
        nonlocal last_request
        url = canonical_url(url, args.population)
        error = None
        if args.replay_manifest:
            record = replay.get(url)
            if record is None:
                raise ValueError('The replay manifest does not contain ' + url)
            path = Path(record.get('path') or record['file'])
            if not path.is_absolute():
                path = args.replay_manifest.parent / path
            data = path.read_bytes()
            if path.suffix == '.gz':
                data = gzip.decompress(data)
            status, final_url = record.get('status', 200), record.get('finalUrl', url)
            fetched_at = record.get('retrievedAt')
        else:
            delay = args.delay - (time.monotonic() - last_request)
            if delay > 0:
                time.sleep(delay)
            fetched_at = timestamp()
            last_request = time.monotonic()
            try:
                request = Request(url, headers={'User-Agent': 'arXiv-Discovery/1.3 (https://github.com/sodium-qed/arXiv-scroller)'})
                with opener.open(request, timeout=args.timeout) as response:
                    data = response.read(MAX_BYTES + 1)
                    status, final_url = response.status, response.url
            except HTTPError as exc:
                data, status, final_url = exc.read(MAX_BYTES + 1), exc.code, exc.url
                error = str(exc)
            except (URLError, TimeoutError, OSError) as exc:
                data, status, final_url = b'', 0, url
                error = str(exc)
        final_url = canonical_url(final_url, args.population)
        if len(data) > MAX_BYTES:
            raise ValueError('Source response exceeded the 32 MiB limit.')
        name = f'{len(observed) + 1:03d}.html.gz'
        (raw_dir / name).write_bytes(gzip.compress(data, mtime=0))
        metadata = {'url': url, 'finalUrl': final_url, 'status': status, 'retrievedAt': fetched_at,
                    'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                    'file': os.path.relpath(raw_dir / name, args.output.parent)}
        if error:
            metadata['error'] = error
        observed.append(metadata)
        return {'status': status, 'finalUrl': final_url, 'text': data.decode('utf-8', errors='replace')}

    started = timestamp()
    first = fetch(initial_url)
    if first['status'] != 200:
        result = {'population': args.population, 'complete': False, 'papers': [], 'baseUrl': source,
                  'warnings': ['Initial arXiv request failed with HTTP ' + str(first['status']) + '.']}
    else:
        with sync_playwright() as playwright:
            bundled = Path(playwright.chromium.executable_path)
            executable = os.getenv('CHROMIUM_BIN') or (str(bundled) if bundled.is_file() else None)
            executable = executable or shutil.which('chromium') or shutil.which('google-chrome')
            browser = playwright.chromium.launch(executable_path=executable, args=['--no-sandbox'])
            page = browser.new_page()

            def route(request):
                relative = request.request.url.removeprefix('https://arxiv.org/__discovery_modules/')
                if relative in ('parser.js', 'categories.js', 'network.js'):
                    request.fulfill(content_type='application/javascript', body=(ROOT / 'src' / relative).read_bytes())
                elif request.request.url == 'https://arxiv.org/__discovery_measure__':
                    request.fulfill(content_type='text/html', body='<!doctype html><html lang="en"></html>')
                else:
                    request.abort()

            page.route('**/*', route)
            page.expose_function('retrievePopulationPage', fetch)
            page.goto('https://arxiv.org/__discovery_measure__')
            result = page.evaluate('''async ({first,url,maxPages}) => {
              const parser=await import('/__discovery_modules/parser.js');
              const network=await import('/__discovery_modules/network.js');
              const parseDocument=html=>{const node=document.createElement('template');node.innerHTML=html;return node.content;};
              const initial=parser.parseListing(parseDocument(first.text),url);
              const result=await network.loadCompleteListing(initial,{maxPages,parseDocument,
                request:(url,options)=>window.retrievePopulationPage(url,options)});
              return result.complete ? network.validatePopulationSnapshot(result) : result;
            }''', {'first': first, 'url': initial_url, 'maxPages': args.max_pages})
            browser.close()
    observed_times = [record['retrievedAt'] for record in observed if record.get('retrievedAt')]
    result.update({'sourcePages': observed, 'retrievalMode': 'replay' if args.replay_manifest else 'live',
                   'retrievedAt': max(observed_times) if observed_times else None,
                   'fetchedAt': max(observed_times) if observed_times else None,
                   'frozenAt': min(observed_times) if observed_times else None,
                   'parsedAt': timestamp(), 'runStartedAt': started,
                   'parser': 'production src/parser.js + src/network.js in Chromium'})
    if result['complete']:
        identity = json.dumps({'source': source, 'dates': result['announcementDates'],
                               'ids': sorted(paper['id'] for paper in result['papers'])}, sort_keys=True).encode()
        result['populationId'] = hashlib.sha256(identity).hexdigest()
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest = args.output.with_name(args.output.stem + '-manifest.json')
    manifest.write_text(json.dumps({'pages': observed}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'population': args.population, 'complete': result['complete'],
                      'papers': len(result['papers']), 'advertisedTotal': result.get('advertisedTotal'),
                      'pages': len(observed), 'output': str(args.output), 'warnings': result['warnings']}))
    return 0 if result['complete'] else 2


if __name__ == '__main__':
    sys.exit(main())
