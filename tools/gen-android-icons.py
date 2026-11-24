"""把 512 图标缩放成 Android 各密度 launcher 图标。"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open(os.path.join(ROOT, "icons", "icon-512.png")).convert("RGBA")
SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for dpi, size in SIZES.items():
    out_dir = os.path.join(ROOT, "android", "res", "mipmap-" + dpi)
    os.makedirs(out_dir, exist_ok=True)
    src.resize((size, size), Image.LANCZOS).save(os.path.join(out_dir, "ic_launcher.png"))
print("android launcher icons ok")
