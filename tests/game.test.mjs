import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, devices } from 'playwright';
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

// Chromium device presets do not set CSS safe-area insets on their own.
const iphonePortrait = { top: 59, right: 0, bottom: 34, left: 0 };
const iphoneLandscape = { top: 0, right: 59, bottom: 21, left: 59 };
const pixelLandscape = { top: 0, right: 0, bottom: 0, left: 0 };

async function prepareSafeArea(page, insets) {
    await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    await page.addInitScript(() => {
        localStorage.setItem('leaderboard', JSON.stringify([{ name: 'Sample', score: 10 }]));
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    return cdp;
}

async function verifySafeLayout(page, { top, right, bottom, left }) {
    const { width, height } = page.viewportSize();
    const expectedInsets = [top, right, bottom, left];
    const actualInsets = await page.evaluate(() => {
        const probe = document.createElement('div');
        const edges = ['top', 'right', 'bottom', 'left'];
        edges.forEach(edge => probe.style.setProperty(`padding-${edge}`, `env(safe-area-inset-${edge})`));
        document.body.appendChild(probe);
        const insets = edges.map(edge => parseFloat(getComputedStyle(probe).getPropertyValue(`padding-${edge}`)));
        probe.remove();
        return insets;
    });
    assert.deepEqual(actualInsets, expectedInsets);

    for (const id of ['scoreDisplay', 'leaderboardDisplay', 'musicToggle', 'sfxToggle',
        'leftButton', 'rightButton', 'jumpButton', 'tossButton']) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box && box.x >= left && box.y >= top &&
            box.x + box.width <= width - right && box.y + box.height <= height - bottom,
        `#${id} crosses the safe area: ${JSON.stringify(box)}`);
    }

    const score = await page.locator('#scoreDisplay').boundingBox();
    const leaderboard = await page.locator('#leaderboardDisplay').boundingBox();
    assert.ok(score.y + score.height <= leaderboard.y, 'The score overlaps the leaderboard');
    const moveLeft = await centerOf(page, '#leftButton');
    const moveRight = await centerOf(page, '#rightButton');
    const jump = await centerOf(page, '#jumpButton');
    const toss = await centerOf(page, '#tossButton');
    assert.ok(moveRight.x - moveLeft.x <= 78 && moveRight.x < width / 2);
    assert.ok(toss.x - jump.x <= 78 && jump.x > width / 2);
}

for (const [name, insets] of [
    ['iPhone 14 Pro', iphonePortrait],
    ['iPhone 14 Pro landscape', iphoneLandscape],
    ['Pixel 7 landscape', pixelLandscape],
]) {
    const device = devices[name];
    test(`${name} keeps the HUD and controls inside the safe area`, async () => {
        const context = await browser.newContext(device);
        try {
            const page = await context.newPage();
            await prepareSafeArea(page, insets);
            await openGame(page, url);
            await tap(page, '#startButton');
            await verifySafeLayout(page, insets);

            const start = await playerPosition(page);
            await tap(page, '#jumpButton');
            await page.waitForFunction(y => playerY < y - 10, start.y);
            await tap(page, '#tossButton');
            await page.locator('.projectile').first().waitFor({ timeout: 1500 });
        } finally {
            await context.close();
        }
    });
}

test('Rotating a notched phone during a run keeps the player and existing objects in view', async () => {
    const portrait = devices['iPhone 14 Pro'].viewport;
    const landscape = devices['iPhone 14 Pro landscape'].viewport;
    const context = await browser.newContext(devices['iPhone 14 Pro']);
    try {
        const page = await context.newPage();
        const cdp = await prepareSafeArea(page, iphonePortrait);
        await openGame(page, url);
        await tap(page, '#startButton');
        await page.evaluate(() => {
            const random = Math.random;
            Math.random = () => 0;
            generateTarget();
            spawnPowerUp();
            Math.random = random;
        });
        const initialPlayer = await playerPosition(page);
        await tap(page, '#jumpButton');
        await page.waitForFunction(y => playerY < y - 20, initialPlayer.y);

        await page.setViewportSize(landscape);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: iphoneLandscape });
        await page.waitForFunction(({ width, height }) => fieldWidth === width && fieldHeight === height, landscape);
        await verifySafeLayout(page, iphoneLandscape);

        const sky = await page.evaluate(() => {
            const existing = [targets.at(-1).y, powerUp.y];
            powerUp.element.remove();
            powerUp.exists = false;
            const random = Math.random;
            Math.random = () => 0;
            generateTarget();
            spawnPowerUp();
            Math.random = random;
            return {
                player: playerY,
                targets: [existing[0], targets.at(-1).y],
                orbs: [existing[1], powerUp.y],
                ground: fieldHeight - groundHeight,
            };
        });
        assert.ok(sky.player >= 0, 'The player jumped above the viewport');
        assert.ok(sky.targets.every(y => y >= 0 && y + 50 <= sky.ground), 'A target is clipped in landscape');
        assert.ok(sky.orbs.every(y => y >= 0 && y + 20 <= sky.ground), 'A power-up is clipped in landscape');
        await tap(page, '#tossButton');
        await page.locator('.projectile').first().waitFor({ timeout: 1500 });

        await page.setViewportSize(portrait);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: iphonePortrait });
        await page.waitForFunction(() => playerY === gameContainer.clientHeight - groundHeight - playerHeight);
        await verifySafeLayout(page, iphonePortrait);
        assert.ok(await page.locator('#controls').isVisible());
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
