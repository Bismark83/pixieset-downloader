const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function test() {
    const url = 'https://pictureperf8ct.pixieset.com/pastorandrewniithompson/';
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    try {
        const enterButton = await page.$('.js-scroll-past-cover, a.btn, button.btn');
        if (enterButton) {
            await enterButton.evaluate(node => node.click());
            console.log("Clicked cover button");
            await page.waitForTimeout(2000);
        }
    } catch(e) {}
    
    // Better scrolling strategy
    const images = await page.evaluate(async () => {
        return new Promise((resolve) => {
            let lastHeight = document.body.scrollHeight;
            let retries = 0;
            
            const timer = setInterval(() => {
                window.scrollBy(0, 1000);
                const currentHeight = document.body.scrollHeight;
                
                if (currentHeight === lastHeight) {
                    retries++;
                    if (retries >= 15) { // 1.5 seconds of no new content
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
    
    console.log("Images found after better scroll:", images);
    await browser.close();
}

test();
