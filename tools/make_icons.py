"""生成扩展图标：粉色圆角底 + 白色 B。

用法：python tools/make_icons.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "icons")

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def make_icon(size, out_path):
    scale = 8
    s = size * scale
    top = (255, 154, 184)
    bottom = (231, 91, 132)

    gradient = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(gradient)
    for y in range(s):
        t = y / max(1, s - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        draw.line([(0, y), (s, y)], fill=color)

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.23), fill=255)

    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(icon)
    font = load_font(int(s * 0.64))
    bbox = draw.textbbox((0, 0), "B", font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (s - w) / 2 - bbox[0]
    y = (s - h) / 2 - bbox[1] - int(s * 0.02)
    draw.text((x, y), "B", font=font, fill=(255, 255, 255, 255))

    icon.resize((size, size), Image.LANCZOS).save(out_path, "PNG")


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(ICON_DIR, "icon%d.png" % size)
        make_icon(size, path)
        print("wrote", path)


if __name__ == "__main__":
    main()
