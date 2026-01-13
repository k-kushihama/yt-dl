const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const app = express();
const progressEvents = new EventEmitter();

app.use(express.json());
app.use(express.static('public'));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// 進捗SSE：taskId をクエリパラメータで受け取る
app.get('/api/progress', (req, res) => {
    const taskId = req.query.taskId;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const onProgress = (data) => {
        if (data.taskId === taskId) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    progressEvents.on('update', onProgress);
    req.on('close', () => progressEvents.removeListener('update', onProgress));
});

app.post('/api/download', async (req, res) => {
    // taskId をリクエストから受け取る
    const { url, type, quality, taskId } = req.body; 
    if (!url) return res.status(400).json({ error: 'URLが必要です．' });

    try {
        let title = 'download';
        const getTitle = spawn('yt-dlp', [
            '--get-title', '--no-playlist', '--encoding', 'utf-8', url
        ], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });

        let titleBuffer = [];
        getTitle.stdout.on('data', (data) => titleBuffer.push(data));

        await new Promise((resolve) => {
            const timer = setTimeout(() => { getTitle.kill(); resolve(); }, 8000);
            getTitle.on('close', () => {
                if (titleBuffer.length > 0) {
                    const fullTitle = Buffer.concat(titleBuffer).toString('utf8').trim();
                    title = fullTitle.replace(/[/\\?%*:|"<>]/g, '_');
                }
                clearTimeout(timer);
                resolve();
            });
        });

        const extension = type === 'wav' ? 'wav' : 'mp4';
        const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${taskId}.${extension}`);

        let args = [
            '--no-playlist', '--newline',
            '--concurrent-fragments', '16',
            '--buffer-size', '16M',
            '--downloader', 'aria2c',
            '--downloader-args', 'aria2c:-x 16 -s 16 -j 16 -k 1M',
            '-o', tempFilePath, url
        ];

        if (type === 'wav') {
            args.splice(2, 0, '-x', '--audio-format', 'wav', '--audio-quality', '0');
        } else {
            const resH = quality || '1080';
            const formatStr = `bestvideo[height<=${resH}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${resH}][ext=mp4]/best`;
            args.splice(2, 0, '-f', formatStr, '--merge-output-format', 'mp4');
            args.push('--postprocessor-args', 'ffmpeg:-threads 0 -preset superfast');
        }

        const ytDlp = spawn('yt-dlp', args);

        ytDlp.stderr.on('data', (data) => {
            const output = data.toString();
            const match = output.match(/(\d+\.\d+)%/);
            if (match) {
                progressEvents.emit('update', { taskId, progress: match[1], status: 'Downloading' });
            } else if (output.includes('Merging')) {
                progressEvents.emit('update', { taskId, progress: 99, status: 'Merging' });
            }
        });

        ytDlp.on('close', (code) => {
            if (code === 0 && fs.existsSync(tempFilePath)) {
                progressEvents.emit('update', { taskId, progress: 100, status: 'Complete' });
                const encodedTitle = encodeURIComponent(title);
                res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
                res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedTitle}.${extension}`);
                fs.createReadStream(tempFilePath).pipe(res).on('close', () => {
                    fs.unlink(tempFilePath, () => {});
                });
            } else {
                if (!res.headersSent) res.status(500).send('Error');
            }
        });
    } catch (e) { res.status(500).end(); }
});

app.listen(3000);