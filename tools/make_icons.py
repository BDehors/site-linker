#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成站点链接助手的图标资产（包内图标 + 商店 logo + 小宣传图）。
依赖 Pillow。用法：python tools/make_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")
os.makedirs(OUT, exist_ok=True)

C1 = (37, 99, 235)    # 渐变起 #2563EB
C2 = (30, 64, 175)    # 渐变止 #1E40AF
WHITE = (255, 255, 255, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(C1, C2, y / max(size - 1, 1)))
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def chain_glyph(size):
    """两个 ±45° 的圆角环，组成链条图标。4 倍超采样抗锯齿。"""
    S = 4
    W = size * S
    ring_len = int(size * 0.66 * S)
    ring_h = int(size * 0.34 * S)
    stroke = max(int(size * 0.085 * S), 2 * S)

    ring = Image.new("RGBA", (ring_len, ring_h), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(
        [stroke // 2, stroke // 2, ring_len - stroke // 2, ring_h - stroke // 2],
        radius=(ring_h - stroke) // 2,
        outline=WHITE,
        width=stroke,
    )
    r1 = ring.rotate(45, expand=True, resample=Image.BICUBIC)
    r2 = ring.rotate(-45, expand=True, resample=Image.BICUBIC)

    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    dx = int(size * 0.085 * S)
    dy = int(size * 0.10 * S)
    layer.alpha_composite(r1, (W // 2 - r1.width // 2 - dx, W // 2 - r1.height // 2 - dy))
    layer.alpha_composite(r2, (W // 2 - r2.width // 2 + dx, W // 2 - r2.height // 2 + dy))
    return layer.resize((size, size), Image.LANCZOS)


def make_icon(size, path, radius_ratio=0.22, text=None):
    img = gradient(size).convert("RGBA")
    img.putalpha(rounded_mask(size, int(size * radius_ratio)))
    glyph = chain_glyph(int(size * 0.56))
    img.alpha_composite(glyph, ((size - glyph.width) // 2, int(size * 0.10)))
    if text:
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", int(size * 0.13))
            d = ImageDraw.Draw(img)
            bbox = d.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            d.text(((size - tw) // 2 - bbox[0], int(size * 0.80) - bbox[1]), text, font=font, fill=WHITE)
        except Exception as e:
            print("字体加载失败，跳过文字：", e)
    img.save(path)
    print("written", path, img.size)


def make_tile(w, h, path):
    """商店小宣传图 440x280：渐变底 + 图标 + 名称。"""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for x in range(w):
        d.line([(x, 0), (x, h)], fill=lerp(C1, C2, x / max(w - 1, 1)))
    side = int(h * 0.52)
    glyph = chain_glyph(int(side * 0.62))
    icon = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    # 白底圆角方块衬底
    ImageDraw.Draw(icon).rounded_rectangle([0, 0, side - 1, side - 1], radius=int(side * 0.22), fill=(255, 255, 255, 38))
    icon.alpha_composite(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))
    img.alpha_composite(icon, (int(w * 0.08), (h - side) // 2))
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", int(h * 0.16))
        d = ImageDraw.Draw(img)
        d.text((int(w * 0.08) + side + int(w * 0.04), int(h * 0.30)), "站点链接助手", font=font, fill=WHITE)
        font2 = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", int(h * 0.075))
        d.text((int(w * 0.08) + side + int(w * 0.04), int(h * 0.55)), "站点名称一键变链接", font=font2, fill=(219, 234, 254, 255))
    except Exception as e:
        print("字体加载失败，跳过文字：", e)
    img.convert("RGB").save(path)
    print("written", path, (w, h))


if __name__ == "__main__":
    make_icon(16, os.path.join(OUT, "icon16.png"))
    make_icon(48, os.path.join(OUT, "icon48.png"))
    make_icon(128, os.path.join(OUT, "icon128.png"))
    make_icon(300, os.path.join(OUT, "logo300.png"), text="站点链接助手")
    make_tile(440, 280, os.path.join(OUT, "promo440x280.png"))
