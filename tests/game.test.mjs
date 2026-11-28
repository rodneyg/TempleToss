import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, devices } from 'playwright';
import { advanceFrames, centerOf, openGame, phoneViewports, playerPosition, runTouchLoop, tap, useFixedGameFrames } from './touch-loop.mjs';

let browser;
let server;
let url;

before(async () => {
    const html = await readFile(new URL('../index.html', import.meta.url));
    server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
    browser = await chromium.launch();
});

after(async () => {
    await browser?.close();
    server?.close();
});

test('The main landmark contains the loading screen and all game screens', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main', { name: 'Temple Toss' });
    assert.equal(await main.count(), 1);
    assert.equal(await main.locator('#loadingTitle').textContent(), 'Temple Toss');
    await page.locator('#loadingScreen').waitFor({ state: 'hidden' });

    await main.getByRole('button', { name: 'Start Game' }).click();
    await main.getByRole('button', { name: /^Toss/i }).waitFor();
    assert.match(await main.locator('#scoreDisplay').textContent(), /^Score: \d+$/);

    await page.evaluate(() => endGame());
    await main.getByRole('heading', { name: 'Game Over!' }).waitFor();
    await main.getByRole('textbox', { name: 'Player name' }).waitFor();
});

test('Decorative motion runs only during play and respects reduced motion', async t => {
    for (const reducedMotion of ['no-preference', 'reduce']) {
        const page = await browser.newPage({ reducedMotion });
        t.after(() => page.close());
        await openGame(page, url);

        const animationNames = () => page.evaluate(() => ['.cloud', '.star', '#groundPattern']
            .map(selector => getComputedStyle(document.querySelector(selector)).animationName));
        const still = ['none', 'none', 'none'];
        assert.deepEqual(await animationNames(), still, `menu, ${reducedMotion}`);

        await page.getByRole('button', { name: 'Start Game' }).click();
        const playing = reducedMotion === 'reduce' ? still : ['drift', 'twinkle', 'moveGround'];
        assert.deepEqual(await animationNames(), playing, `playing, ${reducedMotion}`);

        await page.evaluate(() => endGame());
        await page.getByRole('heading', { name: 'Game Over!' }).waitFor();
        assert.deepEqual(await animationNames(), still, `game over, ${reducedMotion}`);
    }
});

test('Opted-in analytics queues only anonymous run events when the script is blocked', async t => {
    const page = await browser.newPage({ viewport: phoneViewports[0], hasTouch: true, isMobile: true });
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        // Chromium reports the blocked request independently of application errors.
        if (message.text() === 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector'
            && message.location().url === new URL('/_vercel/insights/script.js', url).href) return;
        errors.push(message.text());
    });

    const scriptTag = '<script id="vercel-analytics" defer src="/_vercel/insights/script.js"></script>';
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const optIn = `<!-- ${scriptTag} -->`;
    assert.ok(html.includes(optIn), 'Expected the documented analytics opt-in');
    await page.route(url, route => route.fulfill({
        contentType: 'text/html',
        body: html.replace(optIn, scriptTag),
    }));

    let blockedRequests = 0;
    await page.route('**/_vercel/insights/script.js', route => {
        blockedRequests++;
        return route.abort('blockedbyclient');
    });
    await page.addInitScript(() => {
        sessionStorage.setItem('playerName', 'Private Player Name');
    });
    await openGame(page, url);
    assert.equal(blockedRequests, 1);

    await tap(page, '#startButton');
    await page.waitForFunction(() => audioContext.state === 'running' && musicLoop.loop);
    await tap(page, '#tossButton');
    await page.locator('.projectile').first().waitFor();
    await page.evaluate(() => {
        score = 15;
        endGame();
        endGame();
    });
    assert.equal(await page.locator('#finalScore').textContent(), 'Your score: 15');
    await page.locator('#leaderboardDisplayGameOver').getByText(/Private Player Name/).waitFor();

    await page.locator('#restartButton').press('Enter');
    await page.evaluate(() => endGame());

    assert.deepEqual(await page.evaluate(() => window.vaq), [
        ['event', { name: 'game_start', data: { input_mode: 'touch' } }],
        ['event', { name: 'game_over', data: { input_mode: 'touch' } }],
        ['event', { name: 'game_start', data: { input_mode: 'keyboard' } }],
        ['event', { name: 'game_over', data: { input_mode: 'keyboard' } }],
    ]);
    assert.deepEqual(errors, []);
});

test('The game starts and accepts a toss without Web Audio or external stylesheets', async () => {
    const context = await browser.newContext();
    try {
        const gameOrigin = new URL(url).origin;
        const isExternal = requestUrl => new URL(requestUrl).origin !== gameOrigin;
        await context.route(isExternal, route => route.abort('failed'));
        await context.addInitScript(() => {
            window.AudioContext = undefined;
            window.webkitAudioContext = undefined;
        });

        const page = await context.newPage();
        let stylesheetFailed = false;
        const pageErrors = [];
        page.on('requestfailed', request => {
            if (isExternal(request.url()) && request.resourceType() === 'stylesheet') {
                stylesheetFailed = true;
            }
        });
        page.on('pageerror', error => pageErrors.push(error));

        await openGame(page, url);
        await page.locator('#startButton').click();
        await page.locator('#controls').waitFor({ timeout: 5000 });
        await page.locator('#tossButton').click();
        await page.locator('.projectile').first().waitFor({ timeout: 5000 });

        assert.ok(stylesheetFailed, 'Expected an external stylesheet request to fail');
        assert.deepEqual(pageErrors, [], 'Asset failures must not cause uncaught errors');
    } finally {
        await context.close();
    }
});

test('Game over saves a new high score and shows it after a lower run on reload', async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    try {
        const page = await context.newPage();
        await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
        await openGame(page, url);
        await page.locator('#startButton').click();
        await page.evaluate(() => {
            // Put a target in reach so the game loop awards points without relying on a random spawn.
            generateTarget();
            targets[0].x = playerX;
            targets[0].y = playerY;
        });
        await page.waitForFunction(() => document.getElementById('scoreDisplay').textContent === 'Score: 10');

        const collideWithObstacle = async () => {
            await page.evaluate(() => {
                generateObstacle();
                obstacles[0].x = playerX;
            });
            await page.locator('#gameOver').waitFor();
        };
        const gameOverScores = async () => ({
            run: await page.locator('#finalScore').innerText(),
            high: await page.locator('#highScore').innerText(),
            saved: await page.evaluate(() => localStorage.getItem('templeTossHighScore')),
        });

        await collideWithObstacle();
        assert.deepEqual(await gameOverScores(), { run: 'Your score: 10', high: 'High score: 10', saved: '10' });

        await openGame(page, url);
        await page.locator('#startButton').click();
        await collideWithObstacle();
        assert.deepEqual(await gameOverScores(), { run: 'Your score: 0', high: 'High score: 10', saved: '10' });
    } finally {
        await context.close();
    }
});

const savedLeaderboard = JSON.stringify([{ name: 'Ada', score: 42 }]);
const savedLeaderboardText = 'Leaderboard:1. Ada: 42';

const startupStorageCases = [
    { name: 'missing storage', storage: {} },
    { name: 'malformed leaderboard JSON', storage: { leaderboard: '{' } },
    { name: 'a non-array leaderboard', storage: { leaderboard: '{"name":"Ada","score":42}' } },
    {
        name: 'invalid leaderboard entries alongside a valid score',
        storage: { leaderboard: '[null,{"name":"Missing score"},{"name":1,"score":99},{"name":"String score","score":"99"},{"name":"Infinite score","score":1e400},{"name":"Ada","score":42}]' },
        leaderboardText: savedLeaderboardText,
    },
    {
        name: 'more than five unsorted leaderboard entries',
        storage: { leaderboard: JSON.stringify([
            { name: 'Low', score: 1 }, { name: 'G', score: 70 }, { name: 'F', score: 60 },
            { name: 'E', score: 50 }, { name: 'D', score: 40 }, { name: 'C', score: 30 }, { name: 'B', score: 20 },
        ]) },
        leaderboardText: 'Leaderboard:1. G: 702. F: 603. E: 504. D: 405. C: 30',
    },
    {
        name: 'malformed music JSON',
        storage: { leaderboard: savedLeaderboard, musicOn: '{', sfxOn: 'false' },
        leaderboardText: savedLeaderboardText,
        sfxOn: false,
    },
    {
        name: 'malformed sound effects JSON',
        storage: { leaderboard: savedLeaderboard, musicOn: 'false', sfxOn: '[' },
        leaderboardText: savedLeaderboardText,
        musicOn: false,
    },
    {
        name: 'non-boolean audio preferences',
        storage: { musicOn: '"false"', sfxOn: '0' },
    },
    {
        name: 'malformed JSON in all three startup keys',
        storage: { leaderboard: '{', musicOn: '[', sfxOn: 'tru' },
    },
    {
        name: 'wrong-shaped JSON in all three startup keys',
        storage: { leaderboard: '"[]"', musicOn: '[]', sfxOn: '{}' },
    },
    {
        name: 'a wrong-shaped leaderboard alongside valid muted audio',
        storage: { leaderboard: '{}', musicOn: 'false', sfxOn: 'false' },
        musicOn: false,
        sfxOn: false,
    },
    {
        name: 'valid saved scores and muted audio',
        storage: { leaderboard: savedLeaderboard, musicOn: 'false', sfxOn: 'false' },
        leaderboardText: savedLeaderboardText,
        musicOn: false,
        sfxOn: false,
    },
];

for (const {
    name, storage, leaderboardText = '', musicOn = true, sfxOn = true,
} of startupStorageCases) {
    test(`Startup handles ${name}`, async t => {
        const context = await browser.newContext();
        const pageErrors = [];
        try {
            await context.route('**/*', route =>
                route.request().url() === url ? route.continue() : route.abort());
            await context.addInitScript(entries => {
                for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
            }, storage);

            const page = await context.newPage();
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.locator('#loadingScreen').waitFor({ state: 'hidden', timeout: 6000 });
            assert.deepEqual(pageErrors, []);
            assert.equal(await page.locator('#leaderboardDisplay').textContent(), leaderboardText);
            assert.equal(await page.locator('#musicToggle').getAttribute('aria-pressed'), String(musicOn));
            assert.equal(await page.locator('#sfxToggle').getAttribute('aria-pressed'), String(sfxOn));

            await page.getByRole('button', { name: 'START GAME' }).click();
            await page.locator('#instructions').waitFor({ state: 'hidden', timeout: 2000 });
            await page.locator('#jumpButton').waitFor({ timeout: 2000 });
            assert.deepEqual(pageErrors, []);
        } finally {
            if (pageErrors.length) t.diagnostic(`Uncaught page errors: ${pageErrors.join('; ')}`);
            await context.close();
        }
    });
}

const startupHighScoreCases = [
    { name: 'a valid saved high score', saved: '42', shown: 42 },
    { name: 'a non-numeric high score', saved: 'abc', shown: 0 },
    { name: 'a NaN high score', saved: 'NaN', shown: 0 },
    { name: 'a JSON object high score', saved: '{"score":9}', shown: 0 },
    { name: 'a negative high score', saved: '-5', shown: 0 },
];

for (const { name, saved, shown } of startupHighScoreCases) {
    test(`Startup recovers from ${name}`, async () => {
        const context = await browser.newContext();
        try {
            await context.route('**/*', route =>
                route.request().url() === url ? route.continue() : route.abort());
            await context.addInitScript(value => localStorage.setItem('templeTossHighScore', value), saved);

            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.locator('#loadingScreen').waitFor({ state: 'hidden', timeout: 6000 });
            await page.getByRole('button', { name: 'START GAME' }).click();
            await page.locator('#jumpButton').waitFor({ timeout: 2000 });

            await page.evaluate(() => endGame());
            assert.equal(await page.locator('#highScore').textContent(), `High score: ${shown}`);

            await page.getByRole('button', { name: 'Play Again' }).click();
            await page.evaluate(() => { score = 7; endGame(); });
            const best = Math.max(shown, 7);
            assert.equal(await page.locator('#highScore').textContent(), `High score: ${best}`);
            assert.equal(await page.evaluate(() => localStorage.getItem('templeTossHighScore')),
                best > shown ? '7' : saved);
            assert.deepEqual(pageErrors, []);
        } finally {
            await context.close();
        }
    });
}

for (const viewport of phoneViewports) {
    test(`Touch can play and return to the menu at ${viewport.width}x${viewport.height}`, async () => {
        await runTouchLoop(browser, url, viewport);
    });
}

const compactViewport = { width: 320, height: 568 };
const compactPhone = { ...devices['iPhone SE'], viewport: compactViewport, screen: compactViewport };

for (const viewport of [compactViewport, { width: 375, height: 667 }]) {
    test(`The loading title fits with fallback fonts at ${viewport.width}x${viewport.height}`, async () => {
        const context = await browser.newContext({ ...compactPhone, viewport, screen: viewport });
        try {
            await context.route('**/*', route =>
                route.request().url() === url ? route.continue() : route.abort());

            const page = await context.newPage();
            await page.clock.install({ time: 0 });
            await page.clock.pauseAt(1000);
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            const title = page.locator('#loadingTitle');
            assert.ok(await title.isVisible(), 'The loading screen must be visible for the fit check');
            const lines = await title.evaluate(node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return [...range.getClientRects()].map(({ left, right }) => ({ left, right }));
            });
            assert.equal(lines.length, 1, 'The loading title wraps');
            assert.ok(lines[0].left >= 0 && lines[0].right <= viewport.width,
                `The loading title crosses the viewport: ${JSON.stringify(lines)}`);
        } finally {
            await context.close();
        }
    });
}

for (const device of [compactPhone, devices['Pixel 7']]) {
    const { width, height } = device.viewport;
    for (const viewport of [device.viewport, { width: height, height: width }]) {
        test(`Touch can toss while holding an air arrow at ${viewport.width}x${viewport.height}`, async () => {
            const context = await browser.newContext({ ...device, viewport });
            try {
                const page = await context.newPage();
                await page.route('**/*', route => {
                    return route.request().url() === url ? route.continue() : route.abort();
                });
                await openGame(page, url);
                await tap(page, '#startButton');

                const cdp = await context.newCDPSession(page);
                const arrow = { ...await centerOf(page, '#rightButton'), id: 1 };
                const toss = { ...await centerOf(page, '#tossButton'), id: 2 };
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [arrow] });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [arrow, toss] });
                // End the Toss touch while leaving the steering finger down.
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [toss] });

                const state = await page.evaluate(() => ({
                    projectiles: document.querySelectorAll('.projectile').length,
                    steering: held.right.size,
                }));
                assert.deepEqual(state, { projectiles: 1, steering: 1 });

                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                assert.equal(await page.evaluate(() => held.right.size), 0);
            } finally {
                await context.close();
            }
        });
    }
}

test('The mobile leaderboard fits a full-length name at 320x568', async () => {
    const context = await browser.newContext(compactPhone);
    try {
        const page = await context.newPage();
        const name = 'W'.repeat(24);
        await page.addInitScript(name => {
            localStorage.setItem('leaderboard', JSON.stringify([{ name, score: 900 }]));
        }, name);
        await page.route('**/*', route => route.request().url() === url ? route.continue() : route.abort());
        await openGame(page, url);
        const entry = page.locator('#leaderboardDisplay').getByText(`1. ${name}: 900`, { exact: true });
        const lines = await entry.evaluate(node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].map(({ left, right }) => ({ left, right }));
        });
        assert.ok(lines.length > 0 && lines.every(({ left, right }) => left >= 12 && right <= 308),
            `Leaderboard text crosses the 12px viewport margins: ${JSON.stringify(lines)}`);
    } finally {
        await context.close();
    }
});

const compactTouchViewports = [
    compactViewport,
    { width: 375, height: 667 },
    devices['Pixel 7'].viewport,
];

for (const { width, height } of compactTouchViewports) {
    for (const viewport of [{ width, height }, { width: height, height: width }]) {
        test(`The leaderboard stays off the playfield at ${viewport.width}x${viewport.height}`, async t => {
            const context = await browser.newContext({ ...compactPhone, viewport, screen: viewport });
            t.after(() => context.close());
            const page = await context.newPage();
            const entries = Array.from({ length: 5 }, (_, index) => ({
                name: 'W'.repeat(23) + index,
                score: 500 - index * 10,
            }));
            await page.addInitScript(entries => {
                localStorage.setItem('leaderboard', JSON.stringify(entries));
            }, entries);
            await page.route('**/*', route => route.request().url() === url ? route.continue() : route.abort());
            await useFixedGameFrames(page);
            await openGame(page, url);

            const leaderboard = page.locator('#leaderboardDisplay');
            const expected = ['Leaderboard:', ...entries.map(({ name, score }, index) =>
                `${index + 1}. ${name}: ${score}`)];
            assert.ok(await leaderboard.isVisible());
            assert.deepEqual(await leaderboard.locator('p').allTextContents(), expected);

            await tap(page, '#startButton');
            await page.locator('#controls').waitFor();
            assert.ok(await leaderboard.isHidden(), 'Leaderboard text covers the active playfield');
            assert.ok(await page.locator('#scoreDisplay').isVisible(), 'The run score must remain visible');

            await page.evaluate(() => {
                generateObstacle();
                obstacles.at(-1).x = playerX;
                window.stepTouchLoop();
            });
            const results = page.locator('#leaderboardDisplayGameOver');
            await results.waitFor();
            assert.deepEqual(await results.locator('p').allTextContents(), expected);

            await tap(page, '#restartButton');
            await page.locator('#controls').waitFor();
            assert.ok(await leaderboard.isHidden(), 'Replay must keep the playfield clear');
        });
    }
}

async function assertTouchControlOrder(page) {
    const left = await centerOf(page, '#leftButton');
    const right = await centerOf(page, '#rightButton');
    const jump = await centerOf(page, '#jumpButton');
    const toss = await centerOf(page, '#tossButton');
    const midpoint = page.viewportSize().width / 2;
    assert.ok(left.x < right.x && right.x < midpoint && right.x - left.x <= 78,
        'Move Left must precede Move Right, with both controls on the left');
    assert.ok(midpoint < jump.x && jump.x < toss.x && toss.x - jump.x <= 78,
        'Jump must precede Toss, with both controls on the right');
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
        await assertTouchControlOrder(page);
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

async function verifySafeLayout(page, { top, right, bottom, left }, playing) {
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

    const visibleIds = ['scoreDisplay', 'musicToggle', 'sfxToggle', ...(playing
        ? ['leftButton', 'rightButton', 'jumpButton', 'tossButton']
        : ['leaderboardDisplay'])];
    for (const id of visibleIds) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box && box.x >= left && box.y >= top &&
            box.x + box.width <= width - right && box.y + box.height <= height - bottom,
        `#${id} crosses the safe area: ${JSON.stringify(box)}`);
    }

    if (!playing) {
        const score = await page.locator('#scoreDisplay').boundingBox();
        const leaderboard = await page.locator('#leaderboardDisplay').boundingBox();
        assert.ok(score.y + score.height <= leaderboard.y, 'The score overlaps the leaderboard');
        return;
    }
    await assertTouchControlOrder(page);
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
            await verifySafeLayout(page, insets, false);
            await tap(page, '#startButton');
            await verifySafeLayout(page, insets, true);

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
        await useFixedGameFrames(page);
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
        await advanceFrames(page, 4);
        await page.waitForFunction(y => playerY < y - 20, initialPlayer.y);

        await page.setViewportSize(landscape);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: iphoneLandscape });
        await page.waitForFunction(({ width, height }) => fieldWidth === width && fieldHeight === height, landscape);
        await verifySafeLayout(page, iphoneLandscape, true);

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
        await advanceFrames(page, 85);
        await page.waitForFunction(() => playerY === gameContainer.clientHeight - groundHeight - playerHeight);
        await verifySafeLayout(page, iphonePortrait, true);
        assert.ok(await page.locator('#controls').isVisible());
    } finally {
        await context.close();
    }
});

test('Desktop supports keyboard menus, jump, air control, toss and existing mouse buttons', async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    try {
        const page = await context.newPage();
        await useFixedGameFrames(page);
        await openGame(page, url);
        await page.locator('#startButton').focus();
        await page.keyboard.press('Enter');
        const start = await playerPosition(page);

        await page.keyboard.down('ArrowLeft');
        await page.keyboard.down('Space');
        await advanceFrames(page, 8);
        const keyboardJump = await playerPosition(page);
        assert.ok(keyboardJump.x < start.x - 5, 'ArrowLeft steers the player left');
        assert.ok(keyboardJump.y < start.y - 25, 'Space lifts the player off the ground');
        await page.keyboard.up('Space');
        await page.keyboard.up('ArrowLeft');
        await page.keyboard.press('t');
        const projectiles = page.locator('.projectile');
        assert.equal(await projectiles.count(), 1, 'T creates a projectile');
        await advanceFrames(page, 85);
        assert.equal((await playerPosition(page)).y, start.y, 'The keyboard jump lands');
        assert.equal(await projectiles.count(), 0, 'The keyboard toss has cleared');

        await page.locator('#jumpButton').click();
        await advanceFrames(page, 8);
        assert.ok((await playerPosition(page)).y < start.y - 10, 'The Jump button lifts the player off the ground');
        await page.locator('#tossButton').click();
        assert.equal(await projectiles.count(), 1, 'The Toss button creates a new projectile');

        await advanceFrames(page, 85);
        await page.evaluate(() => {
            generateObstacle();
            obstacles.at(-1).x = playerX;
        });
        await advanceFrames(page, 1);
        await page.locator('#gameOver').waitFor();
        await page.locator('#mainMenuButton').focus();
        await page.keyboard.press('Enter');
        await page.locator('#startButton').waitFor();
        assert.deepEqual(await page.evaluate(() => [window.scrollX, window.scrollY]), [0, 0]);
    } finally {
        await context.close();
    }
});

test('Space activates the focused Toss button without jumping', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());

    await useFixedGameFrames(page);
    await openGame(page, url);
    await page.locator('#startButton').focus();
    await page.keyboard.press('Enter');
    const start = await playerPosition(page);

    // Reach Toss through the native Tab order.
    const toss = page.locator('#tossButton');
    for (let step = 0; step < 6 && !(await toss.evaluate(button => button.matches(':focus'))); step++) {
        await page.keyboard.press('Tab');
    }
    assert.equal(await toss.evaluate(button => button.matches(':focus')), true);
    await page.keyboard.press('Control+Space');
    await advanceFrames(page, 3);
    assert.equal(await page.locator('.projectile').count(), 0);
    assert.deepEqual(await playerPosition(page), start);
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.projectile').count(), 1);
    await advanceFrames(page, 3);
    assert.deepEqual(await playerPosition(page), start);
});

test('Keyboard focus follows Start, Game Over, Save Score, Play Again, and Main Menu', async t => {
    const page = await browser.newPage();
    t.after(() => page.close());

    await useFixedGameFrames(page);
    await openGame(page, url);
    const focusedId = () => page.evaluate(() => document.activeElement.id);
    for (const id of ['musicToggle', 'sfxToggle', 'startButton']) {
        await page.keyboard.press('Tab');
        assert.equal(await focusedId(), id);
    }
    await page.keyboard.press('Enter');
    assert.equal(await focusedId(), 'jumpButton');

    await page.evaluate(() => endGame());
    assert.equal(await focusedId(), 'gameOverTitle');
    for (const id of ['restartButton', 'mainMenuButton', 'playerName']) {
        await page.keyboard.press('Tab');
        assert.equal(await focusedId(), id);
    }
    await page.keyboard.type('Focus check');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'SAVE SCORE');
    await page.keyboard.press('Enter');
    assert.equal(await focusedId(), 'restartButton');
    await page.keyboard.press('Enter');
    assert.equal(await focusedId(), 'jumpButton');

    await page.evaluate(() => endGame());
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await focusedId(), 'mainMenuButton');
    await page.keyboard.press('Enter');
    assert.equal(await focusedId(), 'startButton');
});

test('The game starts while the font stylesheet is pending', async () => {
    const page = await browser.newPage({ viewport: phoneViewports[0], hasTouch: true, isMobile: true });
    const fontStylesheet = 'https://fonts.googleapis.com/**';
    const { promise: releaseFontRequest, resolve: releaseFonts } = Promise.withResolvers();
    try {
        await page.route(fontStylesheet, async route => {
            await releaseFontRequest;
            await route.fulfill({ contentType: 'text/css', body: '' });
        });
        const fontRequest = page.waitForRequest(fontStylesheet);
        await Promise.all([openGame(page, url), fontRequest]);
        const fontLink = page.locator('link[href^="https://fonts.googleapis.com/"]');
        assert.equal(await fontLink.getAttribute('media'), 'print');
        await tap(page, '#startButton');
        await page.locator('#controls').waitFor({ state: 'visible' });
        releaseFonts();
        await page.waitForFunction(() =>
            document.querySelector('link[href^="https://fonts.googleapis.com/"]').media === 'all');
    } finally {
        releaseFonts();
        await page.close();
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

        const music = page.getByRole('button', { name: 'Music', exact: true });
        const effects = page.getByRole('button', { name: 'Sound effects', exact: true });
        assert.equal(await music.getAttribute('aria-pressed'), 'true');
        await music.press('Space');
        assert.equal(await music.getAttribute('aria-pressed'), 'false');
        assert.equal(await page.evaluate(() => musicGain.gain.value), 0);
        assert.equal(await page.evaluate(() => playerJumping), false);
        assert.equal(await effects.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.evaluate(() => window.tonesPlayed), 0);
        await tap(page, '#jumpButton');
        assert.equal(await page.evaluate(() => window.tonesPlayed), 1);

        await tap(page, '#sfxToggle');
        assert.equal(await effects.getAttribute('aria-pressed'), 'false');
        await tap(page, '#tossButton');
        await page.locator('.projectile').first().waitFor();
        assert.equal(await page.evaluate(() => window.tonesPlayed), 1);

        await openGame(page, url);
        await tap(page, '#startButton');
        await page.waitForFunction(() => audioContext.state === 'running');
        assert.equal(await page.evaluate(() => typeof musicLoop), 'undefined');
        assert.equal(await music.getAttribute('aria-pressed'), 'false');
        assert.equal(await effects.getAttribute('aria-pressed'), 'false');
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

async function fixedFramePage(t) {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    t.after(() => page.close());
    await page.route('**/*', route => route.request().url() === url ? route.continue() : route.abort());
    await page.addInitScript(() => {
        Math.random = () => 0.5;
        localStorage.setItem('musicOn', 'false');
        localStorage.setItem('sfxOn', 'false');
        let now = 0;
        let nextId = 0;
        const frames = new Map();
        performance.now = () => now;
        window.requestAnimationFrame = callback => {
            frames.set(++nextId, callback);
            return nextId;
        };
        window.cancelAnimationFrame = id => frames.delete(id);
        window.advanceGameFrame = () => {
            now += 1000 / 60;
            for (const [id, callback] of [...frames]) {
                if (frames.delete(id)) callback(now);
            }
        };
    });
    await openGame(page, url);
    await page.locator('#startButton').click();
    return page;
}

async function assertScore(page, total, floatingScores) {
    assert.equal(await page.locator('#scoreDisplay').textContent(), `Score: ${total}`);
    assert.deepEqual(await page.locator('.floatingScore').allTextContents(), floatingScores);
}

test('Adjacent expired entities are all removed and both obstacle bonuses land in the same frame', async t => {
    const page = await fixedFramePage(t);
    const remaining = await page.evaluate(() => {
        for (let i = 0; i < 2; i++) {
            generateObstacle();
            obstacles[i].x = -50;
            generateTarget();
            targets[i].x = -50;
            spawnParticle(0, 0, 0, 0);
            particles[i].lifetime = 0;
            const element = document.createElement('div');
            element.className = 'projectile';
            gameContainer.appendChild(element);
            projectiles.push({ element, x: 0, y: 0, vy: -19 });
        }
        window.advanceGameFrame();
        return Object.fromEntries(['obstacle', 'target', 'projectile', 'particle'].map(
            name => [name, document.querySelectorAll(`.${name}`).length]
        ));
    });
    assert.deepEqual(remaining, { obstacle: 0, target: 0, projectile: 0, particle: 0 });
    await assertScore(page, 10, ['+5', '+5']);
});

test('Two tosses hitting separate targets in the same frame both score', async t => {
    const page = await fixedFramePage(t);
    await page.evaluate(() => {
        for (const x of [playerX, playerX + 150]) {
            generateTarget();
            const target = targets.at(-1);
            target.x = x;
            const element = document.createElement('div');
            element.className = 'projectile';
            gameContainer.appendChild(element);
            projectiles.push({ element, x, y: target.y + 19, vy: -19 });
        }
        window.advanceGameFrame();
    });
    assert.equal(await page.locator('.target, .projectile').count(), 0);
    await assertScore(page, 20, ['+10', '+10']);
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

test('Denied score writes leave game over, score entry, and restart usable', async t => {
    const page = await openLeaderboardGame(t);
    await page.evaluate(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (this === localStorage && (key === 'templeTossHighScore' || key === 'leaderboard')) {
                throw new DOMException('Storage quota reached', 'QuotaExceededError');
            }
            return setItem.call(this, key, value);
        };
    });

    await finishRun(page, 20);
    assert.equal(await page.locator('#finalScore').textContent(), 'Your score: 20');
    assert.equal(await page.locator('#highScore').textContent(), 'High score: 20');
    await page.getByRole('textbox', { name: 'Player name' }).fill('Ada');
    await page.locator('#scoreForm button').click();
    await page.locator('#scoreForm').waitFor({ state: 'hidden' });
    await page.locator('#leaderboardDisplayGameOver').getByText('1. Ada: 20', { exact: true }).waitFor();

    await finishRun(page, 10, '#restartButton');
    assert.equal(await page.locator('#finalScore').textContent(), 'Your score: 10');
    assert.equal(await page.locator('#highScore').textContent(), 'High score: 20');
    const leaderboard = page.locator('#leaderboardDisplayGameOver');
    await leaderboard.getByText('1. Ada: 20', { exact: true }).waitFor();
    await leaderboard.getByText('2. Ada: 10', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({
        best: localStorage.getItem('templeTossHighScore'),
        leaderboard: localStorage.getItem('leaderboard'),
    })), { best: null, leaderboard: '[]' });
});

test('An older tab preserves newer best score and merges leaderboard saves', async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('**/*', route =>
        route.request().url() === url ? route.continue() : route.abort());
    const oldTab = await context.newPage();
    await oldTab.goto(url, { waitUntil: 'domcontentloaded' });
    await oldTab.locator('#loadingScreen').waitFor({ state: 'hidden' });

    const newerTab = await context.newPage();
    await newerTab.goto(url, { waitUntil: 'domcontentloaded' });
    await newerTab.locator('#loadingScreen').waitFor({ state: 'hidden' });
    await newerTab.evaluate(() => {
        localStorage.setItem('templeTossHighScore', '100');
        localStorage.setItem('leaderboard', JSON.stringify([{ name: 'Ada', score: 100 }]));
    });

    await oldTab.getByRole('button', { name: 'Start Game' }).click();
    await oldTab.evaluate(() => { score = 10; endGame(); });
    assert.equal(await oldTab.locator('#highScore').textContent(), 'High score: 100');
    await oldTab.getByRole('textbox', { name: 'Player name' }).fill('Player');
    await oldTab.locator('#scoreForm button').click();
    assert.deepEqual(await oldTab.evaluate(() => ({
        best: localStorage.getItem('templeTossHighScore'),
        leaderboard: JSON.parse(localStorage.getItem('leaderboard')),
    })), {
        best: '100',
        leaderboard: [{ name: 'Ada', score: 100 }, { name: 'Player', score: 10 }],
    });
});

test('Startup seeds high score from the top leaderboard entry', async t => {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.route('**/*', route =>
        route.request().url() === url ? route.continue() : route.abort());
    await context.addInitScript(() => {
        localStorage.setItem('leaderboard', JSON.stringify([{ name: 'Ada', score: 90 }]));
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#loadingScreen').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Start Game' }).click();
    await page.evaluate(() => endGame());
    assert.equal(await page.locator('#highScore').textContent(), 'High score: 90');
});

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

test('Leaderboard skips the name form when a score does not beat a full board', async t => {
    const entries = [
        { name: 'Avery', score: 90 },
        { name: 'Dana', score: 70 },
        { name: 'Ellis', score: 50 },
        { name: 'Kai', score: 30 },
        { name: 'Sky', score: 10 },
    ];
    const page = await openLeaderboardGame(t, entries);

    // A tie with the lowest saved score does not qualify.
    await finishRun(page, 10);
    assert.ok(await page.locator('#scoreForm').isHidden(), 'A tying score must not ask for a name');
    await assertLeaderboard(page, entries);

    await finishRun(page, 0, '#restartButton');
    assert.ok(await page.locator('#scoreForm').isHidden(), 'A lower score must not ask for a name');
    await assertLeaderboard(page, entries);
});

test('Leaderboard keeps earlier entries ahead of a new tied score', async t => {
    const entries = [{ name: 'Ada', score: 30 }, { name: 'Bo', score: 20 }];
    const page = await openLeaderboardGame(t, entries);
    await finishRun(page, 20);
    await page.getByRole('textbox', { name: 'Player name' }).fill('Cy');
    await page.locator('#scoreForm button').click();
    await assertLeaderboard(page, [...entries, { name: 'Cy', score: 20 }]);
});

test('Leaderboard reuses the session name after reload but not in a new tab', async t => {
    const page = await openLeaderboardGame(t);
    await finishRun(page, 20);
    await page.getByRole('textbox', { name: 'Player name' }).fill('Ada');
    await page.locator('#scoreForm button').click();
    await assertLeaderboard(page, [{ name: 'Ada', score: 20 }]);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#loadingScreen').waitFor({ state: 'hidden' });
    await finishRun(page, 30);
    assert.ok(await page.locator('#scoreForm').isHidden(), 'The session name must be reused after reload');
    await assertLeaderboard(page, [{ name: 'Ada', score: 30 }, { name: 'Ada', score: 20 }]);

    // A new tab shares localStorage but starts a new sessionStorage.
    const tab = await page.context().newPage();
    await openGame(tab, url);
    await assertLeaderboard(tab, [{ name: 'Ada', score: 30 }, { name: 'Ada', score: 20 }]);
    await finishRun(tab, 40);
    await tab.locator('#scoreForm').waitFor();
    assert.equal(await tab.getByRole('textbox', { name: 'Player name' }).inputValue(), '');
    await tab.getByRole('textbox', { name: 'Player name' }).fill('Bo');
    await tab.locator('#scoreForm button').click();
    await assertLeaderboard(tab, [
        { name: 'Bo', score: 40 },
        { name: 'Ada', score: 30 },
        { name: 'Ada', score: 20 },
    ]);
});

async function withControlPage(run, { hasTouch = false } = {}) {
    const context = await browser.newContext({
        viewport: phoneViewports[0],
        hasTouch,
        isMobile: hasTouch,
    });
    try {
        const page = await context.newPage();
        await page.route(/^https:/, route => route.abort());
        const startTime = Date.UTC(2026, 0, 1);
        await page.clock.install({ time: startTime });
        await page.clock.pauseAt(startTime + 1000);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.clock.runFor(2600);
        await page.locator('#startButton').waitFor();
        await run(page, context);
    } finally {
        await context.close();
    }
}

function heldControls(page) {
    return page.evaluate(() => ({
        jump: [...held.jump],
        left: [...held.left],
        right: [...held.right],
    }));
}

const noControlsHeld = { jump: [], left: [], right: [] };

for (const releaseEvent of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    test(`Pointer steering releases on ${releaseEvent}`, async () => {
        await withControlPage(async (page, context) => {
            const cdp = await context.newCDPSession(page);
            await tap(page, '#startButton');
            const arrow = page.locator('#rightButton');
            const point = { ...await centerOf(page, '#rightButton'), id: 1 };
            await arrow.evaluate((button, type) => {
                // Read the state before a later lostpointercapture can clear it.
                button.addEventListener(type, event => {
                    button.dataset.release = JSON.stringify({
                        trusted: event.isTrusted,
                        held: held.right.has(event.pointerId),
                    });
                }, { once: true });
            }, releaseEvent);

            if (releaseEvent === 'lostpointercapture') {
                // A move applies the pending capture while the pointer is still down.
                await page.mouse.move(point.x, point.y);
                await page.mouse.down();
                await page.mouse.move(point.x, point.y - 5);
            } else {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
            }
            assert.equal((await heldControls(page)).right.length, 1);
            await page.keyboard.down('Space');
            await page.clock.runFor(64);
            const moving = await playerPosition(page);
            await page.clock.runFor(16);
            const beforeRelease = await playerPosition(page);
            assert.ok(beforeRelease.x > moving.x && beforeRelease.y < moving.y, 'Player was steering mid-jump');

            if (releaseEvent === 'lostpointercapture') {
                await arrow.evaluate(button => button.releasePointerCapture([...held.right][0]));
                await page.mouse.move(point.x, point.y - 10);
            } else {
                await cdp.send('Input.dispatchTouchEvent', {
                    type: releaseEvent === 'pointerup' ? 'touchEnd' : 'touchCancel',
                    touchPoints: [],
                });
            }

            assert.deepEqual(JSON.parse(await arrow.getAttribute('data-release')), {
                trusted: true,
                held: false,
            });
            assert.deepEqual(await heldControls(page), { ...noControlsHeld, jump: ['Space'] });
            await page.clock.runFor(16);
            const afterRelease = await playerPosition(page);
            assert.ok(afterRelease.x - beforeRelease.x < beforeRelease.x - moving.x,
                'Player stopped accelerating after release');
            if (releaseEvent === 'lostpointercapture') await page.mouse.up();
        }, { hasTouch: true });
    });
}

for (const releaseEvent of ['blur', 'visibilitychange']) {
    test(`Held keyboard and pointer controls clear on ${releaseEvent}`, async () => {
        await withControlPage(async page => {
            const start = await centerOf(page, '#startButton');
            await page.mouse.click(start.x, start.y);
            const { x, y } = await centerOf(page, '#rightButton');
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.keyboard.down('ArrowLeft');
            await page.keyboard.down('Space');
            const before = await heldControls(page);
            assert.deepEqual(before.jump, ['Space']);
            assert.deepEqual(before.left, ['ArrowLeft']);
            assert.equal(before.right.length, 1);

            if (releaseEvent === 'blur') {
                await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            } else {
                // Drive visibility without switching to a different browser window.
                await page.evaluate(() => {
                    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
                    document.dispatchEvent(new Event('visibilitychange'));
                });
                assert.deepEqual(await heldControls(page), before, 'Visible pages keep held controls');
                await page.evaluate(() => {
                    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
                    document.dispatchEvent(new Event('visibilitychange'));
                    delete document.hidden;
                });
            }

            assert.deepEqual(await heldControls(page), noControlsHeld);
            await page.mouse.up();
            await page.keyboard.up('ArrowLeft');
            await page.keyboard.up('Space');
            await page.keyboard.down('ArrowLeft');
            assert.deepEqual((await heldControls(page)).left, ['ArrowLeft'], 'New input works after release');
        }, { hasTouch: true });
    });
}

test('Keyboard release clears only the released key and ignores modified input', async () => {
    await withControlPage(async page => {
        const { x, y } = await centerOf(page, '#startButton');
        await page.mouse.click(x, y);
        const start = await playerPosition(page);
        await page.keyboard.press('Control+Space');
        await page.keyboard.down('Alt');
        await page.keyboard.down('ArrowLeft');
        assert.deepEqual(await heldControls(page), noControlsHeld);
        await page.keyboard.up('ArrowLeft');
        await page.keyboard.up('Alt');
        await page.keyboard.press('Meta+t');
        await page.clock.runFor(64);
        assert.deepEqual(await heldControls(page), noControlsHeld);
        assert.deepEqual(await playerPosition(page), start);
        assert.equal(await page.locator('.projectile').count(), 0);

        await page.keyboard.down('ArrowLeft');
        await page.keyboard.down('a');
        await page.keyboard.down('a');
        assert.deepEqual((await heldControls(page)).left, ['ArrowLeft', 'KeyA']);
        await page.keyboard.up('ArrowLeft');
        assert.deepEqual((await heldControls(page)).left, ['KeyA']);
        await page.keyboard.up('a');
        assert.deepEqual(await heldControls(page), noControlsHeld);
    });
});

test('Gameplay keys are ignored before the run and after game over', async () => {
    await withControlPage(async page => {
        for (const screen of ['#startButton', '#gameOver']) {
            assert.ok(await page.locator(screen).isVisible());
            const start = await playerPosition(page);
            await page.keyboard.down('ArrowLeft');
            await page.keyboard.down('Space');
            await page.keyboard.press('t');
            await page.clock.runFor(64);
            assert.deepEqual(await heldControls(page), noControlsHeld);
            assert.deepEqual(await playerPosition(page), start);
            assert.equal(await page.locator('.projectile').count(), 0);
            assert.equal(await page.locator('#player.jumping').count(), 0);
            await page.keyboard.up('Space');
            await page.keyboard.up('ArrowLeft');

            if (screen === '#startButton') {
                const { x, y } = await centerOf(page, screen);
                await page.mouse.click(x, y);
                await page.clock.runFor(8000);
            }
        }
    });
});

for (const [control, action] of [['#jumpButton', 'jump'], ['#leftButton', 'left']]) {
    test(`${action} hold releases on a cancelled touch`, async () => {
        await withControlPage(async (page, context) => {
            const cdp = await context.newCDPSession(page);
            await tap(page, '#startButton');
            const button = page.locator(control);
            await button.evaluate((element, action) => {
                // Runs after the game's own listener, so it sees the released state.
                element.addEventListener('pointercancel', event => {
                    element.dataset.release = JSON.stringify({
                        trusted: event.isTrusted,
                        held: held[action].has(event.pointerId),
                    });
                }, { once: true });
            }, action);

            const point = { ...await centerOf(page, control), id: 1 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
            assert.equal((await heldControls(page))[action].length, 1);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });

            assert.deepEqual(JSON.parse(await button.getAttribute('data-release')), {
                trusted: true,
                held: false,
            });
            assert.deepEqual(await heldControls(page), noControlsHeld);
        }, { hasTouch: true });
    });
}

test('Hold controls ignore secondary and middle mouse buttons', async () => {
    await withControlPage(async page => {
        const start = await centerOf(page, '#startButton');
        await page.mouse.click(start.x, start.y);
        for (const control of ['#leftButton', '#rightButton', '#jumpButton']) {
            const { x, y } = await centerOf(page, control);
            await page.mouse.move(x, y);
            for (const button of ['right', 'middle']) {
                await page.mouse.down({ button });
                assert.deepEqual(await heldControls(page), noControlsHeld, `${control} ${button}`);
                await page.mouse.up({ button });
            }
        }
        assert.equal(await page.evaluate(() => playerJumping), false);

        const { x, y } = await centerOf(page, '#rightButton');
        await page.mouse.move(x, y);
        await page.mouse.down();
        assert.equal((await heldControls(page)).right.length, 1, 'Primary button still holds');
        await page.mouse.up();
        assert.deepEqual(await heldControls(page), noControlsHeld);
    }, { hasTouch: true });
});

test('Keyboard and pointer input are ignored while the page is hidden', async () => {
    await withControlPage(async page => {
        const setHidden = hidden => page.evaluate(hidden => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
            document.dispatchEvent(new Event('visibilitychange'));
            if (!hidden) delete document.hidden;
        }, hidden);
        const start = await centerOf(page, '#startButton');
        await page.mouse.click(start.x, start.y);
        const before = await playerPosition(page);

        await setHidden(true);
        await page.keyboard.down('ArrowLeft');
        await page.keyboard.down('Space');
        await page.keyboard.press('t');
        const right = await centerOf(page, '#rightButton');
        await page.mouse.move(right.x, right.y);
        await page.mouse.down();
        assert.deepEqual(await heldControls(page), noControlsHeld);
        await page.mouse.up();
        for (const control of ['#tossButton', '#jumpButton']) {
            const { x, y } = await centerOf(page, control);
            await page.mouse.click(x, y);
        }
        await page.clock.runFor(64);
        assert.deepEqual(await heldControls(page), noControlsHeld);
        assert.equal(await page.evaluate(() => playerJumping), false);
        assert.equal(await page.locator('.projectile').count(), 0);
        assert.deepEqual(await playerPosition(page), before);
        await page.keyboard.up('Space');
        await page.keyboard.up('ArrowLeft');

        await setHidden(false);
        await page.keyboard.down('ArrowLeft');
        assert.deepEqual((await heldControls(page)).left, ['ArrowLeft'], 'Input works again once visible');
        await page.keyboard.up('ArrowLeft');
    }, { hasTouch: true });
});

test('Modified Space on the focused Jump button is ignored but a modified Toss click still tosses', async () => {
    await withControlPage(async page => {
        const start = await centerOf(page, '#startButton');
        await page.mouse.click(start.x, start.y);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'jumpButton');

        // Chromium activates a focused button with modified Space, not modified Enter.
        for (const shortcut of ['Control+Space', 'Alt+Space', 'Meta+Space']) {
            await page.keyboard.press(shortcut);
            assert.equal(await page.evaluate(() => playerJumping), false, shortcut);
        }
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => playerJumping), true, 'Plain Enter jumps');

        // A real mouse click reports a click count, so modifiers do not cancel it.
        // Alt avoids the macOS Control+click context menu.
        const toss = await centerOf(page, '#tossButton');
        await page.keyboard.down('Alt');
        await page.mouse.click(toss.x, toss.y);
        await page.keyboard.up('Alt');
        assert.equal(await page.locator('.projectile').count(), 1);
    });
});

test('Toss does not fire when the touch slides off the button before release', async () => {
    await withControlPage(async (page, context) => {
        const cdp = await context.newCDPSession(page);
        await tap(page, '#startButton');
        const toss = { ...await centerOf(page, '#tossButton'), id: 1 };
        const away = { ...await centerOf(page, '#scoreDisplay'), id: 1 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [toss] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [away] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await page.locator('.projectile').count(), 0);

        await tap(page, '#tossButton');
        assert.equal(await page.locator('.projectile').count(), 1, 'A normal tap still tosses');
    }, { hasTouch: true });
});

for (const deniedStorage of [['localStorage'], ['sessionStorage'], ['localStorage', 'sessionStorage']]) {
    test(`The game stays playable when access to ${deniedStorage.join(' and ')} is denied`, async t => {
        const page = await browser.newPage();
        t.after(() => page.close());
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            return route.request().url().startsWith(url) ? route.continue() : route.abort();
        });
        await page.addInitScript(storageNames => {
            for (const storageName of storageNames) {
                Object.defineProperty(window, storageName, {
                    get() { throw new DOMException('Storage access denied', 'SecurityError'); },
                });
            }
        }, deniedStorage);

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        assert.deepEqual(errors, []);
        await page.locator('#loadingScreen').waitFor({ state: 'hidden' });
        for (const toggle of ['#musicToggle', '#sfxToggle']) {
            await page.locator(toggle).click();
            assert.equal(await page.locator(toggle).getAttribute('aria-pressed'), 'false');
        }

        await finishRun(page, 20);
        await page.getByRole('textbox', { name: 'Player name' }).fill('Ada');
        await page.locator('#scoreForm button').click();
        await page.locator('#scoreForm').waitFor({ state: 'hidden' });

        await finishRun(page, 10, '#restartButton');
        assert.equal(await page.locator('#highScore').textContent(), 'High score: 20');
        await page.locator('#scoreForm').waitFor({ state: 'hidden' });
        assert.deepEqual(await page.locator('#leaderboardDisplayGameOver p').allTextContents(),
            ['Leaderboard:', '1. Ada: 20', '2. Ada: 10']);
        assert.deepEqual(errors, []);
    });
}
