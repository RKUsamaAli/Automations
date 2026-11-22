'use strict';
/** Address bar: addresses open directly, words become a search; suggestions are cached and never slow. */
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const search = require('../src/services/search');
const settings = require('../src/services/settings');

test('classify: address or search words, like a browser address bar', () => {
    const url = (x) => assert.equal(search.classify(x).type, 'url', x);
    const words = (x) => assert.equal(search.classify(x).type, 'search', x);
    ['example.com', 'www.example.co.uk/path?q=1', 'https://example.com', 'http://a.b', '203.0.113.5', '203.0.113.5:8080/x', 'localhost:3000', 'sub.domain.io:443'].forEach(url);
    ['best pizza near me', 'weather', 'what is 2+2', 'node.js tutorial for beginners', 'C# vs Java'].forEach(words);
    ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd'].forEach(url); // rejected later as addresses
    assert.equal(search.classify('  ').type, 'empty');
});

test('search engines: Google by default, others and custom templates', () => {
    settings.update({ search_engine: 'google' });
    assert.equal(search.classify('best pizza').url, 'https://www.google.com/search?q=best%20pizza');
    settings.update({ search_engine: 'duckduckgo' });
    assert.equal(search.searchUrl('a&b'), 'https://duckduckgo.com/?q=a%26b');
    settings.update({ search_engine: 'custom', search_url_custom: 'https://search.example/find?term={q}' });
    assert.equal(search.searchUrl('x y'), 'https://search.example/find?term=x%20y');
    settings.update({ search_engine: 'custom', search_url_custom: 'no placeholder' });
    assert.equal(search.engine().name, 'Google', 'invalid custom template falls back to Google');
    assert.throws(() => settings.update({ search_engine: 'yahoo' }), /search_engine/);
    settings.update({ search_engine: 'google', search_url_custom: '' });
});

test('suggestions: OpenSearch JSON, cached, empty on failure or timeout', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        const q = new URL(req.url, 'http://x').searchParams.get('q');
        if (q === 'slow') return setTimeout(() => res.end('[]'), 3000);
        if (q === 'broken') return res.end('not json');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([q, [`${q} recipes`, `${q} near me`, `${q} delivery`]]));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    settings.update({ search_engine: 'custom', search_url_custom: 'http://127.0.0.1:1/?q={q}', search_suggest_url_custom: `http://127.0.0.1:${port}/s?q={q}`, search_suggestions: true });
    try {
        assert.deepEqual(await search.suggestions('pizza'), ['pizza recipes', 'pizza near me', 'pizza delivery']);
        await search.suggestions('PIZZA');
        assert.equal(hits, 1, 'cached (case-insensitive)');
        assert.deepEqual(await search.suggestions('broken'), []);
        const t = Date.now();
        assert.deepEqual(await search.suggestions('slow'), []);
        assert.ok(Date.now() - t < 2500, 'gives up quickly');
        assert.deepEqual(await search.suggestions('a'), [], 'too short');
        settings.update({ search_suggestions: false });
        assert.deepEqual(await search.suggestions('pasta'), [], 'switched off');
    } finally {
        server.close();
        settings.update({ search_engine: 'google', search_url_custom: '', search_suggest_url_custom: '', search_suggestions: true });
    }
});
