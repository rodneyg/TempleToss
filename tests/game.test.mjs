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

async function openLeaderboardGame(t, entries = []) {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('**/*', route => {
        return route.request().url().startsWith(url) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.addInitScript(initialEntries => {
        if (localStorage.getItem('leaderboard') === null) {
            localStorage.setItem('leaderboard', JSON.stringify(initialEntries));
        }
    }, entries);
    await openGame(page, url);
    return page;
}

async function finishRun(page, finalScore, startButton = '#startButton') {
    await page.locator(startButton).click();
    // Set the final score directly so these tests do not depend on obstacle timing.
    await page.evaluate(value => {
        score = value;
        endGame();
    }, finalScore);
    await page.locator('#gameOver').waitFor();
}

async function assertLeaderboard(page, entries) {
    assert.deepEqual(
        await page.evaluate(() => JSON.parse(localStorage.getItem('leaderboard'))),
        entries
    );
    const lines = entries.map(({ name, score }, index) => `${index + 1}. ${name}: ${score}`);
    for (const display of ['#leaderboardDisplay', '#leaderboardDisplayGameOver']) {
        assert.deepEqual(await page.locator(`${display} p`).allTextContents(), ['Leaderboard:', ...lines]);
    }
}

test('Leaderboard uses Player for a whitespace-only name', async t => {
    const page = await openLeaderboardGame(t);
    await finishRun(page, 20);
    await page.getByRole('textbox', { name: 'Player name' }).fill('   ');
    await page.locator('#scoreForm button').click();
    await assertLeaderboard(page, [{ name: 'Player', score: 20 }]);
});

test('Leaderboard saves at most 24 characters from typed names', async t => {
    const page = await openLeaderboardGame(t);
    await finishRun(page, 20);
    const input = page.getByRole('textbox', { name: 'Player name' });
    await input.pressSequentially('abcdefghijklmnopqrstuvwxyz');
    assert.equal(await input.inputValue(), 'abcdefghijklmnopqrstuvwx');
    await page.locator('#scoreForm button').click();
    await assertLeaderboard(page, [{ name: 'abcdefghijklmnopqrstuvwx', score: 20 }]);
});

test('Leaderboard trims names, renders markup literally, and reuses the session name', async t => {
    const page = await openLeaderboardGame(t);
    await finishRun(page, 20);
    const name = '<b>Toss</b>';
    await page.getByRole('textbox', { name: 'Player name' }).fill(`  ${name}  `);
    await page.locator('#scoreForm button').click();
    await assertLeaderboard(page, [{ name, score: 20 }]);
    assert.equal(await page.locator('#leaderboardDisplay b, #leaderboardDisplayGameOver b').count(), 0);

    await finishRun(page, 30, '#restartButton');
    await page.locator('#scoreForm').waitFor({ state: 'hidden' });
    await assertLeaderboard(page, [{ name, score: 30 }, { name, score: 20 }]);
});

test('Leaderboard keeps the five highest scores and restores their order after reload', async t => {
    const entries = [
        { name: 'Avery', score: 90 },
        { name: 'Dana', score: 70 },
        { name: 'Ellis', score: 50 },
        { name: 'Kai', score: 30 },
        { name: 'Sky', score: 10 },
    ];
    const page = await openLeaderboardGame(t, entries);
    await assertLeaderboard(page, entries);

    await finishRun(page, 60);
    await page.getByRole('textbox', { name: 'Player name' }).fill('Reese');
    await page.locator('#scoreForm button').click();
    const ranked = [entries[0], entries[1], { name: 'Reese', score: 60 }, entries[2], entries[3]];
    await assertLeaderboard(page, ranked);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#loadingScreen').waitFor({ state: 'hidden' });
    await assertLeaderboard(page, ranked);
});
