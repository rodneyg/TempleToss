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

test('The first tap starts audio and saved music and effects settings stay separate', async () => {
    const context = await browser.newContext({ viewport: phoneViewports[0], hasTouch: true, isMobile: true });
    try {
        const page = await context.newPage();
        await page.addInitScript(() => {
            window.tonesPlayed = 0;
            const start = OscillatorNode.prototype.start;
            OscillatorNode.prototype.start = function (...args) {
                window.tonesPlayed++;
                return start.apply(this, args);
            };
        });
        await openGame(page, url);
        assert.equal(await page.evaluate(() => typeof audioContext), 'undefined');
        await tap(page, '#startButton');
        await page.waitForFunction(() => audioContext.state === 'running' && musicLoop.loop);
        assert.ok(await page.evaluate(() => musicLoop.buffer.getChannelData(0).some(sample => sample !== 0)));

        await tap(page, '#musicToggle');
        assert.equal(await page.evaluate(() => musicGain.gain.value), 0);
        await tap(page, '#jumpButton');
        assert.equal(await page.evaluate(() => window.tonesPlayed), 1);

        await tap(page, '#sfxToggle');
        await tap(page, '#tossButton');
        await page.locator('.projectile').first().waitFor();
        assert.equal(await page.evaluate(() => window.tonesPlayed), 1);

        await openGame(page, url);
        await tap(page, '#startButton');
        await page.waitForFunction(() => audioContext.state === 'running');
        assert.equal(await page.evaluate(() => typeof musicLoop), 'undefined');
        await tap(page, '#jumpButton');
        assert.equal(await page.evaluate(() => window.tonesPlayed), 0);
    } finally {
        await context.close();
    }
});

test('Hiding a running game clears held input and freezes frames, cooldowns and spawns', async () => {
    const context = await browser.newContext({ viewport: phoneViewports[0], hasTouch: true, isMobile: true });
    try {
        const page = await context.newPage();
        await page.clock.install();
        const setHidden = hidden => page.evaluate(hidden => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
            document.dispatchEvent(new Event('visibilitychange'));
        }, hidden);

        await openGame(page, url);
        await tap(page, '#startButton');
        await page.waitForFunction(() => audioContext.state === 'running');
        await page.keyboard.down('ArrowRight');
        await page.keyboard.down('Space');
        await tap(page, '#tossButton');
        await page.clock.runFor(150);
        await setHidden(true);
        await page.waitForFunction(() => audioContext.state === 'suspended');
        const before = await page.evaluate(() => ({
            x: playerX, y: playerY, cooldown: tossCooldown, elapsed: obstacleElapsed,
        }));
        assert.ok(before.cooldown > 0);
        await page.clock.runFor(5500);
        assert.deepEqual(await page.evaluate(() => ({
            x: playerX, y: playerY, cooldown: tossCooldown, elapsed: obstacleElapsed,
        })), before);
        assert.equal(await page.evaluate(() => animationFrame), null);
        assert.equal(await page.evaluate(() => held.jump.size + held.right.size), 0);

        await setHidden(false);
        await page.waitForFunction(() => audioContext.state === 'running');
        await page.clock.runFor(650);
        assert.notDeepEqual(await playerPosition(page), { x: before.x, y: before.y });
        assert.equal(await page.evaluate(() => tossCooldown), 0);
        assert.equal(await page.locator('.obstacle, .target, .powerUp').count(), 0);
        await page.clock.runFor(2100);
        assert.ok(await page.locator('.obstacle').count());
        await page.keyboard.up('Space');
        await page.keyboard.up('ArrowRight');
    } finally {
        await context.close();
    }
});
