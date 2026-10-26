# Renders clips/proposal_cut.mp4 from the Phase 3 clips and the narration WAVs in clips/audio/.
#   python3 clips/tts.py                    (narration, see that file)
#   python3 clips/render_proposal_cut.py
# Rules: each scene lasts its narration plus 0.5 s (UI scenes 2 to 6 get up to 1.5 s more to breathe),
# clips are trimmed or hold their last frame (never sped up), hard cuts except a 0.3 s crossfade from
# a card into UI, a slow 5% push in on shots longer than 8 s, voice only at about -16 LUFS, no captions.
import json, os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO = os.path.join(HERE, "audio")
OUT = os.path.join(HERE, "proposal_cut.mp4")
XFADE = 0.3
BREATHE = 1.5

# (clip, start, length or None for "the rest") per piece. Pieces are trimmed from the clips; when a
# scene needs more time than its pieces provide, the last frame is held.
SCENES = [
    {"pieces": [("K01_problem", 0.0, None)], "card": True},
    {"pieces": [("C01_chaos_start", 0.5, 4.0), ("C02_failures_retrying", 1.0, None)]},
    {"pieces": [("C03_retries_succeed", 0.0, None)]},
    {"pieces": [("C04_reconciliation", 2.0, 7.0), ("C05_dead_letter_replay_close", 0.4, None)]},
    {"pieces": [("C06_slack_explainer", 0.3, None)]},
    {"pieces": [("C07_email_check", 3.0, 3.6), ("C08_buyer_list", 0.5, None)]},
    {"pieces": [("K04_offer", 0.0, None)], "card": True},
]


def run(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path], check=True, capture_output=True, text=True).stdout
    return float(json.loads(out)["format"]["duration"])


def render_scene(i, scene, length, tmp):
    """Writes one silent scene of exactly `length` seconds."""
    parts = []
    remaining = length
    for n, (clip, start, piece_len) in enumerate(scene["pieces"]):
        src = os.path.join(HERE, f"{clip}.mp4")
        available = duration(src) - start
        is_last = n == len(scene["pieces"]) - 1
        take = min(available, remaining if is_last or piece_len is None else piece_len)
        part = os.path.join(tmp, f"s{i}_{n}.mp4")
        run(["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", src, "-t", f"{take:.3f}", "-an", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "fast", part])
        parts.append(part)
        remaining -= take
    hold = max(0.0, remaining)
    joined = os.path.join(tmp, f"s{i}_joined.mp4")
    inputs = sum([["-i", p] for p in parts], [])
    chain = "".join(f"[{k}:v]" for k in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=0[c]"
    vf = f"{chain};[c]tpad=stop_mode=clone:stop_duration={hold:.3f}"
    if length > 8:
        # Slow 5% push in across the whole shot (upscaled first so the motion stays smooth).
        frames = round(length * 30)
        vf += f",scale=3840:2160,zoompan=z='1+0.05*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30"
    vf += ",format=yuv420p[v]"
    run(["ffmpeg", "-y", *inputs, "-filter_complex", vf, "-map", "[v]", "-t", f"{length:.3f}", "-r", "30", "-c:v", "libx264", "-crf", "16", "-preset", "fast", joined])
    return joined, hold


def main():
    audio = [os.path.join(AUDIO, f"scene{i}.wav") for i in range(1, len(SCENES) + 1)]
    voice = [duration(a) for a in audio]
    lengths = [v + 0.5 + (BREATHE if 2 <= i <= 6 else 0.0) for i, v in enumerate(voice, start=1)]
    # The crossfade from scene 1 into scene 2 overlaps them by XFADE seconds.
    total = sum(lengths) - XFADE
    print("scene lengths:", ", ".join(f"{x:.2f}" for x in lengths), f"total {total:.2f} s")
    if not 60 <= total <= 90:
        raise SystemExit(f"total {total:.2f} s is outside 60 to 90 s; adjust the narration")

    with tempfile.TemporaryDirectory() as tmp:
        scenes = []
        for i, (scene, length) in enumerate(zip(SCENES, lengths), start=1):
            path, hold = render_scene(i, scene, length, tmp)
            print(f"scene {i}: {length:.2f} s, held last frame {hold:.2f} s")
            scenes.append(path)

        # Video: crossfade scene 1 (card) into scene 2 (UI), hard cuts everywhere else.
        inputs = sum([["-i", s] for s in scenes], [])
        v = f"[0:v][1:v]xfade=transition=fade:duration={XFADE}:offset={lengths[0] - XFADE:.3f}[x];"
        v += "[x]" + "".join(f"[{k}:v]" for k in range(2, len(scenes))) + f"concat=n={len(scenes) - 1}:v=1:a=0[v]"

        # Audio: each scene's voice starts when its picture starts.
        a_inputs = sum([["-i", a] for a in audio], [])
        base = len(scenes)
        starts, t = [], 0.0
        for k, length in enumerate(lengths):
            starts.append(t)
            t += length - (XFADE if k == 0 else 0.0)
        a = "".join(f"[{base + k}:a]aresample=48000,adelay={round(s * 1000)}:all=1[a{k}];" for k, s in enumerate(starts))
        a += "".join(f"[a{k}]" for k in range(len(audio))) + f"amix=inputs={len(audio)}:normalize=0:duration=longest,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]"

        run(["ffmpeg", "-y", *inputs, *a_inputs, "-filter_complex", v + ";" + a, "-map", "[v]", "-map", "[a]",
             "-t", f"{total:.3f}", "-r", "30", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", OUT])
    print(f"wrote {OUT} ({duration(OUT):.2f} s)")


if __name__ == "__main__":
    main()
