import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, devices } from 'playwright';
import { jumpAndSteer, openGame, playerPosition, tap } from './touch-loop.mjs';

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
            await openGame(page, url);
            await tap(page, '#startButton');
            await page.locator('#instructions').waitFor({ state: 'hidden', timeout: 1500 });
            await page.locator('#controls').waitFor({ timeout: 1500 });

            // Hold each direction with a second finger on Jump, as a player would.
            const cdp = await context.newCDPSession(page);
            await jumpAndSteer(page, cdp, 'left');
            await jumpAndSteer(page, cdp, 'right');

            const standing = await playerPosition(page);
            await tap(page, '#jumpButton');
            await page.waitForFunction(y => parseFloat(document.getElementById('player').style.top) < y - 10,
                standing.y, { timeout: 1500 });
            await tap(page, '#tossButton');
            await page.locator('.projectile').first().waitFor({ timeout: 1500 });
        } finally {
            await context.close();
        }
    });
}
