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
        storage: { leaderboard: '[null,{"name":"Missing score"},{"name":1,"score":99},{"name":"String score","score":"99"},{"name":"Ada","score":42}]' },
        leaderboardText: savedLeaderboardText,
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
            assert.equal(await page.locator('#musicToggle i').evaluate(icon => icon.classList.contains('fa-volume-up')), musicOn);
            assert.equal(await page.locator('#sfxToggle i').evaluate(icon => icon.style.textDecoration !== 'line-through'), sfxOn);

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

for (const viewport of phoneViewports) {
    test(`Touch can play and return to the menu at ${viewport.width}x${viewport.height}`, async () => {
        await runTouchLoop(browser, url, viewport);
    });
}

const compactViewport = { width: 320, height: 568 };
const compactPhone = { ...devices['iPhone SE'], viewport: compactViewport, screen: compactViewport };

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
        await tap(page, '#startButton');
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
