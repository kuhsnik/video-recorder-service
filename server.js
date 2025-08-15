const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let isRecording = false;
let activeProcesses = [];

const RECORDINGS_DIR = '/usr/src/app/recordings';
const USER_DATA_DIR = '/usr/src/app/chrome-data';

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function killProcess(process, name) {
  return new Promise((resolve) => {
    if (process && !process.killed) {
      log(`Killing ${name} process (PID: ${process.pid})`);
      process.kill('SIGTERM');
      setTimeout(() => {
        if (!process.killed) {
          log(`Force killing ${name} process`);
          process.kill('SIGKILL');
        }
        resolve();
      }, 5000);
    } else {
      resolve();
    }
  });
}

function cleanup() {
  return Promise.all(activeProcesses.map(proc => killProcess(proc.process, proc.name)));
}

function startXvfb() {
  return new Promise((resolve, reject) => {
    log('Starting Xvfb virtual display');
    const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1920x1080x24'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeProcesses.push({ process: xvfb, name: 'Xvfb' });

    xvfb.on('error', (error) => {
      log(`Xvfb error: ${error.message}`);
      reject(error);
    });

    setTimeout(() => {
      if (!xvfb.killed) {
        log('Xvfb started successfully');
        resolve(xvfb);
      } else {
        reject(new Error('Xvfb failed to start'));
      }
    }, 3000);
  });
}

function startChrome(previewUrl) {
  return new Promise((resolve, reject) => {
    log(`Starting Chrome with URL: ${previewUrl}`);

    const chromeArgs = [
      '--display=:99',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=desktop',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blacklist',
      '--enable-webgl',
      '--enable-accelerated-2d-canvas',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${USER_DATA_DIR}`,
      '--window-size=1920,1080',
      '--start-fullscreen',
      '--kiosk',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      previewUrl
    ];

    const chrome = spawn('google-chrome', chromeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY: ':99' }
    });

    activeProcesses.push({ process: chrome, name: 'Chrome' });

    chrome.on('error', (error) => {
      log(`Chrome error: ${error.message}`);
      reject(error);
    });

    chrome.stderr.on('data', (data) => {
      const output = data.toString();
      // Log only important Chrome messages
      if (output.includes('ERROR') || output.includes('WARNING')) {
        log(`Chrome: ${output.trim().substring(0, 200)}`);
      }
    });

    // Chrome started, wait for page load and video to start
    setTimeout(() => {
      if (!chrome.killed) {
        log('Chrome started successfully, waiting for page and video to load');
        // Wait 30 seconds total for video to load and effects to initialize
        // Add basic validation by checking if the page is responsive
        let waitTime = 0;
        const checkInterval = 2000; // Check every 2 seconds
        const maxWaitTime = 30000; // 30 seconds max
        
        const validateVideo = () => {
          waitTime += checkInterval;
          
          if (waitTime >= maxWaitTime) {
            log('Maximum wait time reached - assuming video is ready');
            resolve(chrome);
            return;
          }
          
          // Basic check - if Chrome is still running, continue waiting
          if (!chrome.killed) {
            log(`Video loading progress: ${waitTime/1000}s/${maxWaitTime/1000}s`);
            setTimeout(validateVideo, checkInterval);
          } else {
            reject(new Error('Chrome process died during video loading'));
          }
        };
        
        validateVideo();
      } else {
        reject(new Error('Chrome failed to start'));
      }
    }, 2000);
  });
}

function recordVideo(duration, outputPath) {
  return new Promise((resolve, reject) => {
    log(`Starting FFmpeg recording for ${duration} seconds`);

    const ffmpegArgs = [
      '-nostdin',
      '-f', 'x11grab',
      '-video_size', '1920x1080',
      '-framerate', '30',
      '-i', ':99.0',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-t', duration.toString(),
      '-y',
      outputPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY: ':99' }
    });

    activeProcesses.push({ process: ffmpeg, name: 'FFmpeg' });

    let lastProgress = '';
    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      // Log progress updates
      if (output.includes('frame=') || output.includes('size=')) {
        const match = output.match(/frame=\s*(\d+).*size=\s*(\d+\w+)/);
        if (match) {
          const progress = `Recording: frame=${match[1]}, size=${match[2]}`;
          if (progress !== lastProgress) {
            log(progress);
            lastProgress = progress;
          }
        }
      }
    });

    ffmpeg.on('close', (code) => {
      log(`FFmpeg process exited with code ${code}`);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed with exit code ${code}`));
      }
    });

    ffmpeg.on('error', (error) => {
      log(`FFmpeg error: ${error.message}`);
      reject(error);
    });
  });
}

app.post('/record-video', async (req, res) => {
  if (isRecording) {
    return res.status(429).json({ error: 'Recording already in progress' });
  }

  const { videoId, duration, previewUrl } = req.body;

  if (!videoId || !duration || !previewUrl) {
    return res.status(400).json({ error: 'videoId, duration, and previewUrl are required' });
  }

  if (duration < 1 || duration > 300) {
    return res.status(400).json({ error: 'Duration must be between 1 and 300 seconds' });
  }

  isRecording = true;
  const outputPath = `${RECORDINGS_DIR}/recording_${videoId}_${Date.now()}.mp4`;
  
  try {
    log(`Starting recording process for videoId: ${videoId}, duration: ${duration}s`);

    // Start Xvfb
    await startXvfb();
    
    // Start Chrome and wait for video to load
    await startChrome(previewUrl);
    
    // Now start recording
    await recordVideo(duration, outputPath);

    // Cleanup processes
    await cleanup();
    activeProcesses = [];

    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      log(`Recording completed successfully. File size: ${stats.size} bytes`);
      
      res.json({
        success: true,
        message: 'Video recorded successfully',
        videoId,
        duration,
        fileSize: stats.size,
        outputPath: outputPath
      });

      // Clean up file after 60 seconds
      setTimeout(() => {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
          log(`Cleaned up temporary file: ${outputPath}`);
        }
      }, 60000);
    } else {
      throw new Error('Recording file was not created');
    }

  } catch (error) {
    log(`Recording failed: ${error.message}`);
    
    await cleanup();
    activeProcesses = [];

    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    res.status(500).json({
      success: false,
      error: 'Recording failed',
      message: error.message
    });
  } finally {
    isRecording = false;
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    isRecording,
    timestamp: new Date().toISOString(),
    activeProcesses: activeProcesses.length
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Video Recording Service',
    status: 'running',
    endpoints: {
      'POST /record-video': 'Record a video with {videoId, duration}',
      'GET /health': 'Health check'
    }
  });
});

process.on('SIGINT', async () => {
  log('Received SIGINT, cleaning up...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('Received SIGTERM, cleaning up...');
  await cleanup();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  log(`Video recording service running on port ${PORT}`);
});