import asyncio, json, edge_tts, os, sys
VOICE=os.environ.get('VOICE','en-KE-ChilembaNeural'); RATE=os.environ.get('RATE','+0%')
os.makedirs('vo-out/seg',exist_ok=True)
async def one(k,t):
    for attempt in range(4):
        try:
            c=edge_tts.Communicate(t,VOICE,rate=RATE,boundary='SentenceBoundary'); sm=edge_tts.SubMaker()
            with open(f'vo-out/seg/{k}.mp3','wb') as f:
                async for ch in c.stream():
                    if ch['type']=='audio': f.write(ch['data'])
                    elif ch['type'] in ('WordBoundary','SentenceBoundary'): sm.feed(ch)
            open(f'vo-out/seg/{k}.srt','w').write(sm.get_srt()); print('ok',k); return
        except Exception as e: print('retry',k,e); await asyncio.sleep(3)
    raise SystemExit('failed '+k)
async def main():
    for k,t in json.load(open('vo-in/narration.json')): await one(k,t)
asyncio.run(main())
