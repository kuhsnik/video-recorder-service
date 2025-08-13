const express = require('express');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let isRecording = false;
let activeProcesses = [];

const RECORDINGS_DIR = '/usr/src/app/recordings';

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

async function startChromeAndValidateVideo(videoId) {
  const previewUrl = `https://app.deckoholic.ai/preview-headless/${videoId}?autoplay=true`;
  log(`Starting Chrome with URL: ${previewUrl}`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--display=:99',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blacklist',
      '--enable-webgl',
      '--enable-accelerated-2d-canvas',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--user-data-dir=/usr/src/app/chrome-data',
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
      '--no-default-browser-check'
    ],
    env: { DISPLAY: ':99' }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  log('Navigating to preview URL...');
  await page.goto(previewUrl, { waitUntil: 'networkidle0', timeout: 30000 });

  log('Waiting for video to start playing with effects...');
  
  let videoReady = false;
  let attempts = 0;
  const maxAttempts = 60; // 60 seconds max

  while (!videoReady && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      const status = await page.evaluate(() => {
        const video = document.querySelector('video');
        const canvas = document.querySelector('canvas');
        return {
          ready: window.PREVIEW_READY || false,
          playing: window.PREVIEW_PLAYING || false,
          videoExists: !!video,
          videoPlaying: video ? !video.paused : false,
          currentTime: video ? video.currentTime : 0,
          hasWebGL: !!canvas,
          pageLoaded: document.readyState === 'complete',
          videoSrc: video ? video.src : null,
          videoDuration: video ? video.duration : 0
        };
      });

      log(`Check ${attempts + 1}/60:`, status);

      // Video must be playing AND have WebGL canvas AND show progress
      if (status.ready && status.playing && status.videoPlaying &&
          status.currentTime > 2 && status.hasWebGL && status.pageLoaded) {
        videoReady = true;
        log('✅ Video confirmed playing with effects!');
        break;
      }

      // Extra wait for WebGL to initialize
      if (status.hasWebGL && !videoReady && attempts > 10) {
        log('WebGL detected, waiting for video effects...');
      }

    } catch (err) {
      log(`Evaluation error attempt ${attempts + 1}:`, err.message);
    }

    attempts++;
  }

  if (!videoReady) {
    await browser.close();
    throw new Error('Video with effects failed to start within 60 seconds');
  }

  // Wait additional 3 seconds for effects to fully initialize
  log('Waiting 3 more seconds for effects to stabilize...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  return { browser, page };
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

    ffmpeg.stdout.on('data', (data) => {
      log(`FFmpeg stdout: ${data.toString()}`);
    });

    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      // Log important info but filter noise
      if (output.includes('frame=') || output.includes('size=') || output.includes('time=')) {
        log(`FFmpeg: ${output.trim()}`);
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

  const { videoId, duration } = req.body;

  if (!videoId || !duration) {
    return res.status(400).json({ error: 'videoId and duration are required' });
  }

  if (duration < 1 || duration > 300) {
    return res.status(400).json({ error: 'Duration must be between 1 and 300 seconds' });
  }

  isRecording = true;
  const outputPath = `${RECORDINGS_DIR}/recording_${videoId}_${Date.now()}.mp4`;
  let browser = null;
  
  try {
    log(`Starting recording process for videoId: ${videoId}, duration: ${duration}s`);

    // Start Xvfb
    await startXvfb();
    
    // Start Chrome and validate video is playing with effects
    const { browser: chromeBrowser, page } = await startChromeAndValidateVideo(videoId);
    browser = chromeBrowser;
    
    // Now start recording the validated video
    await recordVideo(duration, outputPath);

    // Close browser
    await browser.close();
    
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
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        log(`Error closing browser: ${e.message}`);
      }
    }
    
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