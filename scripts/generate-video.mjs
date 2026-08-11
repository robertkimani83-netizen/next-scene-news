import { writeFile, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

const SITE_URL = process.env.SITE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

async function getArticle() {
  const res = await fetch(`${SITE_URL}/api/youtube/next-article`);
  if (!res.ok) throw new Error(`No article available: ${res.status}`);
  return res.json();
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

async function main() {
  console.log('Fetching next article...');
  const article = await getArticle();
  console.log('Article:', article.title);

  const workDir = await mkdtemp(path.join(tmpdir(), 'vox254-'));

  console.log('Generating narration...');
  const narrationText = `${article.title}. ${article.text}`.slice(0, 500);
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(narrationText.slice(0, 200))}`;
  const audioRes = await fetch(ttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  const audioPath = path.join(workDir, 'narration.mp3');
  await writeFile(audioPath, audioBuffer);

  console.log('Downloading image...');
  const imgRes = await fetch(article.imageUrl);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  const imgPath = path.join(workDir, 'img0.jpg');
  await writeFile(imgPath, imgBuffer);

  console.log('Building video with ffmpeg...');
  const outputPath = path.join(workDir, 'output.mp4');
  await run('ffmpeg', [
    '-loop', '1', '-i', imgPath,
    '-i', audioPath,
    '-vf', 'scale=1280:720,setsar=1',
    '-c:v', 'libx264', '-c:a', 'aac',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    outputPath,
  ]);

  console.log('Uploading to YouTube...');
  const accessToken = await getAccessToken();
  const videoBuffer = await readFile(outputPath);

  const metadata = {
    snippet: {
      title: article.title.slice(0, 100),
      description: article.text.slice(0, 4900),
      categoryId: '25',
    },
    status: { privacyStatus: 'public' },
  };

  const boundary = 'vox254boundary';
  const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const videoPartHeader = `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(metadataPart),
    Buffer.from(videoPartHeader),
    videoBuffer,
    Buffer.from(closing),
  ]);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  const result = await uploadRes.json();
  if (!uploadRes.ok) throw new Error('YouTube upload failed: ' + JSON.stringify(result));

  console.log('Uploaded! Video ID:', result.id);
  await rm(workDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
