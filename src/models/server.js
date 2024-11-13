const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const cors = require('cors');

const app = express();
const PORT = 3000;
const BASE_PATH = '/api/screenshot-service';
const BASE_OUTPUT_DIR = '/neux/screenshot-reports/output';
const ZIP_OUTPUT_DIR = '/neux/screenshot-reports/output';
const MAX_EXECUTION_TIME = 300000; // 5分鐘超時
const MAX_FILE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessionData = new Map(); // 改用 Map 來存儲 session 數據

// 確保目錄存在的函數
function ensureDirectoryExists(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

// 清理舊文件的函數
function cleanupOldFiles() {
  try {
    const now = Date.now();
    const files = fs.readdirSync(BASE_OUTPUT_DIR);
    files.forEach(file => {
      const filePath = path.join(BASE_OUTPUT_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtime.getTime() > MAX_FILE_AGE) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (error) {
    console.error('Error in cleanup:', error);
  }
}

// 初始化
ensureDirectoryExists(BASE_OUTPUT_DIR);
ensureDirectoryExists(ZIP_OUTPUT_DIR);
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000); // 每24小時清理一次

const progressEmitter = new EventEmitter();

// 基本中間件設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(`${BASE_PATH}/output`, express.static(BASE_OUTPUT_DIR));
app.use(`${BASE_PATH}/zipped_output`, express.static(ZIP_OUTPUT_DIR));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['*'],
  exposedHeaders: ['*']
}));

// Worker 管理函數
async function terminateWorker(worker) {
  try {
    if (worker) {
      await worker.terminate();
    } else {
      console.warn('Attempted to terminate an undefined worker');
    }
  } catch (error) {
    console.error('Error terminating worker:', error);
  }
}

// 添加 URL 處理和延遲函數
function groupAndSortUrls(urls) {
  const urlGroups = new Map();

  // 將 URL 按域名分組並排序
  urls.forEach(url => {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;
      if (!urlGroups.has(domain)) {
        urlGroups.set(domain, []);
      }
      const urlList = urlGroups.get(domain);

      // 根路徑放到最後
      if (urlObj.pathname === '/' || urlObj.pathname === '') {
        urlList.push(url);
      } else {
        urlList.unshift(url);
      }
    } catch (error) {
      console.error(`Invalid URL: ${url}`, error);
    }
  });
  // 展平並返回排序後的 URL 列表
  const sortedUrls = [];
  urlGroups.forEach(urls => {
    sortedUrls.push(...urls);
  });

  return sortedUrls;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cleanupWorkers(workers) {
  try {
    workers.forEach(worker => terminateWorker(worker));
    workers.length = 0;
  } catch (error) {
    console.error('Error cleaning up workers:', error);
  }
}

app.post(`${BASE_PATH}/screenshot`, async (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json'
  };
  Object.entries(corsHeaders).forEach(([key, value]) => res.header(key, value));

  let timeoutId;
  const workers = [];

  try {
    const { urls: originalUrls, headerHeight, widths, heights, fullPage, browserType, username, password, sessionId } = req.body;

    // 處理並排序 URLs
    const sortedUrls = groupAndSortUrls(originalUrls);

    const timestamp = Date.now();
    const screenshotDir = `screenshots_${sessionId}_${timestamp}`;
    const outputDir = path.join(BASE_OUTPUT_DIR, screenshotDir);
    const zipFilePath = path.join(ZIP_OUTPUT_DIR, `${screenshotDir}.zip`);

    ensureDirectoryExists(outputDir);

    const totalTasks = sortedUrls.length * widths.length;
    let completedTasks = 0;
    const queue = [];

    sessionData.set(sessionId, {
      screenSizes: widths.map((width, index) => `${width}*${heights[index]}`),
      datas: []
    });

    // 設置超時處理
    timeoutId = setTimeout(async () => {
      if (completedTasks !== totalTasks) {
        await cleanupWorkers(workers);
        sessionData.delete(sessionId);
        res.status(408).json({ error: 'Operation timed out' });
      }
    }, MAX_EXECUTION_TIME);

    const createWorker = async (workerData) => {
      try {
        // 為同域名的請求添加延遲
        if (queue.length > 0) {
          const currentUrlObj = new URL(workerData.url);
          const lastUrl = queue[queue.length - 1]?.url;
          if (lastUrl) {
            const lastUrlObj = new URL(lastUrl);
            if (currentUrlObj.hostname === lastUrlObj.hostname) {
              await delay(2000); // 同域名請求間延遲 2 秒
            }
          }
        }

        const worker = new Worker(path.join(__dirname, 'screenshotWorker.js'), { workerData });

        worker.on('message', (progress) => {
          if (progress.title) {
            const sessionInfo = sessionData.get(sessionId);
            if (sessionInfo) {
              const existingEntry = sessionInfo.datas.find(item => item.url === workerData.url);
              if (!existingEntry) {
                sessionInfo.datas.push({
                  title: progress.title,
                  url: workerData.url
                });
              }
            }
          } else {
            completedTasks += progress.completed;
            progressEmitter.emit('progress', { completedTasks, totalTasks, sessionId });
          }
        });

        worker.on('error', async (error) => {
          console.error('Worker error:', error);
          await terminateWorker(worker);
        });

        worker.on('exit', async (code) => {
          if (code !== 0) {
            console.error(`Worker stopped with exit code ${code}`);
          }
          await terminateWorker(worker);
          if (queue.length > 0) {
            const nextTask = queue.shift();
            await createWorker(nextTask);
          }
        });

        workers.push(worker);
      } catch (error) {
        console.error('Error creating worker:', error);
        throw error;
      }
    };

    const compressFiles = (files, outputPath) => {
      return new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const output = fs.createWriteStream(outputPath);

        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);
        files.forEach((file) => {
          const filePath = path.join(outputDir, file);
          archive.file(filePath, { name: file });
        });

        archive.finalize();
      });
    };

    // 創建工作隊列
    const tasks = [];
    sortedUrls.forEach((url) => {
      widths.forEach((width, i) => {
        tasks.push({
          url,
          headerHeight,
          width,
          height: heights[i],
          fullPage,
          browserType,
          username,
          password,
          outputDir,
          sessionId,
          isFirstWidth: i === 0
        });
      });
    });

    const jsonFilePath = path.join(outputDir, 'test-list.json');

    progressEmitter.once(`complete_${sessionId}`, async () => {
      try {
        clearTimeout(timeoutId);
        const sessionInfo = sessionData.get(sessionId);
        fs.writeFileSync(jsonFilePath, JSON.stringify(sessionInfo, null, 2));

        const allFiles = fs.readdirSync(outputDir);
        await compressFiles(allFiles, zipFilePath);

        // 清理資源
        await cleanupWorkers(workers);
        sessionData.delete(sessionId);

        res.json({
          downloadLinks: [`${BASE_PATH}/output/${screenshotDir}.zip`],
          outputDir: `${BASE_PATH}/output/${screenshotDir}`,
        });
      } catch (error) {
        console.error('Error in completion handler:', error);
        res.status(500).json({ error: error.message });
      }
    });

    progressEmitter.on('progress', (progress) => {
      if (progress.sessionId === sessionId && progress.completedTasks === progress.totalTasks) {
        progressEmitter.emit(`complete_${sessionId}`);
      }
    });

    // 啟動所有工作
    queue.push(...tasks);
    if (queue.length > 0) {
      await createWorker(queue.shift());
    }

  } catch (error) {
    console.error('Error in screenshot endpoint:', error);
    clearTimeout(timeoutId);
    await cleanupWorkers(workers);
    sessionData.delete(sessionId);
    res.status(500).json({ error: error.message });
  }
});

app.get(`${BASE_PATH}/screenshot-progress`, (req, res) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Credentials': 'true',
  };
  Object.entries(corsHeaders).forEach(([key, value]) => res.header(key, value));

  const sessionId = req.query.sessionId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const onProgress = (progress) => {
    if (progress.sessionId === sessionId) {
      res.write(`data: ${JSON.stringify(progress)}\n\n`);
    }
  };

  progressEmitter.on('progress', onProgress);

  req.on('close', () => {
    progressEmitter.removeListener('progress', onProgress);
  });
});

// 優雅關閉
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM signal. Cleaning up...');
  try {
    await cleanupWorkers(Array.from(sessionData.keys()).map(sessionId => sessionData.get(sessionId).workers));
    sessionData.clear();
    process.exit(0);
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Base path: ${BASE_PATH}`);
});
