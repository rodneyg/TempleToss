import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { centerOf, openGame, phoneViewports, playerPosition, runTouchLoop, tap } from './touch-loop.mjs';

let browser;
let server;
let url;

before(async () => {
    const html = await readFile(new URL('../index.html', import.meta.url));
    server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(html));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

test('The game starts and accepts a toss when external audio and stylesheets fail', async () => {
    const context = await browser.newContext();
    try {
        const gameOrigin = new URL(url).origin;
        const isExternal = requestUrl => new URL(requestUrl).origin !== gameOrigin;
        await context.route(isExternal, route => route.abort('failed'));

        const page = await context.newPage();
        const failedAssets = new Set();
        const pageErrors = [];
        page.on('requestfailed', request => {
            if (isExternal(request.url())) failedAssets.add(request.resourceType());
        });
        page.on('pageerror', error => pageErrors.push(error));

        await openGame(page, url);
        await page.locator('#startButton').click();
        await page.locator('#controls').waitFor({ timeout: 5000 });
        await page.locator('#tossButton').click();
        await page.locator('.projectile').first().waitFor({ timeout: 5000 });

        assert.ok(failedAssets.has('media'), 'Expected an external audio request to fail');
        assert.ok(failedAssets.has('stylesheet'), 'Expected an external stylesheet request to fail');
        assert.deepEqual(pageErrors, [], 'Asset failures must not cause uncaught errors');
    } finally {
        await context.close();
    }
});

for (const viewport of phoneViewports) {
    test(`Touch can play and return to the menu at ${viewport.width}x${viewport.height}`, async () => {
        await runTouchLoop(browser, url, viewport);
    });
}

test('Rotating a phone keeps the player on the ground and all four controls reachable', async () => {
    const context = await browser.newContext({ viewport: phoneViewports[0], hasTouch: true, isMobile: true });
    try {
        const page = await context.newPage();
        await openGame(page, url);
        await tap(page, '#startButton');
        await page.setViewportSize(phoneViewports[2]);
        await page.waitForFunction(() => {
            const game = document.getElementById('gameContainer');
            return parseFloat(document.getElementById('player').style.top) === game.clientHeight - 180;
        });
        const jump = await centerOf(page, '#jumpButton');
        const toss = await centerOf(page, '#tossButton');
        const left = await centerOf(page, '#leftButton');
        const right = await centerOf(page, '#rightButton');
        const { width } = page.viewportSize();
        assert.ok(right.x - left.x <= 78 && right.x < width / 2);
        assert.ok(toss.x - jump.x <= 78 && jump.x > width / 2);
        const start = await playerPosition(page);
        await tap(page, '#jumpButton');
        await page.waitForFunction(y => parseFloat(document.getElementById('player').style.top) < y - 10, start.y);
    } finally {
        await context.close();
    }
});

test('Desktop supports keyboard menus, jump, air control, toss and existing mouse buttons', async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    try {
        const page = await context.newPage();
        await openGame(page, url);
        await page.locator('#startButton').focus();
        await page.keyboard.press('Enter');
        const start = await playerPosition(page);

        await page.keyboard.down('ArrowLeft');
        await page.keyboard.down('Space');
        await page.waitForFunction(({ x, y }) => {
            const { left, top } = document.getElementById('player').style;
            return parseFloat(left) < x - 5 && parseFloat(top) < y - 25;
        }, start);
        await page.keyboard.up('Space');
        await page.keyboard.up('ArrowLeft');
        await page.keyboard.press('t');
        await page.locator('.projectile').first().waitFor();
        await page.waitForFunction(y => parseFloat(document.getElementById('player').style.top) === y, start.y);
        await page.locator('#jumpButton').click();
        await page.waitForFunction(y => parseFloat(document.getElementById('player').style.top) < y - 10, start.y);
        await page.locator('.projectile').first().waitFor({ state: 'hidden' });
        await page.locator('#tossButton').click();
        await page.locator('.projectile').first().waitFor();

        await page.locator('#gameOver').waitFor({ timeout: 10000 });
        await page.locator('#mainMenuButton').focus();
        await page.keyboard.press('Enter');
        await page.locator('#startButton').waitFor();
        assert.deepEqual(await page.evaluate(() => [window.scrollX, window.scrollY]), [0, 0]);
    } finally {
        await context.close();
    }
});
