import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const text = req.nextUrl.searchParams.get('text') || 'Hello, this is a test of VOX254 news narration.';

  // Google Translate TTS endpoint (free, unofficial, works for short text)
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=${encodeURIComponent(text)}`;

  const audioRes = await fetch(ttsUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  if (!audioRes.ok) {
    return NextResponse.json({ error: 'TTS fetch failed', status: audioRes.status }, { status: 500 });
  }

  const audioBuffer = await audioRes.arrayBuffer();

  return new NextResponse(audioBuffer, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.byteLength.toString(),
    },
  });
}
