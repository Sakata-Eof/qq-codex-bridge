import sys, json
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[2], device='cpu', compute_type='int8', local_files_only=True)
segments, info = model.transcribe(sys.argv[1], vad_filter=True)
print(json.dumps({'text': ''.join(s.text for s in segments).strip(), 'language': info.language}, ensure_ascii=False))
