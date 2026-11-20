import assert from 'node:assert/strict';

export const phoneViewports = [
    { width: 375, height: 812 },
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 812, height: 375 },
    { width: 844, height: 390 },
];

export async function openGame(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#loadingScreen').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'START GAME' }).waitFor();
}

export async function centerOf(page, selector) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} has no visible tap target`);
    const { width, height } = page.viewportSize();
    assert.ok(
        box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height,
        `${selector} is outside the mobile viewport: ${JSON.stringify(box)}`
    );
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

export async function tap(page, selector) {
    const { x, y } = await centerOf(page, selector);
    await page.touchscreen.tap(x, y);
}

export function playerPosition(page) {
    return page.locator('#player').evaluate(player => ({
        x: parseFloat(player.style.left),
        y: parseFloat(player.style.top),
    }));
}

function viewportPosition(page) {
    return page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
        scale: window.visualViewport.scale,
        visualX: window.visualViewport.offsetLeft,
        visualY: window.visualViewport.offsetTop,
    }));
}

async function sendTouch(cdp, type, touchPoints) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
}

async function jumpAndSteer(page, cdp, direction) {
    const start = await playerPosition(page);
    const arrow = { ...await centerOf(page, `#${direction}Button`), id: 1 };
    const jump = { ...await centerOf(page, '#jumpButton'), id: 2 };
    await sendTouch(cdp, 'touchStart', [arrow]);
    await sendTouch(cdp, 'touchStart', [arrow, jump]);
    try {
        await page.waitForFunction(({ start, direction }) => {
            const { left, top } = document.getElementById('player').style;
            const dx = parseFloat(left) - start.x;
            return parseFloat(top) < start.y - 25 && (direction === 'right' ? dx > 5 : dx < -5);
        }, { start, direction }, { timeout: 1500 });
    } finally {
        await sendTouch(cdp, 'touchEnd', []);
    }
    await page.waitForFunction(y => parseFloat(document.getElementById('player').style.top) === y,
        start.y, { timeout: 1800 });
}

async function verifyGesturesStayInGame(page, cdp) {
    const before = await viewportPosition(page);
    const { width, height } = page.viewportSize();
    const x = Math.round(width / 2);
    const y = Math.round(height / 2);

    await sendTouch(cdp, 'touchStart', [{ x, y, id: 1 }]);
    await sendTouch(cdp, 'touchMove', [{ x, y: y - 100, id: 1 }]);
    await sendTouch(cdp, 'touchEnd', []);

    await sendTouch(cdp, 'touchStart', [{ x: x - 24, y, id: 1 }, { x: x + 24, y, id: 2 }]);
    await sendTouch(cdp, 'touchMove', [{ x: x - 110, y, id: 1 }, { x: x + 110, y, id: 2 }]);
    await sendTouch(cdp, 'touchEnd', []);

    assert.deepEqual(await viewportPosition(page), before, 'Swipe or pinch moved the viewport');
}

async function verifyGameFits(page) {
    const { width, height } = page.viewportSize();
    const game = await page.locator('#gameContainer').boundingBox();
    assert.deepEqual(game, { x: 0, y: 0, width, height });
    const pageWidths = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
        window.visualViewport.width,
    ]);
    assert.deepEqual(pageWidths, [width, width, width], 'The game overflows the phone viewport');
}

export async function runTouchLoop(browser, url, viewport, { screenshot, preparePage } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    try {
        const page = await context.newPage();
        await preparePage?.(page);
        const cdp = await context.newCDPSession(page);
        await openGame(page, url);
        await verifyGameFits(page);
        const before = await viewportPosition(page);
        assert.deepEqual(before, { x: 0, y: 0, scale: 1, visualX: 0, visualY: 0 });
        const controls = page.locator('#controls');
        const gameOver = page.locator('#gameOver');

        await tap(page, '#startButton');
        await controls.waitFor();
        await verifyGameFits(page);
        await jumpAndSteer(page, cdp, 'right');
        await tap(page, '#tossButton');
        await page.locator('.projectile').first().waitFor({ timeout: 1200 });
        await verifyGesturesStayInGame(page, cdp);

        if (screenshot) await page.screenshot({ path: screenshot });

        await gameOver.waitFor({ timeout: 10000 });
        await controls.waitFor({ state: 'hidden' });
        await tap(page, '#scoreForm button');
        await page.locator('#leaderboardDisplayGameOver').getByText(/1\. Player:/).waitFor();

        await tap(page, '#restartButton');
        await controls.waitFor();
        await jumpAndSteer(page, cdp, 'left');
        await gameOver.waitFor({ timeout: 10000 });
        await tap(page, '#mainMenuButton');
        await page.locator('#startButton').waitFor();

        assert.deepEqual(await viewportPosition(page), before, 'Playing or returning to the menu moved the viewport');
        return { viewport, start: true, jump: true, toss: true, steerBothWays: true, replay: true, menu: true, viewportPosition: before };
    } finally {
        await context.close();
    }
}
