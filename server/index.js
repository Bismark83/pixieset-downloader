require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const archiver = require('archiver');
const https = require('https');
const fs = require('fs');

console.log('--- SERVER STARTING ---');
console.log('Current directory:', __dirname);
console.log('Process.env.PORT:', process.env.PORT);

const app = express();
app.use(cors());
// Increase JSON payload size limit for large image arrays
app.use(express.json({ limit: '50mb' }));

// Serve the built React client if it exists (production mode)
const clientDist = path.join(__dirname, '..', 'client', 'dist');
const isProduction = fs.existsSync(clientDist);

console.log('Production mode (dist folder found):', isProduction);
if (isProduction) {
    app.use(express.static(clientDist));
}



// Global Browser Instance with Auto-Relaunch
let globalBrowser;
const launchBrowser = async () => {
    try {
        if (globalBrowser) await globalBrowser.close().catch(() => {});
        globalBrowser = await chromium.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        });
        console.log("--- BROWSER POOL RELAUNCHED ---");
    } catch (e) {
        console.error("CRITICAL: Failed to launch browser:", e);
    }
};
launchBrowser();

// Scraping Concurrency Limit (Semaphore)
let activeScrapes = 0;
const MAX_CONCURRENT_SCRAPES = 2; // Pixieset is heavy; 2 is safe for most small VPS/Railway tiers
const scrapeQueue = [];

const processScrapeQueue = () => {
    if (activeScrapes < MAX_CONCURRENT_SCRAPES && scrapeQueue.length > 0) {
        const { resolve } = scrapeQueue.shift();
        activeScrapes++;
        resolve();
    }
};

const waitForScrapeSlot = () => new Promise(resolve => {
    scrapeQueue.push({ resolve });
    processScrapeQueue();
});


// Deleted in-memory store for paid galleries

// Downloads an image to a Buffer with a hard 20-second timeout.
// Using a buffer (not a stream) prevents a hung CDN connection from freezing the archiver.
const downloadImageBuffer = (url, timeoutMs = 20000) => {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://pixieset.com/'
            }
        }, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Follow redirect
                return downloadImageBuffer(response.headers.location, timeoutMs).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                response.resume(); // Drain the response body
                return reject(new Error(`HTTP ${response.statusCode}`));
            }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });

        // Hard timeout: destroy the request if it takes too long
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
        });
        req.on('error', reject);
    });
};

// Endpoint 1: Extract Image URLs from Pixieset
// Health check for Railway
app.get('/api/health', (req, res) => {
    console.log('Health check requested at /api/health');
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Always provide a response for / to help health checks
app.get('/', (req, res) => {
    if (isProduction) {
        res.sendFile(path.join(clientDist, 'index.html'));
    } else {
        res.send('Server is running (Development mode - Dist not found)');
    }
});


app.post('/api/extract', async (req, res) => {
    const { url } = req.body;

    if (!url || !url.includes('pixieset.com')) {
        return res.status(400).json({ error: 'Invalid Pixieset URL' });
    }

    console.log(`Extraction request: ${url} (Queue: ${scrapeQueue.length}, Active: ${activeScrapes})`);
    
    await waitForScrapeSlot();
    let context;

    try {
        if (!globalBrowser || !globalBrowser.isConnected()) {
            await launchBrowser();
        }

        context = await globalBrowser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        
        // Block only heavy non-image resources (stylesheets, fonts, media)
        // We allow images so lazy-load JS can properly populate srcset URLs
        await context.route('**/*', route => {
            const type = route.request().resourceType();
            if (['stylesheet', 'font', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        const page = await context.newPage();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000); // Wait for Cloudflare / JS to settle

        // --- STEP 1: Try to click through any cover/landing page ---
        try {
            const coverBtn = await page.$('.js-scroll-past-cover');
            if (coverBtn) {
                await coverBtn.evaluate(node => node.click());
                await page.waitForTimeout(1500);
            } else {
                // Fallback: click any element that clearly says "View Gallery"
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('a, button, div, span'));
                    for (const b of btns) {
                        const text = (b.innerText || '').toLowerCase().trim();
                        if (text === 'view gallery' || text === 'open gallery') {
                            b.click();
                        }
                    }
                });
                await page.waitForTimeout(2000);
            }
        } catch (e) {
            console.log('Cover click step:', e.message);
        }

        // --- STEP 2: Handle multi-album galleries ---
        // If the page has very few images, it may be an album-list page.
        // We try to find and click a PHOTO album (skipping video/highlight albums).
        try {
            const imgCountBeforeAlbum = await page.evaluate(() => 
                document.querySelectorAll('img[srcset], img[data-srcset], img[data-src]').length
            );

            if (imgCountBeforeAlbum < 5) {
                console.log('Looks like an album/cover page, scanning for photo albums...');

                // Words that indicate this is NOT a photo album
                const videoKeywords = ['video', 'highlight', 'film', 'reel', 'clip', 'teaser'];

                // Collect all candidate sub-album links sorted by likely-photo-album priority
                const albumLinks = await page.evaluate((videoKw) => {
                    const seen = new Set();
                    const results = [];
                    Array.from(document.querySelectorAll('a[href]')).forEach(a => {
                        try {
                            const href = a.href || '';
                            const text = (a.innerText || '').trim().toLowerCase();
                            const parsed = new URL(href);
                            // Must be same origin sub-path (at least 2 path segments)
                            if (parsed.origin !== window.location.origin) return;
                            const parts = parsed.pathname.split('/').filter(Boolean);
                            if (parts.length < 2) return;
                            // Skip nav/utility links
                            const navWords = ['download', 'share', 'contact', 'home', 'about', 'cart', 'login'];
                            if (navWords.some(w => text.includes(w) || href.includes(w))) return;
                            if (seen.has(href)) return;
                            seen.add(href);
                            const isVideo = videoKw.some(w => text.includes(w) || parsed.pathname.toLowerCase().includes(w));
                            results.push({ href, text, isVideo });
                        } catch (e) {}
                    });
                    // Photo albums first, video albums last
                    return results.sort((a, b) => (a.isVideo ? 1 : -1) - (b.isVideo ? 1 : -1));
                }, videoKeywords);

                console.log(`Found ${albumLinks.length} candidate albums:`, albumLinks.map(a => a.text || a.href));

                // Try each album in order until we get images
                for (const album of albumLinks) {
                    console.log(`Navigating into album: "${album.text}" → ${album.href}`);
                    await page.goto(album.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await page.waitForTimeout(2500);

                    // Quick scroll to trigger lazy load
                    await page.evaluate(() => {
                        for (let i = 0; i < 10; i++) window.scrollBy(0, window.innerHeight);
                    });
                    await page.waitForTimeout(1000);

                    const count = await page.evaluate(() =>
                        document.querySelectorAll('img[srcset], img[data-srcset], img[data-src], img[src]').length
                    );
                    console.log(`Album "${album.text}" has ${count} img elements`);
                    if (count >= 3) break; // Found a real photo album, stop here
                }
            }
        } catch (e) {
            console.log('Album navigation step:', e.message);
        }

        // --- STEP 3: Smart scroll to trigger ALL lazy loading ---
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let lastHeight = document.body.scrollHeight;
                let retries = 0;
                const timer = setInterval(() => {
                    window.scrollBy(0, 2500);
                    const currentHeight = document.body.scrollHeight;
                    if (currentHeight === lastHeight) {
                        retries++;
                        if (retries >= 20) { clearInterval(timer); resolve(); }
                    } else {
                        retries = 0;
                        lastHeight = currentHeight;
                    }
                }, 150);
            });
        });

        // --- STEP 3.5: Force-trigger all lazy loads so srcset gets populated ---
        await page.evaluate(() => {
            document.querySelectorAll('img').forEach(img => {
                // Copy data-src -> src and data-srcset -> srcset to trigger lazy loaders
                const dSrc = img.getAttribute('data-src');
                const dSrcset = img.getAttribute('data-srcset');
                if (dSrc) img.src = dSrc;
                if (dSrcset) img.srcset = dSrcset;
            });
        });
        await page.waitForTimeout(500);

        // --- STEP 4: Extract HIGHEST quality image URLs ---
        const imageUrls = await page.evaluate(() => {
            const seen = new Set();
            const results = [];

            const upgradeUrl = (src) => {
                if (!src) return null;
                // Strip query string before processing
                const base = src.split('?')[0];

                // Skip non-photo assets
                if (/pixieset\.com\/(img|assets|icons|logo)/i.test(base)) return null;
                if (/\/(icon|logo|favicon|pixel\.)/i.test(base)) return null;
                if (/-cover|-cover_/i.test(base)) return null;
                if (!/\.(jpg|jpeg|png|webp)/i.test(base)) return null;

                // Upgrade size suffix: replace any known size with xxlarge
                let upgraded = base
                    .replace(/-xsmall\./, '-xxlarge.')
                    .replace(/-small\./, '-xxlarge.')
                    .replace(/-medium\./, '-xxlarge.')
                    .replace(/-large\./, '-xxlarge.')
                    .replace(/-xlarge\./, '-xxlarge.');

                // Also handle path-based sizes
                upgraded = upgraded
                    .replace(/\/xsmall\//, '/xxlarge/')
                    .replace(/\/small\//, '/xxlarge/')
                    .replace(/\/medium\//, '/xxlarge/')
                    .replace(/\/large\//, '/xxlarge/')
                    .replace(/\/xlarge\//, '/xxlarge/');

                return upgraded.startsWith('http') ? upgraded : `https:${upgraded}`;
            };

            const add = (src) => {
                const url = upgradeUrl(src);
                if (!url) return;
                if (!seen.has(url)) {
                    seen.add(url);
                    results.push(url);
                }
            };

            document.querySelectorAll('img').forEach(img => {
                // Priority 1: srcset (contains multiple resolutions — pick highest by 'w' descriptor)
                const srcsetStr = img.getAttribute('srcset') || img.getAttribute('data-srcset');
                if (srcsetStr) {
                    const entries = srcsetStr.split(',')
                        .map(s => s.trim().split(/\s+/))
                        .filter(s => s[0]);
                    // Sort by width descriptor descending (e.g. 2048w > 1024w)
                    entries.sort((a, b) => {
                        const wa = parseInt((a[1] || '0').replace(/\D/g, ''), 10);
                        const wb = parseInt((b[1] || '0').replace(/\D/g, ''), 10);
                        return wb - wa;
                    });
                    if (entries.length > 0) {
                        add(entries[0][0]);
                        return; // srcset found, skip src fallback
                    }
                }

                // Priority 2: data-src (lazy load placeholder for final URL)
                const dataSrc = img.getAttribute('data-src');
                if (dataSrc) { add(dataSrc); return; }

                // Priority 3: src (final fallback — might be low-res)
                const src = img.getAttribute('src');
                if (src && !src.startsWith('data:')) add(src);
            });

            return results;
        });

        console.log(`Found ${imageUrls.length} images.`);

        if (imageUrls.length === 0) {
            const debugInfo = await page.evaluate(() => ({
                title: document.title,
                htmlSnippet: document.body.innerText.substring(0, 400),
                allImgsCount: document.querySelectorAll('img').length,
                url: window.location.href,
            }));
            console.log("Debug Info:", debugInfo);
            return res.status(404).json({ error: 'No images found. The gallery may require a password or is using a layout our scraper hasn\'t seen before.', debug: debugInfo });
        }

        res.json({ images: imageUrls });

    } catch (error) {
        console.error('Error processing gallery:', error);
        res.status(500).json({ error: 'Failed to extract gallery: ' + error.message });
    } finally {
        if (context) await context.close();
        activeScrapes--;
        processScrapeQueue(); // Trigger next in line
    }
});



// Endpoint 2: Download provided images as a ZIP
app.post('/api/zip', async (req, res) => {
    const { images, filename } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
        return res.status(400).json({ error: 'No images provided for zipping.' });
    }

    console.log(`Starting ZIP for ${images.length} images...`);

    try {
        const zipName = filename ? `${filename}.zip` : 'pixieset_gallery.zip';
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 0 } }); // Store-only = maximum speed for JPEGs
        archive.on('warning', err => { if (err.code !== 'ENOENT') throw err; });
        archive.on('error', err => { throw err; });
        archive.pipe(res);

        // ── Proper concurrent queue (not batches) ──────────────────────────────
        // A batch approach causes ALL workers to wait for the SLOWEST image.
        // A queue keeps CONCURRENCY workers always busy until everything is done.
        const CONCURRENCY = 8; // Lower than before — prevents CDN rate-limiting
        const queue = images.map((url, i) => ({ url, i }));
        let active = 0;
        let failed = 0;

        await new Promise((resolve) => {
            const next = () => {
                // If queue empty and nothing active, we're done
                if (queue.length === 0 && active === 0) return resolve();

                // Spawn workers up to concurrency limit
                while (active < CONCURRENCY && queue.length > 0) {
                    const { url, i } = queue.shift();
                    active++;

                    let fname = `image_${String(i + 1).padStart(4, '0')}.jpg`;
                    try {
                        const parts = new URL(url).pathname.split('/');
                        const last = parts[parts.length - 1].split('?')[0];
                        if (last && last.includes('.')) fname = last;
                    } catch (_) {}

                    downloadImageBuffer(url)
                        .then(buffer => {
                            archive.append(buffer, { name: fname });
                            console.log(`[${i + 1}/${images.length}] ✓ ${fname} (${(buffer.length / 1024).toFixed(0)}KB)`);
                        })
                        .catch(err => {
                            failed++;
                            console.warn(`[${i + 1}/${images.length}] ✗ Skipped: ${err.message}`);
                        })
                        .finally(() => {
                            active--;
                            next(); // Immediately pick up the next item
                        });
                }
            };

            next(); // Kick off the queue
        });

        console.log(`ZIP complete. ${images.length - failed} added, ${failed} skipped.`);
        await archive.finalize();

    } catch (error) {
        console.error('ZIP error:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to create ZIP: ' + error.message });
    }
});


// Endpoint 3: Download single image (Fixing broken stream call)
app.get('/api/download-single', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'No URL provided' });
    
    try {
        const buffer = await downloadImageBuffer(url);
        let filename = 'image.jpg';
        try {
            const parsedUrl = new URL(url);
            const pathParts = parsedUrl.pathname.split('/');
            const lastPart = pathParts[pathParts.length - 1];
            if (lastPart && lastPart.includes('.')) {
                filename = lastPart.split('?')[0];
            }
        } catch (e) {}
        
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error('Single download error:', err);
        res.status(500).json({ error: 'Failed to download image' });
    }
});


// Serve React SPA for all non-API routes (only in production)
if (isProduction) {
    app.get('/{*splat}', (req, res) => {
        res.sendFile(path.join(clientDist, 'index.html'));
    });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`--- SERVER IS LIVE ON PORT ${PORT} ---`);
});
