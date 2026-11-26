import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { openGame, phoneViewports, tap } from './touch-loop.mjs';

// Every test here breaks one outside dependency and checks that a player can
// still start a run, move, and toss.

let browser;
let server;
let url;
let html;

before(async () => {
    html = await readFile(new URL('../index.html', import.meta.url));
    server = createServer((req, res) => {
        // Serve only the page. Icons and the manifest are missing, as they
        // would be in a broken deploy or on a stale CDN edge.
        if (req.url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('missing');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

async function playablePage({ initScript, routes = [], touch = true } = {}) {
    const context = await browser.newContext(touch
        ? { viewport: phoneViewports[1], hasTouch: true, isMobile: true }
        : { viewport: { width: 1000, height: 700 } });
    for (const [pattern, handler] of routes) await context.route(pattern, handler);
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    return { context, page, pageErrors };
}

async function startMoveAndToss(page, { touch = true } = {}) {
    await openGame(page, url);
    if (touch) await tap(page, '#startButton');
    else await page.locator('#startButton').click();
    await page.locator('#controls').waitFor({ state: 'visible', timeout: 5000 });

    // Move: jump and steer right in the air.
    const start = await page.evaluate(() => ({ x: playerX, y: playerY }));
    await page.keyboard.down('ArrowRight');
    if (touch) await tap(page, '#jumpButton');
    else await page.keyboard.press('ArrowUp');
    await page.waitForFunction(({ x, y }) => playerY < y && playerX > x, start, { timeout: 5000 });
    await page.keyboard.up('ArrowRight');

    if (touch) await tap(page, '#tossButton');
    else await page.keyboard.press('t');
    await page.locator('.projectile').first().waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => gameStarted), true);
}

test('The game plays when Web Audio exists but cannot be created', async () => {
    const { context, page, pageErrors } = await playablePage({
        initScript: () => {
            window.audioConstructions = 0;
            class BlockedAudioContext {
                constructor() {
                    window.audioConstructions++;
                    throw new DOMException('Audio hardware is unavailable', 'NotSupportedError');
                }
            }
            window.AudioContext = BlockedAudioContext;
            window.webkitAudioContext = BlockedAudioContext;
        },
    });
    try {
        await startMoveAndToss(page);
        await tap(page, '#jumpButton');

        const music = page.getByRole('button', { name: 'Music', exact: true });
        await tap(page, '#musicToggle');
        assert.equal(await music.getAttribute('aria-pressed'), 'false');
        await tap(page, '#musicToggle');
        assert.equal(await music.getAttribute('aria-pressed'), 'true');

        assert.equal(await page.evaluate(() => typeof audioContext), 'undefined');
        assert.equal(await page.evaluate(() => window.audioConstructions), 1,
            'A failed audio setup should not be retried on every tap');
        assert.deepEqual(pageErrors, [], 'Audio setup failures must not cause uncaught errors');
    } finally {
        await context.close();
    }
});

test('The game plays when the browser never lets audio resume', async () => {
    const { context, page, pageErrors } = await playablePage({
        initScript: () => {
            window.resumeAttempts = 0;
            Object.defineProperty(BaseAudioContext.prototype, 'state', {
                configurable: true,
                get: () => 'suspended',
            });
            AudioContext.prototype.resume = function () {
                window.resumeAttempts++;
                return Promise.reject(new DOMException('Autoplay is blocked', 'NotAllowedError'));
            };
        },
    });
    try {
        await startMoveAndToss(page);
        await tap(page, '#jumpButton');
        assert.ok(await page.evaluate(() => window.resumeAttempts) >= 1);
        assert.equal(await page.evaluate(() => audioContext.state), 'suspended');
        assert.deepEqual(pageErrors, [], 'A rejected audio resume must not cause uncaught errors');
    } finally {
        await context.close();
    }
});

test('The default game never requests analytics, even while fonts hang and icons are missing', async () => {
    const { promise: released, resolve: release } = Promise.withResolvers();
    const hung = new Set();
    const hang = async route => {
        hung.add(new URL(route.request().url()).pathname);
        await released;
        await route.abort('timedout').catch(() => {});
    };
    const { context, page, pageErrors } = await playablePage({
        touch: false,
        // Playwright tries the most recently added route first.
        routes: [
            [/^https:/, route => route.abort('internetdisconnected')],
            ['https://fonts.googleapis.com/**', hang],
        ],
    });
    const analyticsRequests = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/_vercel/insights/script.js') {
            analyticsRequests.push(request.url());
        }
    });
    try {
        await startMoveAndToss(page, { touch: false });
        await page.evaluate(() => endGame());
        await page.getByRole('heading', { name: 'Game Over!' }).waitFor();

        assert.deepEqual(analyticsRequests, [], 'The default game must not request the analytics script');
        assert.ok(hung.has('/css2'), 'The font stylesheet should still be pending');
        for (const asset of ['assets/favicon-32.png', 'assets/apple-touch-icon.png', 'manifest.webmanifest']) {
            assert.equal((await fetch(new URL(asset, url))).status, 404, `${asset} should be missing`);
        }
        assert.equal(await page.evaluate(() => window.vaq), undefined, 'Disabled analytics must not queue events');
        assert.deepEqual(pageErrors, [], 'Missing assets must not cause uncaught errors');
    } finally {
        release();
        await context.close();
    }
});
