import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { openGame, useFixedGameFrames } from './touch-loop.mjs';

let browser;
let server;
let url;

before(async () => {
    const html = await readFile(new URL('../index.html', import.meta.url));
    server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(html));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

for (const [label, viewport] of [['desktop', { width: 1200, height: 800 }], ['phone', { width: 320, height: 568 }]]) {
    test(`${label}: near miss stays alive and visible touch ends the run`, async t => {
        const context = await browser.newContext({ viewport, hasTouch: label === 'phone', isMobile: label === 'phone' });
        t.after(() => context.close());
        const page = await context.newPage();
        await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
        await useFixedGameFrames(page);
        await openGame(page, url);
        await page.locator('#startButton').click();
        await page.locator('#controls').waitFor();

        const geometry = await page.evaluate(() => {
            obstacleElapsed = -Infinity;
            const art = document.querySelector('.obstacle') || (() => { generateObstacle(); return obstacles.at(-1).element; })();
            const obstacle = obstacles.at(-1);
            const artWidth = parseFloat(getComputedStyle(art).width);
            const playerBox = document.getElementById('player').getBoundingClientRect();
            // Leave a 5 px visible gap between player and obstacle.
            obstacle.x = playerX + 20 + 5;
            return { artWidth, playerWidth: playerBox.width, obstacleX: obstacle.x, playerX };
        });
        await page.evaluate(() => window.stepTouchLoop());
        await page.screenshot({ path: new URL(`../evidence/${label}-near-miss.png`, import.meta.url).pathname });
        assert.equal(await page.locator('#gameOver').isVisible(), false,
            `${label} ended with a visible gap; geometry=${JSON.stringify(geometry)}`);

        await page.evaluate(() => {
            obstacles.at(-1).x = playerX + 10;
            window.stepTouchLoop();
        });
        await page.locator('#gameOver').waitFor();
        await page.screenshot({ path: new URL(`../evidence/${label}-touch.png`, import.meta.url).pathname });
        assert.equal(await page.locator('#gameOver').isVisible(), true);
    });
}
