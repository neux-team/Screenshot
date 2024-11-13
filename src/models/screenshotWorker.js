const { workerData, parentPort } = require('worker_threads');
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');

// 新增頁面載入函數
async function waitForPageLoad(page, url) {
  console.log(`[waitForPageLoad]`);
  try {
    console.log(`等待頁面基本載入中`),
    // 增加頁面載入超時時間到 半分鐘
    await page.goto(url, { 
      waitUntil: 'networkidle',
      timeout: 29000  // 半分鐘
    });
  } catch (error) {
    console.log(`頁面載入超時，但將繼續執行: ${error.message}`);
  }

  try {
    // 等待頁面基本載入狀態
    await Promise.allSettled([
      console.log(`等待頁面基本載入中`),
      page.waitForLoadState('domcontentloaded', { timeout: 29000 }),
      page.waitForLoadState('networkidle', { timeout: 29000 })
    ]);
  } catch (error) {
    console.log(`等待頁面載入狀態時超時: ${error.message}`);
  }

  // 確保頁面渲染的基本等待時間
  await page.waitForTimeout(2000);

  // 檢查頁面準備狀態
  const isPageReady = await page.evaluate(() => {
    return new Promise((resolve) => {
      if (document.readyState === 'complete') {
        resolve(true);
      } else {
        window.addEventListener('load', () => resolve(true));
        setTimeout(() => resolve(false), 10000);
      }
    });
  });

  if (!isPageReady) {
    console.log('頁面可能未完全載入，但將繼續執行');
  }

  // 等待所有圖片載入
  try {
    await page.evaluate(() => {
      return Promise.all(
        Array.from(document.images)
          .filter(img => !img.complete)
          .map(img => new Promise(resolve => {
            img.onload = img.onerror = resolve;
          }))
      );
    });
  } catch (error) {
    console.log('等待圖片載入時出現錯誤，但將繼續執行');
  }
}

async function takeScreenshot() {
  console.log(`[takeScreenshot]`);
  const { url, headerHeight, width, height, fullPage, browserType, username, password, outputDir, isFirstWidth } = workerData;

  try {
    console.log('開始截圖作業...');
    console.log(`URL: ${url}`);
    console.log(`瀏覽器類型: ${browserType}`);
    console.log(`header高度: ${headerHeight}`);
    console.log(`寬度: ${width}`);
    console.log(`高度: ${height}`);
    console.log(`是否全頁截圖: ${fullPage}`);
    console.log(`輸出目錄: ${outputDir}`);

    if (!['chromium', 'firefox', 'webkit'].includes(browserType)) {
      throw new Error(`無效的瀏覽器類型: ${browserType}`);
    }

    const credentials = username && password ? { username, password } : undefined;
    if (credentials) {
      console.log('使用登入憑證進行操作...');
    } else {
      console.log('未提供登入憑證。');
    }

    const browser = await playwright[browserType].launch({ 
      headless: true,
      args: ['--disable-web-security', '--disable-features=IsolateOrigins', '--disable-site-isolation-trials']
    });
    
    const context = await browser.newContext({
      viewport: { width: parseInt(width, 10), height: parseInt(height, 10) },
      httpCredentials: credentials,
    });

    const page = await context.newPage();
    console.log('正在導航至目標 URL...');
    
    // 使用新的頁面載入函數
    await waitForPageLoad(page, url);

    // 等待動態內容
    try {
      await Promise.allSettled([
        console.log('等待 nav加載中...'),
        page.waitForSelector('nav', { timeout: 10000 }),
        console.log('等待 main加載中...'),
        page.waitForSelector('main', { timeout: 10000 }),
        console.log('等待 header加載中...'),
        page.waitForSelector('header', { timeout: 10000 }),
        console.log('等待 footer加載中...'),
        page.waitForSelector('footer', { timeout: 10000 })
      ]);
    } catch (error) {
      console.log('等待頁面元素時超時，但將繼續執行');
    }

    if (isFirstWidth) {
      const pageTitle = await page.title();
      parentPort.postMessage({ title: pageTitle });
      console.log(`頁面標題: ${pageTitle}`);
    }

    const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const sanitizedUrl = url.replace(/^https?:\/\//, '').replace(/[\/\:*?"<>|]/g, '_');
    const fileName = `${sanitizedUrl}_${width}x${height}.jpg`;
    const filePath = path.join(outputDir, fileName);
    const fileNamePrefix = `${sanitizedUrl}_${width}x${height}`;

    if (fullPage || (height >= totalHeight)) {
      // 全頁截圖前的額外等待
      await page.waitForTimeout(2000);
      await page.screenshot({ 
        path: filePath, 
        type: 'jpeg', 
        quality: 80, 
        fullPage: true,
        timeout: 60000  // 增加截圖超時時間
      });
      console.log(`全頁截圖已儲存至 ${filePath}`);
    } else {
      let yOffset = 0;
      let part = 1;
      const totalPart = Math.ceil(totalHeight / (height - headerHeight));
      const scrollBottom = totalHeight - height;
      console.log(`總分段數:${totalPart} 開始進行分段截圖...`);

      while (yOffset <= scrollBottom && part <= totalPart) {
        console.log(`當前 yOffset: ${yOffset}, 預計總高度: ${totalHeight}`);
        await page.evaluate((y) => window.scrollTo(0, y), yOffset);
        
        // 滾動後等待內容載入和穩定
        await page.waitForTimeout(2000);
        await page.evaluate(() => new Promise(resolve => {
          const images = Array.from(document.getElementsByTagName('img'));
          if (images.every(img => img.complete)) {
            resolve();
          } else {
            Promise.all(images.map(img => {
              if (img.complete) return Promise.resolve();
              return new Promise(resolve => {
                img.onload = img.onerror = resolve;
              });
            })).then(resolve);
          }
        }));

        const partFilePath = path.join(outputDir, `${fileNamePrefix}-${part}.jpg`);
        await page.screenshot({ 
          path: partFilePath, 
          type: 'jpeg', 
          quality: 80, 
          fullPage: false,
          timeout: 30000  // 分段截圖的超時時間
        });
        console.log(`分段截圖 ${part} 已儲存至 ${partFilePath}`);

        part += 1;
        if (part != totalPart) {
          yOffset = parseInt(yOffset, 10) + parseInt(height - headerHeight, 10);
        } else {
          yOffset = scrollBottom;
        }

        console.log(`更新後的 yOffset: ${yOffset} totalHeight: ${totalHeight}`);
      }
    }

    await browser.close();
    parentPort.postMessage({ completed: 1 });

  } catch (error) {
    console.error(`截圖過程發生錯誤 (${url}, 寬度 ${width}):`, error);
    try {
      if (browser) {
        await browser.close();
      }
    } catch (closeError) {
      console.error('關閉瀏覽器時發生錯誤:', closeError);
    }
  }
}

takeScreenshot()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Worker 執行錯誤:', error);
    process.exit(1);
  });