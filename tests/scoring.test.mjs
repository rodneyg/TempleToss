import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
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

async function scoringPage(t, overrides) {
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
    if (overrides) {
        await page.addInitScript(config => { window.templeTossStreakConfig = config; }, overrides);
    }
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

test('A target hit on the obstacle game-over frame does not change the final score', async t => {
    const page = await scoringPage(t);
    await page.evaluate(() => {
        generateObstacle();
        obstacles[0].x = playerX;
        generateTarget();
        targets[0].x = playerX;
        targets[0].y = 100;
        toss();
        Object.assign(projectiles[0], { x: playerX, y: targets[0].y + 20, vx: 0, vy: 0 });
        stepGame();
    });

    assert.equal(await page.locator('#gameOver').isVisible(), true);
    assert.equal(await page.locator('#finalScore').textContent(), 'Your score: 0');
    await assertScore(page, 0, []);
});

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

test('The game moves at the same pace on 30, 60, 120 and 144 Hz screens', async t => {
    const page = await scoringPage(t);
    const runs = await page.evaluate(() => [60, 30, 120, 144].map(hz => {
        resetGame();
        gameStarted = true;
        showPlayControls(true);
        scheduleRunFrame();
        const step = () => stepGame(1000 / hz);
        stepGame(0);
        obstacleElapsed = targetElapsed = powerUpSpawnTimer = -Infinity;

        // One second of scrolling.
        generateObstacle();
        obstacles[0].x = 5000;
        for (let frame = 0; frame < hz; frame++) step();
        const scrolled = 5000 - obstacles[0].x;
        obstacles.pop().element.remove();

        // A tapped jump while steering right.
        const start = { x: playerX, y: playerY };
        held.right.add('test');
        jump();
        let peak = 0;
        let frames = 0;
        while (playerJumping && frames < hz * 5) {
            step();
            frames++;
            peak = Math.max(peak, start.y - playerY);
            if (frames === Math.round(hz / 5)) held.right.clear();
        }
        const air = frames / hz;

        // A toss after a fifth of a second.
        toss();
        for (let frame = 0; frame < Math.round(hz / 5); frame++) step();
        return { hz, scrolled, peak, air, drift: playerX - start.x, tossed: start.y + 30 - projectiles[0].y };
    }));
    const [base, ...others] = runs;
    assert.ok(Math.abs(base.scrolled - 300) < 0.01, JSON.stringify(base));
    for (const run of others) {
        const detail = JSON.stringify({ base, run });
        assert.ok(Math.abs(run.scrolled - base.scrolled) < 0.01, detail);
        // Frames sample the same arc at different moments, so allow a few pixels.
        assert.ok(Math.abs(run.peak - base.peak) < 4, detail);
        assert.ok(Math.abs(run.air - base.air) < 0.07, detail);
        // 144 Hz cannot release the arrow at exactly a fifth of a second.
        assert.ok(Math.abs(run.drift - base.drift) < 8, detail);
        assert.ok(Math.abs(run.tossed - base.tossed) < 8, detail);
    }
});

test('Streak rules unlock at 3, 5 and 10 hits and keep the best across a miss', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const [, rules] = html.match(/<script id="targetStreakRules">([\s\S]*?)<\/script>/);
    const Streak = runInNewContext(rules + '\nTargetStreak');
    const run = new Streak();
    for (let hit = 1; hit <= 10; hit++) {
        assert.equal(run.hit(), [3, 5, 10].includes(hit), `hit ${hit}`);
    }
    assert.equal(run.scale('wide'), 1.6);
    assert.equal(run.scale('multiplier'), 2);
    assert.equal(run.scale('slow'), 0.65);
    run.miss();
    assert.equal(run.streak, 0);
    assert.equal(run.bestStreak, 10);
    assert.equal(run.feedback, 'Streak broken');

    run.advance(8);
    assert.equal(run.feedback, '');
    assert.equal(run.scale('wide'), 1);
    assert.equal(run.scale('slow'), 1);
    assert.equal(run.scale('multiplier'), 2);
    run.advance(2);
    assert.equal(run.scale('multiplier'), 1);
    for (let i = 0; i < 3; i++) assert.equal(run.takeThrow().length, 3);
    assert.equal(run.takeThrow().length, 1);

    const custom = new Streak({ wide: { hits: 1, seconds: 0.25 }, slow: { hits: 1, throws: 1 } });
    assert.equal(custom.hit(), true);
    assert.match(custom.feedback, /Wide Target.*Multi-Throw/);
    assert.equal(custom.scale('wide'), 1.6);
    assert.equal(custom.takeThrow().length, 3);
    custom.advance(0.25);
    assert.equal(custom.scale('wide'), 1);
    custom.reset();
    assert.equal(custom.streak, 0);
    assert.equal(custom.bestStreak, 0);
    assert.equal(custom.scale('slow'), 1);
    assert.equal(custom.throws, 0);
    assert.equal(custom.feedback, '');
});

test('Toss and target misses break a streak, while player pickups only score', async t => {
    const page = await scoringPage(t);
    const streak = page.locator('#streakDisplay');
    await tossAtTarget(page, false);
    assert.match(await streak.textContent(), /Streak: 1 · Best: 1/);
    await page.evaluate(() => {
        // Let a genuine toss expire without contacting anything.
        tossCooldown = 0;
        toss();
        for (let frame = 0; frame < 70 && projectiles.length; frame++) stepGame();
    });
    assert.equal(await page.locator('.projectile').count(), 0);
    assert.match(await streak.textContent(), /Streak: 0 · Best: 1/);
    assert.equal(await page.locator('#streakFeedback').textContent(), 'Streak broken');

    await tossAtTarget(page, false);
    await page.evaluate(() => {
        generateTarget();
        Object.assign(targets[0], { x: playerX, y: playerY });
        stepGame();
    });
    assert.match(await streak.textContent(), /Streak: 1 · Best: 1/);
    await page.evaluate(() => {
        generateTarget();
        targets[0].x = -50;
        stepGame();
    });
    assert.match(await streak.textContent(), /Streak: 0 · Best: 1/);
});

test('Milestone effects change hitboxes, scores and movement, then expire and reset', async t => {
    const page = await scoringPage(t, {
        wide: { hits: 1, seconds: 12 },
        multiplier: { hits: 2, seconds: 8 },
        slow: { hits: 3, seconds: 0.5, throws: 1 },
    });
    await collectOrb(page);
    await tossAtTarget(page, false);
    const sample = await page.evaluate(() => {
        generateTarget();
        const target = targets[0];
        Object.assign(target, { x: playerX - 80, y: 200 });
        const width = target.element.offsetWidth;
        // Put the projectile beyond even the padded normal hitbox.
        tossCooldown = 0;
        toss();
        Object.assign(projectiles[0], { y: 219, vy: -19 });
        stepGame(0);
        return { width, scored: !targets.length };
    });
    assert.deepEqual(sample, { width: 80, scored: true });
    await page.evaluate(() => stepGame(500));
    await tossAtTarget(page, false);
    assert.equal(await page.locator('#scoreDisplay').textContent(), 'Score: 80');
    assert.equal(await page.locator('#streakFeedback').textContent(), 'Multi-Throw + Slow-Mo');

    const slowed = await page.evaluate(() => {
        generateObstacle();
        generateTarget();
        targets[0].y = 200;
        const startingX = fieldWidth;
        stepGame(0);
        return [startingX - obstacles[0].x, startingX - targets[0].x];
    });
    assert.deepEqual(slowed, [3.25, 3.25]);
    const restored = await page.evaluate(() => {
        const prevX = obstacles[0].x;
        stepGame(500);
        return prevX - obstacles[0].x;
    });
    assert.equal(restored, 5);
    assert.equal(await page.getByText(/^Slow-Mo ·/).count(), 0);

    // The central projectile hits. The two wings expire and must preserve the streak.
    await page.keyboard.press('t');
    const spread = await page.evaluate(() => {
        const xVelocities = projectiles.map(projectile => projectile.vx);
        Object.assign(targets[0], { x: playerX, y: 200 });
        Object.assign(projectiles[0], { y: 1, vy: -19 });
        Object.assign(projectiles[1], { y: 219, vy: -19 });
        stepGame(0);
        Object.assign(projectiles[0], { y: 1, vy: -19 });
        stepGame(0);
        return xVelocities;
    });
    assert.deepEqual(spread, [-3, 0, 3]);
    assert.match(await page.locator('#streakDisplay').textContent(), /Streak: 4 · Best: 4/);
    assert.equal(await page.getByText(/^Multi-Throw ·/).count(), 0);

    // After the next earned streak, an all-miss spread only breaks on the last exit.
    const spreadMiss = await page.evaluate(() => {
        streakRun.miss();
        for (let i = 0; i < 3; i++) streakRun.hit();
        tossCooldown = 0;
        toss();
        Object.assign(projectiles[0], { y: 1, vy: -19 });
        stepGame(0);
        const before = streakRun.streak;
        for (const projectile of projectiles) Object.assign(projectile, { y: 1, vy: -19 });
        stepGame(0);
        return [before, streakRun.streak];
    });
    assert.deepEqual(spreadMiss, [3, 0]);
    await page.evaluate(() => stepGame(12000));
    assert.equal(await page.locator('#streakPowers').textContent(), '');

    await page.evaluate(() => {
        streakRun.hit();
        endGame();
    });
    await page.locator('#restartButton').click();
    assert.match(await page.locator('#streakDisplay').textContent(), /Streak: 0 · Best: 0/);
    assert.equal(await page.locator('#streakFeedback').textContent(), '');
    assert.equal(await page.locator('#streakPowers').textContent(), '');
    assert.equal(await page.locator('.particle').count(), 0);
});
