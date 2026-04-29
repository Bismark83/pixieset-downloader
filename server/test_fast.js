const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function test() {
    const url = 'https://pictureperf8ct.pixieset.com/pastorandrewniithompson/';
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    
    await context.route('**/*', route => {
        const type = route.request().resourceType();
        if (['stylesheet', 'font', 'media', 'image'].includes(type)) {
            route.abort();
        } else {
            route.continue();
        }
    });

    const page = await context.newPage();
    const startTime = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    try {
        const enterButton = await page.$('.js-scroll-past-cover, a.btn, button.btn');
        if (enterButton) {
            await enterButton.evaluate(node => node.click());
            await page.waitForTimeout(500);
        }
    } catch(e) {}
    
    const images = await page.evaluate(async () => {
        return new Promise((resolve) => {
            let lastHeight = document.body.scrollHeight;
            let retries = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, 3000);
                const currentHeight = document.body.scrollHeight;
                if (currentHeight === lastHeight) {
                    retries++;
                    if (retries >= 10) { // 1 second
                        clearInterval(timer);
                        resolve(document.querySelectorAll('img').length);
                    }
                } else {
                    retries = 0;
                    lastHeight = currentHeight;
                }
            }, 100);
        });
    });
    
    const timeTaken = (Date.now() - startTime) / 1000;
    console.log(`Images found: ${images} in ${timeTaken} seconds`);
    
    await browser.close();
}

test();
