import { NextRequest, NextResponse } from 'next/server';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { writeFile, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export async function POST(req: NextRequest) {
  try {
    const { text, imageUrls } = await req.json();

    if (!text || !imageUrls || !imageUrls.length) {
      return NextResponse.json({ error: 'Missing text or imageUrls' }, { status: 400 });
    }

    const workDir = await mkdtemp(path.join(tmpdir(), 'vox254-'));

    // 1. Get narration audio
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(text.slice(0, 200))}`;
    const audioRes = await fetch(ttsUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const audioPath = path.join(workDir, 'narration.mp3');
    await writeFile(audioPath, audioBuffer);

    // 2. Download images
    const imagePaths: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const imgRes = await fetch(imageUrls[i]);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const imgPath = path.join(workDir, `img${i}.jpg`);
      await writeFile(imgPath, imgBuffer);
      imagePaths.push(imgPath);
    }

    // 3. Build video: slideshow of images synced to audio length
    const outputPath = path.join(workDir, 'output.mp4');

    await new Promise((resolve, reject) => {
      const command = ffmpeg();
      imagePaths.forEach((imgPath) => {
        command.input(imgPath).loop(4);
      });
      command.input(audioPath);

      command
        .complexFilter([
          `${imagePaths.map((_, i) => `[${i}:v]scale=1280:720,setsar=1[v${i}]`).join(';')}`,
          `${imagePaths.map((_, i) => `[v${i}]`).join('')}concat=n=${imagePaths.length}:v=1:a=0[outv]`,
        ])
        .outputOptions(['-map', '[outv]', '-map', `${imagePaths.length}:a`, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const videoBuffer = await readFile(outputPath);
    await rm(workDir, { recursive: true, force: true });

    return new NextResponse(videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': videoBuffer.byteLength.toString(),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Video generation failed' }, { status: 500 });
  }
}
