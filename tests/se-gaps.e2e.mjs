import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { advanceFrames, openGame, tap, useFixedGameFrames } from './touch-loop.mjs';

// iPhone SE sizes, including the shorter ones left over when browser bars are showing.
// BROWSER=webkit runs the same checks in the Safari engine.
const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
const portrait = [{ width: 320, height: 568 }, { width: 320, height: 460 }, { width: 375, height: 667 }];
const landscape = [{ width: 568, height: 320 }, { width: 568, height: 260 }, { width: 667, height: 375 }];

let browser;
let server;
let url;

before(async () => {
    const html = await readFile(new URL('../index.html', import.meta.url));
    server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(html));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
    browser = await engine.launch({ executablePath: process.env.BROWSER_PATH || undefined });
});

after(async () => {
    await browser?.close();
    server?.close();
});

async function startRun(t, viewport) {
    const context = await browser.newContext({ viewport, screen: viewport, hasTouch: true, isMobile: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    await useFixedGameFrames(page);
    await openGame(page, url);
    await tap(page, '#startButton');
    await page.locator('#controls').waitFor();
    // Only the objects each test creates should be on the field.
    await page.evaluate(() => {
        obstacleElapsed = -Infinity;
        targetElapsed = -Infinity;
        powerUpSpawnTimer = -Infinity;
    });
    return page;
}

// Sample the whole random range, including the rare high target branch.
function passTargets(page) {
    return page.evaluate(() => {
        const random = Math.random;
        let scored = 0;
        for (const branch of [0.1, 0.5]) {
            for (const height of [0, 0.25, 0.5, 0.75, 0.999]) {
                const values = [branch, height];
                Math.random = () => values.shift() ?? 0.5;
                generateTarget();
                Math.random = random;
                targets.at(-1).x = playerX + 25;
                const before = score;
                window.stepTouchLoop();
                if (score > before) scored++;
                targets.forEach(target => target.element.remove());
                targets = [];
            }
        }
        return scored;
    });
}

for (const viewport of [...portrait, ...landscape]) {
    const size = `${viewport.width}x${viewport.height}`;

    test(`${size}: a runner who does nothing scores no targets`, async t => {
        const page = await startRun(t, viewport);
        assert.equal(await passTargets(page), 0, 'Targets reached the standing runner');
    });

    // Taller screens need a jump to reach targets. Short ones must still reward a Toss from the ground.
    if (viewport.height <= 460) test(`${size}: a tapped Toss still hits a target`, async t => {
        const page = await startRun(t, viewport);
        for (const height of [0, 0.999]) {
            await page.evaluate(height => {
                const random = Math.random;
                const values = [0.5, height];
                Math.random = () => values.shift() ?? 0.5;
                generateTarget();
                Math.random = random;
                targets.at(-1).x = playerX + 20;
                score = 0;
                tossCooldown = 0;
            }, height);
            await tap(page, '#tossButton');
            await advanceFrames(page, 40);
            assert.ok(await page.evaluate(() => score > 0 && !targets.length), `Toss missed at ${size}`);
        }
    });
}

for (const [from, to] of [[landscape[0], portrait[0]], [landscape[2], portrait[2]], [portrait[0], landscape[0]]]) {
    test(`Rotating ${from.width}x${from.height} to ${to.width}x${to.height} keeps the runner centred and the gap ahead`, async t => {
        const page = await startRun(t, from);
        await page.evaluate(() => {
            generateObstacle();
            obstacles[0].x = playerX + 120;
        });
        await page.setViewportSize(to);
        await page.waitForFunction(({ width, height }) => fieldWidth === width && fieldHeight === height, to);
        const state = await page.evaluate(() => ({
            playerX,
            gap: obstacles[0].x - playerX,
            drawn: parseFloat(obstacles[0].element.style.left) - parseFloat(document.getElementById('player').style.left),
        }));
        assert.ok(Math.abs(state.playerX - to.width / 2) < 1, `Runner moved to x=${state.playerX} of ${to.width}`);
        assert.ok(Math.abs(state.gap - 120) < 1 && Math.abs(state.drawn - 120) < 1,
            `Obstacle gap changed: ${JSON.stringify(state)}`);

        // A new obstacle must enter with room to react.
        const frames = await page.evaluate(() => {
            obstacles.forEach(obstacle => obstacle.element.remove());
            obstacles = [];
            generateObstacle();
            let count = 0;
            while (!gameOver && count < 300) {
                window.stepTouchLoop();
                count++;
            }
            return count;
        });
        assert.ok(frames >= 24, `A new obstacle hit ${frames} frames after rotation`);
    });
}
