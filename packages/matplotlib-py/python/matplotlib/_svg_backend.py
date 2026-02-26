"""
matplotlib._svg_backend — render a Figure to an SVG string.
"""

from matplotlib.colors import to_hex, to_rgb


def render_figure_svg(fig):
    """Return an SVG string for *fig*."""
    dpi = fig.dpi
    fw, fh = fig.figsize
    svg_w = int(fw * dpi)
    svg_h = int(fh * dpi)

    parts = []
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{svg_w}" height="{svg_h}" '
        f'viewBox="0 0 {svg_w} {svg_h}">'
    )
    # White background
    parts.append(f'<rect width="{svg_w}" height="{svg_h}" fill="white"/>')

    for ax in fig._axes:
        _render_axes(parts, ax, svg_w, svg_h)

    parts.append('</svg>')
    return '\n'.join(parts)


def _render_axes(parts, ax, svg_w, svg_h):
    """Render one Axes into the SVG parts list."""
    # Margins
    ml, mr, mt, mb = 70, 20, 40, 50

    plot_x = ml
    plot_y = mt
    plot_w = svg_w - ml - mr
    plot_h = svg_h - mt - mb

    if plot_w <= 0 or plot_h <= 0:
        return

    # Gather data ranges
    xmin, xmax, ymin, ymax = _data_range(ax)

    # Apply axis limits if set
    if ax._xlim:
        if ax._xlim[0] is not None:
            xmin = ax._xlim[0]
        if ax._xlim[1] is not None:
            xmax = ax._xlim[1]
    if ax._ylim:
        if ax._ylim[0] is not None:
            ymin = ax._ylim[0]
        if ax._ylim[1] is not None:
            ymax = ax._ylim[1]

    # Add padding
    dx = (xmax - xmin) or 1.0
    dy = (ymax - ymin) or 1.0
    xmin -= dx * 0.05
    xmax += dx * 0.05
    ymin -= dy * 0.05
    ymax += dy * 0.05

    # Coordinate mappers
    def sx(v):
        return plot_x + (v - xmin) / (xmax - xmin) * plot_w

    def sy(v):
        return plot_y + plot_h - (v - ymin) / (ymax - ymin) * plot_h

    # Plot area border
    parts.append(
        f'<rect x="{plot_x}" y="{plot_y}" width="{plot_w}" height="{plot_h}" '
        f'fill="none" stroke="#000" stroke-width="1"/>'
    )

    # Grid
    if ax._grid:
        xticks = _nice_ticks(xmin, xmax, 8)
        yticks = _nice_ticks(ymin, ymax, 6)
        for t in xticks:
            tx = sx(t)
            if plot_x < tx < plot_x + plot_w:
                parts.append(
                    f'<line x1="{tx:.1f}" y1="{plot_y}" '
                    f'x2="{tx:.1f}" y2="{plot_y + plot_h}" '
                    f'stroke="#ddd" stroke-width="0.5" stroke-dasharray="4,4"/>'
                )
        for t in yticks:
            ty = sy(t)
            if plot_y < ty < plot_y + plot_h:
                parts.append(
                    f'<line x1="{plot_x}" y1="{ty:.1f}" '
                    f'x2="{plot_x + plot_w}" y2="{ty:.1f}" '
                    f'stroke="#ddd" stroke-width="0.5" stroke-dasharray="4,4"/>'
                )

    # Tick marks and labels
    xticks = _nice_ticks(xmin, xmax, 8)
    yticks = _nice_ticks(ymin, ymax, 6)
    for t in xticks:
        tx = sx(t)
        if plot_x <= tx <= plot_x + plot_w:
            parts.append(
                f'<line x1="{tx:.1f}" y1="{plot_y + plot_h}" '
                f'x2="{tx:.1f}" y2="{plot_y + plot_h + 5}" stroke="#000" stroke-width="1"/>'
            )
            parts.append(
                f'<text x="{tx:.1f}" y="{plot_y + plot_h + 18}" '
                f'text-anchor="middle" font-size="11" fill="#333">'
                f'{_fmt_tick(t)}</text>'
            )
    for t in yticks:
        ty = sy(t)
        if plot_y <= ty <= plot_y + plot_h:
            parts.append(
                f'<line x1="{plot_x - 5}" y1="{ty:.1f}" '
                f'x2="{plot_x}" y2="{ty:.1f}" stroke="#000" stroke-width="1"/>'
            )
            parts.append(
                f'<text x="{plot_x - 8}" y="{ty + 4:.1f}" '
                f'text-anchor="end" font-size="11" fill="#333">'
                f'{_fmt_tick(t)}</text>'
            )

    # Data elements
    for elem in ax._elements:
        if elem['type'] == 'line':
            _draw_line(parts, elem, sx, sy)
        elif elem['type'] == 'scatter':
            _draw_scatter(parts, elem, sx, sy)
        elif elem['type'] == 'bar':
            _draw_bar(parts, elem, sx, sy, plot_y, plot_h, ymin, ymax)

    # Title
    if ax._title:
        parts.append(
            f'<text x="{plot_x + plot_w / 2:.1f}" y="{plot_y - 10}" '
            f'text-anchor="middle" font-size="14" font-weight="bold" fill="#000">'
            f'{_esc(ax._title)}</text>'
        )

    # Axis labels
    if ax._xlabel:
        parts.append(
            f'<text x="{plot_x + plot_w / 2:.1f}" y="{svg_h - 5}" '
            f'text-anchor="middle" font-size="12" fill="#333">'
            f'{_esc(ax._xlabel)}</text>'
        )
    if ax._ylabel:
        ty = plot_y + plot_h / 2
        parts.append(
            f'<text x="15" y="{ty:.1f}" '
            f'text-anchor="middle" font-size="12" fill="#333" '
            f'transform="rotate(-90, 15, {ty:.1f})">'
            f'{_esc(ax._ylabel)}</text>'
        )

    # Legend
    if ax._legend:
        _draw_legend(parts, ax, plot_x + plot_w - 10, plot_y + 10)


# ------------------------------------------------------------------
# Element renderers
# ------------------------------------------------------------------

def _draw_line(parts, elem, sx, sy):
    xd, yd = elem['x'], elem['y']
    if not xd:
        return
    color = elem['color']
    lw = elem.get('linewidth', 1.5)
    ls = elem.get('linestyle', '-')
    dash = ''
    if ls == '--' or ls == 'dashed':
        dash = ' stroke-dasharray="6,3"'
    elif ls == ':' or ls == 'dotted':
        dash = ' stroke-dasharray="2,2"'
    elif ls == '-.' or ls == 'dashdot':
        dash = ' stroke-dasharray="6,2,2,2"'

    points = ' '.join(f'{sx(xd[i]):.2f},{sy(yd[i]):.2f}' for i in range(len(xd)))
    parts.append(
        f'<polyline points="{points}" fill="none" '
        f'stroke="{color}" stroke-width="{lw}"{dash}/>'
    )

    marker = elem.get('marker')
    if marker:
        for i in range(len(xd)):
            cx, cy = sx(xd[i]), sy(yd[i])
            parts.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="3" fill="{color}"/>')


def _draw_scatter(parts, elem, sx, sy):
    xd, yd = elem['x'], elem['y']
    color = elem['color']
    s = elem.get('s', 20)
    import math
    r = max(1, int(math.sqrt(s) / 2))
    for i in range(len(xd)):
        cx, cy = sx(xd[i]), sy(yd[i])
        parts.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r}" fill="{color}"/>')


def _draw_bar(parts, elem, sx, sy, plot_y, plot_h, ymin, ymax):
    xd = elem['x']
    heights = elem['height']
    width = elem['width']
    color = elem['color']

    for i in range(len(xd)):
        x_center = xd[i]
        h = heights[i]
        # Bar from y=0 (or ymin) to y=h
        base_val = max(0, ymin)
        x_left = sx(x_center - width / 2)
        x_right = sx(x_center + width / 2)
        y_top = sy(h)
        y_bottom = sy(base_val)
        bw = max(1, x_right - x_left)
        bh = max(0, y_bottom - y_top)
        parts.append(
            f'<rect x="{x_left:.2f}" y="{y_top:.2f}" '
            f'width="{bw:.2f}" height="{bh:.2f}" fill="{color}"/>'
        )


def _draw_legend(parts, ax, right_x, top_y):
    """Draw a legend box in the top-right corner."""
    items = [(e['color'], e.get('label')) for e in ax._elements if e.get('label')]
    if not items:
        return
    lw = 120
    lh = len(items) * 20 + 10
    lx = right_x - lw
    ly = top_y
    parts.append(
        f'<rect x="{lx}" y="{ly}" width="{lw}" height="{lh}" '
        f'fill="white" stroke="#999" stroke-width="0.5"/>'
    )
    for i, (color, label) in enumerate(items):
        iy = ly + 15 + i * 20
        parts.append(
            f'<line x1="{lx + 5}" y1="{iy}" x2="{lx + 25}" y2="{iy}" '
            f'stroke="{color}" stroke-width="2"/>'
        )
        parts.append(
            f'<text x="{lx + 30}" y="{iy + 4}" font-size="11" fill="#333">'
            f'{_esc(label or "")}</text>'
        )


# ------------------------------------------------------------------
# Axis helpers
# ------------------------------------------------------------------

def _data_range(ax):
    """Compute min/max across all elements."""
    xs, ys = [], []
    for e in ax._elements:
        xs.extend(e.get('x', []))
        if e['type'] == 'bar':
            ys.extend(e.get('height', []))
            ys.append(0)  # bars start from 0
        else:
            ys.extend(e.get('y', []))
    if not xs:
        xs = [0, 1]
    if not ys:
        ys = [0, 1]
    return min(xs), max(xs), min(ys), max(ys)


def _nice_ticks(lo, hi, target_count):
    """Generate roughly *target_count* nicely-rounded ticks between lo and hi."""
    if hi <= lo:
        return [lo]
    import math
    raw_step = (hi - lo) / max(target_count, 1)
    mag = 10 ** math.floor(math.log10(raw_step + 1e-15))
    residual = raw_step / mag
    if residual <= 1.5:
        step = 1 * mag
    elif residual <= 3:
        step = 2 * mag
    elif residual <= 7:
        step = 5 * mag
    else:
        step = 10 * mag

    start = math.floor(lo / step) * step
    ticks = []
    t = start
    while t <= hi + step * 0.01:
        if lo <= t <= hi:
            ticks.append(round(t, 10))
        t += step
    return ticks if ticks else [lo, hi]


def _fmt_tick(v):
    """Format a tick value nicely."""
    if v == int(v):
        return str(int(v))
    return f'{v:.2g}'


def _esc(s):
    """Escape HTML entities."""
    return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
