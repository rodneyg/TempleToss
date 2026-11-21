import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { openGame } from './touch-loop.mjs';

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

async function scoringPage(t) {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    t.after(() => page.close());
    await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    await page.addInitScript(() => {
        Math.random = () => 0.5;
        localStorage.setItem('musicOn', 'false');
        localStorage.setItem('sfxOn', 'false');

        // Run each queued animation frame once at the exact requested timestamp.
        let now = 100;
        let nextId = 0;
        const frames = new Map();
        const timers = new Map();
        window.controlGameTimers = () => {
            // Keep the startup loading screen on browser time. Control in-game timers.
            window.setTimeout = (callback, delay = 0) => {
                timers.set(++nextId, { callback, due: now + delay });
                return nextId;
            };
            window.clearTimeout = id => timers.delete(id);
        };
        performance.now = () => now;
        window.requestAnimationFrame = callback => {
            frames.set(++nextId, callback);
            return nextId;
        };
        window.cancelAnimationFrame = id => frames.delete(id);
        window.stepGame = (ms = 1000 / 60) => {
            now += ms;
            for (const [id, { callback, due }] of timers) {
                if (due <= now && timers.delete(id)) callback();
            }
            for (const [id, callback] of [...frames]) {
                if (frames.delete(id)) callback(now);
            }
        };
    });
    await openGame(page, url);
    await page.evaluate(() => controlGameTimers());
    await page.locator('#startButton').focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
        // The tests set up specific obstacles and targets. The orb uses its normal spawn timer.
        obstacleElapsed = -Infinity;
        targetElapsed = -Infinity;
        // The first frame initializes the active play clock.
        stepGame(0);
    });
    return page;
}

async function assertScore(page, total, floatingScores) {
    assert.equal(await page.locator('#scoreDisplay').textContent(), `Score: ${total}`);
    assert.deepEqual(await page.locator('.floatingScore').allTextContents(), floatingScores);
}

async function collectOrb(page) {
    await page.evaluate(() => stepGame(5000));
    assert.equal(await page.locator('.powerUp').count(), 1);
    await page.evaluate(() => {
        powerUp.x = playerX;
        powerUp.y = playerY;
        // Resolve pickup at the current time so the full ten seconds start here.
        stepGame(0);
    });
    assert.equal(await page.locator('.powerUp').count(), 0);
    assert.match(await page.locator('#player').evaluate(el => el.style.filter), /drop-shadow/);
}

test('Jumping over an obstacle awards +5 and shows the floating score after it exits', async t => {
    const page = await scoringPage(t);
    await page.evaluate(() => {
        generateObstacle();
        obstacles[0].x = playerX + 75;
    });
    await page.keyboard.down('Space');
    await page.evaluate(() => {
        for (let frame = 0; frame < 45; frame++) stepGame();
    });
    await page.keyboard.up('Space');
    assert.equal(await page.locator('#gameOver').isVisible(), false);
    assert.equal(await page.locator('.obstacle').count(), 1);
    await assertScore(page, 0, []);
    await page.evaluate(() => {
        for (let frame = 0; frame < 80; frame++) stepGame();
    });
    assert.equal(await page.locator('.obstacle').count(), 0);
    await assertScore(page, 5, ['+5']);
});

async function tossAtTarget(page, highTarget) {
    await page.evaluate(high => {
        // Select the rare high target branch at this viewport; ordinary targets use y = 200.
        Math.random = () => high ? 0.1 : 0.5;
        generateTarget();
        targets[0].x = playerX;
    }, highTarget);
    await page.keyboard.press('t');
    assert.equal(await page.locator('.projectile').count(), 1);
    await page.evaluate(() => {
        for (let frame = 0; frame < 30 && projectiles.length; frame++) stepGame();
    });
    assert.equal(await page.locator('.target, .projectile').count(), 0);
}

for (const [highTarget, basePoints] of [[false, 10], [true, 20]]) {
    test(`Tossing at a target awards +${basePoints}, doubled during Super Jump`, async t => {
        const page = await scoringPage(t);
        await tossAtTarget(page, highTarget);
        await assertScore(page, basePoints, [`+${basePoints}`]);

        await collectOrb(page);
        await tossAtTarget(page, highTarget);
        await assertScore(page, basePoints * 3, [`+${basePoints * 2}`]);
    });
}

test('Orb pickup activates Super Jump for ten seconds, then restores normal scoring and jump strength', async t => {
    const page = await scoringPage(t);
    await collectOrb(page);
    const playerFilter = () => page.locator('#player').evaluate(el => el.style.filter);
    const jumpRise = async () => {
        const y = await page.locator('#player').evaluate(el => parseFloat(el.style.top));
        await page.keyboard.press('Space');
        await page.evaluate(() => stepGame(0));
        const nextY = await page.locator('#player').evaluate(el => parseFloat(el.style.top));
        return y - nextY;
    };

    await page.evaluate(() => stepGame(9999));
    assert.match(await playerFilter(), /drop-shadow/);
    // Take the boosted jump without advancing its expiration timer.
    const boostedRise = await jumpRise();
    await page.evaluate(() => stepGame(1));
    assert.equal(await playerFilter(), 'none');
    const land = () => page.evaluate(() => {
        for (let frame = 0; frame < 120 && playerJumping; frame++) stepGame();
        return !playerJumping;
    });
    assert.ok(await land(), 'The boosted jump should land');
    const normalRise = await jumpRise();
    assert.ok(normalRise > 0 && boostedRise > normalRise, 'Super Jump should rise faster than a normal jump');
    assert.ok(await land(), 'The normal jump should land before the toss');

    await tossAtTarget(page, false);
    await assertScore(page, 10, ['+10']);
});

test('Adjacent expired entities are all removed and both obstacle bonuses land in the same frame', async t => {
    const page = await scoringPage(t);
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
        stepGame();
        return Object.fromEntries(['obstacle', 'target', 'projectile', 'particle'].map(
            name => [name, document.querySelectorAll(`.${name}`).length]
        ));
    });
    assert.deepEqual(remaining, { obstacle: 0, target: 0, projectile: 0, particle: 0 });
    await assertScore(page, 10, ['+5', '+5']);
});

test('Two tosses hitting separate targets in the same frame both score', async t => {
    const page = await scoringPage(t);
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
        stepGame();
    });
    assert.equal(await page.locator('.target, .projectile').count(), 0);
    await assertScore(page, 20, ['+10', '+10']);
});
