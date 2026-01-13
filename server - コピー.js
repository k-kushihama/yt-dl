const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events'); // 追加

const app = express();
const progressEvents = new EventEmitter(); // 進捗通知用

app.use(express.json());
app.use(express.static('public'));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// 進捗をブラウザに送るためのSSEエンドポイント
app.get('/api/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    progressEvents.on('update', onProgress);
    req.on('close', () => progressEvents.removeListener('update', onProgress));
});

app.post('/api/download', async (req, res) => {
    const { url, type } = req.body;
    if (!url) return res.status(400).json({ error: 'URLが必要です．' });

    try {
        let title = 'download';
console.log('[Step 1] Fetching title...');

const getTitle = spawn('yt-dlp', [
    '--get-title', 
    '--no-playlist', 
    '--encoding', 'utf-8', // yt-dlpにUTF-8出力を強制
    url
], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } // Python環境変数でUTF-8を指定
});

let titleBuffer = [];
getTitle.stdout.on('data', (data) => {
    titleBuffer.push(data);
});

await new Promise((resolve) => {
    const timer = setTimeout(() => { getTitle.kill(); resolve(); }, 8000);
    getTitle.on('close', () => {
        if (titleBuffer.length > 0) {
            // バッファを結合してUTF-8として文字列化
            const fullTitle = Buffer.concat(titleBuffer).toString('utf8').trim();
            // OSで使用不可能な文字を除去
            title = fullTitle.replace(/[/\\?%*:|"<>]/g, '_');
        }
        clearTimeout(timer);
        resolve();
    });
});

        const extension = type === 'wav' ? 'wav' : 'mp4';
        const tempFilePath = path.join(TEMP_DIR, `${Date.now()}.${extension}`);

        let args = [
            '--no-playlist', '--newline',
            '--downloader', 'aria2c',
            '--downloader-args', 'aria2c:-x 16 -s 16 -k 1M',
            '-o', tempFilePath, url
        ];

        if (type === 'wav') {
            args.splice(2, 0, '-x', '--audio-format', 'wav', '--audio-quality', '0');
        } else {
            args.splice(2, 0, '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', '--merge-output-format', 'mp4');
        }

        const ytDlp = spawn('yt-dlp', args);

        ytDlp.stderr.on('data', (data) => {
            const output = data.toString();
            // yt-dlpの進捗ログから数値を抽出 (例: [download]  10.5% of ...)
            const match = output.match(/(\d+\.\d+)%/);
            if (match) {
                progressEvents.emit('update', { progress: match[1], status: 'Downloading' });
            } else if (output.includes('Merging')) {
                progressEvents.emit('update', { progress: 99, status: 'Merging' });
            }
        });

        ytDlp.on('close', (code) => {
            if (code === 0 && fs.existsSync(tempFilePath)) {
                progressEvents.emit('update', { progress: 100, status: 'Complete' });
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