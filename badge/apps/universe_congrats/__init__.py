import os
import sys
import math
import random

APP_DIR = "/system/apps/universe_congrats"

os.chdir(APP_DIR)
sys.path.insert(0, APP_DIR)

badge.mode(HIRES | VSYNC)

W = screen.width
H = screen.height
SKY = color.rgb(13, 17, 38)
WHITE = color.rgb(255, 255, 255)
DIM = color.rgb(120, 130, 175)
FLAME = [color.rgb(255, 230, 120), color.rgb(255, 170, 60), color.rgb(240, 98, 70), color.rgb(163, 113, 247)]

# Text lines are Mona Sans renders: 320x200 PNGs with the line in the top 40px band.
def text_line(path):
    return image.load(path).spritesheet(1, 5).sprite(0, 0)


GLYPH_CHARS = "@-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
# Mona Sans atlases (8x8 grid of 32x40 cells, glyph 4px from the left) and
# advance widths, made with badge-glyphs.html in the cheat sheet exercise.
FONTS = [
    ("assets/glyphs.png", [21, 9, 16, 9, 14, 14, 15, 14, 15, 13, 14, 15, 15, 15, 14, 15, 14, 9, 14, 15, 6, 6, 14, 6, 23, 15, 14, 15, 15, 9, 13, 9, 15, 14, 19, 14, 14, 12, 18, 16, 18, 17, 15, 14, 19, 18, 7, 10, 17, 13, 21, 18, 19, 16, 19, 17, 16, 15, 17, 18, 24, 18, 17, 15]),
    ("assets/glyphs_small.png", [14, 6, 11, 6, 9, 10, 10, 10, 10, 9, 10, 10, 10, 10, 9, 10, 9, 6, 10, 10, 4, 4, 10, 4, 16, 10, 10, 10, 10, 6, 9, 6, 10, 9, 13, 10, 9, 8, 12, 11, 12, 12, 10, 10, 13, 12, 4, 7, 12, 9, 14, 12, 13, 11, 13, 11, 11, 10, 12, 12, 16, 12, 12, 10]),
]


def github_login():
    # The Badge Simulator canvas adds github_login.txt with the signed-in user's login.
    try:
        with open("github_login.txt") as f:
            login = f.read().strip()
    except OSError:
        return None
    login = "".join(ch for ch in login if ch in GLYPH_CHARS)
    return "@" + login.lstrip("@") if login else None


def name_line(login):
    # Returns [(sprite, x)] for the login centred on screen, or None.
    if not login:
        return None
    for path, advances in FONTS:
        width = sum(advances[GLYPH_CHARS.index(ch)] for ch in login)
        if width <= W - 12 or path == FONTS[-1][0]:
            break
    sheet = image.load(path).spritesheet(8, 8)
    while width > W - 12 and len(login) > 2:
        width -= advances[GLYPH_CHARS.index(login[-1])]
        login = login[:-1]
    x = (W - width) // 2 - 4
    out = []
    for ch in login:
        i = GLYPH_CHARS.index(ch)
        out.append((sheet.sprite(i % 8, i // 8), x))
        x += advances[i]
    return out


TITLE = text_line("assets/title.png")
SUBTITLE = text_line("assets/subtitle.png")
NAME = name_line(github_login())

# mona_2 is upright; 1/0 lean further forward when flying faster.
MONA = [image.load("assets/mona_%d.png" % i) for i in range(5)]

stars = [[random.randint(0, W - 1), random.randint(0, H - 1), random.choice((8, 16, 30))] for _ in range(70)]
sparks = []


def draw_stars(dt):
    for s in stars:
        s[0] -= s[2] * dt
        if s[0] < 0:
            # Re-enter just off the right edge with a little jitter, so stars that
            # wrap together don't line up into columns.
            s[0] = W - 1 + random.randint(0, 24)
            s[1] = random.randint(0, H - 1)
        screen.pen = WHITE if s[2] == 30 else DIM
        screen.rectangle(int(s[0]), s[1], 2 if s[2] == 30 else 1, 1)


def mona_path(t):
    x = W / 2 + 108 * math.sin(t / 1500)
    y = 160 + 16 * math.sin(t / 750)
    return x, y


def draw_sparks(dt):
    keep = []
    for p in sparks:
        p[0] += p[2] * dt
        p[1] += p[3] * dt
        p[4] -= dt
        if p[4] > 0:
            screen.pen = FLAME[min(3, int((0.6 - p[4]) * 6))]
            screen.rectangle(int(p[0]), int(p[1]), 2, 2)
            keep.append(p)
    sparks[:] = keep


def draw_mona(t, dt):
    x, y = mona_path(t)
    nx, ny = mona_path(t + 40)
    dx = nx - x
    speed = abs(dx)
    frame = 2 if speed < 0.8 else (1 if speed < 2.2 else 0)
    img = MONA[frame]
    w, h = img.width, img.height
    left = int(x - w / 2)
    top = int(y - h / 2)

    # Thruster trail streams out behind her boots.
    back = -1 if dx >= 0 else 1
    fx = x + back * w * 0.25
    fy = y + h * 0.42
    for _ in range(3):
        sparks.append([fx + random.randint(-3, 3), fy + random.randint(-2, 2),
                       back * random.randint(20, 50), random.randint(25, 60), 0.6])
    draw_sparks(dt)

    if dx >= 0:
        screen.blit(img, rect(left, top, w, h))
    else:
        screen.blit(img, rect(left + w, top, -w, h))


def update():
    t = badge.ticks
    # A paused simulator (hidden panel) reports a huge delta; cap it so the
    # starfield and thruster trail don't jump across the screen at once.
    dt = min(badge.ticks_delta, 100) / 1000

    screen.pen = SKY
    screen.rectangle(0, 0, W, H)
    draw_stars(dt)
    draw_mona(t, dt)

    screen.blit(TITLE, vec2(0, 0))
    if NAME:
        for glyph, x in NAME:
            screen.blit(glyph, vec2(x, 30))
    else:
        screen.font = font.ziplock
        screen.pen = WHITE
        label = "Well done!"
        w, _ = screen.measure_text(label)
        screen.text(label, int((W - w) / 2), 42)
    screen.blit(SUBTITLE, vec2(0, 54))


run(update)
