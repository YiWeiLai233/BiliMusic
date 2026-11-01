"""生成应用图标：assets/icon.png (512) 与 assets/tray.png (32)，粉色音符圆角方块。"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(OUT, exist_ok=True)

S = 512


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def draw_note(size, color=(255, 255, 255, 255)):
    """画一个八分音符（带符干与符尾）。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    u = size / 512.0

    # 符头：椭圆，略微倾斜
    head_w, head_h = 128 * u, 96 * u
    cx, cy = 196 * u, 330 * u
    head = Image.new("RGBA", (int(head_w * 2), int(head_h * 2)), (0, 0, 0, 0))
    hd = ImageDraw.Draw(head)
    hd.ellipse([head_w * 0.5, head_h * 0.5, head_w * 1.5, head_h * 1.5], fill=color)
    head = head.rotate(-22, resample=Image.BICUBIC, center=(head_w, head_h))
    layer.alpha_composite(head, (int(cx - head_w), int(cy - head_h)))

    # 符干
    stem_w = 30 * u
    d.rounded_rectangle(
        [298 * u, 130 * u, 298 * u + stem_w, 330 * u],
        radius=stem_w / 2,
        fill=color,
    )

    # 符尾（向右下的弧）
    flag = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flag)
    fd.ellipse([306 * u, 118 * u, 470 * u, 250 * u], fill=color)
    fd.ellipse([330 * u, 150 * u, 470 * u, 250 * u], fill=(0, 0, 0, 0))
    layer.alpha_composite(flag)

    return layer


def make_icon(size, radius_ratio=0.235):
    scale = 4  # 超采样再缩小，边缘更干净
    big = size * scale

    bg = gradient(big, (255, 140, 172), (243, 82, 133))
    # 左上角加一点高光
    glow = Image.new("L", (big, big), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-big * 0.35, -big * 0.55, big * 0.85, big * 0.45], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(big * 0.09))
    white = Image.new("RGB", (big, big), (255, 255, 255))
    bg = Image.composite(white, bg, glow.point(lambda v: int(v * 1.0)))

    note = draw_note(big)
    # 音符轻微投影
    shadow = note.split()[3].filter(ImageFilter.GaussianBlur(big * 0.012))
    sh = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    sh.putalpha(shadow.point(lambda v: int(v * 0.35)))
    bg = Image.alpha_composite(bg.convert("RGBA"), sh)
    bg = Image.alpha_composite(bg, note)

    mask = rounded_mask(big, int(big * radius_ratio))
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


icon = make_icon(512)
icon.save(os.path.join(OUT, "icon.png"))
# Windows 任务栏/标题栏也常用 ico
icon.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

tray = make_icon(64, radius_ratio=0.28).resize((32, 32), Image.LANCZOS)
tray.save(os.path.join(OUT, "tray.png"))
tray2 = make_icon(64, radius_ratio=0.28).resize((16, 16), Image.LANCZOS)
tray2.save(os.path.join(OUT, "tray-16.png"))

print("wrote:", os.listdir(OUT))
print("icon size:", icon.size)
