const express = require('express');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const cors = require('cors');

const app = express();
const PORT = 3000;
const BASE_PATH = '/api/screenshot-service'; // 新增基礎路徑
const BASE_OUTPUT_DIR = '/neux/screenshot-reports/output';
const ZIP_OUTPUT_DIR = '/neux/screenshot-reports/output';
const MAX_THREADS = 2;
const sessionData = {};
const titlesData = {};

// 確保目錄存在的函數
function ensureDirectoryExists(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

// 初始化時確保目錄存在
ensureDirectoryExists(BASE_OUTPUT_DIR);
ensureDirectoryExists(ZIP_OUTPUT_DIR);

const progressEmitter = new EventEmitter();

// 基本中間件設定
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 調整靜態檔案路徑
app.use(`${BASE_PATH}/output`, express.static(BASE_OUTPUT_DIR));
app.use(`${BASE_PATH}/zipped_output`, express.static(ZIP_OUTPUT_DIR));

// CORS 設定
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['*'],
  exposedHeaders: ['*']
}));

// 修改路由以包含基礎路徑
app.post(`${BASE_PATH}/screenshot`, async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Content-Type', 'application/json');
  
  const { urls, headerHeight, widths, heights, fullPage, browserType, username, password, sessionId } = req.body;
  const timestamp = Date.now();
  const screenshotDir = `screenshots_${sessionId}_${timestamp}`;
  const outputDir = path.join(BASE_OUTPUT_DIR, screenshotDir);
  const zipFilePath = path.join(ZIP_OUTPUT_DIR, `${screenshotDir}.zip`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  const totalTasks = urls.length * widths.length;
  let completedTasks = 0;

  const workers = [];
  let activeThreads = 0;
  const queue = [];

  sessionData[sessionId] = {
    screenSizes: widths.map((width, index) => `${width}*${heights[index]}`),
    datas: []
  };

  const createWorker = (workerData) => {
    const worker = new Worker(path.join(__dirname, 'screenshotWorker.js'), { workerData });

    worker.on('message', (progress) => {
      if (progress.title) {
        const existingEntry = sessionData[sessionId].datas.find(item => item.url === workerData.url);
        if (!existingEntry) {
          sessionData[sessionId].datas.push({
            title: progress.title,
            url: workerData.url
          });
          console.log(`Added title for session ${sessionId}: ${progress.title}`);
        }
      } else {
        completedTasks += progress.completed;
        progressEmitter.emit('progress', { completedTasks, totalTasks, sessionId });
      }
    });

    worker.on('error', (error) => {
      console.error('Worker error:', error);
    });

    worker.on('exit', (code) => {
      activeThreads--;
      if (code !== 0) {
        console.error(`Worker stopped with exit code ${code}`);
      }
      if (queue.length > 0) {
        queue.shift()();
      }
    });

    workers.push(worker);
    activeThreads++;
  };

  urls.forEach((url) => {
    widths.forEach((width, i) => {
      const height = heights[i];
      const workerData = {
        url,
        headerHeight,
        width,
        height,
        fullPage,
        browserType,
        username,
        password,
        outputDir,
        sessionId,
        isFirstWidth: i === 0
      };
  
      if (activeThreads < MAX_THREADS) {
        createWorker(workerData);
      } else {
        queue.push(() => createWorker(workerData));
      }
    });
  });

  const compressFiles = (files, outputPath) => {
    return new Promise((resolve, reject) => {
      let archive = archiver('zip', { zlib: { level: 9 } });
      let output = fs.createWriteStream(outputPath);
      archive.pipe(output);

      output.on('close', () => {
        resolve();
      });

      archive.on('error', (err) => {
        reject(err);
      });

      files.forEach((file) => {
        const filePath = path.join(outputDir, file);
        archive.file(filePath, { name: file });
      });

      archive.finalize();
    });
  };

  const jsonFilePath = path.join(outputDir, 'test-list.json');

  progressEmitter.on('progress', (progress) => {
    if (progress.sessionId === sessionId && completedTasks === totalTasks) {
      fs.writeFileSync(jsonFilePath, JSON.stringify(sessionData[sessionId], null, 2));
      
      const allFiles = fs.readdirSync(outputDir);
      compressFiles(allFiles, zipFilePath)
        .then(() => {
          res.json({ 
            downloadLinks: [`${BASE_PATH}/output/${screenshotDir}.zip`],
            outputDir: `${BASE_PATH}/output/${screenshotDir}`,
          });
        })
        .catch((err) => {
          console.error('Error during archiving process:', err);
          res.status(500).json({ error: err.message });
        });
    }
  });
});

app.get(`${BASE_PATH}/screenshot-progress`, (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Base path: ${BASE_PATH}`);
});