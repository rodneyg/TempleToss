import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, devices } from 'playwright';
import { advanceFrames, jumpAndSteer, openGame, playerPosition, tap, useFixedGameFrames } from './touch-loop.mjs';

const compactScreen = { width: 320, height: 568 };
const phones = {
    'iPhone SE (320x568)': { ...devices['iPhone SE'], viewport: compactScreen, screen: compactScreen },
    'Pixel 7': devices['Pixel 7'],
};

let server;
let browser;
let url;

before(async () => {
    const html = await readFile(new URL('../index.html', import.meta.url));
    server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
});

after(async () => {
    try {
        await browser?.close();
    } finally {
        server?.close();
    }
});

for (const [phone, device] of Object.entries(phones)) {
    test(`${phone} touch controls start, jump, toss and steer both ways`, { timeout: 15_000 }, async () => {
        const context = await browser.newContext({ ...device, hasTouch: true });
        try {
            const page = await context.newPage();
            // Keep the test independent of the game's remote fonts and sounds.
            await page.route('**/*', route => {
                return new URL(route.request().url()).origin === url ? route.continue() : route.abort();
            });
            await useFixedGameFrames(page);
            await openGame(page, url);
            await tap(page, '#startButton');
            await page.locator('#instructions').waitFor({ state: 'hidden', timeout: 1500 });
            await page.locator('#controls').waitFor({ timeout: 1500 });

            // Keep obstacles out of the control exercise while stepping frames.
            await page.evaluate(() => { obstacleElapsed = -Infinity; });

            // Hold each direction with a second finger on Jump, as a player would.
            const cdp = await context.newCDPSession(page);
            await jumpAndSteer(page, cdp, 'left');
            await jumpAndSteer(page, cdp, 'right');

            const standing = await playerPosition(page);
            await tap(page, '#jumpButton');
            await advanceFrames(page, 3);
            await page.waitForFunction(y => parseFloat(document.getElementById('player').style.top) < y - 10,
                standing.y, { timeout: 1500 });
            await tap(page, '#tossButton');
            await page.locator('.projectile').first().waitFor({ timeout: 1500 });
        } finally {
            await context.close();
        }
    });
}

test('Sound buttons stay tappable over the menu and results on small screens', async t => {
    for (const viewport of [compactScreen, { width: 375, height: 667 }, { width: 568, height: 320 }]) {
        const context = await browser.newContext({ ...phones['iPhone SE (320x568)'], viewport, screen: viewport });
        t.after(() => context.close());
        await context.addInitScript(() => localStorage.setItem('leaderboard', JSON.stringify(
            [50, 40, 30, 20, 10].map(score => ({ name: 'W'.repeat(24), score })))));
        const page = await context.newPage();
        await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
        await openGame(page, url);
        const toggleBoth = async screen => {
            for (const toggle of ['#musicToggle', '#sfxToggle']) {
                const button = page.locator(toggle);
                const before = await button.getAttribute('aria-pressed');
                await tap(page, toggle);
                assert.notEqual(await button.getAttribute('aria-pressed'), before,
                    `${toggle} is covered on the ${screen} at ${viewport.width}x${viewport.height}`);
            }
        };
        await toggleBoth('menu');
        await tap(page, '#startButton');
        await page.evaluate(() => endGame());
        await toggleBoth('results screen');
    }
});

test('Compact touch play shows a milestone without covering controls and clears it on replay', async t => {
    const context = await browser.newContext({
        ...phones['iPhone SE (320x568)'], reducedMotion: 'reduce',
    });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    await useFixedGameFrames(page);
    await openGame(page, url);
    await tap(page, '#startButton');
    await page.evaluate(() => {
        obstacleElapsed = -Infinity;
        targetElapsed = -Infinity;
    });
    for (let hit = 0; hit < 3; hit++) {
        await page.evaluate(() => {
            generateTarget();
            Object.assign(targets[0], { x: playerX + 20, y: playerY - 100 });
        });
        await tap(page, '#tossButton');
        await advanceFrames(page, 32);
    }

    assert.equal(await page.locator('#streakDisplay').textContent(), 'Streak: 3 · Best: 3');
    assert.equal(await page.locator('#streakFeedback').textContent(), 'Wide Target');
    assert.match(await page.locator('#streakPowers').textContent(), /Wide Target · \ds/);
    assert.equal(await page.locator('.particle').count(), 0, 'Reduced motion skips the milestone burst');

    for (const viewport of [compactScreen, { width: 568, height: 320 }]) {
        await page.setViewportSize(viewport);
        const hud = await page.locator('#streakHud').boundingBox();
        const controls = await page.locator('#controls').boundingBox();
        const music = await page.locator('#musicToggle').boundingBox();
        assert.ok(hud.x >= 0 && hud.x + hud.width <= music.x && hud.y + hud.height < controls.y);
    }

    await page.evaluate(() => endGame());
    await tap(page, '#restartButton');
    assert.equal(await page.locator('#streakDisplay').textContent(), 'Streak: 0 · Best: 0');
    assert.equal(await page.locator('#streakPowers').textContent(), '');
});
