"""
matplotlib.colors — colour name resolution, hex conversion, default cycle.
"""

# Default colour cycle (matplotlib C0–C9)
DEFAULT_CYCLE = [
    '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
    '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
]

# Named CSS / matplotlib colours
_NAMED = {
    'b': '#0000ff', 'blue': '#0000ff',
    'g': '#008000', 'green': '#008000',
    'r': '#ff0000', 'red': '#ff0000',
    'c': '#00bfbf', 'cyan': '#00bfbf',
    'm': '#bf00bf', 'magenta': '#bf00bf',
    'y': '#bfbf00', 'yellow': '#bfbf00',
    'k': '#000000', 'black': '#000000',
    'w': '#ffffff', 'white': '#ffffff',
    'orange': '#ff7f00',
    'purple': '#800080',
    'brown': '#8b4513',
    'pink': '#ffc0cb',
    'gray': '#808080', 'grey': '#808080',
}


def to_hex(color):
    """Convert a colour specification to ``#rrggbb`` hex string.

    Accepts:
      - ``str`` name (``'red'``, ``'b'``) or hex (``'#ff0000'``)
      - ``(r, g, b)`` tuple — floats in 0‑1 *or* ints in 0‑255
    """
    if isinstance(color, str):
        if color.startswith('#'):
            return color[:7].lower()
        c = color.lower()
        if c in _NAMED:
            return _NAMED[c]
        return color  # pass through unknown
    if isinstance(color, (list, tuple)):
        r, g, b = color[0], color[1], color[2]
        if isinstance(r, float) and r <= 1.0:
            r, g, b = int(r * 255), int(g * 255), int(b * 255)
        return f'#{int(r):02x}{int(g):02x}{int(b):02x}'
    return '#000000'


def to_rgb(color):
    """Convert a colour specification to ``(r, g, b)`` ints 0‑255."""
    h = to_hex(color)
    if h.startswith('#') and len(h) >= 7:
        return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))
    return (0, 0, 0)


# Format‑string parsing: e.g. ``'ro-'`` → colour, marker, linestyle
_COLOR_CHARS = set('bgrcmykw')
_MARKER_CHARS = {'o': 'circle', 's': 'square', '^': 'triangle', 'D': 'diamond', '.': 'point'}
_LINE_CHARS = {'-': 'solid', '--': 'dashed', ':': 'dotted', '-.': 'dashdot'}


def parse_fmt(fmt):
    """Parse a matplotlib format string, return (color, marker, linestyle)."""
    color = None
    marker = None
    linestyle = None
    if not fmt:
        return color, marker, linestyle
    i = 0
    while i < len(fmt):
        ch = fmt[i]
        if ch in _COLOR_CHARS and color is None:
            color = ch
        elif ch in _MARKER_CHARS and marker is None:
            marker = ch
        elif ch == '-' and i + 1 < len(fmt) and fmt[i + 1] in ('-', '.'):
            linestyle = fmt[i:i+2]
            i += 1
        elif ch in ('-', ':', '.'):
            if linestyle is None:
                linestyle = ch
        i += 1
    return color, marker, linestyle
