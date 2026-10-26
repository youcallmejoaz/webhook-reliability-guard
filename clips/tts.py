# Generates one narration WAV per proposal cut scene with Kokoro TTS (open weights, Apache 2.0).
#   pip install kokoro-onnx soundfile
#   KOKORO_DIR=<folder with kokoro-v1.0.onnx and voices-v1.0.bin> python3 clips/tts.py
import os, sys
import soundfile as sf
from kokoro_onnx import Kokoro

SCENES = [
    "A customer pays, and the access email never arrives. Usually nobody knows until they complain.",
    "This safety net catches every event between your tools. Here, one in five deliveries is failing on purpose.",
    "Failed deliveries are retried automatically, with a growing pause between tries, until they go through. Nothing is lost while a tool is down.",
    "Every fifteen minutes it checks that every buyer really has access, and fixes the ones that slipped through silently. In this test, it caught all three.",
    "When something keeps failing, you get a plain English explanation of what happened, and what to fix.",
    "It also checks your email setup, and keeps your buyer list up to date.",
    "If your automations are dropping customers, reply to this proposal, and we can map this to your tools.",
]

model_dir = os.environ.get("KOKORO_DIR", ".")
voice = os.environ.get("VOICE", "am_michael")
out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")
os.makedirs(out_dir, exist_ok=True)
kokoro = Kokoro(os.path.join(model_dir, "kokoro-v1.0.onnx"), os.path.join(model_dir, "voices-v1.0.bin"))
for i, text in enumerate(SCENES, start=1):
    samples, rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
    path = os.path.join(out_dir, f"scene{i}.wav")
    sf.write(path, samples, rate)
    print(f"scene{i}.wav {len(samples) / rate:.2f} s")
