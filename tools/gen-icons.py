"""生成 PWA 图标：深色底 + 琥珀色复习环 + 四个节点 + 朱红当前点。"""
import math
import os
from PIL import Image, ImageDraw

INK = (23, 19, 15, 255)
AMBER = (232, 163, 61, 255)
CREAM = (247, 242, 231, 255)
VERM = (192, 83, 44, 255)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")
os.makedirs(OUT, exist_ok=True)


def draw(size, scale=1.0, rounded=True):
    big = size * 4
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, big, big], radius=int(big * 0.225), fill=INK)
    else:
        d.rectangle([0, 0, big, big], fill=INK)

    cx = cy = big / 2
    radius = big * 0.34 * scale
    width = max(2, int(big * 0.045 * scale))
    box = [cx - radius, cy - radius, cx + radius, cy + radius]
    d.arc(box, start=-90, end=210, fill=AMBER, width=width)

    for ang in (-90, 0, 90, 180):
        a = math.radians(ang)
        x = cx + math.cos(a) * radius
        y = cy + math.sin(a) * radius
        r = big * 0.03 * scale
        d.ellipse([x - r, y - r, x + r, y + r], fill=CREAM)

    r = big * 0.075 * scale
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=VERM)
    return img.resize((size, size), Image.LANCZOS)


draw(512).save(os.path.join(OUT, "icon-512.png"))
draw(192).save(os.path.join(OUT, "icon-192.png"))
draw(180, scale=0.94).save(os.path.join(OUT, "icon-180.png"))
draw(512, scale=0.76, rounded=False).save(os.path.join(OUT, "icon-maskable-512.png"))
print("icons:", sorted(os.listdir(OUT)))
