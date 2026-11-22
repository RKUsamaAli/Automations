'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword, sign, verify } = require('../src/lib/crypto');
const { matchesAny, matchesPattern, isValidPattern, hostOf } = require('../src/lib/domainMatch');
const { parseProxyLine, parseProxyList } = require('../src/lib/proxyString');
const RateLimiter = require('../src/lib/rateLimiter');
const { parseCookies, mintTicket, readTicket } = require('../src/lib/authTokens');

test('password hashing round trip', () => {
    const h = hashPassword('correct horse');
    assert.ok(verifyPassword('correct horse', h));
    assert.ok(!verifyPassword('wrong', h));
    assert.ok(!verifyPassword('x', 'garbage'));
});

test('signed tokens: purpose separation, tampering, expiry', () => {
    const secret = 's'.repeat(40);
    const t = sign({ uid: 1, exp: Date.now() + 1000 }, secret, 'login');
    assert.equal(verify(t, secret, 'login').uid, 1);
    assert.equal(verify(t, secret, 'proxy'), null, 'token for one purpose must not verify for another');
    assert.equal(verify(t.slice(0, -2) + 'aa', secret, 'login'), null);
    assert.equal(verify(sign({ uid: 1, exp: Date.now() - 1 }, secret, 'login'), secret, 'login'), null);
});

test('domain patterns', () => {
    assert.ok(matchesPattern('example.com', 'example.com'));
    assert.ok(!matchesPattern('www.example.com', 'example.com'));
    assert.ok(matchesPattern('www.example.com', '*.example.com'));
    assert.ok(matchesPattern('example.com', '*.example.com'));
    assert.ok(!matchesPattern('badexample.com', '*.example.com'));
    assert.ok(matchesAny('a.b.cdn.net', 'foo.com, *.cdn.net'));
    assert.ok(matchesAny('anything.org', '*'));
    assert.ok(isValidPattern('*.example.co.uk'));
    assert.ok(!isValidPattern('http://example.com'));
    assert.equal(hostOf('https://WWW.Example.com:8443/x'), 'www.example.com');
    assert.equal(hostOf('javascript:alert(1)'), null);
});

test('proxy line parsing', () => {
    assert.deepEqual(parseProxyLine('http://user:p%40ss@1.2.3.4:8080'), { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'p@ss' });
    assert.equal(parseProxyLine('socks5://u:p@5.6.7.8:1080').protocol, 'socks5');
    assert.deepEqual(parseProxyLine('9.9.9.9:3128:alice:se:cret'), { protocol: 'http', host: '9.9.9.9', port: 3128, username: 'alice', password: 'se:cret' });
    assert.equal(parseProxyLine('9.9.9.9:3128', 'socks5').protocol, 'socks5');
    assert.equal(parseProxyLine('# comment'), null);
    const { proxies, errors } = parseProxyList('1.1.1.1:80\nftp://x:1\n\nnot a proxy');
    assert.equal(proxies.length, 1);
    assert.equal(errors.length, 2);
});

test('rate limiter', () => {
    const rl = new RateLimiter(60000);
    assert.ok(rl.hit('k', 2));
    assert.ok(rl.hit('k', 2));
    assert.ok(!rl.hit('k', 2));
    assert.ok(rl.hit('other', 2));
    assert.ok(rl.hit('k', 0), '0 means unlimited');
});

test('cookies and tickets', () => {
    assert.deepEqual(parseCookies('a=1; b=hello%20world; a=2'), { a: '1', b: 'hello world' });
    const t = mintTicket({ uid: 7, v: 1, url: 'https://example.com/' });
    const p = readTicket(t);
    assert.equal(p.uid, 7);
    assert.equal(p.url, 'https://example.com/');
    assert.ok(p.n && p.n.length >= 12, 'ticket carries a nonce');
});
